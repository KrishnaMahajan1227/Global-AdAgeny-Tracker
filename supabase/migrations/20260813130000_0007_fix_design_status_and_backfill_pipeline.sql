/*
# Fix status constraint mismatches + backfill missing pipeline rows

This migration fixes three separate problems found while tracing why shops
were showing an advanced status (e.g. "Surveyed") with nothing showing up
on the Survey Review / Design Queue / Production Queue screens.

## Problem 1 — a real schema/app mismatch on design_tasks.status
`DesignerPage.tsx`'s "Send for Review" button sets `design_tasks.status =
'in_review'`. But the table's CHECK constraint only allows
('assigned','designing','design_ready','internal_review','approved',
'ready_for_production','rejected') — 'in_review' was never in that list.
Every "Send for Review" click was rejected by Postgres. Widen the
constraint to match what the app actually sends (same fix pattern as the
earlier survey_photos.photo_type constraint fix).

## Problem 1b — the same mismatch on work_items.status
Two more values the app actually writes to `work_items.status` were never
in that column's CHECK constraint either:
- `DesignerPage.tsx` "Ready for Production" sets `'design_approved'`
- `ProductionPage.tsx` marking an order "Completed" sets `'production_done'`
Both were silently rejected by Postgres (or, after the app-code fix in this
same pass, now throw a visible error instead of failing silently) — meaning
a design could never actually be marked ready for production, and a
finished production order could never actually mark its work items done.
Widened to match every status value the app writes.

## Problem 2 — shops whose status is ahead of their pipeline rows
Every queue screen (Survey Review, Design Queue, Production Queue) reads
its own table (`surveys`, `design_tasks`, `production_orders`) — not
`shops.status`. If a `shops.status` update ever succeeded while the
matching row in one of those tables failed to get created/updated (several
such silent-failure paths existed in the app code and have now been fixed
going forward — see CHANGES.md), the shop is left permanently invisible to
whoever's supposed to work on it next, even though the shop card elsewhere
in the app says it's further along.

This backfills the missing rows so every shop's status is consistent with
what actually exists in the pipeline tables. It is safe to run more than
once — every insert is guarded by "does a row already exist for this
shop", so it only ever fills genuine gaps.
*/

-- ============================================================
-- Problem 1: widen design_tasks status constraint
-- ============================================================
ALTER TABLE public.design_tasks DROP CONSTRAINT IF EXISTS design_tasks_status_check;
ALTER TABLE public.design_tasks ADD CONSTRAINT design_tasks_status_check
  CHECK (status IN ('assigned','designing','design_ready','in_review','internal_review','approved','ready_for_production','rejected'));

-- ============================================================
-- Problem 1b: widen work_items status constraint
-- ============================================================
ALTER TABLE public.work_items DROP CONSTRAINT IF EXISTS work_items_status_check;
ALTER TABLE public.work_items ADD CONSTRAINT work_items_status_check
  CHECK (status IN ('pending','surveyed','approved','designing','designed','design_approved','in_production','produced','production_done','installed','cancelled'));

-- ============================================================
-- Problem 2a: backfill missing `surveys` rows
-- ============================================================
DO $$
DECLARE
  shop_row RECORD;
  chosen_surveyor uuid;
  chosen_status text;
