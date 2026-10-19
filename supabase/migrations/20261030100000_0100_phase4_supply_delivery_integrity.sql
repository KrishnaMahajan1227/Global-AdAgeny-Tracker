-- Phase 4: atomic Production & Delivery dispatch and verified receipt.
-- Apply AFTER 0097, 0098, 0099. No historical Work Order is newly blocked.
-- Existing installation routes are unaffected; these functions operate ONLY on supply_only.

ALTER TABLE public.purchase_orders
  ADD COLUMN IF NOT EXISTS delivery_receipt_required boolean NOT NULL DEFAULT false;
ALTER TABLE public.routes
  ADD COLUMN IF NOT EXISTS phase4_request_id uuid;
CREATE UNIQUE INDEX IF NOT EXISTS idx_phase4_route_request
  ON public.routes(phase4_request_id) WHERE phase4_request_id IS NOT NULL;

-- Existing orders keep their previous dispatched=billable policy. Newly created
-- supply orders must have a confirmed receipt before becoming billable.
CREATE OR REPLACE FUNCTION public.phase4_set_supply_receipt_policy()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.fulfillment_type='supply_only' THEN NEW.delivery_receipt_required:=true; END IF;
  ELSIF OLD.delivery_receipt_required IS DISTINCT FROM NEW.delivery_receipt_required THEN
    RAISE EXCEPTION 'Delivery policy cannot be changed after Work Order creation';
  END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS trg_phase4_delivery_policy ON public.purchase_orders;
CREATE TRIGGER trg_phase4_delivery_policy BEFORE INSERT OR UPDATE OF delivery_receipt_required
  ON public.purchase_orders FOR EACH ROW EXECUTE FUNCTION public.phase4_set_supply_receipt_policy();

CREATE TABLE IF NOT EXISTS public.supply_delivery_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  route_stop_id uuid NOT NULL UNIQUE REFERENCES public.route_stops(id) ON DELETE RESTRICT,
  shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE RESTRICT,
  purchase_order_id uuid NOT NULL REFERENCES public.purchase_orders(id) ON DELETE RESTRICT,
  received_by text NOT NULL CHECK (length(btrim(received_by)) BETWEEN 2 AND 160),
  proof_reference text,
  notes text,
  confirmed_by uuid NOT NULL REFERENCES public.profiles(id),
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id)
);
CREATE INDEX IF NOT EXISTS idx_supply_receipts_org_po
  ON public.supply_delivery_receipts(organization_id,purchase_order_id);
ALTER TABLE public.supply_delivery_receipts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS supply_receipts_select ON public.supply_delivery_receipts;
CREATE POLICY supply_receipts_select ON public.supply_delivery_receipts FOR SELECT TO authenticated
  USING (organization_id=public.current_org_id() AND public.current_role() IN ('agency_owner','admin','accounts'));
-- Mutations only via role-checked SECURITY DEFINER RPC; no direct insert/update/delete.
REVOKE ALL ON public.supply_delivery_receipts FROM anon,authenticated;
GRANT SELECT ON public.supply_delivery_receipts TO authenticated;

-- Guard against bypass through a direct shops update; new supply receipts
-- must have been confirmed in the atomic RPC before a final status is set.
CREATE OR REPLACE FUNCTION public.phase4_guard_supply_final_status()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_required boolean;
BEGIN
  IF NEW.status IN ('delivered','installed','billed')
    AND OLD.status NOT IN ('delivered','installed','billed') THEN
    SELECT po.delivery_receipt_required INTO v_required FROM public.purchase_orders po
     WHERE po.id=NEW.purchase_order_id AND po.fulfillment_type='supply_only';
    IF COALESCE(v_required,false) AND COALESCE(current_setting('app.phase4_receipt',true),'')<>'on' THEN
      RAISE EXCEPTION 'Delivery receipt is required before finalizing this Production & Delivery site';
    END IF;
  END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS trg_phase4_supply_final_guard ON public.shops;
