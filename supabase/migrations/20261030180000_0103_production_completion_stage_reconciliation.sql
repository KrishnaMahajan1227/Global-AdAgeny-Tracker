-- Phase 6: production status/progress reconciliation (read-only).
-- Completed is a department-stage fact; measured quantities are separate facts.
-- Existing production_orders, work_items, production_items and audit logs remain untouched.
-- Status is reconciled from an already-finished downstream shop stage. The same
-- effective status drives the list, tabs, summary RPC and server-side filters.
-- Keep existing view column names, order and types unchanged (replace in place).
-- Excluded site-unavailable work items are not active production obligations.
-- Installed work items remain visible in the board detail/read-only history.
-- Closed orders are never shown as having open pending/materials work.

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
    AND wi.status IN ('approved', 'design_approved', 'in_production', 'produced', 'production_done', 'installed')
    AND NOT COALESCE(wi.excluded_from_calculations, false)
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
  CASE
    WHEN s.status IN ('cancelled', 'rejected') THEN po.status
    WHEN po.status = 'completed' OR s.status IN (
      'production_done', 'dispatched', 'delivered', 'installation_pending',
      'installing', 'installation_review', 'installed', 'billed'
    ) THEN 'completed'
    ELSE po.status
  END AS status,
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
  CASE WHEN po.status = 'completed' OR s.status IN (
    'production_done', 'dispatched', 'delivered', 'installation_pending',
    'installing', 'installation_review', 'installed', 'billed'
  ) THEN 0::bigint ELSE COALESCE(bc.pending_boards, 0) END AS pending_boards,
  CASE WHEN po.status = 'completed' OR s.status IN (
    'production_done', 'dispatched', 'delivered', 'installation_pending',
    'installing', 'installation_review', 'installed', 'billed'
  ) THEN 0::bigint ELSE COALESCE(bc.materials_pending_boards, 0) END AS materials_pending_boards,
  COALESCE(bc.work_type_ids, ARRAY[]::uuid[]) AS work_type_ids,
  CASE
    WHEN po.status = 'completed' OR s.status IN (
      'production_done', 'dispatched', 'delivered', 'installation_pending',
      'installing', 'installation_review', 'installed', 'billed'
    ) THEN 100::numeric
    WHEN COALESCE(bc.total_boards, 0) > 0
      THEN round(COALESCE(bc.done_boards, 0) * 100.0 / bc.total_boards)
    ELSE 0::numeric
  END AS progress_pct,
  CASE
    WHEN po.status = 'completed' OR s.status IN (
      'production_done', 'dispatched', 'delivered', 'installation_pending',
      'installing', 'installation_review', 'installed', 'billed'
    ) THEN 3
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
