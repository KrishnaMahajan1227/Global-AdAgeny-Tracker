/*
# Design Studio — scale-ready summary view + missing indexes

## Why
`DesignerPage.tsx` currently loads its list by fetching **every** design
task for the org, then **every** work item / survey photo / board marking
for **every** shop those tasks touch, all client-side, on every page
load. That is fine at the handful of shops this org has today but is an
outright O(all data) screen: at 10,000+ shops it means one query result
set with tens of thousands of rows shipped to the browser on every open
of the Design Studio, just to render a summary list. This migration is
the backend half of fixing that (the frontend half — paginating,
filtering server-side, and only loading a shop's full board/marking/
version detail when its row is actually expanded — lives in
`DesignerPage.tsx`).

## What this adds
1. **Missing indexes** on the columns the design pipeline's own queries
   already filter/join on (`design_tasks.organization_id/shop_id/
   designer_id/status`, `design_versions.design_task_id`,
   `board_markings.survey_photo_id/work_item_id`, `survey_photos.shop_id`,
   `surveys.shop_id, submitted_at`). None of these existed before —
   every one of those lookups was a sequential scan.
2. **`v_design_task_list`** — one pre-aggregated row per design task:
   shop/client identity, designer name, PO context, latest survey date,
   and board-count tallies (total/done/pending/not-ready) computed in
   SQL via indexed GROUP BYs, instead of pulled client-side by fetching
   full `work_items` rows for every shop. This is what the list/table
   view queries directly, with normal PostgREST `range()` pagination,
   `.eq()`/`.in()` status filtering, and `.or(...ilike...)` search —
   all pushed down to Postgres instead of happening in the browser.
3. **`design_task_stats()`** — the "Pending / Boards Pending / In Review /
   Approved / In Production" summary strip needs org-wide (or
   per-designer) totals, which a paginated list can no longer supply by
   just counting what's on the current page. Rather than fetch every row
   to sum client-side, this does the SUM/COUNT server-side and returns a
   single row. Ordinary (invoker-rights) SQL function — no elevated
   privileges — so it still runs under the caller's own RLS.

Both objects are read-only and additive: no existing table, trigger, or
column is touched, and nothing currently reading `design_tasks` /
`work_items` directly needs to change for this to be safe to apply.
*/

-- ============================================================
-- 1. Indexes
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_design_tasks_org ON public.design_tasks(organization_id);
CREATE INDEX IF NOT EXISTS idx_design_tasks_shop ON public.design_tasks(shop_id);
CREATE INDEX IF NOT EXISTS idx_design_tasks_designer ON public.design_tasks(designer_id);
CREATE INDEX IF NOT EXISTS idx_design_tasks_status ON public.design_tasks(status);
CREATE INDEX IF NOT EXISTS idx_design_tasks_org_status ON public.design_tasks(organization_id, status);

CREATE INDEX IF NOT EXISTS idx_design_versions_task ON public.design_versions(design_task_id);

CREATE INDEX IF NOT EXISTS idx_board_markings_photo ON public.board_markings(survey_photo_id);
CREATE INDEX IF NOT EXISTS idx_board_markings_work_item ON public.board_markings(work_item_id);

CREATE INDEX IF NOT EXISTS idx_survey_photos_shop ON public.survey_photos(shop_id);

CREATE INDEX IF NOT EXISTS idx_surveys_shop_submitted ON public.surveys(shop_id, submitted_at DESC);

-- Composite used by the "boards to design" tally per shop.
CREATE INDEX IF NOT EXISTS idx_work_items_shop_status ON public.work_items(shop_id, status);

-- ============================================================
-- 2. v_design_task_list — one row per design task, fully summarized
-- ============================================================
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
  pc.fulfillment_type
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

-- ============================================================
-- 3. design_task_stats() — one-row aggregate for the summary strip
-- ============================================================
-- Also covers the tab strip's per-status counts (`total`, `design_ready`)
-- so the tab bar never has to fetch full row sets just to count them.
CREATE OR REPLACE FUNCTION public.design_task_stats(p_designer_id uuid DEFAULT NULL)
RETURNS TABLE (
  total bigint,
  pending_shops bigint,
  boards_pending bigint,
  design_ready bigint,
  in_review bigint,
  approved bigint,
  in_production bigint
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    COUNT(*) AS total,
    COUNT(*) FILTER (WHERE status IN ('assigned', 'designing')) AS pending_shops,
    COALESCE(SUM(pending_boards), 0) AS boards_pending,
    COUNT(*) FILTER (WHERE status = 'design_ready') AS design_ready,
    COUNT(*) FILTER (WHERE status = 'in_review') AS in_review,
    COUNT(*) FILTER (WHERE status = 'approved') AS approved,
    COUNT(*) FILTER (WHERE status = 'ready_for_production') AS in_production
  FROM public.v_design_task_list
  WHERE p_designer_id IS NULL OR designer_id = p_designer_id;
$$;

GRANT EXECUTE ON FUNCTION public.design_task_stats(uuid) TO authenticated;
