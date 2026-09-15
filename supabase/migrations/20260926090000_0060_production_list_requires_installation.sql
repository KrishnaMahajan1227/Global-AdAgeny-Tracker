/*
# Phase 17 — wire requires_installation into Production's "mark completed"
# flow (Architecture v2.0 §3.4 queue-wiring, step 2 of N)

## What this does
Migration 0046 added `po_line_items.requires_survey/design/production/
installation`, and 0048 exposed them read-only on
`v_po_line_item_work_context` — but nothing yet *acts* on them. Per
0048's own scope note, wiring this into the state-transition write
points needs to happen carefully, one stage at a time, without touching
the approval-gate triggers from 0011/0013/0014 (those already accept
every status value this migration uses — nothing here needs a new
CHECK-constraint value or a new trigger).

This pass wires **Installation only** — the clearest, lowest-risk case,
and per the doc's own examples ("Others: client already has boards
installed, just wants re-servicing", "install pre-made boards" is design/
survey-skip not installation-skip, so actually the highest-value case is
`requires_installation = false` — "just wants design+production, will
install themselves"). Design-skip and Production-skip (rarer in
practice — you almost always still have to produce the boards) are left
for a later pass, same as 0048 scoped things.

## Design
Adds `requires_installation_all` to `v_production_order_list` — true
only when EVERY work item on that shop that's linked to a po_line_item
has `requires_installation = false`. A shop with no linked line items
(legacy data, or items not yet tied to a line item) defaults to `false`
(i.e. "installation IS required") — the same fail-safe direction 0046
took defaulting every new column to `true`, so nothing that already
works today silently starts skipping installation.

Purely additive: CREATE OR REPLACE on an existing view, no table/trigger
change, no CHECK constraint touched.
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
-- New: per-shop "does ANY linked board still require installation".
-- Only shops with at least one linked po_line_item AND all of them
-- explicitly false count as skip-eligible; unlinked/legacy boards keep
-- the old behaviour (installation required) by defaulting true.
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
  -- true only when this shop has ≥1 board linked to a po_line_item and
  -- every one of them explicitly opts out of installation.
  COALESCE(ir.linked_line_items, 0) > 0 AND NOT COALESCE(ir.any_requires_installation, true) AS requires_installation_all_false
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
