/*
# Phase 13 — Campaign surfaced through to Production (folder-style browsing)

## Why
Production's queue can run into hundreds of shops across many Purchase
Orders. Five flat filter dropdowns (Zone, PO, Work Type, Fulfillment,
Assigned) work, but ask the person to hold a mental AND-query in their
head ("Zone=Mumbai AND PO=ABC..."). The natural top-level grouping for
this data already exists in the schema — it just wasn't surfaced to the
two non-financial views Production/Surveyor actually read
(`v_po_work_context`, `v_production_order_list`).

## Which "Campaign" — both, exactly like PurchaseOrdersPage.tsx already
## treats them
This app actually has TWO campaign-like groupings on `purchase_orders`,
and — per PurchaseOrdersPage.tsx's own existing comment — "at most one of
the two is ever set on a given PO":
- `project_id` -> `projects` — the AGENCY's own campaign, for a PO it
  created itself. This is the common case for a self-contained agency and
  was already selectable there as "My Campaigns".
- `campaign_id` -> `campaigns` (migration 0051) — the CLIENT's own
  campaign, one level above a PO the client created and assigned in.
  Optional, client-portal-only.

Exposing only `campaign_id` (and not `project_id`/`project_name` too)
would have left the Production folder browser's top level nearly empty
for any agency that doesn't use client-side PO creation — i.e. most of
them. Both are added here; the frontend picks whichever one is actually
set on a given PO (same "at most one" rule PurchaseOrdersPage already
relies on) to build a single "Campaign" folder level.

Purely additive: four new columns appended to each view's existing
SELECT list, no existing column/join/WHERE clause touched, so nothing
that already reads either view changes behavior.
*/

-- ============ v_po_work_context: +campaign_id, +campaign_name, +project_name ============
-- IMPORTANT: Postgres's CREATE OR REPLACE VIEW only allows new columns to
-- be appended after every existing column — it matches the old and new
-- column lists BY POSITION, not by name, so inserting a new column in
-- the middle (as an earlier version of this migration did, putting
-- project_name right after project_id) makes it look like an attempt to
-- RENAME the column that got pushed down (po_number -> project_name, in
-- that failed attempt), which Postgres rejects outright
-- ("cannot change name of view column ... to ...", SQLSTATE 42P16). All
-- three new columns are appended at the very end here instead; every
-- pre-existing column keeps its original name AND position.
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
  po.name,
  po.campaign_id,
  camp.name AS campaign_name,
  proj.name AS project_name
FROM public.purchase_orders po
LEFT JOIN public.projects proj ON proj.id = po.project_id
LEFT JOIN public.campaigns camp ON camp.id = po.campaign_id
WHERE po.organization_id = public.current_org_id();

GRANT SELECT ON public.v_po_work_context TO authenticated;

-- ============ v_production_order_list: +project_id, +project_name, +campaign_id, +campaign_name ============
-- Identical to the version in migration 0068 (the last one to redefine
-- this view), with only the final four SELECT columns added and the
-- `pc` join (already `v_po_work_context`) now carrying them through.
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
  pc.campaign_name
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

