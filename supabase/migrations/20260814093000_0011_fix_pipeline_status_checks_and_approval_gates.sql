/*
# Fix: survey/design/production never actually reach their approval queues
# + make approval mandatory at the database level, not just in the UI

## Root cause (same class of bug as 0006, found in two more places)

`0006` fixed one CHECK-constraint mismatch (survey_photos.photo_type). There
were two more, and they're the actual reason Design and Production approvals
were invisible:

1. `design_tasks.status` only allowed `'internal_review'`, but every part of
   the app (DesignerPage's "Send for Review" button, the "Approve Design"
   button's condition, everything) uses `'in_review'`. Every "Send for
   Review" click was therefore rejected by Postgres with a check-constraint
   violation. The task silently stayed on `design_ready` forever, so
   "Approve Design" (which only appears when `status = 'in_review'`) could
   never show up for the Owner/Admin — Design approval was structurally
   unreachable.

2. `work_items.status` didn't allow `'design_approved'` or `'production_done'`
   — both values the app writes as soon as a design is sent to production or
   a production order is completed. Both writes were rejected by Postgres.
   Because those two writes happen *after* the shop/production_orders rows
   are already updated (multiple sequential statements, not a transaction),
   the shop looked like it had moved forward while the underlying work item
   never did — and since the Production page's own item list filters on
   `work_items.status`, approved work quietly disappeared from Production.

Fix: widen both CHECK constraints to match what the app actually writes.

## Making "nothing moves without approval" a database guarantee

Every one of `surveys_update`, `design_tasks_update`, `production_orders_update`
and `installation_jobs_update`'s RLS policies only checks organization
membership — any authenticated user in the org can currently set any status
value on any of these rows via a direct API call, regardless of role or
current stage. The app's pages only *hide* the buttons that would do this;
nothing stops the transition itself. Add trigger-enforced guards so the
approval step and stage order are real constraints, not just UI affordances:

- A survey can only move to approved/rejected/correction_requested from
  'submitted', and only by an Agency Owner / Admin.
- A design task can only move to 'approved' from 'in_review', and to
  'ready_for_production' from 'approved' — both only by an Agency Owner / Admin.
- A production order can only move to 'completed' from 'in_production' or
  'ready', and only by an Agency Owner / Admin.
- An installation job can't be created at all unless the shop has actually
  finished production (status is production_done / production_ready /
  dispatched / installation_pending / installing).

'demo' is treated the same as 'agency_owner'/'admin' here since it's used
throughout the app (see DesignerPage's `canApprove`) as the read/write demo
role for the same screens.
*/

-- ============================================================
-- Part A: widen the two mismatched CHECK constraints
-- ============================================================
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
-- Part B: approval gate triggers
-- ============================================================

-- Surveys: only Owner/Admin/Demo can review, and only a submitted survey
-- can be reviewed.
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

-- Design tasks: approval + stage order enforced server-side.
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

-- Production orders: only Owner/Admin/Demo can mark completed, and only
-- from in_production or ready.
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

-- Installation jobs: can't be started until the shop has actually finished
-- production. This is the server-side backstop for the "Start Install"
-- button — closes the gap where the mobile "My Work" list let an installer
-- start a job on any assigned shop regardless of its real pipeline stage.
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
-- Part C: repair any shops/work_items already stuck from the bug above
-- ============================================================
-- Any design_task that made it to 'design_ready' with a design_versions
-- upload but never got an 'in_review'/'approved' companion — nothing to
-- auto-fix here safely (would require guessing intent), but this query is
-- left as a comment for the Owner to spot them manually if needed:
--   SELECT dt.*, s.name FROM design_tasks dt JOIN shops s ON s.id = dt.shop_id
--   WHERE dt.status = 'design_ready' AND EXISTS (SELECT 1 FROM design_versions dv WHERE dv.design_task_id = dt.id);
