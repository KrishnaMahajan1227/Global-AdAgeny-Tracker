-- Billing correctness release. New invoice creation and edits are one atomic
-- database transaction, serialized for a PO. Existing invoices are NOT changed.
-- Source-only until migrated/tested against staging; take DB backup first.

CREATE OR REPLACE FUNCTION public.billing_save_invoice(p_header jsonb, p_items jsonb, p_existing_invoice uuid DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE
  v_actor record; v_po public.purchase_orders%ROWTYPE; v_invoice public.invoices%ROWTYPE;
  v_item jsonb; v_work public.work_items%ROWTYPE; v_shop public.shops%ROWTYPE;
  v_line public.po_line_items%ROWTYPE; v_org uuid; v_client uuid; v_po_id uuid;
  v_item_id uuid; v_shop_id uuid; v_line_id uuid; v_units numeric;
  v_rate numeric; v_amount numeric; v_subtotal numeric := 0; v_prior numeric;
  v_cap numeric; v_qty numeric; v_area numeric; v_basis text; v_stage text;
  v_tax_rate numeric; v_cgst numeric; v_sgst numeric; v_igst numeric;
  v_tax numeric; v_total numeric; v_new_id uuid; v_inv_number text;
  v_seen uuid[] := ARRAY[]::uuid[]; v_count integer := 0;
BEGIN
  SELECT organization_id,role,is_active INTO v_actor FROM public.profiles WHERE id=auth.uid();
  IF v_actor.organization_id IS NULL OR v_actor.is_active IS DISTINCT FROM true OR
     v_actor.role NOT IN ('agency_owner','admin','accounts') THEN
    RAISE EXCEPTION 'Not authorized to post invoices' USING ERRCODE='42501';
  END IF;
  v_org:=v_actor.organization_id;
  v_client:=NULLIF(p_header->>'client_id','')::uuid;
  v_po_id:=NULLIF(p_header->>'purchase_order_id','')::uuid;
  IF p_header IS NULL OR p_items IS NULL OR jsonb_typeof(p_items) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Invoice header and item array are required';
  END IF;
  IF v_client IS NULL OR v_po_id IS NULL OR jsonb_array_length(p_items) NOT BETWEEN 1 AND 250 THEN
    RAISE EXCEPTION 'A Work Order and 1-250 invoice items are required';
  END IF;
  -- Lock serializes both browser requests AND concurrent devices submitting
  -- invoices for the same PO. Second request will see first one's allocations.
  PERFORM pg_advisory_xact_lock(hashtextextended(v_org::text||':'||v_po_id::text, 14219));
  SELECT * INTO v_po FROM public.purchase_orders
   WHERE id=v_po_id AND organization_id=v_org AND client_id=v_client FOR UPDATE;
  IF NOT FOUND OR v_po.status='cancelled' THEN
    RAISE EXCEPTION 'Work Order not found, cancelled or belongs to another client';
  END IF;
  IF NULLIF(p_header->>'project_id','')::uuid IS DISTINCT FROM v_po.project_id THEN
    RAISE EXCEPTION 'Invoice project must match the Work Order project';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.clients c WHERE c.id=v_client AND c.organization_id=v_org) THEN
    RAISE EXCEPTION 'Client not found in your agency';
  END IF;
  IF p_existing_invoice IS NOT NULL THEN
    SELECT * INTO v_invoice FROM public.invoices
      WHERE id=p_existing_invoice AND organization_id=v_org FOR UPDATE;
    IF NOT FOUND OR v_invoice.payment_status <> 'unpaid' THEN
      RAISE EXCEPTION 'Only unpaid invoices may be edited; use a credit note/reconciliation for payments';
    END IF;
    IF v_invoice.client_id IS DISTINCT FROM v_client OR
       v_invoice.purchase_order_id IS DISTINCT FROM v_po_id THEN
      RAISE EXCEPTION 'Editing cannot move an invoice to a different Work Order/client';
    END IF;
  END IF;
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items) AS elems(value) LOOP
    v_count:=v_count+1;
    v_item_id:=NULLIF(v_item->>'work_item_id','')::uuid;
    v_shop_id:=NULLIF(v_item->>'shop_id','')::uuid;
    v_line_id:=NULLIF(v_item->>'po_line_item_id','')::uuid;
    IF v_item_id IS NULL OR v_shop_id IS NULL OR v_line_id IS NULL OR v_item_id=ANY(v_seen) THEN
      RAISE EXCEPTION 'Each item requires a unique linked shop, PO line and work item';
    END IF;
    v_seen:=array_append(v_seen,v_item_id);
    SELECT * INTO v_shop FROM public.shops WHERE id=v_shop_id AND organization_id=v_org AND client_id=v_client FOR UPDATE;
    IF NOT FOUND OR (v_shop.purchase_order_id IS NOT NULL AND v_shop.purchase_order_id<>v_po_id) THEN
      RAISE EXCEPTION 'Shop does not belong to this client/Work Order';
    END IF;
    SELECT * INTO v_line FROM public.po_line_items WHERE id=v_line_id AND organization_id=v_org
      AND purchase_order_id=v_po_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'PO line/rate missing or from a different order'; END IF;
    SELECT * INTO v_work FROM public.work_items WHERE id=v_item_id AND organization_id=v_org
      AND shop_id=v_shop_id AND (po_line_item_id=v_line_id OR po_line_item_id IS NULL) FOR UPDATE;
    IF NOT FOUND OR v_work.excluded_from_calculations IS TRUE THEN
      RAISE EXCEPTION 'Work item is missing, excluded or linked to a different site/PO line';
    END IF;
    -- Legacy work items with no PO-line link must be assigned unambiguously.
    -- A request may not relabel their rate by providing a different PO line.
    IF v_work.po_line_item_id IS NULL AND (
        v_shop.purchase_order_id IS DISTINCT FROM v_po_id OR
        (v_line.work_type_id IS NOT NULL AND v_line.work_type_id IS DISTINCT FROM v_work.work_type_id) OR
        (SELECT count(*) FROM public.po_line_items pl
          WHERE pl.purchase_order_id=v_po_id AND pl.organization_id=v_org AND
            (pl.work_type_id IS NOT DISTINCT FROM v_work.work_type_id)) <> 1
      ) THEN
      RAISE EXCEPTION 'Legacy item needs an unambiguous PO-line allocation before billing';
    END IF;
    IF v_shop.status IN ('cancelled','rejected','pending','assigned','installation_pending','installation_review','installing','redo') THEN
      RAISE EXCEPTION 'Shop has not reached a final billable stage';
    END IF;
    -- Match the canonical front-end final stage: supplied pieces, installed
    -- pieces, or the last required custom stage. Never use a planned PO budget
    -- as evidence of produced/installed quantity.
    IF v_po.fulfillment_type='supply_only' THEN
      IF v_shop.status NOT IN (CASE WHEN v_po.delivery_receipt_required THEN 'delivered' ELSE 'dispatched' END,'delivered','billed') THEN
        RAISE EXCEPTION 'Delivery/dispatch not complete for this shop';
      END IF;
      v_stage:='produced';
    ELSIF v_po.fulfillment_type='custom' AND v_line.requires_installation IS FALSE THEN
      IF v_line.requires_production IS DISTINCT FROM FALSE THEN v_stage:='produced';
      ELSIF v_line.requires_design IS DISTINCT FROM FALSE THEN v_stage:='approved';
      ELSE v_stage:='surveyed'; END IF;
      IF v_stage='produced' AND v_shop.status NOT IN ('production_done','dispatched','delivered','installed','billed') THEN
        RAISE EXCEPTION 'Production is not complete'; END IF;
      IF v_stage='approved' AND v_shop.status NOT IN ('design_approved','production_pending','production_done','dispatched','delivered','installed','billed') THEN
        RAISE EXCEPTION 'Design approval is not complete'; END IF;
      IF v_stage='surveyed' AND v_shop.status NOT IN ('approved','design_pending','design_approved','production_pending','production_done','dispatched','delivered','installed','billed') THEN
        RAISE EXCEPTION 'Survey approval is not complete'; END IF;
    ELSE
      v_stage:='installed';
      IF v_shop.status NOT IN ('installed','billed') OR v_work.status IN ('installation_review','installation_pending','installing','redo') THEN
        RAISE EXCEPTION 'Installation review is not complete'; END IF;
    END IF;
    IF v_po.fulfillment_type='supply_only' AND v_po.delivery_receipt_required IS TRUE AND
      NOT EXISTS(SELECT 1 FROM public.supply_delivery_receipts WHERE shop_id=v_shop_id) THEN
      RAISE EXCEPTION 'Supply receipt required before invoicing';
    END IF;
    v_basis:=CASE WHEN lower(trim(coalesce(v_line.uom,''))) IN
      ('sqft','sq.ft','sq ft','ft2','ft²','square feet','square foot','sq. ft.','sq feet')
      THEN 'area' ELSE 'quantity' END;
    v_qty:=NULLIF(v_item->>'quantity','')::numeric;
    v_area:=NULLIF(v_item->>'area','')::numeric;
    v_units:=CASE WHEN v_basis='area' THEN v_area ELSE v_qty END;
    v_rate:=v_line.rate;
    IF v_units IS NULL OR v_units<=0 OR v_units>100000000 OR v_rate IS NULL OR v_rate<=0 OR
       abs(v_rate-coalesce(NULLIF(v_item->>'rate','')::numeric,0))>0.0001 THEN
      RAISE EXCEPTION 'Invalid units or rate; the approved PO rate is authoritative';
    END IF;
    v_cap:=CASE v_stage
      WHEN 'produced' THEN CASE WHEN v_basis='area' THEN
           CASE WHEN coalesce(v_work.approved_quantity,0)>0 THEN
             coalesce(v_work.approved_area,0)*coalesce(v_work.produced_quantity,0)/v_work.approved_quantity ELSE 0 END
           ELSE coalesce(v_work.produced_quantity,0) END
      WHEN 'approved' THEN CASE WHEN v_basis='area' THEN coalesce(v_work.approved_area,0) ELSE coalesce(v_work.approved_quantity,0) END
      WHEN 'surveyed' THEN CASE WHEN v_basis='area' THEN coalesce(v_work.survey_area,0) ELSE coalesce(v_work.survey_quantity,0) END
      ELSE CASE WHEN v_basis='area' THEN coalesce(nullif(v_work.installed_area,0),CASE WHEN v_work.status='installed' THEN v_work.approved_area ELSE 0 END,0)
           ELSE coalesce(nullif(v_work.installed_quantity,0),CASE WHEN v_work.status='installed' THEN v_work.approved_quantity ELSE 0 END,0) END
      END;
    SELECT COALESCE(sum(CASE WHEN v_basis='area' THEN ii.area ELSE ii.quantity END),0)
      INTO v_prior FROM public.invoice_items ii
      WHERE ii.organization_id=v_org AND ii.work_item_id=v_item_id AND
        (p_existing_invoice IS NULL OR ii.invoice_id<>p_existing_invoice);
    IF EXISTS(SELECT 1 FROM public.invoice_items ii WHERE ii.organization_id=v_org
      AND (ii.shop_id=v_shop_id OR ii.po_line_item_id=v_line_id)
      AND ii.work_item_id IS NULL AND (p_existing_invoice IS NULL OR ii.invoice_id<>p_existing_invoice)) THEN
      RAISE EXCEPTION 'Legacy unallocated invoice exists; reconcile before billing';
    END IF;
    IF v_units + v_prior > v_cap + 0.0001 THEN
      RAISE EXCEPTION 'Invoice exceeds completed, unbilled Work Order quantity';
    END IF;
    v_amount:=round(v_units*v_rate,2);
    IF abs(v_amount-coalesce(NULLIF(v_item->>'amount','')::numeric,0))>0.01 THEN
      RAISE EXCEPTION 'Amount does not match measured units multiplied by PO rate';
    END IF;
    v_subtotal:=v_subtotal+v_amount;
  END LOOP;
  v_subtotal:=round(v_subtotal,2);
  v_cgst:=COALESCE(NULLIF(p_header->>'cgst_rate','')::numeric,0);
  v_sgst:=COALESCE(NULLIF(p_header->>'sgst_rate','')::numeric,0);
  v_igst:=COALESCE(NULLIF(p_header->>'igst_rate','')::numeric,0);
  IF LEAST(v_cgst,v_sgst,v_igst)<0 OR GREATEST(v_cgst,v_sgst,v_igst)>100 OR
    (v_igst>0 AND (v_cgst>0 OR v_sgst>0)) THEN
    RAISE EXCEPTION 'Invalid GST split';
  END IF;
  v_tax_rate:=v_cgst+v_sgst+v_igst;
  IF v_tax_rate>100 THEN RAISE EXCEPTION 'GST rate exceeds 100 percent'; END IF;
  v_tax:=round(v_subtotal*v_cgst/100,2)+round(v_subtotal*v_sgst/100,2)+round(v_subtotal*v_igst/100,2);
  v_total:=round(v_subtotal+v_tax,2);
  -- Client supplied tax totals are NOT authoritative: recompute them here.
  IF abs(v_subtotal-coalesce(NULLIF(p_header->>'subtotal','')::numeric,0))>0.01 OR
     abs(v_total-coalesce(NULLIF(p_header->>'total','')::numeric,0))>0.02 THEN
    RAISE EXCEPTION 'Totals changed; review invoice before posting';
  END IF;
  IF p_existing_invoice IS NULL THEN
    v_inv_number:='INV-'||to_char(clock_timestamp(),'YYYYMMDD')||'-'||upper(left(replace(gen_random_uuid()::text,'-',''),10));
    INSERT INTO public.invoices (organization_id,client_id,project_id,purchase_order_id,invoice_number,
      invoice_date,due_date,subtotal,tax_rate,tax_amount,cgst_rate,cgst_amount,sgst_rate,sgst_amount,
      igst_rate,igst_amount,total,payment_status,notes,terms,bill_to_name,bill_to_address,bill_to_city,bill_to_state,bill_to_gst)
    VALUES (v_org,v_client,NULLIF(p_header->>'project_id','')::uuid,v_po_id,v_inv_number,
      (p_header->>'invoice_date')::date,NULLIF(p_header->>'due_date','')::date,v_subtotal,v_tax_rate,v_tax,
      v_cgst,round(v_subtotal*v_cgst/100,2),v_sgst,round(v_subtotal*v_sgst/100,2),
      v_igst,round(v_subtotal*v_igst/100,2),v_total,'unpaid',p_header->>'notes',p_header->>'terms',
      p_header->>'bill_to_name',p_header->>'bill_to_address',p_header->>'bill_to_city',
      p_header->>'bill_to_state',p_header->>'bill_to_gst') RETURNING id INTO v_new_id;
  ELSE
    v_new_id:=p_existing_invoice;
    UPDATE public.invoices SET invoice_date=(p_header->>'invoice_date')::date,
      due_date=NULLIF(p_header->>'due_date','')::date,
      subtotal=v_subtotal,tax_rate=v_tax_rate,tax_amount=v_tax,
      cgst_rate=v_cgst,cgst_amount=round(v_subtotal*v_cgst/100,2),
      sgst_rate=v_sgst,sgst_amount=round(v_subtotal*v_sgst/100,2),
      igst_rate=v_igst,igst_amount=round(v_subtotal*v_igst/100,2),total=v_total,
      notes=p_header->>'notes',terms=p_header->>'terms',
      bill_to_name=p_header->>'bill_to_name',bill_to_address=p_header->>'bill_to_address',
      bill_to_city=p_header->>'bill_to_city',bill_to_state=p_header->>'bill_to_state',
      bill_to_gst=p_header->>'bill_to_gst' WHERE id=v_new_id AND organization_id=v_org;
    DELETE FROM public.invoice_items WHERE invoice_id=v_new_id AND organization_id=v_org;
  END IF;
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items) AS elems(value) LOOP
    v_item_id:=(v_item->>'work_item_id')::uuid;
    v_shop_id:=(v_item->>'shop_id')::uuid;
    v_line_id:=(v_item->>'po_line_item_id')::uuid;
    SELECT rate,uom INTO v_rate,v_basis FROM public.po_line_items WHERE id=v_line_id;
    v_units:=CASE WHEN lower(trim(coalesce(v_basis,''))) IN
      ('sqft','sq.ft','sq ft','ft2','ft²','square feet','square foot','sq. ft.','sq feet')
      THEN NULLIF(v_item->>'area','')::numeric ELSE NULLIF(v_item->>'quantity','')::numeric END;
    INSERT INTO public.invoice_items (organization_id,invoice_id,description,quantity,area,rate,amount,
       po_line_item_id,shop_id,work_item_id,hsn_code,notes)
    VALUES(v_org,v_new_id,left(btrim(v_item->>'description'),1000),NULLIF(v_item->>'quantity','')::numeric,
      NULLIF(v_item->>'area','')::numeric,v_rate,round(v_units*v_rate,2),v_line_id,v_shop_id,v_item_id,
      v_item->>'hsn_code',v_item->>'notes');
  END LOOP;
  INSERT INTO public.audit_logs(organization_id,user_id,table_name,record_id,action,description)
    VALUES(v_org,auth.uid(),'invoices',v_new_id,
      CASE WHEN p_existing_invoice IS NULL THEN 'insert' ELSE 'update' END,
      CASE WHEN p_existing_invoice IS NULL THEN 'Atomic invoice created' ELSE 'Atomic unpaid invoice revised' END);
  RETURN v_new_id;
