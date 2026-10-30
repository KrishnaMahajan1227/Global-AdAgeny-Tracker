-- A finalized production stage must not silently regress, and completion must
-- use the atomic RPC (which validates work, role, next-stage handoff and audit).
-- This protects both old and new Work Orders. Read/display migration 0103 is
-- separate so it can be applied and reviewed independently.
-- No existing production rows are changed by this migration.

CREATE OR REPLACE FUNCTION public.protect_final_production_status()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_shop_status text;
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;

  -- Reopening an order after handoff would contradict the installed/delivered
  -- site and the recorded audit trail. An explicit audited correction workflow
  -- is required rather than a generic status dropdown.
  IF OLD.status = 'completed' THEN
    RAISE EXCEPTION 'Production is already completed and cannot be reopened via status update';
  END IF;

  -- The sole normal completion path is phase3_complete_production; that RPC
  -- sets this transaction-local flag before updating the row.
  IF NEW.status = 'completed' AND current_setting('app.phase3_handoff', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'Use the verified production completion action, not a direct status update';
  END IF;

  SELECT status INTO v_shop_status FROM public.shops WHERE id = NEW.shop_id;
  IF v_shop_status IN (
    'production_done', 'dispatched', 'delivered', 'installation_pending',
    'installing', 'installation_review', 'installed', 'billed'
  ) THEN
    RAISE EXCEPTION 'Site has already passed production; cannot change an earlier production status';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_production_final_status ON public.production_orders;
CREATE TRIGGER trg_production_final_status
BEFORE UPDATE OF status ON public.production_orders
FOR EACH ROW EXECUTE FUNCTION public.protect_final_production_status();
