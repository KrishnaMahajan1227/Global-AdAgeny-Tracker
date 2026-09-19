-- 0086 — Make shops.status the authoritative operational stage.
-- Owner/Admin manual stage changes must immediately reconcile the worker queues
-- instead of leaving stale redo/completed child state behind.

CREATE OR REPLACE FUNCTION public.sync_shop_stage_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  -- A manual/normal move back into survey work is a fresh survey round.
  IF NEW.status IN ('pending','assigned','survey_started') THEN
    UPDATE public.field_corrections
       SET status = 'cancelled', resolved_at = COALESCE(resolved_at, now())
     WHERE shop_id = NEW.id AND status IN ('open','resubmitted');

    UPDATE public.shop_assignments
       SET status = 'assigned', completed_at = NULL
     WHERE shop_id = NEW.id AND role = 'surveyor' AND status <> 'declined';

    UPDATE public.surveys
       SET status = 'draft', submitted_at = NULL, reviewed_at = NULL,
           reviewed_by = NULL, review_note = NULL, updated_at = now()
     WHERE id = (
       SELECT id FROM public.surveys WHERE shop_id = NEW.id
       ORDER BY created_at DESC LIMIT 1
     );
  END IF;

  -- Re-entering design means the existing designer gets a normal design task,
  -- not a stale rejected/approved state from the previous stage.
  IF NEW.status IN ('design_pending','designing') THEN
    UPDATE public.field_corrections
       SET status = 'cancelled', resolved_at = COALESCE(resolved_at, now())
     WHERE shop_id = NEW.id AND status IN ('open','resubmitted');

    UPDATE public.design_tasks
       SET status = CASE WHEN NEW.status = 'designing' THEN 'designing' ELSE 'assigned' END,
           completed_at = NULL, updated_at = now()
     WHERE id = (
       SELECT id FROM public.design_tasks WHERE shop_id = NEW.id
       ORDER BY created_at DESC LIMIT 1
     );
  END IF;

  -- Re-entering installation is a NEW normal installation round. Any previous
  -- granular redo request is superseded by the explicit stage override.
  IF NEW.status IN ('production_done','dispatched','installation_pending','installing') THEN
    UPDATE public.field_corrections
       SET status = 'cancelled', resolved_at = COALESCE(resolved_at, now())
     WHERE shop_id = NEW.id AND stage = 'installation' AND status IN ('open','resubmitted');

    UPDATE public.shop_assignments
       SET status = 'assigned', completed_at = NULL
     WHERE shop_id = NEW.id AND role = 'installer' AND status <> 'declined';

    UPDATE public.installation_jobs
       SET status = CASE WHEN NEW.status = 'installing' THEN 'started' ELSE 'assigned' END,
           review_status = 'not_applicable', reviewed_at = NULL, reviewed_by = NULL,
           completed_at = NULL, exception_reason = NULL, exception_note = NULL,
           updated_at = now()
     WHERE id = (
       SELECT id FROM public.installation_jobs WHERE shop_id = NEW.id
       ORDER BY created_at DESC LIMIT 1
     );
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_shop_stage_change ON public.shops;
CREATE TRIGGER trg_sync_shop_stage_change
AFTER UPDATE OF status ON public.shops
FOR EACH ROW
EXECUTE FUNCTION public.sync_shop_stage_change();
