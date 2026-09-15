/*
# Consolidated safety net: realtime + re-assert every prior pipeline fix

## Why this migration exists
Migrations 0006, 0007, 0008, 0009, 0011 each fixed a real bug (CHECK
constraint mismatches that silently rejected writes, missing approval-gate
triggers, etc — see their own header comments and CHANGES.md for the full
story). Every one of those fixes only takes effect once actually applied to
the *live* Supabase project, not just present in this repo. If any of them
were skipped, forgotten, or applied out of order on the live project, the
symptom is exactly "survey submits fine but never shows up for Admin/Owner
to approve" — because the write that flips `surveys.status` to `'submitted'`
(or a later stage's status) gets silently rejected by a stale constraint.

This migration is 100% idempotent (every statement uses IF NOT EXISTS /
DROP + recreate / ON CONFLICT-safe patterns) and safe to run any number of
times, in any order relative to the others. Run it in the Supabase SQL
Editor (or `supabase db push`) now, once, to guarantee the live database
matches what the app code expects — regardless of migration history.

## The actual new fix in this pass: Realtime was never turned on
None of the previous migrations ever added a single table to the
`supabase_realtime` publication. Supabase's Postgres Changes feature (used
by `useRealtimeInvalidate` and the new notification bell) only delivers
events for tables explicitly in that publication — without this, every
"live update" in the app was silently relying on nothing but its 15-20s
poll fallback (or, on pages that never had a poll fallback, only refreshing
on a full page reload). This is very likely why a submitted survey "didn't
show up" on the Admin/Owner dashboard even though the database write itself
was correct: the page just hadn't refetched yet.
*/

-- ============================================================
-- Part A: turn on Realtime for every table the app subscribes to
-- ============================================================
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'shops', 'surveys', 'survey_photos', 'board_markings', 'work_items',
    'shop_assignments', 'design_tasks', 'design_versions',
    'production_orders', 'production_items', 'installation_jobs',
    'installation_proofs', 'worker_locations', 'notifications',
    'audit_logs', 'invoices', 'invoice_items'
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
    END IF;
  END LOOP;
END $$;

-- ============================================================
-- Part B: re-assert the CHECK constraints from 0006 and 0011
-- (safe no-ops if already correct)
-- ============================================================
ALTER TABLE public.survey_photos
  DROP CONSTRAINT IF EXISTS survey_photos_photo_type_check;
ALTER TABLE public.survey_photos
  ADD CONSTRAINT survey_photos_photo_type_check
  CHECK (photo_type IN ('shop_front','interior','other','marked','survey'));

ALTER TABLE public.design_tasks
  DROP CONSTRAINT IF EXISTS design_tasks_status_check;
ALTER TABLE public.design_tasks
  ADD CONSTRAINT design_tasks_status_check
  CHECK (status IN ('assigned','designing','design_ready','internal_review','in_review','approved','ready_for_production','rejected'));

ALTER TABLE public.work_items
  DROP CONSTRAINT IF EXISTS work_items_status_check;
ALTER TABLE public.work_items
  ADD CONSTRAINT work_items_status_check
  CHECK (status IN ('pending','surveyed','approved','designing','designed','design_approved','in_production','produced','production_done','installed','cancelled'));

-- ============================================================
-- Part C: re-assert the approval-gate triggers from 0011
-- (CREATE OR REPLACE FUNCTION + DROP/CREATE TRIGGER — always safe to rerun)
-- ============================================================
CREATE OR REPLACE FUNCTION public.enforce_survey_review_gate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('approved','rejected','correction_requested') THEN
    IF public.current_role() NOT IN ('agency_owner','admin','demo') THEN
      RAISE EXCEPTION 'Only the Agency Owner or Admin can review a survey';
    END IF;
    IF OLD.status <> 'submitted' THEN
      RAISE EXCEPTION 'Only a submitted survey can be reviewed (current status: %)', OLD.status;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_survey_review_gate ON public.surveys;
CREATE TRIGGER trg_survey_review_gate
  BEFORE UPDATE ON public.surveys
  FOR EACH ROW EXECUTE FUNCTION public.enforce_survey_review_gate();