CREATE TRIGGER trg_phase4_supply_final_guard BEFORE UPDATE OF status ON public.shops
  FOR EACH ROW EXECUTE FUNCTION public.phase4_guard_supply_final_status();

-- One transaction for route + stops + shops + supply destinations + audit.
-- Stable request UUID makes a timeout/retry safe without duplicate dispatches.
CREATE OR REPLACE FUNCTION public.phase4_create_supply_dispatch(
  p_request_id uuid, p_shop_ids uuid[], p_name text, p_route_date date,
  p_driver_id uuid DEFAULT NULL, p_transport_mode text DEFAULT NULL,
  p_tracking_reference text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_org uuid:=public.current_org_id(); v_route public.routes%ROWTYPE;
  v_count integer; v_zone uuid; v_zones integer; v_mode text:=nullif(btrim(coalesce(p_transport_mode,'')),'');
BEGIN
  IF auth.uid() IS NULL OR public.current_role() NOT IN ('agency_owner','admin','accounts') THEN
    RAISE EXCEPTION 'Office dispatch permission required'; END IF;
  IF p_request_id IS NULL OR p_shop_ids IS NULL OR array_length(p_shop_ids,1) IS NULL
     OR array_length(p_shop_ids,1)>200 THEN RAISE EXCEPTION 'Select 1–200 shops and a valid request id'; END IF;
  IF p_route_date IS NULL THEN RAISE EXCEPTION 'Dispatch date is required'; END IF;
  IF (p_driver_id IS NULL)=(v_mode IS NULL) THEN
    RAISE EXCEPTION 'Choose one delivery method: staff or transport company'; END IF;
  IF p_driver_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.profiles WHERE id=p_driver_id AND organization_id=v_org AND is_active=true
       AND role IN ('installer','admin','agency_owner','client_manager','printing')
  ) THEN RAISE EXCEPTION 'Delivery staff must be active in your organization'; END IF;

  -- Lock the idempotency key even on first use, preventing simultaneous
  -- retries from creating two routes. UUID halves form an advisory lock key.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id::text,0));
  SELECT * INTO v_route FROM public.routes WHERE phase4_request_id=p_request_id;
  IF FOUND THEN
    IF v_route.organization_id<>v_org THEN RAISE EXCEPTION 'Request id belongs to another organization'; END IF;
    RETURN jsonb_build_object('outcome','already_dispatched','route_id',v_route.id);
  END IF;

  SELECT count(*),min(zone_id),count(DISTINCT zone_id) INTO v_count,v_zone,v_zones
    FROM public.shops WHERE id=ANY(p_shop_ids) AND organization_id=v_org;
  IF v_count<>coalesce(array_length(p_shop_ids,1),0) OR
     (SELECT count(DISTINCT id) FROM unnest(p_shop_ids) id)<>v_count THEN
    RAISE EXCEPTION 'Shop selection contains duplicates or another organization'; END IF;
  -- Deterministic lock order avoids races on overlapping bulk selections.
  PERFORM id FROM public.shops WHERE id=ANY(p_shop_ids) ORDER BY id FOR UPDATE;
  IF EXISTS (
    SELECT 1 FROM public.shops s LEFT JOIN public.purchase_orders po ON po.id=s.purchase_order_id
    WHERE s.id=ANY(p_shop_ids) AND (
      po.fulfillment_type IS DISTINCT FROM 'supply_only' OR po.organization_id<>v_org
      OR po.status='cancelled' OR po.assignment_status='rejected' OR s.status<>'production_done'
    )
  ) THEN RAISE EXCEPTION 'Some selected sites are not ready for supply dispatch. Refresh the queue'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.route_stops st JOIN public.routes r ON r.id=st.route_id
    WHERE st.shop_id=ANY(p_shop_ids) AND st.status<>'skipped' AND r.status<>'completed'
  ) THEN RAISE EXCEPTION 'One or more sites already have an active dispatch'; END IF;

  INSERT INTO public.routes(organization_id,user_id,name,route_date,status,zone_id,transport_mode,
      tracking_reference,phase4_request_id)
    VALUES (v_org,p_driver_id,coalesce(nullif(btrim(p_name),''),'Supply dispatch'),p_route_date,'planned',
      CASE WHEN v_zones<=1 THEN v_zone ELSE NULL END,v_mode,nullif(btrim(p_tracking_reference),''),p_request_id)
    RETURNING * INTO v_route;
  INSERT INTO public.route_stops(organization_id,route_id,shop_id,stop_order,status)
    SELECT v_org,v_route.id,id,row_number() OVER (ORDER BY id),'pending'
    FROM unnest(p_shop_ids) id;
  UPDATE public.shops SET status='dispatched' WHERE id=ANY(p_shop_ids);
  UPDATE public.supply_destinations SET status='dispatched',route_id=v_route.id
    WHERE shop_id=ANY(p_shop_ids) AND organization_id=v_org;
  INSERT INTO public.audit_logs(organization_id,user_id,table_name,record_id,action,field_name,new_value,description)
    VALUES(v_org,auth.uid(),'routes',v_route.id,'insert','dispatch',v_route.id::text,
      format('Atomic supply dispatch created for %s sites',v_count));
  RETURN jsonb_build_object('outcome','dispatched','route_id',v_route.id,'sites',v_count);
