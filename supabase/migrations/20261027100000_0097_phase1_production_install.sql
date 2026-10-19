-- Phase 1: additive Production & Installation workflow.
-- No historical PO/work-item/approval is rewritten. Existing types retain
-- their legacy stored values and existing completion/billing interpretation.
-- Apply only after the existing migrations, including 0077 and 0096.

ALTER TABLE public.purchase_orders
  DROP CONSTRAINT IF EXISTS purchase_orders_fulfillment_type_check;
ALTER TABLE public.purchase_orders
  ADD CONSTRAINT purchase_orders_fulfillment_type_check
  CHECK (fulfillment_type IN ('survey_install','production_install','supply_only','direct_install','custom'));

-- Presets applied on new lines: no repeat stage checkboxes required.
CREATE OR REPLACE FUNCTION public.apply_po_line_item_stage_preset()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_type text;
BEGIN
  SELECT fulfillment_type INTO v_type FROM public.purchase_orders WHERE id = NEW.purchase_order_id;
  IF v_type = 'production_install' THEN
    NEW.requires_survey := false;
    NEW.requires_design := true;
    NEW.requires_production := true;
    NEW.requires_installation := true;
  ELSIF v_type = 'supply_only'
     AND NEW.requires_survey IS TRUE AND NEW.requires_installation IS TRUE THEN
    NEW.requires_survey := false;
    NEW.requires_installation := false;
  ELSIF v_type = 'direct_install'
     AND NEW.requires_survey IS TRUE AND NEW.requires_design IS TRUE
     AND NEW.requires_production IS TRUE AND NEW.requires_installation IS TRUE THEN
    NEW.requires_survey := false;
    NEW.requires_design := false;
    NEW.requires_production := false;
  END IF;
  RETURN NEW;
END;
$$;
-- Preserve the existing BEFORE INSERT trigger installed by 0046/0077.

-- Workflow type is an execution contract: once sites are linked, changing it
-- would retroactively relabel approved work. Keep old workflows safe.
CREATE OR REPLACE FUNCTION public.guard_po_fulfillment_change()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.fulfillment_type IS DISTINCT FROM OLD.fulfillment_type THEN
    IF EXISTS (SELECT 1 FROM public.shops WHERE purchase_order_id = OLD.id)
      OR EXISTS (SELECT 1 FROM public.work_items wi
        JOIN public.po_line_items li ON li.id=wi.po_line_item_id
        WHERE li.purchase_order_id=OLD.id)
      OR EXISTS (SELECT 1 FROM public.invoice_items ii
        JOIN public.po_line_items li ON li.id=ii.po_line_item_id
        WHERE li.purchase_order_id=OLD.id) THEN
      RAISE EXCEPTION 'Fulfillment cannot be changed after sites or execution records are linked. Create a new Work Order for a different flow.';
    END IF;
    IF NEW.fulfillment_type = 'production_install' THEN
      UPDATE public.po_line_items SET requires_survey=false, requires_design=true,
        requires_production=true, requires_installation=true
        WHERE purchase_order_id=OLD.id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_guard_po_fulfillment_change ON public.purchase_orders;
CREATE TRIGGER trg_guard_po_fulfillment_change
  BEFORE UPDATE OF fulfillment_type ON public.purchase_orders
  FOR EACH ROW EXECUTE FUNCTION public.guard_po_fulfillment_change();

