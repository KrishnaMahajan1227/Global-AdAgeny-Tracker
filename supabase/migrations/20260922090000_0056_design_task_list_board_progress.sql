/*
# Design Studio — board-progress filter column

## Why
Both roles on the Design Studio screen asked for working filters beyond
just the status tabs: a designer wants to filter "which of my shops still
have boards untouched vs. partially done vs. fully designed" without that
depending on PO/order-type context (which they can't see); an owner wants
the same lens plus the existing order-type filter. `v_design_task_list`
(migration 0055) already computes `total_boards`/`done_boards` per row,
but there was no single filterable column for "where is this shop's board
progress at" — filtering on two numeric columns' relationship isn't
something a simple PostgREST `.eq()`/`.in()` can express. This adds that
as one precomputed text column so the frontend can filter on it directly.

Purely additive: `CREATE OR REPLACE VIEW` with the exact same query as
0055 plus one more computed column at the end. Nothing existing changes
shape or meaning.
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
  -- One filterable bucket instead of the caller having to compare
  -- total_boards/done_boards themselves (which PostgREST's simple
  -- column=value filters can't express column-to-column anyway).
  CASE
    WHEN COALESCE(bc.total_boards, 0) = 0 THEN 'no_boards'
    WHEN COALESCE(bc.done_boards, 0) = 0 THEN 'not_started'
    WHEN bc.done_boards = bc.total_boards THEN 'done'
    ELSE 'in_progress'
  END AS board_progress
FROM public.design_tasks dt
JOIN public.shops s ON s.id = dt.shop_id
JOIN public.clients c ON c.id = s.client_id
LEFT JOIN public.profiles p ON p.id = dt.designer_id
LEFT JOIN board_counts bc ON bc.shop_id = dt.shop_id
LEFT JOIN version_counts vc ON vc.design_task_id = dt.id
LEFT JOIN survey_dates sd ON sd.shop_id = dt.shop_id
LEFT JOIN po_context pc ON pc.shop_id = dt.shop_id
WHERE dt.organization_id = public.current_org_id();

GRANT SELECT ON public.v_design_task_list TO authenticated;