END; $$;
REVOKE ALL ON FUNCTION public.phase4_create_supply_dispatch(uuid,uuid[],text,date,uuid,text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.phase4_create_supply_dispatch(uuid,uuid[],text,date,uuid,text,text) TO authenticated;

-- Receipt is separately recorded per destination, with recipient and audit.
-- Idempotent; a duplicate retry can't create an extra receipt or notification.
CREATE OR REPLACE FUNCTION public.phase4_confirm_supply_receipt(
  p_route_stop_id uuid, p_received_by text, p_proof_reference text DEFAULT NULL, p_notes text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_org uuid:=public.current_org_id(); v_stop public.route_stops%ROWTYPE;
  v_shop public.shops%ROWTYPE; v_po public.purchase_orders%ROWTYPE; v_route public.routes%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR public.current_role() NOT IN ('agency_owner','admin') THEN
    RAISE EXCEPTION 'Only agency Owner/Admin can confirm received deliveries'; END IF;
  IF length(btrim(coalesce(p_received_by,''))) NOT BETWEEN 2 AND 160 THEN
    RAISE EXCEPTION 'Enter the recipient name (2–160 characters)'; END IF;
  SELECT * INTO v_stop FROM public.route_stops WHERE id=p_route_stop_id FOR UPDATE;
  IF NOT FOUND OR v_stop.organization_id<>v_org THEN RAISE EXCEPTION 'Dispatch stop not accessible'; END IF;
  SELECT * INTO v_route FROM public.routes WHERE id=v_stop.route_id FOR UPDATE;
  SELECT * INTO v_shop FROM public.shops WHERE id=v_stop.shop_id FOR UPDATE;
  IF v_shop.organization_id<>v_org OR v_route.organization_id<>v_org THEN RAISE EXCEPTION 'Dispatch organization mismatch'; END IF;
  SELECT * INTO v_po FROM public.purchase_orders WHERE id=v_shop.purchase_order_id;
  IF NOT FOUND OR v_po.organization_id<>v_org OR v_po.fulfillment_type<>'supply_only' THEN
    RAISE EXCEPTION 'This stop is not linked to a supply Work Order'; END IF;
  IF EXISTS (SELECT 1 FROM public.supply_delivery_receipts WHERE route_stop_id=p_route_stop_id) THEN
    RETURN jsonb_build_object('outcome','already_received','shop_id',v_shop.id);
  END IF;
  IF v_stop.status='skipped' OR v_shop.status<>'dispatched' THEN
    RAISE EXCEPTION 'Only an active dispatched destination can be confirmed received'; END IF;
  INSERT INTO public.supply_delivery_receipts(organization_id,route_stop_id,shop_id,purchase_order_id,
    received_by,proof_reference,notes,confirmed_by)
  VALUES(v_org,v_stop.id,v_shop.id,v_po.id,btrim(p_received_by),nullif(left(btrim(coalesce(p_proof_reference,'')),200),''),
    nullif(left(btrim(coalesce(p_notes,'')),500),''),auth.uid());
  UPDATE public.route_stops SET status='visited' WHERE id=v_stop.id;
  PERFORM set_config('app.phase4_receipt','on',true);
  UPDATE public.shops SET status='delivered' WHERE id=v_shop.id;
  UPDATE public.supply_destinations SET status='delivered' WHERE shop_id=v_shop.id AND organization_id=v_org;
  IF NOT EXISTS (SELECT 1 FROM public.route_stops WHERE route_id=v_stop.route_id AND status='pending') THEN
    UPDATE public.routes SET status='completed' WHERE id=v_stop.route_id;
  END IF;
  INSERT INTO public.audit_logs(organization_id,user_id,table_name,record_id,action,field_name,new_value,description)
    VALUES(v_org,auth.uid(),'supply_delivery_receipts',v_stop.id,'insert','received_by',btrim(p_received_by),
      'Supply receipt recorded for site '||v_shop.id::text);
  RETURN jsonb_build_object('outcome','received','shop_id',v_shop.id,'route_id',v_stop.route_id);
END; $$;
REVOKE ALL ON FUNCTION public.phase4_confirm_supply_receipt(uuid,text,text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.phase4_confirm_supply_receipt(uuid,text,text,text) TO authenticated;

-- Server-side invoice guard. Applies ONLY to newly created supply orders with
-- delivery_receipt_required=true. Historical invoices/POs are unchanged.
-- Validates linked PO, work item and site; prevents client-side filter bypass.
CREATE OR REPLACE FUNCTION public.phase4_guard_invoice_delivery()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_invoice_po uuid; v_item_po uuid; v_shop uuid; v_required boolean; v_status text;
BEGIN
  SELECT purchase_order_id INTO v_invoice_po FROM public.invoices WHERE id=NEW.invoice_id;
  IF NEW.po_line_item_id IS NOT NULL THEN
    SELECT purchase_order_id INTO v_item_po FROM public.po_line_items WHERE id=NEW.po_line_item_id;
  END IF;
  IF NEW.shop_id IS NOT NULL THEN
    v_shop:=NEW.shop_id;
  ELSIF NEW.work_item_id IS NOT NULL THEN
    SELECT shop_id INTO v_shop FROM public.work_items WHERE id=NEW.work_item_id;
  END IF;
  IF v_item_po IS NULL AND v_shop IS NOT NULL THEN
    SELECT purchase_order_id INTO v_item_po FROM public.shops WHERE id=v_shop;
  END IF;
  IF v_invoice_po IS NOT NULL AND v_item_po IS NOT NULL AND v_invoice_po<>v_item_po THEN
    RAISE EXCEPTION 'Invoice line belongs to a different Work Order'; END IF;
  SELECT delivery_receipt_required INTO v_required FROM public.purchase_orders
    WHERE id=coalesce(v_invoice_po,v_item_po) AND fulfillment_type='supply_only';
  IF COALESCE(v_required,false) THEN
    IF v_shop IS NULL THEN RAISE EXCEPTION 'Delivery-backed invoice requires a linked site/work item'; END IF;
    SELECT status INTO v_status FROM public.shops WHERE id=v_shop
      AND purchase_order_id=coalesce(v_invoice_po,v_item_po);
    IF v_status IS NULL OR v_status NOT IN ('delivered','billed') OR
       NOT EXISTS(SELECT 1 FROM public.supply_delivery_receipts r WHERE r.shop_id=v_shop) THEN
      RAISE EXCEPTION 'Delivery receipt required before this Work Order can be invoiced';
    END IF;
  END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS trg_phase4_guard_invoice_delivery ON public.invoice_items;
CREATE TRIGGER trg_phase4_guard_invoice_delivery BEFORE INSERT OR UPDATE OF
    invoice_id,shop_id,work_item_id,po_line_item_id ON public.invoice_items
  FOR EACH ROW EXECUTE FUNCTION public.phase4_guard_invoice_delivery();

-- Atomic Direct / On-site Execution setup: all 3 linked records + assignment
-- commit together, or nothing is saved. Retried request ID reuses the site.
-- Photos still upload afterwards using existing installation-proof workflow.
ALTER TABLE public.shops ADD COLUMN IF NOT EXISTS phase4_field_request_id uuid;
CREATE UNIQUE INDEX IF NOT EXISTS idx_phase4_field_request
  ON public.shops(phase4_field_request_id) WHERE phase4_field_request_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.phase4_create_direct_install_site(
  p_request_id uuid, p_po_id uuid, p_po_line_id uuid, p_site_name text,
  p_address text DEFAULT NULL, p_city text DEFAULT NULL, p_state text DEFAULT NULL,
  p_landmark text DEFAULT NULL, p_lat double precision DEFAULT NULL,
  p_lng double precision DEFAULT NULL, p_accuracy double precision DEFAULT NULL,
  p_width_ft numeric DEFAULT NULL, p_height_ft numeric DEFAULT NULL,
  p_entered_width numeric DEFAULT NULL, p_entered_height numeric DEFAULT NULL,
  p_entered_width_unit text DEFAULT NULL, p_entered_height_unit text DEFAULT NULL,
  p_quantity integer DEFAULT 1, p_notes text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_org uuid:=public.current_org_id(); v_po public.purchase_orders%ROWTYPE;
  v_line public.po_line_items%ROWTYPE; v_shop public.shops%ROWTYPE;
  v_job uuid; v_area numeric; v_area_based boolean;
BEGIN
  IF auth.uid() IS NULL OR public.current_role()<>'installer'
    OR NOT EXISTS(SELECT 1 FROM public.profiles WHERE id=auth.uid() AND organization_id=v_org AND is_active=true) THEN
    RAISE EXCEPTION 'Active assigned installer authorization required'; END IF;
  IF p_request_id IS NULL OR p_site_name IS NULL OR length(btrim(p_site_name)) NOT BETWEEN 2 AND 200 THEN
    RAISE EXCEPTION 'A valid request and site name are required'; END IF;
  IF p_quantity IS NULL OR p_quantity<1 OR p_quantity>10000 THEN
    RAISE EXCEPTION 'Quantity must be between 1 and 10000'; END IF;
  IF (p_lat IS NOT NULL AND (p_lat < -90 OR p_lat > 90)) OR
     (p_lng IS NOT NULL AND (p_lng < -180 OR p_lng > 180)) THEN
    RAISE EXCEPTION 'Invalid GPS coordinates'; END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id::text,0));
  SELECT * INTO v_shop FROM public.shops WHERE phase4_field_request_id=p_request_id;
  IF FOUND THEN
    IF v_shop.organization_id<>v_org OR v_shop.purchase_order_id<>p_po_id THEN
      RAISE EXCEPTION 'Request belongs to a different organization or Work Order'; END IF;
    SELECT id INTO v_job FROM public.installation_jobs WHERE shop_id=v_shop.id ORDER BY created_at DESC LIMIT 1;
    IF v_job IS NULL THEN RAISE EXCEPTION 'Incomplete historical field record needs reconciliation'; END IF;
    RETURN jsonb_build_object('outcome','already_created','shop_id',v_shop.id,'job_id',v_job,'shop_name',v_shop.name);
  END IF;

  SELECT * INTO v_po FROM public.purchase_orders WHERE id=p_po_id;
  IF NOT FOUND OR v_po.organization_id<>v_org OR v_po.fulfillment_type<>'direct_install'
    OR v_po.status<>'active' OR v_po.assignment_status='rejected' THEN
    RAISE EXCEPTION 'Selected On-site Execution Work Order is not active'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.po_assignments WHERE organization_id=v_org
    AND purchase_order_id=v_po.id AND user_id=auth.uid() AND role='installer') THEN
    RAISE EXCEPTION 'You are not assigned to this On-site Execution Work Order'; END IF;
  SELECT * INTO v_line FROM public.po_line_items WHERE id=p_po_line_id
     AND purchase_order_id=p_po_id AND organization_id=v_org;
  IF NOT FOUND THEN RAISE EXCEPTION 'Work item is not part of the selected Work Order'; END IF;
  v_area_based:=v_line.uom='sqft';
  IF v_area_based AND (p_width_ft IS NULL OR p_height_ft IS NULL OR p_width_ft<=0 OR p_height_ft<=0) THEN
    RAISE EXCEPTION 'Positive wall dimensions are required for sqft work'; END IF;
  v_area:=CASE WHEN v_area_based THEN round(p_width_ft*p_height_ft*p_quantity,4) ELSE NULL END;

  INSERT INTO public.shops(organization_id,client_id,project_id,purchase_order_id,name,address,city,state,
    latitude,longitude,status,extra_details,phase4_field_request_id)
  VALUES(v_org,v_po.client_id,v_po.project_id,v_po.id,btrim(p_site_name),nullif(btrim(coalesce(p_address,'')),''),
    nullif(btrim(coalesce(p_city,'')),''),nullif(btrim(coalesce(p_state,'')),''),p_lat,p_lng,
    'installation_review',CASE WHEN nullif(btrim(coalesce(p_landmark,'')),'') IS NULL THEN '{}'::jsonb
      ELSE jsonb_build_object('landmark',btrim(p_landmark)) END,p_request_id)
  RETURNING * INTO v_shop;
  INSERT INTO public.work_items(organization_id,shop_id,work_type_id,work_type_name,po_line_item_id,
    installed_width,installed_height,installed_unit,entered_width,entered_height,
    entered_width_unit,entered_height_unit,installed_quantity,installed_area,installed_notes,installed_at,status)
  VALUES(v_org,v_shop.id,v_line.work_type_id,v_line.description,v_line.id,
    CASE WHEN v_area_based THEN p_width_ft ELSE NULL END,
    CASE WHEN v_area_based THEN p_height_ft ELSE NULL END,
    CASE WHEN v_area_based THEN 'ft' ELSE NULL END,
    CASE WHEN v_area_based THEN p_entered_width ELSE NULL END,
    CASE WHEN v_area_based THEN p_entered_height ELSE NULL END,
    CASE WHEN v_area_based THEN p_entered_width_unit ELSE NULL END,
    CASE WHEN v_area_based THEN p_entered_height_unit ELSE NULL END,
    p_quantity,v_area,nullif(btrim(coalesce(p_notes,'')),''),now(),'installed');
  INSERT INTO public.installation_jobs(organization_id,shop_id,installer_id,status,review_status,
    material_check_confirmed,gps_lat,gps_lng,gps_accuracy,gps_captured_at,started_at,completed_at,notes)
  VALUES(v_org,v_shop.id,auth.uid(),'completed','pending',true,p_lat,p_lng,p_accuracy,
    CASE WHEN p_lat IS NOT NULL THEN now() ELSE NULL END,now(),now(),nullif(btrim(coalesce(p_notes,'')),''))
  RETURNING id INTO v_job;
  INSERT INTO public.shop_assignments(organization_id,shop_id,user_id,role,status,completed_at)
  VALUES(v_org,v_shop.id,auth.uid(),'installer','completed',now());
  INSERT INTO public.audit_logs(organization_id,user_id,table_name,record_id,action,field_name,description)
  VALUES(v_org,auth.uid(),'shops',v_shop.id,'insert','phase4_field_request_id',
    'Atomic On-site Execution draft created; photographs and review still required');
  RETURN jsonb_build_object('outcome','created','shop_id',v_shop.id,'job_id',v_job,'shop_name',v_shop.name);
END; $$;
REVOKE ALL ON FUNCTION public.phase4_create_direct_install_site(uuid,uuid,uuid,text,text,text,text,text,
  double precision,double precision,double precision,numeric,numeric,numeric,numeric,text,text,integer,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.phase4_create_direct_install_site(uuid,uuid,uuid,text,text,text,text,text,
  double precision,double precision,double precision,numeric,numeric,numeric,numeric,text,text,integer,text) TO authenticated;

-- Idempotent final submission after uploaded installation evidence exists.
-- Ensures retry does not send duplicate Owner/Admin notifications.
ALTER TABLE public.installation_jobs ADD COLUMN IF NOT EXISTS phase4_submitted_at timestamptz;
CREATE OR REPLACE FUNCTION public.phase4_submit_direct_install(p_job_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_org uuid:=public.current_org_id(); v_job public.installation_jobs%ROWTYPE;
  v_shop public.shops%ROWTYPE; v_po public.purchase_orders%ROWTYPE; v_actor text;
BEGIN
  IF auth.uid() IS NULL OR public.current_role()<>'installer' THEN
    RAISE EXCEPTION 'Installer authorization required'; END IF;
  SELECT * INTO v_job FROM public.installation_jobs WHERE id=p_job_id FOR UPDATE;
  IF NOT FOUND OR v_job.organization_id<>v_org OR v_job.installer_id<>auth.uid() THEN
    RAISE EXCEPTION 'Installation job not assigned to this user'; END IF;
  IF v_job.phase4_submitted_at IS NOT NULL THEN
    RETURN jsonb_build_object('outcome','already_submitted','job_id',v_job.id);
  END IF;
  SELECT * INTO v_shop FROM public.shops WHERE id=v_job.shop_id;
  SELECT * INTO v_po FROM public.purchase_orders WHERE id=v_shop.purchase_order_id;
  IF NOT FOUND OR v_po.organization_id<>v_org OR v_po.fulfillment_type<>'direct_install'
    OR v_shop.status NOT IN ('installation_review','installed') THEN
    RAISE EXCEPTION 'Not an active On-site Execution installation'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.installation_proofs WHERE installation_job_id=v_job.id) THEN
    RAISE EXCEPTION 'Upload at least one installation proof photo before submission'; END IF;
  UPDATE public.installation_jobs SET phase4_submitted_at=now() WHERE id=v_job.id;
  SELECT full_name INTO v_actor FROM public.profiles WHERE id=auth.uid();
  INSERT INTO public.notifications(organization_id,user_id,title,message,type,link)
  SELECT v_org,p.id,'On-site Execution ready for review',
    coalesce(v_actor,'Installer')||' submitted '||coalesce(v_shop.name,'a new site')||
    ' for '||coalesce(v_po.po_number,'a Work Order')||'. Review the installation evidence.',
    'installation','/installation-review'
  FROM public.profiles p WHERE p.organization_id=v_org AND p.is_active=true AND p.role IN ('agency_owner','admin');
  INSERT INTO public.audit_logs(organization_id,user_id,table_name,record_id,action,field_name,description)
  VALUES(v_org,auth.uid(),'installation_jobs',v_job.id,'update','phase4_submitted_at',
    'On-site Execution proof submitted for review; one-time notification');
  RETURN jsonb_build_object('outcome','submitted','job_id',v_job.id);
END; $$;
REVOKE ALL ON FUNCTION public.phase4_submit_direct_install(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.phase4_submit_direct_install(uuid) TO authenticated;
