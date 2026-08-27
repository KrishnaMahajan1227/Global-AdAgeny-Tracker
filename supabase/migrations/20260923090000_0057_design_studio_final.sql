/*
# Design Studio — consolidated final migration (supersedes 0055 + 0056)

Run this one file. It is the complete, current state of everything the
Design Studio screen needs on the database side: the performance indexes,
`v_design_task_list` (including the `board_progress` column added after
0055 shipped), and the `design_task_stats()` RPC.

Every statement here is idempotent — `CREATE INDEX IF NOT EXISTS`,
`CREATE OR REPLACE VIEW`, `CREATE OR REPLACE FUNCTION` — so it is safe to
run whether this is the first time, or 0055/0056 already partially or
fully applied. Nothing is dropped; a `CREATE OR REPLACE VIEW` on a view
that already exists keeps the exact same object (same OID), so any
grants already made stay in place and the `GRANT SELECT` lines below are
just here for completeness / a clean first run.

If you see "column v_design_task_list.board_progress does not exist" (or
any error naming this view/function), it means only the earlier partial
version of this migration ran — running this file will fix that.
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

CREATE INDEX IF NOT EXISTS idx_work_items_shop_status ON public.work_items(shop_id, status);

-- ============================================================
-- 2. v_design_task_list
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
  pc.fulfillment_type,
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

-- ============================================================
-- 3. design_task_stats()
-- ============================================================
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
