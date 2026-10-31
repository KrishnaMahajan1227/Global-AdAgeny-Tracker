-- Harden references that were independently writable via direct REST requests.
-- Never trust a UI navigation guard as authorization.

-- A client must never invent an active agency link by editing a link's IDs/status.
CREATE OR REPLACE FUNCTION public.guard_client_agency_link()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_catalog AS $$
DECLARE v_org uuid; v_role text;
BEGIN
 IF auth.uid() IS NULL THEN RETURN NEW; END IF;
 v_org:=public.current_org_id(); v_role:=public.current_role();
 IF v_role IS NULL THEN RAISE EXCEPTION 'Inactive account' USING ERRCODE='42501'; END IF;
 IF TG_OP='INSERT' THEN
   IF v_role='client_admin' AND NEW.status='active' THEN
      RAISE EXCEPTION 'Agency approval required to activate a link' USING ERRCODE='42501';
   END IF;
 ELSE
   IF NEW.client_org_id IS DISTINCT FROM OLD.client_org_id
      OR NEW.agency_org_id IS DISTINCT FROM OLD.agency_org_id
      OR NEW.invited_by IS DISTINCT FROM OLD.invited_by THEN
       RAISE EXCEPTION 'Linked organization identities are immutable' USING ERRCODE='42501';
   END IF;
   IF NEW.agency_client_id IS DISTINCT FROM OLD.agency_client_id AND NOT (v_org=OLD.agency_org_id AND v_role IN ('agency_owner','admin')) THEN
     RAISE EXCEPTION 'Agency identity mapping can only be set by its agency' USING ERRCODE='42501';
   END IF;
   IF v_org=OLD.client_org_id AND v_role='client_admin'
     AND NEW.status IN ('active','invited') AND OLD.status IS DISTINCT FROM NEW.status THEN
     RAISE EXCEPTION 'Only the agency can activate a pending link' USING ERRCODE='42501';
   END IF;
 END IF;
 RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_guard_client_agency_link ON public.client_agency_links;
CREATE TRIGGER trg_guard_client_agency_link BEFORE INSERT OR UPDATE ON public.client_agency_links
 FOR EACH ROW EXECUTE FUNCTION public.guard_client_agency_link();
REVOKE ALL ON FUNCTION public.guard_client_agency_link() FROM PUBLIC,anon,authenticated;

-- Client portal billing reads may reference only currently-active agency/client links.
DROP POLICY IF EXISTS clients_select_client_org ON public.clients;
CREATE POLICY clients_select_client_org ON public.clients FOR SELECT TO authenticated USING (
 public.current_role() IN ('client_admin','client_viewer') AND
 EXISTS(SELECT 1 FROM public.client_agency_links l
  WHERE l.client_org_id=public.current_org_id() AND l.agency_client_id=clients.id AND l.status='active')
);

-- On self-service updates, the assignment identity cannot be swapped for a
-- different shop/worker using an authorized row's ID.
CREATE OR REPLACE FUNCTION public.guard_shop_assignment_identity()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_catalog AS $$
BEGIN
 IF auth.uid() IS NULL THEN RETURN NEW; END IF;
 IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.shop_id IS DISTINCT FROM OLD.shop_id OR NEW.user_id IS DISTINCT FROM OLD.user_id
    OR NEW.role IS DISTINCT FROM OLD.role OR NEW.assigned_at IS DISTINCT FROM OLD.assigned_at THEN
      RAISE EXCEPTION 'Assignments cannot be repointed to another worker/site' USING ERRCODE='42501';
 END IF;
 IF public.current_role() NOT IN ('agency_owner','admin') AND OLD.user_id<>auth.uid() THEN
   RAISE EXCEPTION 'Not your assigned work' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_guard_shop_assignment_identity ON public.shop_assignments;
CREATE TRIGGER trg_guard_shop_assignment_identity BEFORE UPDATE ON public.shop_assignments
 FOR EACH ROW EXECUTE FUNCTION public.guard_shop_assignment_identity();
REVOKE ALL ON FUNCTION public.guard_shop_assignment_identity() FROM PUBLIC,anon,authenticated;
DROP POLICY IF EXISTS shop_assign_insert ON public.shop_assignments;
CREATE POLICY shop_assign_insert ON public.shop_assignments FOR INSERT TO authenticated
 WITH CHECK (organization_id=public.current_org_id() AND public.current_role() IN ('agency_owner','admin'));
DROP POLICY IF EXISTS shop_assign_update ON public.shop_assignments;
CREATE POLICY shop_assign_update ON public.shop_assignments FOR UPDATE TO authenticated
 USING (organization_id=public.current_org_id() AND
  (public.current_role() IN ('agency_owner','admin') OR user_id=auth.uid()))
 WITH CHECK (organization_id=public.current_org_id() AND
  (public.current_role() IN ('agency_owner','admin') OR user_id=auth.uid()));

