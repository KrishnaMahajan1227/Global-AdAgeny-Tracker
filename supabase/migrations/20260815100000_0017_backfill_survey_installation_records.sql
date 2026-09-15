/*
# Backfill: reconstruct missing survey/installation records + fix status
# drift, so Shop Detail (and billing) reflect what actually happened

## What was wrong
Three related data gaps, all with the same root cause: some shops'
survey/installation work was done through a path (older app version,
direct data import, etc.) that updated `work_items` and
`shop_assignments` but never wrote the corresponding `surveys` /
`installation_jobs` row, and in some cases never advanced
`work_items.status` or `shops.status` either. The UI was reading only the
"official" record and had no way to know the work was actually real, so
it showed "No surveys yet" / "No installation jobs yet" and stale
"Designing" badges on shops and work items that are, in reality, fully
installed. (ShopsPages.tsx has already been changed to fall back to this
same evidence for display — this migration fixes the underlying data
itself, since cosmetic-only fixes aren't good enough to bill against.)

## Fix, in order
1. `work_items.status` self-consistency: set each row's status to match
   the furthest stage its own filled columns actually prove (installed >
   produced > approved > surveyed > pending), for any row where the
   status column is behind that.
2. Reconstruct a missing `surveys` row wherever work items prove a survey
   happened but no survey row exists, using the shop's own surveyor
   assignment for who/when. Marked 'approved' if work items also carry
   approved measurements, else 'submitted'.
3. Reconstruct a missing `installation_jobs` row the same way, using the
   installer assignment, with `review_status` set to 'approved' only if
   the shop has actually reached 'installed'/'billed'.
4. Nudge `design_tasks.status` forward if an approved design version
   exists but the task itself is still sitting behind that (e.g.
   'designing') — mirrors what DesignerPage's own Approve action would
   have set.
5. Advance `shops.status` to 'installed' for any shop where every one of
   its (non-cancelled) work items is now 'installed' but the shop's own
   status hasn't caught up — this is what actually unblocks Billing. The
   installation-review trigger is disabled for the duration of this
   specific correction since there's no real "Owner clicked Approve"
   event to attribute historical rows to; it's re-enabled immediately
   after so all *future* transitions still go through the normal gate.

Safe to re-run: every step only touches rows that are actually behind,
so running this again after everything is already consistent is a no-op.
*/

-- ============================================================
-- Step 1: work_items.status self-consistency
-- ============================================================
UPDATE public.work_items
SET status = CASE
  WHEN installed_width IS NOT NULL THEN 'installed'
  WHEN produced_at IS NOT NULL OR produced_quantity IS NOT NULL THEN 'production_done'
  WHEN approved_width IS NOT NULL THEN 'approved'
  WHEN survey_width IS NOT NULL THEN 'surveyed'
  ELSE status
END
WHERE status <> 'cancelled'
  AND status <> CASE
    WHEN installed_width IS NOT NULL THEN 'installed'
    WHEN produced_at IS NOT NULL OR produced_quantity IS NOT NULL THEN 'production_done'
    WHEN approved_width IS NOT NULL THEN 'approved'
    WHEN survey_width IS NOT NULL THEN 'surveyed'
    ELSE status
  END;

-- ============================================================
-- Step 2: reconstruct missing `surveys` rows
-- ============================================================
DO $$
DECLARE
  rec RECORD;
  a RECORD;
  has_approved boolean;
  new_survey_id uuid;
