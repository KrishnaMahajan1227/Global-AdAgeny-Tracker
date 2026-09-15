/*
# Fix: Installation completion skipped straight to "Installed" / billable
# with no Owner/Admin approval step — unlike Survey, Design and Production.

## What was wrong
Migration 0011 made three of the four pipeline stages require an explicit
Owner/Admin approval before moving on (Survey -> approved, Design -> approved,
Production -> completed). Installation was the odd one out: as soon as the
Installer tapped "Mark Installation Complete" (no exception), the app set
`shops.status = 'installed'` directly, and `BillingPage` treats any shop
with `status = 'installed'` as immediately billable. There was no
"Installation Review" queue at all, so the requested chain of

  Survey -> Approve -> Design -> Approve -> Production -> Approve ->
  Installation -> Approve -> Billing

was only 3/4 complete. This migration adds the missing gate.

## Design
- New shop status `installation_review`: the state a shop sits in between
  "installer says they're done" and "Owner/Admin confirmed it". Only this
  status can move to `installed`, and only an Owner/Admin/Demo can do it.
- `installation_jobs` gets its own review columns (`review_status`,
  `reviewed_by`, `reviewed_at`, `review_note`), mirroring how `surveys`
  already tracks its own review — so the Installation Review page has a
  real row per job to act on, not just a shop status flag.
- Rejecting/requesting redo sends the shop back to `installation_pending`
  (already an allowed status, already visible on the Installer's own
  Home/My Work list) and resets `review_status` to `pending` again once the
  installer resubmits — handled in application code (InstallerPage), not
  here, since the job row is reused for a redo rather than recreated.
- Exception installations (shop closed, material damaged, etc.) don't go
  through this review queue — they already send the shop back to
  `installation_pending` for the installer to retry, which is the correct
  outcome; there's nothing for Admin to "approve" yet.
*/

-- ============================================================
-- Part A: allow the new shop status
-- ============================================================
ALTER TABLE public.shops
  DROP CONSTRAINT IF EXISTS shops_status_check;
ALTER TABLE public.shops
  ADD CONSTRAINT shops_status_check
  CHECK (status IN (
    'pending','assigned','survey_started','surveyed','approval_pending',
    'approved','design_pending','designing','design_ready','in_review',
    'design_approved','production_pending','in_production','production_ready',
    'production_hold','production_done','dispatched','installation_pending',
    'installing','installation_review','installed','billed','cancelled'
  ));

-- ============================================================
-- Part B: review columns on installation_jobs
-- ============================================================
ALTER TABLE public.installation_jobs
  ADD COLUMN IF NOT EXISTS review_status text NOT NULL DEFAULT 'not_applicable'
    CHECK (review_status IN ('not_applicable','pending','approved','rejected'));
ALTER TABLE public.installation_jobs
  ADD COLUMN IF NOT EXISTS reviewed_by uuid REFERENCES public.profiles(id);
ALTER TABLE public.installation_jobs
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;
ALTER TABLE public.installation_jobs
  ADD COLUMN IF NOT EXISTS review_note text;

-- ============================================================
-- Part C: gate triggers — same pattern as 0011/0013
-- ============================================================

-- A shop can only reach 'installed' from 'installation_review', and only
-- an Owner/Admin/Demo can make that move (Approve in Installation Review).
CREATE OR REPLACE FUNCTION public.enforce_installation_review_gate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status = 'installed' THEN
    IF public.current_role() NOT IN ('agency_owner','admin','demo') THEN
      RAISE EXCEPTION 'Only the Agency Owner or Admin can approve an installation';
    END IF;
    IF OLD.status <> 'installation_review' THEN
      RAISE EXCEPTION 'Installation must go through review before it can be marked Installed (current status: %)', OLD.status;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_installation_review_gate ON public.shops;
CREATE TRIGGER trg_installation_review_gate
  BEFORE UPDATE ON public.shops
  FOR EACH ROW EXECUTE FUNCTION public.enforce_installation_review_gate();

-- An installation_jobs.review_status can only move to approved/rejected
-- from 'pending', and only by an Owner/Admin/Demo.
CREATE OR REPLACE FUNCTION public.enforce_installation_job_review_gate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.review_status IS DISTINCT FROM OLD.review_status AND NEW.review_status IN ('approved','rejected') THEN
    IF public.current_role() NOT IN ('agency_owner','admin','demo') THEN
      RAISE EXCEPTION 'Only the Agency Owner or Admin can review an installation';
    END IF;
    IF OLD.review_status <> 'pending' THEN
      RAISE EXCEPTION 'Only a pending installation review can be approved or rejected (current: %)', OLD.review_status;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_installation_job_review_gate ON public.installation_jobs;
CREATE TRIGGER trg_installation_job_review_gate
  BEFORE UPDATE ON public.installation_jobs
  FOR EACH ROW EXECUTE FUNCTION public.enforce_installation_job_review_gate();

-- ============================================================
-- Part D: realtime + nav/dashboard pending-count view
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'installation_jobs'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.installation_jobs;
  END IF;
END $$;

DROP VIEW IF EXISTS public.v_pipeline_pending_counts;

CREATE VIEW public.v_pipeline_pending_counts AS
SELECT
  o.id AS organization_id,
  o.name AS organization_name,
  (SELECT count(*) FROM public.surveys s WHERE s.organization_id = o.id AND s.status = 'submitted') AS surveys_awaiting_review,
  (SELECT count(*) FROM public.design_tasks d WHERE d.organization_id = o.id AND d.status = 'in_review') AS designs_awaiting_review,
  (SELECT count(*) FROM public.production_orders p WHERE p.organization_id = o.id AND p.status IN ('in_production','ready')) AS production_awaiting_completion,
  (SELECT count(*) FROM public.installation_jobs i WHERE i.organization_id = o.id AND i.review_status = 'pending') AS installations_awaiting_review,
  (SELECT count(*) FROM public.installation_jobs i WHERE i.organization_id = o.id AND i.status NOT IN ('completed','cancelled')) AS installations_in_progress
FROM public.organizations o
WHERE o.id = public.current_org_id();

GRANT SELECT ON public.v_pipeline_pending_counts TO authenticated;