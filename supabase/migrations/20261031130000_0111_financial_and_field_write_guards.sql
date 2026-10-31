-- Security release 0111: permissions enforced for direct table REST writes,
-- not merely hidden browser controls. Retains client-org draft PO creation.
-- EXISTING restrictive active-user RLS from 0105 remains in force.

-- Accounts and financial pricing are never writable by field staff, designer,
-- printing, demo or regular client-viewer via arbitrary REST requests.
DO $policy$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['invoices','invoice_items','rate_cards'] LOOP
  EXECUTE format('DROP POLICY IF EXISTS security_finance_insert ON public.%I',t);
  EXECUTE format('CREATE POLICY security_finance_insert ON public.%I AS RESTRICTIVE FOR INSERT TO authenticated WITH CHECK (organization_id=public.current_org_id() AND public.current_role() IN (''agency_owner'',''admin'',''accounts''))',t);
  EXECUTE format('DROP POLICY IF EXISTS security_finance_update ON public.%I',t);
  EXECUTE format('CREATE POLICY security_finance_update ON public.%I AS RESTRICTIVE FOR UPDATE TO authenticated USING (organization_id=public.current_org_id() AND public.current_role() IN (''agency_owner'',''admin'',''accounts'')) WITH CHECK (organization_id=public.current_org_id() AND public.current_role() IN (''agency_owner'',''admin'',''accounts''))',t);
  EXECUTE format('DROP POLICY IF EXISTS security_finance_delete ON public.%I',t);
  EXECUTE format('CREATE POLICY security_finance_delete ON public.%I AS RESTRICTIVE FOR DELETE TO authenticated USING (organization_id=public.current_org_id() AND public.current_role() IN (''agency_owner'',''admin'',''accounts''))',t);
 END LOOP;
END $policy$;

-- Agency PO editors can write only their own tenant. Linked client_admin
-- writes only a currently-active linked agency's pending draft work orders.
DROP POLICY IF EXISTS security_po_insert ON public.purchase_orders;
CREATE POLICY security_po_insert ON public.purchase_orders AS RESTRICTIVE FOR INSERT TO authenticated
 WITH CHECK (
  (organization_id=public.current_org_id() AND public.current_role() IN ('agency_owner','admin','accounts','client_manager'))
  OR (public.current_role()='client_admin' AND client_org_id=public.current_org_id()
   AND organization_id=assigned_agency_id AND origin='client_created'
   AND assignment_status='pending_acceptance'
   AND public.is_active_client_agency_link(client_org_id,organization_id))
 );
DROP POLICY IF EXISTS security_po_update ON public.purchase_orders;
CREATE POLICY security_po_update ON public.purchase_orders AS RESTRICTIVE FOR UPDATE TO authenticated
 USING (
  (organization_id=public.current_org_id() AND public.current_role() IN ('agency_owner','admin','accounts','client_manager'))
  OR (public.current_role()='client_admin' AND client_org_id=public.current_org_id()
      AND origin='client_created' AND assignment_status='pending_acceptance')
 )
 WITH CHECK (
  (organization_id=public.current_org_id() AND public.current_role() IN ('agency_owner','admin','accounts','client_manager'))
  OR (public.current_role()='client_admin' AND client_org_id=public.current_org_id()
   AND origin='client_created' AND assignment_status='pending_acceptance'
   AND organization_id=assigned_agency_id
   AND public.is_active_client_agency_link(client_org_id,organization_id))
 );
DROP POLICY IF EXISTS security_po_delete ON public.purchase_orders;
CREATE POLICY security_po_delete ON public.purchase_orders AS RESTRICTIVE FOR DELETE TO authenticated
 USING (
  (organization_id=public.current_org_id() AND public.current_role() IN ('agency_owner','admin'))
  OR (public.current_role()='client_admin' AND client_org_id=public.current_org_id()
      AND origin='client_created' AND assignment_status='pending_acceptance')
 );

DROP POLICY IF EXISTS security_poli_insert ON public.po_line_items;
CREATE POLICY security_poli_insert ON public.po_line_items AS RESTRICTIVE FOR INSERT TO authenticated
 WITH CHECK (
  (organization_id=public.current_org_id() AND public.current_role() IN ('agency_owner','admin','accounts','client_manager'))
  OR (public.current_role()='client_admin' AND EXISTS (
    SELECT 1 FROM public.purchase_orders po WHERE po.id=purchase_order_id
     AND po.organization_id=po_line_items.organization_id
     AND po.client_org_id=public.current_org_id()
     AND po.origin='client_created' AND po.assignment_status='pending_acceptance'
     AND public.is_active_client_agency_link(po.client_org_id,po.organization_id)))
 );
DROP POLICY IF EXISTS security_poli_update ON public.po_line_items;
CREATE POLICY security_poli_update ON public.po_line_items AS RESTRICTIVE FOR UPDATE TO authenticated
 USING (
  (organization_id=public.current_org_id() AND public.current_role() IN ('agency_owner','admin','accounts','client_manager'))
  OR (public.current_role()='client_admin' AND EXISTS (
    SELECT 1 FROM public.purchase_orders po WHERE po.id=purchase_order_id AND po.client_org_id=public.current_org_id()
     AND po.origin='client_created' AND po.assignment_status='pending_acceptance'))
 )
 WITH CHECK (
  (organization_id=public.current_org_id() AND public.current_role() IN ('agency_owner','admin','accounts','client_manager'))
  OR (public.current_role()='client_admin' AND EXISTS (
    SELECT 1 FROM public.purchase_orders po WHERE po.id=purchase_order_id
      AND po.organization_id=po_line_items.organization_id
      AND po.client_org_id=public.current_org_id() AND po.origin='client_created'
      AND po.assignment_status='pending_acceptance'))
 );