CREATE OR REPLACE FUNCTION public.enforce_design_task_gate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status IN ('approved','ready_for_production') THEN
      IF public.current_role() NOT IN ('agency_owner','admin','demo') THEN
        RAISE EXCEPTION 'Only the Agency Owner or Admin can approve a design or send it to production';
      END IF;
      IF NEW.status = 'approved' AND OLD.status NOT IN ('in_review','internal_review') THEN
        RAISE EXCEPTION 'A design can only be approved from In Review (current status: %)', OLD.status;
      END IF;
      IF NEW.status = 'ready_for_production' AND OLD.status <> 'approved' THEN
        RAISE EXCEPTION 'A design must be Approved before it can move to production (current status: %)', OLD.status;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_design_task_gate ON public.design_tasks;
CREATE TRIGGER trg_design_task_gate
  BEFORE UPDATE ON public.design_tasks
  FOR EACH ROW EXECUTE FUNCTION public.enforce_design_task_gate();

CREATE OR REPLACE FUNCTION public.enforce_production_order_gate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status = 'completed' THEN
    IF public.current_role() NOT IN ('agency_owner','admin','demo') THEN
      RAISE EXCEPTION 'Only the Agency Owner or Admin can mark production as completed';
    END IF;
    IF OLD.status NOT IN ('in_production','ready') THEN
      RAISE EXCEPTION 'Production must be In Production or Ready before it can be completed (current status: %)', OLD.status;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_production_order_gate ON public.production_orders;
CREATE TRIGGER trg_production_order_gate
  BEFORE UPDATE ON public.production_orders
  FOR EACH ROW EXECUTE FUNCTION public.enforce_production_order_gate();

CREATE OR REPLACE FUNCTION public.enforce_installation_start_gate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_shop_status text;
BEGIN
  SELECT status INTO v_shop_status FROM public.shops WHERE id = NEW.shop_id;
  IF v_shop_status IS NULL OR v_shop_status NOT IN ('production_done','production_ready','dispatched','installation_pending','installing','installed') THEN
    RAISE EXCEPTION 'Installation cannot start until production is completed for this shop (current shop status: %)', COALESCE(v_shop_status, 'unknown');
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_installation_start_gate ON public.installation_jobs;
CREATE TRIGGER trg_installation_start_gate
  BEFORE INSERT ON public.installation_jobs
  FOR EACH ROW EXECUTE FUNCTION public.enforce_installation_start_gate();

-- ============================================================
-- Part D: diagnostic view — quick one-query health check for Admin/Owner
-- to see exactly what's sitting where in the pipeline right now, useful
-- for confirming this migration worked and nothing is stuck.
-- ============================================================
-- IMPORTANT (multi-tenant safety): this view is scoped to
-- `public.current_org_id()` in its own WHERE clause rather than left as an
-- unfiltered join across `organizations`, because a plain view does NOT
-- automatically inherit the underlying tables' RLS policies unless the
-- querying role would independently be blocked — and `organizations` has
-- no per-row org filter of its own (see 0001c). Scoping it here means it
-- always returns at most one row: the caller's own organization.
CREATE OR REPLACE VIEW public.v_pipeline_pending_counts AS
SELECT
  o.id AS organization_id,
  o.name AS organization_name,
  (SELECT count(*) FROM public.surveys s WHERE s.organization_id = o.id AND s.status = 'submitted') AS surveys_awaiting_review,
  (SELECT count(*) FROM public.design_tasks d WHERE d.organization_id = o.id AND d.status = 'in_review') AS designs_awaiting_review,
  (SELECT count(*) FROM public.production_orders p WHERE p.organization_id = o.id AND p.status IN ('in_production','ready')) AS production_awaiting_completion,
  (SELECT count(*) FROM public.installation_jobs i WHERE i.organization_id = o.id AND i.status NOT IN ('completed','cancelled')) AS installations_in_progress
FROM public.organizations o
WHERE o.id = public.current_org_id();

GRANT SELECT ON public.v_pipeline_pending_counts TO authenticated;
