-- Phase 3: atomic, idempotent Design -> Production and Production -> Field/Delivery handoffs.
-- Apply strictly AFTER 0097 (fulfillment presets) and 0098 (approval gates).
-- Existing review_apply remains authoritative for Survey -> Design and Installation review.
-- No historical rows are rewritten, no automatic invoice is created.

-- All writes, audit and the one notification belong to the SAME transaction.
-- A retry returns already_* without recreating orders or notification spam.
CREATE OR REPLACE FUNCTION public.phase3_send_to_production(p_design_task_id uuid, p_assignee_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_task public.design_tasks%ROWTYPE; v_shop public.shops%ROWTYPE;
  v_po public.purchase_orders%ROWTYPE; v_order public.production_orders%ROWTYPE;
  v_existing_count integer; v_requires_design boolean; v_has_artwork boolean; v_role text; v_new boolean:=false;
  v_assignee_changed boolean:=false; v_before text;
BEGIN
  v_role:=public.current_role();
  IF auth.uid() IS NULL OR v_role NOT IN ('agency_owner','admin') THEN
    RAISE EXCEPTION 'Owner/Admin authorization required for production handoff';
  END IF;
  IF p_assignee_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.profiles WHERE id=p_assignee_id
      AND organization_id=public.current_org_id() AND role='printing' AND is_active=true
  ) THEN RAISE EXCEPTION 'Choose an active production team member in your agency'; END IF;

  SELECT * INTO v_task FROM public.design_tasks WHERE id=p_design_task_id FOR UPDATE;
  IF NOT FOUND OR v_task.organization_id IS DISTINCT FROM public.current_org_id() THEN
    RAISE EXCEPTION 'Design task not found in your organization'; END IF;
  SELECT * INTO v_shop FROM public.shops WHERE id=v_task.shop_id FOR UPDATE;
  IF NOT FOUND OR v_shop.organization_id IS DISTINCT FROM v_task.organization_id OR v_shop.purchase_order_id IS NULL THEN
    RAISE EXCEPTION 'Design task must belong to an active linked Work Order'; END IF;
  SELECT * INTO v_po FROM public.purchase_orders WHERE id=v_shop.purchase_order_id;
  IF NOT FOUND OR v_po.organization_id IS DISTINCT FROM v_shop.organization_id
    OR v_po.status='cancelled' OR v_po.assignment_status='rejected' THEN
    RAISE EXCEPTION 'Work Order is not active or organization does not match'; END IF;
  IF v_shop.status IN ('cancelled','rejected','dispatched','installation_pending','installing','installation_review','installed','billed') THEN
    RAISE EXCEPTION 'Site has already passed production; it cannot be sent backward'; END IF;
  SELECT EXISTS(SELECT 1 FROM public.po_line_items WHERE purchase_order_id=v_po.id AND requires_design IS TRUE),
         (SELECT count(*)>0 FROM public.po_line_items WHERE purchase_order_id=v_po.id)
    INTO v_requires_design,v_new;
  IF NOT v_new THEN RAISE EXCEPTION 'Work Order has no configured line items'; END IF;
  -- Client artwork / design-not-required entries have a reviewable design task,
  -- but they do not require an approved agency-created version.
  SELECT EXISTS(SELECT 1 FROM public.design_versions WHERE design_task_id=v_task.id) INTO v_has_artwork;
  -- Company-supplied artwork is NOT a separate fulfillment type. If artwork
  -- exists, review it even when the PO line flags say no in-house design.
  IF (v_requires_design OR v_has_artwork) AND v_task.status NOT IN ('approved','ready_for_production') THEN
    RAISE EXCEPTION 'Approve the artwork and required company confirmation before production'; END IF;
  IF NOT v_requires_design AND NOT v_has_artwork AND v_task.status NOT IN ('approved','ready_for_production','assigned','design_ready') THEN
    RAISE EXCEPTION 'Design handoff cannot proceed from the current status'; END IF;
  IF COALESCE(v_po.company_approval_required,false) AND (v_requires_design OR v_has_artwork)
      AND NOT public.phase2_handoff_is_valid('design',v_task.id,v_shop.id) THEN
    RAISE EXCEPTION 'Company design approval missing or evidence changed; review again'; END IF;

  SELECT count(*) INTO v_existing_count FROM public.production_orders WHERE shop_id=v_shop.id;
  IF v_existing_count>1 THEN RAISE EXCEPTION 'Multiple production orders exist for this site. Reconcile before handoff'; END IF;
  SELECT * INTO v_order FROM public.production_orders WHERE shop_id=v_shop.id FOR UPDATE;
  IF FOUND AND v_order.status IN ('completed','in_production','ready','hold') THEN
    -- Existing production execution is authoritative. Never overwrite it.
    RETURN jsonb_build_object('outcome','already_in_progress','production_order_id',v_order.id,'shop_id',v_shop.id);
  END IF;

  IF NOT FOUND THEN
    INSERT INTO public.production_orders(organization_id,shop_id,design_task_id,status,assigned_to)
      VALUES(v_shop.organization_id,v_shop.id,v_task.id,'pending',p_assignee_id)
      RETURNING * INTO v_order;
    v_new:=true;
  ELSE
    v_assignee_changed:=v_order.assigned_to IS DISTINCT FROM p_assignee_id;
    IF v_assignee_changed THEN
      UPDATE public.production_orders SET assigned_to=p_assignee_id,design_task_id=v_task.id
        WHERE id=v_order.id;
    END IF;
    v_new:=false;
  END IF;
  PERFORM set_config('app.phase3_handoff','on',true);
  IF v_task.status IS DISTINCT FROM 'ready_for_production' THEN
    UPDATE public.design_tasks SET status='ready_for_production' WHERE id=v_task.id;
  END IF;
  IF v_shop.status IN ('design_pending','designing','design_ready','in_review','design_approved','pending','assigned') THEN
    UPDATE public.shops SET status='production_pending' WHERE id=v_shop.id;
  END IF;
  UPDATE public.work_items SET status='design_approved' WHERE shop_id=v_shop.id
    AND status IN ('pending','approved','designed','designing');

  IF v_new OR v_assignee_changed THEN
    INSERT INTO public.notifications(organization_id,user_id,title,message,type,link)
    VALUES(v_shop.organization_id,p_assignee_id,'Production work assigned',
      'Production is ready for '||COALESCE(v_shop.name,'this site')||'. Open your Production queue.',
      'production','/production');
  END IF;
  INSERT INTO public.audit_logs(organization_id,user_id,table_name,record_id,action,field_name,old_value,new_value,description)
  VALUES(v_shop.organization_id,auth.uid(),'design_tasks',v_task.id,'update','production_handoff',v_task.status,'ready_for_production',
    'Atomic design-to-production handoff, assigned production staff '||p_assignee_id::text);
  RETURN jsonb_build_object('outcome',CASE WHEN v_new THEN 'created' WHEN v_assignee_changed THEN 'reassigned' ELSE 'already_ready' END,
    'production_order_id',v_order.id,'shop_id',v_shop.id);
