/*
# Phase 18 — wire requires_design into the Design Studio queue
# (Architecture v2.0 §3.4 queue-wiring, step 3 of N — final stage)

## Scope
Following the same "one stage at a time" approach as migration 0060
(installation), this wires **design** — the doc's own "client already has
designs ready, just wants production + install" example. `requires_
production` skip is deliberately left out: in practice a PO line item
almost always still needs its boards physically produced even when
design/installation are skipped, so there's no realistic case to wire it
against, and forcing one would just be unused surface area.

## Design
Adds `requires_design_all_false` to `v_design_task_list`: true only when
every board on that shop linked to a `po_line_item` has
`requires_design = false`. A shop with no linked line items defaults to
`false` (design still required) — same fail-safe default direction 0046
and 0060 both took. Purely additive `CREATE OR REPLACE VIEW`.

This does NOT change how a design task reaches this queue in the first
place (Survey Review still creates it exactly as before — deliberately
not touched, since that's the approval-gate-adjacent code the 0048 scope
note warned against rushing). What changes is what the Design Studio
screen offers to do with a task once it's here: skip the upload/review
chain and send straight to Production, reusing the exact same
`sendDesignTaskToProduction()` the normal "Approve Design" path already
calls.
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
po_context AS (
  SELECT DISTINCT ON (wi.shop_id) wi.shop_id, ctx.po_number, ctx.fulfillment_type
  FROM public.work_items wi
  JOIN public.v_po_line_item_work_context ctx ON ctx.id = wi.po_line_item_id
  WHERE wi.organization_id = public.current_org_id()
    AND wi.po_line_item_id IS NOT NULL
  ORDER BY wi.shop_id, wi.created_at
),
-- New: per-shop "does ANY linked board still require design" — same
-- shape as migration 0060's installation_requirement CTE.
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
  COALESCE(dr.linked_line_items, 0) > 0 AND NOT COALESCE(dr.any_requires_design, true) AS requires_design_all_false
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
