/*
# Production Studio — scale-ready summary view + missing indexes

## Why
`ProductionPage.tsx` fetches every production order for the org, then
every eligible work item, every production_item, and every
work_item_component across every one of those shops, entirely
client-side, on every page load, with no pagination. That works fine at
today's handful of shops but is exactly the same O(all data) shape the
Design Studio screen had before migration 0055 — at 10,000+ shops it
means dumping the org's entire production dataset into the browser just
to render a list. This is the production-side equivalent of that fix.

## What this adds
1. **Missing indexes** on `production_orders` — organization_id, shop_id,
   status, and the (organization_id, status) pair the status tabs filter
   on. None of these existed; every query against this table was a
   sequential scan.
2. **`v_production_order_list`** — one pre-aggregated row per production
   order: shop/client/zone identity, PO number + fulfillment type (via
   the existing rate-free `v_po_work_context`, so the 'printing' role
   still never sees financial data), assigned production person, and
   board-count tallies (total/done/pending/materials-pending) computed in
   SQL — replicating exactly the "done" logic the frontend used to
   compute client-side (locked, or quantity met AND every BOM component
   ready). Also carries `work_type_ids` (the distinct work types present
   on that shop's boards) so the Work Type filter can stay a real,
   server-side filter via PostgREST's array `contains` operator instead
   of requiring every board fetched into the browser first.
3. **`production_order_stats()`** — one-row aggregate (org-wide, or
   scoped to one assignee) for the summary strip and tab counts, computed
   server-side instead of by summing every row in the browser.

Both are read-only and additive — no existing table, trigger, or column
changes shape.
*/

-- ============================================================
-- 1. Indexes
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_production_orders_org ON public.production_orders(organization_id);
CREATE INDEX IF NOT EXISTS idx_production_orders_shop ON public.production_orders(shop_id);
CREATE INDEX IF NOT EXISTS idx_production_orders_status ON public.production_orders(status);
CREATE INDEX IF NOT EXISTS idx_production_orders_org_status ON public.production_orders(organization_id, status);

-- ============================================================
-- 2. v_production_order_list
-- ============================================================
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
  -- Precomputed so "Sort by % complete" and the default "needs attention
  -- first" order can be plain server-side ORDER BY clauses instead of
  -- requiring every row fetched into the browser to sort there.
  CASE WHEN COALESCE(bc.total_boards, 0) > 0
    THEN round(COALESCE(bc.done_boards, 0) * 100.0 / bc.total_boards)
    ELSE 0
  END AS progress_pct,
  CASE
    WHEN COALESCE(bc.materials_pending_boards, 0) > 0 THEN 0
    WHEN COALESCE(bc.pending_boards, 0) > 0 THEN 1
    ELSE 2
  END AS attention_rank
FROM public.production_orders po
JOIN public.shops s ON s.id = po.shop_id
JOIN public.clients c ON c.id = s.client_id
LEFT JOIN public.zones z ON z.id = s.zone_id
LEFT JOIN public.profiles p ON p.id = po.assigned_to
LEFT JOIN public.v_po_work_context pc ON pc.id = s.purchase_order_id
LEFT JOIN board_counts bc ON bc.shop_id = po.shop_id
WHERE po.organization_id = public.current_org_id();

GRANT SELECT ON public.v_production_order_list TO authenticated;

-- ============================================================
-- 3. production_order_stats()
-- ============================================================
CREATE OR REPLACE FUNCTION public.production_order_stats(p_assigned_to uuid DEFAULT NULL)
RETURNS TABLE (
  total bigint,
  pending bigint,
  in_production bigint,
  ready bigint,
  hold bigint,
  completed bigint,
  boards_pending bigint,
  materials_pending bigint,
  needs_materials_orders bigint
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    COUNT(*) AS total,
    COUNT(*) FILTER (WHERE status = 'pending') AS pending,
    COUNT(*) FILTER (WHERE status = 'in_production') AS in_production,
    COUNT(*) FILTER (WHERE status = 'ready') AS ready,
    COUNT(*) FILTER (WHERE status = 'hold') AS hold,
    COUNT(*) FILTER (WHERE status = 'completed') AS completed,
    COALESCE(SUM(pending_boards), 0) AS boards_pending,
    COALESCE(SUM(materials_pending_boards), 0) AS materials_pending,
    COUNT(*) FILTER (WHERE materials_pending_boards > 0) AS needs_materials_orders
  FROM public.v_production_order_list
  WHERE p_assigned_to IS NULL OR assigned_to = p_assigned_to;
$$;

GRANT EXECUTE ON FUNCTION public.production_order_stats(uuid) TO authenticated;