-- A survey/proof write must target one's assigned shop; any other UUID in
-- the address is rejected even when it belongs to the same organization.
DROP POLICY IF EXISTS security_survey_insert ON public.surveys;
CREATE POLICY security_survey_insert ON public.surveys AS RESTRICTIVE FOR INSERT TO authenticated
 WITH CHECK (organization_id=public.current_org_id() AND
  (public.current_role() IN ('agency_owner','admin') OR
   (public.current_role()='surveyor' AND surveyor_id=auth.uid() AND public.can_access_field_shop(shop_id))));
DROP POLICY IF EXISTS security_survey_update ON public.surveys;
CREATE POLICY security_survey_update ON public.surveys AS RESTRICTIVE FOR UPDATE TO authenticated
 USING (organization_id=public.current_org_id() AND
  (public.current_role() IN ('agency_owner','admin') OR
   (public.current_role()='surveyor' AND surveyor_id=auth.uid() AND public.can_access_field_shop(shop_id))))
 WITH CHECK (organization_id=public.current_org_id() AND
  (public.current_role() IN ('agency_owner','admin') OR
   (public.current_role()='surveyor' AND surveyor_id=auth.uid() AND public.can_access_field_shop(shop_id))));
DROP POLICY IF EXISTS security_survey_photos_insert ON public.survey_photos;
CREATE POLICY security_survey_photos_insert ON public.survey_photos AS RESTRICTIVE FOR INSERT TO authenticated
 WITH CHECK (organization_id=public.current_org_id() AND
  (public.current_role() IN ('agency_owner','admin') OR
   (public.current_role()='surveyor' AND public.can_access_field_shop(shop_id))));
DROP POLICY IF EXISTS security_install_proofs_insert ON public.installation_proofs;
CREATE POLICY security_install_proofs_insert ON public.installation_proofs AS RESTRICTIVE FOR INSERT TO authenticated
 WITH CHECK (organization_id=public.current_org_id() AND
  (public.current_role() IN ('agency_owner','admin') OR
   (public.current_role()='installer' AND public.can_access_field_shop(shop_id))));

-- Platform operator sees aggregate workload, not individual agency customer records.
-- The earlier permissive super-admin policies exposed full records over REST.
DROP POLICY IF EXISTS clients_select_super_admin ON public.clients;
DROP POLICY IF EXISTS projects_select_super_admin ON public.projects;
DROP POLICY IF EXISTS shops_select_super_admin ON public.shops;
DROP POLICY IF EXISTS work_items_select_super_admin ON public.work_items;
DROP POLICY IF EXISTS purchase_orders_select_super_admin ON public.purchase_orders;
CREATE OR REPLACE FUNCTION public.super_admin_org_metrics()
RETURNS TABLE(organization_id uuid, client_count bigint, shop_count bigint, completed_shop_count bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_catalog AS $$
 SELECT o.id,COALESCE(c.total,0),COALESCE(s.total,0),COALESCE(s.done,0)
 FROM public.organizations o
 LEFT JOIN (SELECT organization_id,count(*) total FROM public.clients GROUP BY organization_id) c ON c.organization_id=o.id
 LEFT JOIN (SELECT organization_id,count(*) total,count(*) FILTER (WHERE status IN ('installed','billed')) done
            FROM public.shops GROUP BY organization_id) s ON s.organization_id=o.id
 WHERE public.current_is_super_admin();
$$;
REVOKE ALL ON FUNCTION public.super_admin_org_metrics() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.super_admin_org_metrics() TO authenticated;

-- Only subscription fields are editable by a platform operator through the
-- organizations REST endpoint; agency business/banking identity stays tenant-owned.
CREATE OR REPLACE FUNCTION public.guard_organization_platform_update()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_catalog AS $$
BEGIN
 IF auth.uid() IS NULL THEN RETURN NEW; END IF;
 IF public.current_is_super_admin() THEN
    IF (to_jsonb(NEW) - 'subscription_status' - 'subscription_plan' - 'subscription_notes' - 'subscription_updated_at')
       IS DISTINCT FROM
       (to_jsonb(OLD) - 'subscription_status' - 'subscription_plan' - 'subscription_notes' - 'subscription_updated_at') THEN
       RAISE EXCEPTION 'Platform operators may only change subscription fields' USING ERRCODE='42501';
    END IF;
 END IF;
 RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_guard_organization_platform_update ON public.organizations;
CREATE TRIGGER trg_guard_organization_platform_update BEFORE UPDATE ON public.organizations
 FOR EACH ROW EXECUTE FUNCTION public.guard_organization_platform_update();
REVOKE ALL ON FUNCTION public.guard_organization_platform_update() FROM PUBLIC,anon,authenticated;