BEGIN
  FOR shop_row IN
    SELECT s.id, s.organization_id, s.status, s.created_at
    FROM public.shops s
    WHERE s.status <> 'pending' AND s.status <> 'assigned'
      AND NOT EXISTS (SELECT 1 FROM public.surveys sv WHERE sv.shop_id = s.id)
  LOOP
    -- Prefer whoever is actually assigned as this shop's surveyor;
    -- otherwise fall back to any surveyor, then any admin/owner, in the org.
    SELECT sa.user_id INTO chosen_surveyor
      FROM public.shop_assignments sa
      WHERE sa.shop_id = shop_row.id AND sa.role = 'surveyor'
      ORDER BY sa.assigned_at DESC LIMIT 1;

    IF chosen_surveyor IS NULL THEN
      SELECT p.id INTO chosen_surveyor FROM public.profiles p
        WHERE p.organization_id = shop_row.organization_id AND p.role = 'surveyor'
        ORDER BY p.created_at LIMIT 1;
    END IF;
    IF chosen_surveyor IS NULL THEN
      SELECT p.id INTO chosen_surveyor FROM public.profiles p
        WHERE p.organization_id = shop_row.organization_id AND p.role IN ('agency_owner','admin')
        ORDER BY p.created_at LIMIT 1;
    END IF;

    -- Skip if the org genuinely has no one to attribute this survey to —
    -- surveyor_id is NOT NULL, nothing sensible to insert.
    CONTINUE WHEN chosen_surveyor IS NULL;

    chosen_status := CASE
      WHEN shop_row.status IN ('surveyed', 'approval_pending') THEN 'submitted'
      ELSE 'approved' -- anything design/production/installation-stage implies the survey was approved
    END;

    INSERT INTO public.surveys (organization_id, shop_id, surveyor_id, status, submitted_at, reviewed_at, notes)
    VALUES (
      shop_row.organization_id, shop_row.id, chosen_surveyor, chosen_status,
      shop_row.created_at, CASE WHEN chosen_status = 'approved' THEN shop_row.created_at ELSE NULL END,
      'Backfilled automatically — this shop''s status indicated a survey had already happened, but no survey record existed. Please verify against real survey data if available.'
    );
  END LOOP;
END $$;

-- Link any pre-existing work_items that were created without a survey_id
-- (e.g. via direct DB inserts) to the survey we just backfilled for their
-- shop, so the Shop Detail page's Work Items / measurements line up with
-- a real survey record.
UPDATE public.work_items wi
SET survey_id = sv.id
FROM public.surveys sv
WHERE wi.survey_id IS NULL
  AND sv.shop_id = wi.shop_id
  AND sv.notes LIKE 'Backfilled automatically%';

-- ============================================================
-- Problem 2b: backfill missing `design_tasks` rows
-- ============================================================
INSERT INTO public.design_tasks (organization_id, shop_id, status)
SELECT s.organization_id, s.id,
  CASE
    WHEN s.status = 'design_pending' THEN 'assigned'
    WHEN s.status = 'designing' THEN 'designing'
    WHEN s.status = 'design_ready' THEN 'design_ready'
    WHEN s.status = 'in_review' THEN 'in_review'
    WHEN s.status = 'design_approved' THEN 'approved'
    ELSE 'ready_for_production' -- production/dispatched/installation/installed/billed all imply design was finished
  END
FROM public.shops s
WHERE s.status IN (
  'design_pending','designing','design_ready','in_review','design_approved',
  'production_pending','in_production','production_ready','production_hold',
  'production_done','dispatched','installation_pending','installing','installed','billed'
)
AND NOT EXISTS (SELECT 1 FROM public.design_tasks dt WHERE dt.shop_id = s.id);

-- ============================================================
-- Problem 2c: backfill missing `production_orders` rows
-- ============================================================
INSERT INTO public.production_orders (organization_id, shop_id, design_task_id, status)
SELECT s.organization_id, s.id, dt.id,
  CASE
    WHEN s.status = 'production_pending' THEN 'pending'
    WHEN s.status = 'in_production' THEN 'in_production'
    WHEN s.status = 'production_ready' THEN 'ready'
    WHEN s.status = 'production_hold' THEN 'hold'
    ELSE 'completed' -- production_done/dispatched/installation/installed/billed all imply production finished
  END
FROM public.shops s
LEFT JOIN public.design_tasks dt ON dt.shop_id = s.id
WHERE s.status IN (
  'production_pending','in_production','production_ready','production_hold',
  'production_done','dispatched','installation_pending','installing','installed','billed'
)
AND NOT EXISTS (SELECT 1 FROM public.production_orders po WHERE po.shop_id = s.id);

-- ============================================================
-- Problem 2d: de-duplicate shop_assignments
-- ============================================================
-- Same person assigned to the same role on the same shop more than once
-- (e.g. from a manual DB edit before the in-app "Assign" feature existed)
-- — keep only the most recently updated row per (shop_id, user_id, role).
DELETE FROM public.shop_assignments sa
WHERE sa.id NOT IN (
  SELECT DISTINCT ON (shop_id, user_id, role) id
  FROM public.shop_assignments
  ORDER BY shop_id, user_id, role, COALESCE(completed_at, assigned_at) DESC
);