DROP POLICY IF EXISTS security_poli_delete ON public.po_line_items;
CREATE POLICY security_poli_delete ON public.po_line_items AS RESTRICTIVE FOR DELETE TO authenticated
 USING (
  (organization_id=public.current_org_id() AND public.current_role() IN ('agency_owner','admin','accounts','client_manager'))
  OR (public.current_role()='client_admin' AND EXISTS (
    SELECT 1 FROM public.purchase_orders po WHERE po.id=purchase_order_id
      AND po.client_org_id=public.current_org_id() AND po.origin='client_created'
      AND po.assignment_status='pending_acceptance'))
 );

-- Any worker location posted from a browser must belong to that user.
-- The owner can review location history, not forge a different person's location.
DROP POLICY IF EXISTS security_location_insert ON public.worker_locations;
CREATE POLICY security_location_insert ON public.worker_locations AS RESTRICTIVE FOR INSERT TO authenticated
 WITH CHECK (organization_id=public.current_org_id() AND user_id=auth.uid()
  AND public.current_role() IN ('surveyor','installer'));
DROP POLICY IF EXISTS security_location_update ON public.worker_locations;
CREATE POLICY security_location_update ON public.worker_locations AS RESTRICTIVE FOR UPDATE TO authenticated USING(false) WITH CHECK(false);
DROP POLICY IF EXISTS security_location_delete ON public.worker_locations;
CREATE POLICY security_location_delete ON public.worker_locations AS RESTRICTIVE FOR DELETE TO authenticated USING(false);

-- Route stops are worker-readable only when the route belongs to that worker;
-- workers may only change their own stop status, not redirect the stop to a
-- different shop/route by changing foreign keys in an UPDATE.
DROP POLICY IF EXISTS security_route_stop_read ON public.route_stops;
CREATE POLICY security_route_stop_read ON public.route_stops AS RESTRICTIVE FOR SELECT TO authenticated
 USING (public.current_role() NOT IN ('surveyor','installer') OR EXISTS(
  SELECT 1 FROM public.routes r WHERE r.id=route_stops.route_id AND r.user_id=auth.uid()
  AND r.organization_id=public.current_org_id()));
DROP POLICY IF EXISTS security_route_stop_insert ON public.route_stops;
CREATE POLICY security_route_stop_insert ON public.route_stops AS RESTRICTIVE FOR INSERT TO authenticated
 WITH CHECK (organization_id=public.current_org_id() AND public.current_role() IN ('agency_owner','admin'));
DROP POLICY IF EXISTS security_route_stop_update ON public.route_stops;
CREATE POLICY security_route_stop_update ON public.route_stops AS RESTRICTIVE FOR UPDATE TO authenticated
 USING (organization_id=public.current_org_id() AND (public.current_role() IN ('agency_owner','admin')
  OR (public.current_role() IN ('surveyor','installer') AND EXISTS (
   SELECT 1 FROM public.routes r WHERE r.id=route_stops.route_id AND r.user_id=auth.uid()))))
 WITH CHECK (organization_id=public.current_org_id() AND (public.current_role() IN ('agency_owner','admin')
  OR (public.current_role() IN ('surveyor','installer') AND EXISTS (
   SELECT 1 FROM public.routes r WHERE r.id=route_stops.route_id AND r.user_id=auth.uid()))));
CREATE OR REPLACE FUNCTION public.guard_worker_route_stop_identity()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_catalog AS $$
BEGIN
 IF auth.uid() IS NOT NULL AND public.current_role() IN ('surveyor','installer') AND
  (NEW.id IS DISTINCT FROM OLD.id OR NEW.route_id IS DISTINCT FROM OLD.route_id OR
   NEW.shop_id IS DISTINCT FROM OLD.shop_id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
   OR NEW.stop_order IS DISTINCT FROM OLD.stop_order) THEN
   RAISE EXCEPTION 'Route identity cannot be edited' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS trg_guard_worker_route_stop_identity ON public.route_stops;
CREATE TRIGGER trg_guard_worker_route_stop_identity BEFORE UPDATE ON public.route_stops FOR EACH ROW
 EXECUTE FUNCTION public.guard_worker_route_stop_identity();
REVOKE ALL ON FUNCTION public.guard_worker_route_stop_identity() FROM PUBLIC,anon,authenticated;

-- A field user can see only their own notifications, plus owner/admin notifications
-- needed to contact supervisors. Prevent reading other worker identity/contact PII.
DROP POLICY IF EXISTS security_profile_privacy ON public.profiles;
CREATE POLICY security_profile_privacy ON public.profiles AS RESTRICTIVE FOR SELECT TO authenticated
 USING (public.current_role() IN ('super_admin') OR id=auth.uid()
   OR (organization_id=public.current_org_id() AND
     (public.current_role() IN ('agency_owner','admin','client_manager','accounts','client_admin')
       OR role IN ('agency_owner','admin'))));

DROP POLICY IF EXISTS security_notify_read ON public.notifications;
CREATE POLICY security_notify_read ON public.notifications AS RESTRICTIVE FOR SELECT TO authenticated
 USING(user_id=auth.uid());
DROP POLICY IF EXISTS security_notify_update ON public.notifications;
CREATE POLICY security_notify_update ON public.notifications AS RESTRICTIVE FOR UPDATE TO authenticated
 USING(user_id=auth.uid()) WITH CHECK(user_id=auth.uid());
DROP POLICY IF EXISTS security_notify_delete ON public.notifications;
CREATE POLICY security_notify_delete ON public.notifications AS RESTRICTIVE FOR DELETE TO authenticated
 USING(user_id=auth.uid());