-- Idempotent initialization of the *new* no-survey preset only.
-- Creates scope placeholders but NEVER creates survey/approval/quantity proof.
-- Client-provided artwork can be uploaded/reviewed by Owner/Admin in the
-- existing Design Studio with no assigned designer.
CREATE OR REPLACE FUNCTION public.initialize_production_install_site(p_shop_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_shop public.shops%ROWTYPE;
        v_type text;
        v_line record;
BEGIN
  SELECT * INTO v_shop FROM public.shops WHERE id=p_shop_id FOR UPDATE;
  IF NOT FOUND OR v_shop.purchase_order_id IS NULL OR v_shop.status IN ('cancelled','rejected') THEN RETURN; END IF;
  SELECT fulfillment_type INTO v_type FROM public.purchase_orders
    WHERE id=v_shop.purchase_order_id AND organization_id=v_shop.organization_id AND client_id=v_shop.client_id;
  IF v_type IS DISTINCT FROM 'production_install' THEN RETURN; END IF;
  -- Never push an already progressing/approved job backwards.
  IF v_shop.status NOT IN ('pending','assigned','design_pending') THEN RETURN; END IF;

  FOR v_line IN SELECT id,work_type_id,description
    FROM public.po_line_items WHERE purchase_order_id=v_shop.purchase_order_id LOOP
    INSERT INTO public.work_items (organization_id,shop_id,po_line_item_id,work_type_id,work_type_name,status,
      survey_quantity,approved_quantity,approved_area)
    SELECT v_shop.organization_id,v_shop.id,v_line.id,v_line.work_type_id,v_line.description,'pending',NULL,NULL,NULL
    WHERE NOT EXISTS (SELECT 1 FROM public.work_items
      WHERE shop_id=v_shop.id AND po_line_item_id=v_line.id);
  END LOOP;

  INSERT INTO public.design_tasks (organization_id,shop_id,status,designer_id)
    SELECT v_shop.organization_id,v_shop.id,'assigned',NULL
    WHERE NOT EXISTS (SELECT 1 FROM public.design_tasks WHERE shop_id=v_shop.id);

  IF v_shop.status IN ('pending','assigned') THEN
    UPDATE public.shops SET status='design_pending' WHERE id=v_shop.id;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.initialize_production_install_site(uuid) FROM PUBLIC;
-- Called only by privileged row triggers. No exposed public RPC.

CREATE OR REPLACE FUNCTION public.trg_initialize_production_install_shop()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.initialize_production_install_site(NEW.id);
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_phase1_production_install_shop ON public.shops;
CREATE TRIGGER trg_phase1_production_install_shop
  AFTER INSERT OR UPDATE OF purchase_order_id ON public.shops
  FOR EACH ROW EXECUTE FUNCTION public.trg_initialize_production_install_shop();

-- PO lines are often added after PO and shops. Initialize their work items
-- automatically, without forcing the user to revisit individual shop forms.
CREATE OR REPLACE FUNCTION public.trg_initialize_production_install_line()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_shop record;
BEGIN
  FOR v_shop IN SELECT id FROM public.shops WHERE purchase_order_id=NEW.purchase_order_id LOOP
    PERFORM public.initialize_production_install_site(v_shop.id);
  END LOOP;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_phase1_production_install_line ON public.po_line_items;
CREATE TRIGGER trg_phase1_production_install_line
  AFTER INSERT ON public.po_line_items
  FOR EACH ROW EXECUTE FUNCTION public.trg_initialize_production_install_line();

-- Protect new no-survey orders from accidental survey assignments.
CREATE OR REPLACE FUNCTION public.guard_phase1_unneeded_survey_assignment()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.role = 'surveyor' AND EXISTS (
    SELECT 1 FROM public.shops s JOIN public.purchase_orders po
      ON po.id=s.purchase_order_id
    WHERE s.id=NEW.shop_id AND po.fulfillment_type='production_install'
  ) THEN
    RAISE EXCEPTION 'Survey is not required for Production & Installation. Use Design Review or assign an installer.';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_guard_phase1_survey_assignment ON public.shop_assignments;
CREATE TRIGGER trg_guard_phase1_survey_assignment
  BEFORE INSERT OR UPDATE OF role, shop_id ON public.shop_assignments
  FOR EACH ROW EXECUTE FUNCTION public.guard_phase1_unneeded_survey_assignment();

CREATE OR REPLACE FUNCTION public.guard_phase1_survey_stage()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.status IN ('survey_started','surveyed','approval_pending','approved')
    AND EXISTS (SELECT 1 FROM public.purchase_orders po
      WHERE po.id=NEW.purchase_order_id AND po.fulfillment_type='production_install') THEN
    RAISE EXCEPTION 'Survey stage does not apply to Production & Installation Work Orders.';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_guard_phase1_survey_stage ON public.shops;
CREATE TRIGGER trg_guard_phase1_survey_stage
  BEFORE INSERT OR UPDATE OF status, purchase_order_id ON public.shops
  FOR EACH ROW EXECUTE FUNCTION public.guard_phase1_survey_stage();
