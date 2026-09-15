/*
# Phase 14 — Campaign/Zone surfaced through to Design Studio (folder-style browsing)

## Why
Design Studio's queue has the exact same shape problem Production's had:
potentially hundreds of shops across many Purchase Orders, with only flat
filter dropdowns to narrow them down. Migration 0079 gave Production a
Campaign -> Work Order -> Zone folder browser; this migration gives
`v_design_task_list` the same columns so Design Studio gets the identical
treatment.

## What's added, and how
- `zone_id`, `zone_name` — straight off `shops`/`zones`, the same join
  Production's list already has.
- `po_id`, `project_id`, `project_name`, `campaign_id`, `campaign_name` —
  the existing `po_context` CTE previously reached a shop's PO context
  indirectly, through one of its `work_items.po_line_item_id` rows
  joined to `v_po_line_item_work_context` (itself missing project/
  campaign columns entirely). That indirection existed only to get to
  `po_number`/`fulfillment_type`/`name`, all three of which are just as
  reachable — more directly and unambiguously — via
  `shops.purchase_order_id -> v_po_work_context` (migration 0079 already
  widened that view with project_id/project_name/campaign_id/
  campaign_name). `po_context` is simplified to join that way instead,
  which also drops the `DISTINCT ON (wi.shop_id) ... ORDER BY
  wi.created_at` tie-break the old version needed (a shop can have
  several work_items with different po_line_item_ids; it only ever has
  one `purchase_order_id`). `po_number`/`fulfillment_type`/`po_name`
  keep the exact same values as before for every shop that has one.

Purely additive to the final SELECT list — appended after the existing
last column (`po_name`) so no existing column's name or position moves
(Postgres's `CREATE OR REPLACE VIEW` rule: append-only, matching
migration 0079's own fix for the same mistake).
*/

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
-- Simplified (see header): a shop has exactly one purchase_order_id, so
-- this reaches PO/Campaign/Project context directly instead of via one
-- arbitrary linked work_item's line item.
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
  pc.campaign_name
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