END;
$fn$;
REVOKE ALL ON FUNCTION public.billing_save_invoice(jsonb,jsonb,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.billing_save_invoice(jsonb,jsonb,uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.billing_set_payment_status(p_invoice_id uuid,p_status text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE v_actor record; v_old text;
BEGIN
  SELECT organization_id,role,is_active INTO v_actor FROM public.profiles WHERE id=auth.uid();
  IF v_actor.organization_id IS NULL OR v_actor.is_active IS DISTINCT FROM true OR
    v_actor.role NOT IN ('agency_owner','admin','accounts') OR
    p_status NOT IN ('unpaid','partial','paid','overdue') THEN
    RAISE EXCEPTION 'Not authorized to change invoice payment status' USING ERRCODE='42501';
  END IF;
  SELECT payment_status INTO v_old FROM public.invoices WHERE id=p_invoice_id
    AND organization_id=v_actor.organization_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found'; END IF;
  IF v_old=p_status THEN RETURN true; END IF;
  IF v_old='paid' OR (v_old='partial' AND p_status IN ('unpaid','overdue')) THEN
    RAISE EXCEPTION 'Recorded payments cannot be reversed by changing an invoice status; reconcile first';
  END IF;
  UPDATE public.invoices SET payment_status=p_status WHERE id=p_invoice_id;
  INSERT INTO public.audit_logs(organization_id,user_id,table_name,record_id,action,field_name,old_value,new_value,description)
    VALUES(v_actor.organization_id,auth.uid(),'invoices',p_invoice_id,'update','payment_status',v_old,p_status,
    'Invoice payment status changed');
  RETURN true;
END;
$fn$;
REVOKE ALL ON FUNCTION public.billing_set_payment_status(uuid,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.billing_set_payment_status(uuid,text) TO authenticated;

-- Mutations by authenticated clients must use the two audited RPCs above or
-- the existing privileged archive RPC. Finance SELECT permissions unchanged.
DROP POLICY IF EXISTS billing_atomic_invoice_insert ON public.invoices;
CREATE POLICY billing_atomic_invoice_insert ON public.invoices AS RESTRICTIVE FOR INSERT TO authenticated WITH CHECK(false);
DROP POLICY IF EXISTS billing_atomic_invoice_update ON public.invoices;
CREATE POLICY billing_atomic_invoice_update ON public.invoices AS RESTRICTIVE FOR UPDATE TO authenticated USING(false) WITH CHECK(false);
DROP POLICY IF EXISTS billing_atomic_invoice_delete ON public.invoices;
CREATE POLICY billing_atomic_invoice_delete ON public.invoices AS RESTRICTIVE FOR DELETE TO authenticated USING(false);
DROP POLICY IF EXISTS billing_atomic_item_insert ON public.invoice_items;
CREATE POLICY billing_atomic_item_insert ON public.invoice_items AS RESTRICTIVE FOR INSERT TO authenticated WITH CHECK(false);
DROP POLICY IF EXISTS billing_atomic_item_update ON public.invoice_items;
CREATE POLICY billing_atomic_item_update ON public.invoice_items AS RESTRICTIVE FOR UPDATE TO authenticated USING(false) WITH CHECK(false);
DROP POLICY IF EXISTS billing_atomic_item_delete ON public.invoice_items;
CREATE POLICY billing_atomic_item_delete ON public.invoice_items AS RESTRICTIVE FOR DELETE TO authenticated USING(false);
