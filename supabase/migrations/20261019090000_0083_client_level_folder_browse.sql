/*
# Phase 15 — Client level for the Production/Design folder browsers

## Why
Migrations 0079/0080 gave Production and Design Studio a Campaign ->
Work Order -> Zone folder browser. Both views already join
public.clients (for client_name, shown in the list) but never selected
the client's id — only usable as a label, not as a stable key to browse
by. Owner/Admin's own screens group by client first (Client -> Campaign
-> Work Order -> Shops); Production and Design should offer the same
top level instead of starting one level in.

Also: Design Studio's folder root has been skipped straight to Zone for
designer sessions specifically (see DesignerPage.tsx's `isDesigner`
check) — this migration only adds the column; the accompanying frontend
change (this same fix) removes that skip so a designer gets the full
Client -> Campaign -> Work Order -> Zone tree, same as Production.

Purely additive: `client_id` appended after each view's existing last
column, so no existing column's name or position moves (same
append-only rule migrations 0079/0080 already followed).
*/

CREATE OR REPLACE VIEW public.v_production_order_list AS
WITH component_status AS (
  SELECT
    wic.work_item_id,
    COUNT(*) AS comp_count,
    COUNT(*) FILTER (WHERE wic.status = 'ready') AS comp_ready_count
  FROM public.work_item_components wic
  WHERE wic.organization_id = public.current_org_id()
  GROUP BY wic.work_item_id
),
item_flags AS (
  SELECT
    wi.id,
    wi.shop_id,
    wi.work_type_id,
    wi.po_line_item_id,
    (wi.status IN ('production_done', 'installed')) AS locked,
    COALESCE(cs.comp_count, 0) AS comp_count,
    COALESCE(cs.comp_count, 0) = 0 OR COALESCE(cs.comp_count, 0) = COALESCE(cs.comp_ready_count, 0) AS components_ready,
    (wi.produced_quantity IS NOT NULL AND wi.produced_quantity >= COALESCE(wi.approved_quantity, wi.survey_quantity, 1)) AS qty_met
  FROM public.work_items wi
  LEFT JOIN component_status cs ON cs.work_item_id = wi.id
  WHERE wi.organization_id = public.current_org_id()
    AND wi.status IN ('approved', 'design_approved', 'in_production', 'produced', 'production_done')
),
item_done AS (
  SELECT *, (locked OR (qty_met AND components_ready)) AS is_done
  FROM item_flags
),
board_counts AS (
  SELECT
    shop_id,
    COUNT(*) AS total_boards,
    COUNT(*) FILTER (WHERE is_done) AS done_boards,
    COUNT(*) FILTER (WHERE NOT is_done) AS pending_boards,
    COUNT(*) FILTER (WHERE NOT locked AND comp_count > 0 AND NOT components_ready) AS materials_pending_boards,
    array_agg(DISTINCT work_type_id) FILTER (WHERE work_type_id IS NOT NULL) AS work_type_ids
  FROM item_done
  GROUP BY shop_id
),
installation_requirement AS (
  SELECT
    wi.shop_id,
    bool_or(COALESCE(pli.requires_installation, true)) AS any_requires_installation,
    COUNT(pli.id) AS linked_line_items
  FROM public.work_items wi
  LEFT JOIN public.po_line_items pli ON pli.id = wi.po_line_item_id
  WHERE wi.organization_id = public.current_org_id()
  GROUP BY wi.shop_id
)
SELECT
  po.id AS production_order_id,
  po.organization_id,
  po.shop_id,
  po.status,
  po.notes,
  po.assigned_to,
  po.created_at,
  po.updated_at,
  s.name AS shop_name,
  s.city AS shop_city,
  s.address AS shop_address,
  s.owner_name AS shop_owner_name,
  s.contact_phone AS shop_contact_phone,
  s.zone_id,
  z.name AS zone_name,
  c.name AS client_name,
  p.full_name AS assigned_name,
  pc.id AS po_id,
  pc.po_number,
  pc.fulfillment_type,
  COALESCE(bc.total_boards, 0) AS total_boards,
  COALESCE(bc.done_boards, 0) AS done_boards,
  COALESCE(bc.pending_boards, 0) AS pending_boards,
  COALESCE(bc.materials_pending_boards, 0) AS materials_pending_boards,
  COALESCE(bc.work_type_ids, ARRAY[]::uuid[]) AS work_type_ids,
  CASE WHEN COALESCE(bc.total_boards, 0) > 0
    THEN round(COALESCE(bc.done_boards, 0) * 100.0 / bc.total_boards)
    ELSE 0
  END AS progress_pct,
  CASE
    WHEN COALESCE(bc.materials_pending_boards, 0) > 0 THEN 0
    WHEN COALESCE(bc.pending_boards, 0) > 0 THEN 1
    ELSE 2
  END AS attention_rank,
  COALESCE(ir.linked_line_items, 0) > 0 AND NOT COALESCE(ir.any_requires_installation, true) AS requires_installation_all_false,
  pc.name AS po_name,
  pc.project_id,
  pc.project_name,
  pc.campaign_id,
  pc.campaign_name,
  c.id AS client_id