END; $$;
REVOKE ALL ON FUNCTION public.phase3_send_to_production(uuid,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.phase3_send_to_production(uuid,uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.phase3_complete_production(p_production_order_id uuid, p_installer_id uuid DEFAULT NULL,
  p_notes text DEFAULT NULL, p_force_complete boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_order public.production_orders%ROWTYPE; v_shop public.shops%ROWTYPE;
  v_po public.purchase_orders%ROWTYPE; v_role text; v_requires_install boolean;
  v_incomplete integer; v_active integer; v_notification boolean:=false; v_assigned boolean:=false;
BEGIN
  v_role:=public.current_role();
  IF auth.uid() IS NULL OR v_role NOT IN ('agency_owner','admin','printing') THEN
    RAISE EXCEPTION 'Only Owner/Admin or authorized production staff can finalize production'; END IF;
  SELECT * INTO v_order FROM public.production_orders WHERE id=p_production_order_id FOR UPDATE;
  IF NOT FOUND OR v_order.organization_id IS DISTINCT FROM public.current_org_id() THEN
    RAISE EXCEPTION 'Production order not found in your organization'; END IF;
  IF v_role='printing' AND v_order.assigned_to IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Production staff can complete only their assigned work'; END IF;
  SELECT * INTO v_shop FROM public.shops WHERE id=v_order.shop_id FOR UPDATE;
  IF NOT FOUND OR v_shop.organization_id IS DISTINCT FROM v_order.organization_id OR v_shop.purchase_order_id IS NULL THEN
    RAISE EXCEPTION 'Linked Work Order/site could not be verified'; END IF;
  SELECT * INTO v_po FROM public.purchase_orders WHERE id=v_shop.purchase_order_id;
  IF NOT FOUND OR v_po.organization_id IS DISTINCT FROM v_shop.organization_id
    OR v_po.status='cancelled' OR v_po.assignment_status='rejected' THEN
    RAISE EXCEPTION 'Work Order is cancelled or organization mismatch'; END IF;
  IF v_order.status='completed' THEN
    RETURN jsonb_build_object('outcome','already_completed','shop_id',v_shop.id,'next_stage',
      CASE WHEN v_po.fulfillment_type='supply_only' THEN 'dispatch' ELSE 'installation' END);
  END IF;
  IF v_shop.status IN ('cancelled','rejected','dispatched','installation_pending','installing','installation_review','installed','billed') THEN
    RAISE EXCEPTION 'Site is already past production; cannot rewind it'; END IF;

  v_requires_install := CASE
    WHEN v_po.fulfillment_type IN ('survey_install','production_install') THEN true
    WHEN v_po.fulfillment_type='supply_only' THEN false
    ELSE EXISTS (SELECT 1 FROM public.po_line_items WHERE purchase_order_id=v_po.id AND requires_installation IS TRUE) END;
  IF v_requires_install THEN
    IF p_installer_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.profiles
      WHERE id=p_installer_id AND organization_id=v_shop.organization_id AND role='installer' AND is_active=true) THEN
      RAISE EXCEPTION 'Assign an active installer from your agency'; END IF;
  END IF;
  -- Verify actual production records on the SERVER, not only the browser UI.
  -- The override stays Owner/Admin-only, with audit trail; normal users cannot force completion.
  SELECT count(*) INTO v_active FROM public.work_items w
    WHERE w.shop_id=v_shop.id AND COALESCE(w.excluded_from_calculations,false)=false;
  IF v_active=0 THEN RAISE EXCEPTION 'No active work items found. Check Work Order scope before completing production'; END IF;
  SELECT count(*) INTO v_incomplete FROM public.work_items w
  WHERE w.shop_id=v_shop.id AND COALESCE(w.excluded_from_calculations,false)=false
    AND w.status NOT IN ('production_done','installed')
    AND (
      NOT EXISTS(SELECT 1 FROM public.production_items pi WHERE pi.production_order_id=v_order.id AND pi.work_item_id=w.id
          AND pi.produced_qty IS NOT NULL AND pi.produced_qty>=COALESCE(w.approved_quantity,w.survey_quantity,1))
      OR EXISTS(SELECT 1 FROM public.work_item_components c WHERE c.work_item_id=w.id AND c.status IS DISTINCT FROM 'ready')
    );
  IF v_incomplete>0 AND (NOT p_force_complete OR v_role NOT IN ('agency_owner','admin')) THEN
    RAISE EXCEPTION '% work item(s) still lack verified production quantity/material. Owner override needed.',v_incomplete;
  END IF;

  PERFORM set_config('app.phase3_handoff','on',true);
  UPDATE public.production_orders SET status='completed', notes=NULLIF(trim(COALESCE(p_notes,'')),'') WHERE id=v_order.id;
  IF v_shop.status NOT IN ('production_done') THEN
    UPDATE public.shops SET status='production_done' WHERE id=v_shop.id;
  END IF;
  UPDATE public.work_items SET status='production_done' WHERE shop_id=v_shop.id
    AND status IN ('approved','design_approved','in_production','produced');
  IF v_po.fulfillment_type='supply_only' THEN
    UPDATE public.supply_destinations SET status='packed' WHERE shop_id=v_shop.id
      AND status IN ('pending','in_production');
  ELSIF NOT v_requires_install THEN
    -- Historical custom production-only remains compatible with existing billing stage rules.
    -- Phase 2 shop-level installation gate applies only to installation-required types.
    UPDATE public.shops SET status='installed' WHERE id=v_shop.id;
    UPDATE public.work_items SET status='installed' WHERE shop_id=v_shop.id AND status='production_done';
  ELSE
    SELECT EXISTS(SELECT 1 FROM public.shop_assignments WHERE shop_id=v_shop.id AND role='installer'
      AND user_id=p_installer_id AND status<>'declined') INTO v_assigned;
    IF NOT v_assigned THEN
      INSERT INTO public.shop_assignments(organization_id,shop_id,user_id,role,status)
      VALUES(v_shop.organization_id,v_shop.id,p_installer_id,'installer','assigned');
    END IF;
    -- Notify the selected installer on the first successful completion, even
    -- if they were already assigned before production started. A retry returns
    -- 'already_completed' above and sends nothing.
    v_notification:=true;
    IF v_notification THEN
      INSERT INTO public.notifications(organization_id,user_id,title,message,type,link)
      VALUES(v_shop.organization_id,p_installer_id,'Ready for installation',
        'Production completed at '||COALESCE(v_shop.name,'a site')||'. Open your installation tasks.',
        'installation','/mobile');
    END IF;
  END IF;
  INSERT INTO public.audit_logs(organization_id,user_id,table_name,record_id,action,field_name,old_value,new_value,description)
  VALUES(v_order.organization_id,auth.uid(),'production_orders',v_order.id,'update','status',v_order.status,'completed',
    'Atomic production completion; next stage '||CASE WHEN v_po.fulfillment_type='supply_only' THEN 'dispatch' WHEN v_requires_install THEN 'installation' ELSE 'complete' END||
    CASE WHEN p_force_complete AND v_incomplete>0 THEN ' (Owner override: '||v_incomplete||' incomplete items)' ELSE '' END);
  RETURN jsonb_build_object('outcome','completed','shop_id',v_shop.id,
    'next_stage',CASE WHEN v_po.fulfillment_type='supply_only' THEN 'dispatch' WHEN v_requires_install THEN 'installation' ELSE 'complete' END,
    'needs_review',v_incomplete);
END; $$;
REVOKE ALL ON FUNCTION public.phase3_complete_production(uuid,uuid,text,boolean) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.phase3_complete_production(uuid,uuid,text,boolean) TO authenticated;

-- Prevent bypass through ordinary table updates for NEW company-gated Work Orders.
-- Historical orders retain their previous behavior. Normal intermediate
-- production statuses still work through the existing Production screen.
CREATE OR REPLACE FUNCTION public.phase3_guard_direct_handoff()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_required boolean;
BEGIN
  IF current_setting('app.phase3_handoff',true)='on' THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME='design_tasks' AND NEW.status='ready_for_production'
      AND OLD.status IS DISTINCT FROM 'ready_for_production' THEN
    SELECT po.company_approval_required INTO v_required
    FROM public.shops s JOIN public.purchase_orders po ON po.id=s.purchase_order_id
    WHERE s.id=NEW.shop_id;
  ELSIF TG_TABLE_NAME='production_orders' AND NEW.status='completed'
      AND OLD.status IS DISTINCT FROM 'completed' THEN
    SELECT po.company_approval_required INTO v_required
    FROM public.shops s JOIN public.purchase_orders po ON po.id=s.purchase_order_id
    WHERE s.id=NEW.shop_id;
  ELSE RETURN NEW; END IF;
  IF COALESCE(v_required,false) THEN
    RAISE EXCEPTION 'Use the verified Phase 3 department handoff action to advance this Work Order';
  END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS trg_phase3_design_handoff ON public.design_tasks;
CREATE TRIGGER trg_phase3_design_handoff BEFORE UPDATE OF status ON public.design_tasks
FOR EACH ROW EXECUTE FUNCTION public.phase3_guard_direct_handoff();
DROP TRIGGER IF EXISTS trg_phase3_production_handoff ON public.production_orders;
CREATE TRIGGER trg_phase3_production_handoff BEFORE UPDATE OF status ON public.production_orders
FOR EACH ROW EXECUTE FUNCTION public.phase3_guard_direct_handoff();

-- True zero-extra-click handoff for a new PO when assignment is unambiguous:
-- internal/company design approval -> final shop design_approved -> Production.
-- More than one eligible production person: preserve Owner selection UI.
-- No auto handoff for historical orders or incomplete company approvals.
CREATE OR REPLACE FUNCTION public.phase3_auto_assign_single_printer()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_po public.purchase_orders%ROWTYPE; v_printer uuid; v_team_count int;
        v_design uuid; v_design_count int;
BEGIN
  IF OLD.status IS NOT DISTINCT FROM NEW.status OR NEW.status<>'design_approved'
    OR NEW.purchase_order_id IS NULL OR public.current_role() NOT IN ('agency_owner','admin') THEN
    RETURN NEW; END IF;
  SELECT * INTO v_po FROM public.purchase_orders WHERE id=NEW.purchase_order_id;
  IF NOT FOUND OR NOT COALESCE(v_po.company_approval_required,false)
    OR v_po.organization_id<>NEW.organization_id THEN RETURN NEW; END IF;
  SELECT count(*) INTO v_team_count FROM public.profiles
    WHERE organization_id=NEW.organization_id AND role='printing' AND is_active=true;
  IF v_team_count<>1 THEN RETURN NEW; END IF;
  SELECT id INTO v_printer FROM public.profiles
    WHERE organization_id=NEW.organization_id AND role='printing' AND is_active=true LIMIT 1;
  SELECT count(*) INTO v_design_count FROM public.design_tasks
    WHERE shop_id=NEW.id AND status='approved';
  IF v_design_count<>1 OR EXISTS (SELECT 1 FROM public.production_orders WHERE shop_id=NEW.id) THEN RETURN NEW; END IF;
  SELECT id INTO v_design FROM public.design_tasks
    WHERE shop_id=NEW.id AND status='approved' LIMIT 1;
  IF v_design IS NULL THEN
    RETURN NEW; END IF;
  -- The atomic RPC separately verifies company confirmation and all security rules.
  PERFORM public.phase3_send_to_production(v_design,v_printer);
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS trg_phase3_auto_assign_single_printer ON public.shops;
CREATE TRIGGER trg_phase3_auto_assign_single_printer AFTER UPDATE OF status ON public.shops
  FOR EACH ROW EXECUTE FUNCTION public.phase3_auto_assign_single_printer();
