/*
# Surface Work Order Name on the non-financial PO context views

Migration 0067 added `purchase_orders.name`, but the field-safe screens
(Survey Review, Surveyor mobile, Designer, Production) never read the
`purchase_orders` table directly — they read `v_po_work_context` /
`v_po_line_item_work_context` (migration 0029's RLS lockdown pattern, so
surveyor/designer/printing roles never touch the financial columns on the
base table). Without this, "PO {number}" badges on those screens would
never be able to show the Work Order Name no matter what the UI does.

Purely additive: same columns as before, same security definition
(current_org_id() scoping, no role check — name is exactly as
non-financial as po_number already was), one new column each.
*/

CREATE OR REPLACE VIEW public.v_po_work_context AS
SELECT
  po.id,
  po.organization_id,
  po.client_id,
  po.project_id,
  po.po_number,
  po.po_date,
  po.fulfillment_type,
  po.status,
  po.name
FROM public.purchase_orders po
WHERE po.organization_id = public.current_org_id();

GRANT SELECT ON public.v_po_work_context TO authenticated;

CREATE OR REPLACE VIEW public.v_po_line_item_work_context AS
SELECT
  pli.id,
  pli.organization_id,
  pli.purchase_order_id,
  po.po_number,
  po.fulfillment_type,
  po.status AS po_status,
  pli.work_type_id,
  pli.description,
  pli.uom,
  pli.budgeted_qty,
  pli.budgeted_area,
  pli.requires_survey,
  pli.requires_design,
  pli.requires_production,
  pli.requires_installation,
  po.name
FROM public.po_line_items pli
JOIN public.purchase_orders po ON po.id = pli.purchase_order_id
WHERE pli.organization_id = public.current_org_id();

GRANT SELECT ON public.v_po_line_item_work_context TO authenticated;

-- v_production_order_list (Production queue rows) joins v_po_work_context
-- already (as `pc`) — re-declaring it here, unchanged except for one new
-- column appended at the end (po_name), is the only way to surface the
-- Work Order Name on Production's "PO {number}" badge without touching
-- any of the board-counting/status logic above it.
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
  pc.name AS po_name
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

-- v_design_task_list (Design Studio queue rows) joins v_po_line_item_work_context
-- via its own `po_context` CTE — same treatment: unchanged logic, `name`
-- threaded through and appended as the final SELECT column.
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
  SELECT DISTINCT ON (wi.shop_id) wi.shop_id, ctx.po_number, ctx.fulfillment_type, ctx.name
  FROM public.work_items wi
  JOIN public.v_po_line_item_work_context ctx ON ctx.id = wi.po_line_item_id
  WHERE wi.organization_id = public.current_org_id()
    AND wi.po_line_item_id IS NOT NULL
  ORDER BY wi.shop_id, wi.created_at
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
  pc.name AS po_name
FROM public.design_tasks dt
JOIN public.shops s ON s.id = dt.shop_id
JOIN public.clients c ON c.id = s.client_id
LEFT JOIN public.profiles p ON p.id = dt.designer_id
LEFT JOIN board_counts bc ON bc.shop_id = dt.shop_id
LEFT JOIN version_counts vc ON vc.design_task_id = dt.id
LEFT JOIN survey_dates sd ON sd.shop_id = dt.shop_id
LEFT JOIN po_context pc ON pc.shop_id = dt.shop_id
LEFT JOIN design_requirement dr ON dr.shop_id = dt.shop_id
WHERE dt.organization_id = public.current_org_id();

GRANT SELECT ON public.v_design_task_list TO authenticated;