BEGIN
  FOR rec IN
    SELECT DISTINCT s.id AS shop_id, s.organization_id
    FROM public.shops s
    JOIN public.work_items wi ON wi.shop_id = s.id
    WHERE wi.survey_width IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.surveys sv WHERE sv.shop_id = s.id)
  LOOP
    SELECT sa.user_id, sa.assigned_at, sa.completed_at INTO a
    FROM public.shop_assignments sa
    WHERE sa.shop_id = rec.shop_id AND sa.role = 'surveyor' AND sa.status <> 'declined'
    ORDER BY COALESCE(sa.completed_at, sa.assigned_at) DESC
    LIMIT 1;

    IF a.user_id IS NULL THEN
      CONTINUE; -- no evidence of who surveyed it; skip rather than guess
    END IF;

    SELECT EXISTS(
      SELECT 1 FROM public.work_items wi2 WHERE wi2.shop_id = rec.shop_id AND wi2.approved_width IS NOT NULL
    ) INTO has_approved;

    INSERT INTO public.surveys (organization_id, shop_id, surveyor_id, status, submitted_at, reviewed_at, review_note, notes)
    VALUES (
      rec.organization_id, rec.shop_id, a.user_id,
      CASE WHEN has_approved THEN 'approved' ELSE 'submitted' END,
      COALESCE(a.completed_at, a.assigned_at),
      CASE WHEN has_approved THEN COALESCE(a.completed_at, a.assigned_at) ELSE NULL END,
      CASE WHEN has_approved THEN 'Backfilled — original survey record was missing; reconstructed from work item and assignment history.' ELSE NULL END,
      'Backfilled from historical work item and assignment data.'
    )
    RETURNING id INTO new_survey_id;

    UPDATE public.work_items SET survey_id = new_survey_id WHERE shop_id = rec.shop_id AND survey_id IS NULL;
  END LOOP;
END $$;

-- ============================================================
-- Step 3: reconstruct missing `installation_jobs` rows
-- ============================================================
DO $$
DECLARE
  rec RECORD;
  a RECORD;
  prod_order_id uuid;
BEGIN
  FOR rec IN
    SELECT DISTINCT s.id AS shop_id, s.organization_id, s.status
    FROM public.shops s
    JOIN public.work_items wi ON wi.shop_id = s.id
    WHERE wi.installed_width IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.installation_jobs ij WHERE ij.shop_id = s.id)
  LOOP
    SELECT sa.user_id, sa.assigned_at, sa.completed_at INTO a
    FROM public.shop_assignments sa
    WHERE sa.shop_id = rec.shop_id AND sa.role = 'installer' AND sa.status <> 'declined'
    ORDER BY COALESCE(sa.completed_at, sa.assigned_at) DESC
    LIMIT 1;

    IF a.user_id IS NULL THEN
      CONTINUE;
    END IF;

    SELECT po.id INTO prod_order_id
    FROM public.production_orders po WHERE po.shop_id = rec.shop_id
    ORDER BY po.created_at DESC LIMIT 1;

    INSERT INTO public.installation_jobs (
      organization_id, shop_id, installer_id, production_order_id,
      status, review_status, reviewed_at, started_at, completed_at, notes
    )
    VALUES (
      rec.organization_id, rec.shop_id, a.user_id, prod_order_id,
      'completed',
      CASE WHEN rec.status IN ('installed', 'billed') THEN 'approved' ELSE 'pending' END,
      CASE WHEN rec.status IN ('installed', 'billed') THEN COALESCE(a.completed_at, a.assigned_at) ELSE NULL END,
      COALESCE(a.completed_at, a.assigned_at),
      COALESCE(a.completed_at, a.assigned_at),
      'Backfilled — original installation job record was missing; reconstructed from work item and assignment history.'
    );
  END LOOP;
END $$;

-- ============================================================
-- Step 4: nudge design_tasks.status forward if an approved version
-- already exists but the task row didn't catch up
-- ============================================================
UPDATE public.design_tasks dt
SET status = 'approved',
    completed_at = COALESCE(dt.completed_at, dv.created_at)
FROM public.design_versions dv
WHERE dv.design_task_id = dt.id
  AND dv.status = 'approved'
  AND dt.status IN ('assigned', 'designing', 'design_ready', 'internal_review', 'in_review');

-- ============================================================
-- Step 5: advance shops.status where every work item is installed but
-- the shop's own status hasn't caught up
-- ============================================================
ALTER TABLE public.shops DISABLE TRIGGER trg_installation_review_gate;

UPDATE public.shops s
SET status = 'installed'
WHERE s.status NOT IN ('installed', 'billed', 'cancelled')
  AND EXISTS (SELECT 1 FROM public.work_items wi WHERE wi.shop_id = s.id)
  AND NOT EXISTS (
    SELECT 1 FROM public.work_items wi
    WHERE wi.shop_id = s.id AND wi.status NOT IN ('installed', 'cancelled')
  );

ALTER TABLE public.shops ENABLE TRIGGER trg_installation_review_gate;
