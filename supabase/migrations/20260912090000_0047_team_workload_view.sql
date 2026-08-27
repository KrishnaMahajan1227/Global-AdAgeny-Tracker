/*
# Phase 13 — Team Workload view (Architecture v2.0 §9.2, §8 item 9)

Per §9.2: "who was given how much work, how much is done" should be a
first-class, always-visible view instead of something pieced together by
filtering lists per person. This is the aggregation layer the doc calls
for — a Supabase view, same pattern as `poUtilization.ts`'s own
`v_po_line_item_utilization` (migration 0025).

## Design
One row per (person, role) who currently has at least one assignment,
covering the three field/production roles the doc's own example table
uses — surveyor, designer, installer:

- **Surveyor / Installer** are sourced from `shop_assignments` (already
  the source of truth for who's assigned to which shop in which of
  those two roles — nothing new to track).
- **Designer** is sourced from `design_tasks` (`designer_id`,
  `assigned_at`, `completed_at`, `status`) — the equivalent table for
  design work.

Columns: `assigned_open` (not yet completed/declined/rejected),
`in_progress` (actively being worked, not just sitting assigned),
`completed_this_month`, `overdue` (open longer than 3 days — a simple,
documented proxy; there's no per-assignment due-date column anywhere in
this schema to do better than that today), and `avg_turnaround_days`
(mean days from assigned to completed, over this-month completions).

This is read-only aggregation over existing tables — no new columns on
`shop_assignments`/`design_tasks`, no trigger, nothing that touches the
core pipeline's state machine.
*/

CREATE OR REPLACE VIEW public.v_team_workload AS
WITH shop_assignment_rows AS (
  SELECT
    sa.organization_id,
    sa.user_id,
    sa.role,
    sa.status,
    sa.assigned_at,
    sa.completed_at
  FROM public.shop_assignments sa
  WHERE sa.role IN ('surveyor', 'installer')
),
design_task_rows AS (
  SELECT
    dt.organization_id,
    dt.designer_id AS user_id,
    'designer'::text AS role,
    dt.status,
    dt.assigned_at,
    dt.completed_at
  FROM public.design_tasks dt
  WHERE dt.designer_id IS NOT NULL
),
all_rows AS (
  SELECT * FROM shop_assignment_rows
  UNION ALL
  SELECT * FROM design_task_rows
),
-- A row counts as "completed" for surveyor/installer at status='completed'
-- (shop_assignments), and for designer at status='approved'
-- (design_tasks' terminal success state).
scored AS (
  SELECT
    *,
    (
      (role IN ('surveyor', 'installer') AND status = 'completed')
      OR (role = 'designer' AND status = 'approved')
    ) AS is_completed,
    (
      (role IN ('surveyor', 'installer') AND status NOT IN ('completed', 'declined'))
      OR (role = 'designer' AND status NOT IN ('approved', 'rejected'))
    ) AS is_open,
    (
      (role IN ('surveyor', 'installer') AND status = 'started')
      OR (role = 'designer' AND status IN ('designing', 'internal_review'))
    ) AS is_in_progress
  FROM all_rows
)
SELECT
  p.id AS user_id,
  p.organization_id,
  p.full_name,
  s.role,
  COUNT(*) FILTER (WHERE s.is_open) AS assigned_open,
  COUNT(*) FILTER (WHERE s.is_in_progress) AS in_progress,
  COUNT(*) FILTER (WHERE s.is_completed AND s.completed_at >= date_trunc('month', now())) AS completed_this_month,
  COUNT(*) FILTER (WHERE s.is_open AND s.assigned_at < now() - interval '3 days') AS overdue,
  ROUND(
    AVG(EXTRACT(epoch FROM (s.completed_at - s.assigned_at)) / 86400.0)
      FILTER (WHERE s.is_completed AND s.completed_at >= date_trunc('month', now())),
    1
  ) AS avg_turnaround_days
FROM scored s
JOIN public.profiles p ON p.id = s.user_id
WHERE s.organization_id = public.current_org_id()
GROUP BY p.id, p.organization_id, p.full_name, s.role;

GRANT SELECT ON public.v_team_workload TO authenticated;
