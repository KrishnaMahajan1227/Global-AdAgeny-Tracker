-- Security release 0112: enforce foreign-reference ownership and notification
-- permissions on the server; this cannot be bypassed by editing URL/JSON.
CREATE OR REPLACE FUNCTION public.guard_po_business_identity()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_catalog AS $$
DECLARE v_role text;
BEGIN
 IF auth.uid() IS NULL THEN RETURN NEW; END IF;
 v_role:=public.current_role();
 IF v_role IS NULL THEN RAISE EXCEPTION 'Inactive user' USING ERRCODE='42501'; END IF;
 IF TG_OP='UPDATE' AND (
    NEW.id IS DISTINCT FROM OLD.id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.client_org_id IS DISTINCT FROM OLD.client_org_id
    OR NEW.client_id IS DISTINCT FROM OLD.client_id
    OR NEW.origin IS DISTINCT FROM OLD.origin
    OR NEW.assigned_agency_id IS DISTINCT FROM OLD.assigned_agency_id) THEN
   RAISE EXCEPTION 'Purchase-order tenant/client identity cannot change' USING ERRCODE='42501';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM public.clients c
   WHERE c.id=NEW.client_id AND c.organization_id=NEW.organization_id) THEN
   RAISE EXCEPTION 'Purchase-order customer belongs to another agency' USING ERRCODE='42501';
 END IF;
 IF NEW.project_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.projects pr WHERE pr.id=NEW.project_id
     AND pr.organization_id=NEW.organization_id AND pr.client_id=NEW.client_id) THEN
   RAISE EXCEPTION 'Project does not belong to the customer' USING ERRCODE='42501';
 END IF;
 IF v_role='client_admin' AND NOT EXISTS (
   SELECT 1 FROM public.client_agency_links l WHERE l.client_org_id=public.current_org_id()
     AND l.agency_org_id=NEW.organization_id AND l.agency_client_id=NEW.client_id AND l.status='active') THEN
   RAISE EXCEPTION 'Client cannot create or edit another customer work order' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS trg_guard_po_business_identity ON public.purchase_orders;
CREATE TRIGGER trg_guard_po_business_identity BEFORE INSERT OR UPDATE ON public.purchase_orders
 FOR EACH ROW EXECUTE FUNCTION public.guard_po_business_identity();
REVOKE ALL ON FUNCTION public.guard_po_business_identity() FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.guard_shop_business_identity()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_catalog AS $$
BEGIN
 IF auth.uid() IS NULL THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND (NEW.id IS DISTINCT FROM OLD.id
  OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
  OR NEW.client_id IS DISTINCT FROM OLD.client_id) THEN
   RAISE EXCEPTION 'Shop customer/tenant identity cannot change' USING ERRCODE='42501';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM public.clients c WHERE c.id=NEW.client_id AND c.organization_id=NEW.organization_id) THEN
   RAISE EXCEPTION 'Shop customer not within agency' USING ERRCODE='42501';
 END IF;
 IF NEW.project_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM public.projects p WHERE p.id=NEW.project_id
    AND p.organization_id=NEW.organization_id AND p.client_id=NEW.client_id) THEN
  RAISE EXCEPTION 'Shop project not within agency/customer' USING ERRCODE='42501';
 END IF;
 IF NEW.purchase_order_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM public.purchase_orders p WHERE p.id=NEW.purchase_order_id
    AND p.organization_id=NEW.organization_id AND p.client_id=NEW.client_id) THEN
  RAISE EXCEPTION 'Shop work order not within agency/customer' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS trg_guard_shop_business_identity ON public.shops;
CREATE TRIGGER trg_guard_shop_business_identity BEFORE INSERT OR UPDATE ON public.shops
 FOR EACH ROW EXECUTE FUNCTION public.guard_shop_business_identity();
REVOKE ALL ON FUNCTION public.guard_shop_business_identity() FROM PUBLIC,anon,authenticated;

-- A signed-in user cannot direct API POST arbitrary notifications to a
-- different organization. Supervisors may notify workers in their tenant;
-- field staff can notify their own supervisors only.
DROP POLICY IF EXISTS security_notify_insert ON public.notifications;
CREATE POLICY security_notify_insert ON public.notifications AS RESTRICTIVE FOR INSERT TO authenticated
 WITH CHECK ((organization_id=public.current_org_id() AND EXISTS (
    SELECT 1 FROM public.profiles p WHERE p.id=user_id AND p.organization_id=public.current_org_id()
      AND p.is_active=true AND (public.current_role() IN ('agency_owner','admin','client_admin')
        OR p.role IN ('agency_owner','admin')))));

-- Public shop share links were intentionally REMOVED by migration 0066.
-- Do not recreate the obsolete table or apply policies to a missing relation.
-- The former anonymous share RPC was also dropped by migration 0066.