FROM public.production_orders po
JOIN public.shops s ON s.id = po.shop_id
JOIN public.clients c ON c.id = s.client_id
LEFT JOIN public.zones z ON z.id = s.zone_id
LEFT JOIN public.profiles p ON p.id = po.assigned_to
LEFT JOIN public.v_po_work_context pc ON pc.id = s.purchase_order_id
LEFT JOIN board_counts bc ON bc.shop_id = po.shop_id
LEFT JOIN installation_requirement ir ON ir.shop_id = po.shop_id
WHERE po.organization_id = public.current_org_id();

GRANT SELECT ON public.v_production_order_list TO authenticated;


CREATE OR REPLACE VIEW public.v_design_task_list AS
WITH board_counts AS (
  SELECT
    wi.shop_id,
    COUNT(*) AS total_boards,
    COUNT(*) FILTER (
      WHERE wi.status IN ('designed', 'design_approved', 'in_production', 'produced', 'production_done', 'installed')
    ) AS done_boards,
    COUNT(*) FILTER (WHERE wi.status IN ('pending', 'surveyed')) AS not_ready_boards,
    COUNT(*) FILTER (
      WHERE wi.status NOT IN (
        'designed', 'design_approved', 'in_production', 'produced', 'production_done', 'installed',
        'pending', 'surveyed', 'cancelled'
      )
    ) AS pending_boards
  FROM public.work_items wi
  WHERE wi.organization_id = public.current_org_id()
    AND wi.status <> 'cancelled'
  GROUP BY wi.shop_id
),
version_counts AS (
  SELECT dv.design_task_id, COUNT(*) AS version_count, MAX(dv.created_at) AS last_upload_at
  FROM public.design_versions dv
  WHERE dv.organization_id = public.current_org_id()
  GROUP BY dv.design_task_id
),
survey_dates AS (
  SELECT DISTINCT ON (sv.shop_id) sv.shop_id, COALESCE(sv.submitted_at, sv.created_at) AS survey_date
  FROM public.surveys sv
  WHERE sv.organization_id = public.current_org_id()
  ORDER BY sv.shop_id, COALESCE(sv.submitted_at, sv.created_at) DESC
),
po_context AS (
  SELECT
    s2.id AS shop_id,
    pc2.id AS po_id,
    pc2.po_number,
    pc2.fulfillment_type,
    pc2.name AS po_name,
    pc2.project_id,
    pc2.project_name,
    pc2.campaign_id,
    pc2.campaign_name
  FROM public.shops s2
  LEFT JOIN public.v_po_work_context pc2 ON pc2.id = s2.purchase_order_id
  WHERE s2.organization_id = public.current_org_id()
),
design_requirement AS (
  SELECT
    wi.shop_id,
    bool_or(COALESCE(pli.requires_design, true)) AS any_requires_design,
    COUNT(pli.id) AS linked_line_items
  FROM public.work_items wi
  LEFT JOIN public.po_line_items pli ON pli.id = wi.po_line_item_id
  WHERE wi.organization_id = public.current_org_id()
  GROUP BY wi.shop_id
)
SELECT
  dt.id AS design_task_id,
  dt.organization_id,
  dt.shop_id,
  dt.designer_id,
  dt.status,
  dt.notes,
  dt.assigned_at,
  dt.completed_at,
  dt.created_at,
  dt.updated_at,
  s.name AS shop_name,
  s.city AS shop_city,
  s.address AS shop_address,
  s.owner_name AS shop_owner_name,
  s.contact_phone AS shop_contact_phone,
  c.name AS client_name,
  p.full_name AS designer_name,
  COALESCE(bc.total_boards, 0) AS total_boards,
  COALESCE(bc.done_boards, 0) AS done_boards,
  COALESCE(bc.pending_boards, 0) AS pending_boards,
  COALESCE(bc.not_ready_boards, 0) AS not_ready_boards,
  COALESCE(vc.version_count, 0) AS version_count,
  vc.last_upload_at,
  sd.survey_date,
  pc.po_number,
  pc.fulfillment_type,
  CASE
    WHEN COALESCE(bc.total_boards, 0) = 0 THEN 'no_boards'
    WHEN COALESCE(bc.done_boards, 0) = 0 THEN 'not_started'
    WHEN bc.done_boards = bc.total_boards THEN 'done'
    ELSE 'in_progress'
  END AS board_progress,
  COALESCE(dr.linked_line_items, 0) > 0 AND NOT COALESCE(dr.any_requires_design, true) AS requires_design_all_false,
  pc.po_name,
  s.zone_id,
  z.name AS zone_name,
  pc.po_id,
  pc.project_id,
  pc.project_name,
  pc.campaign_id,
  pc.campaign_name,
  c.id AS client_id
FROM public.design_tasks dt
JOIN public.shops s ON s.id = dt.shop_id
JOIN public.clients c ON c.id = s.client_id
LEFT JOIN public.profiles p ON p.id = dt.designer_id
LEFT JOIN public.zones z ON z.id = s.zone_id
LEFT JOIN board_counts bc ON bc.shop_id = dt.shop_id
LEFT JOIN version_counts vc ON vc.design_task_id = dt.id
LEFT JOIN survey_dates sd ON sd.shop_id = dt.shop_id
LEFT JOIN po_context pc ON pc.shop_id = dt.shop_id
LEFT JOIN design_requirement dr ON dr.shop_id = dt.shop_id
WHERE dt.organization_id = public.current_org_id();

GRANT SELECT ON public.v_design_task_list TO authenticated;
