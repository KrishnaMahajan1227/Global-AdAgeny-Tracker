-- Security release 0105. Additive after 0104; no business data is deleted.
-- RLS is the enforcement boundary, NOT frontend route/sidebars.

-- Every session must map to an active profile, including SECURITY DEFINER helpers.
CREATE OR REPLACE FUNCTION public.current_is_active()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_catalog AS $$
  SELECT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id=auth.uid() AND p.is_active IS TRUE);
$$;
REVOKE ALL ON FUNCTION public.current_is_active() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.current_is_active() TO authenticated;

CREATE OR REPLACE FUNCTION public.current_org_id()
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_catalog AS $$
  SELECT p.organization_id FROM public.profiles p WHERE p.id=auth.uid() AND p.is_active IS TRUE;
$$;
CREATE OR REPLACE FUNCTION public.current_role()
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_catalog AS $$
  SELECT p.role FROM public.profiles p WHERE p.id=auth.uid() AND p.is_active IS TRUE;
$$;
CREATE OR REPLACE FUNCTION public.current_is_super_admin()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_catalog AS $$
  SELECT EXISTS(SELECT 1 FROM public.profiles p WHERE p.id=auth.uid() AND p.is_active IS TRUE AND p.role='super_admin');
$$;
CREATE OR REPLACE FUNCTION public.current_org_type()
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_catalog AS $$
 SELECT o.org_type FROM public.organizations o JOIN public.profiles p ON p.organization_id=o.id
 WHERE p.id=auth.uid() AND p.is_active IS TRUE;
$$;

-- A regular user's profile edit must never become a role, tenant, status or client reassignment.
-- The Owner Console may update other staff in the SAME tenant, but not grant owner/platform roles.
CREATE OR REPLACE FUNCTION public.guard_profile_privileges()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_catalog AS $$
DECLARE v_role text; v_org uuid;
BEGIN
 IF auth.uid() IS NULL THEN RETURN NEW; END IF; -- migrations/service administration
 SELECT p.role,p.organization_id INTO v_role,v_org
 FROM public.profiles p WHERE p.id=auth.uid() AND p.is_active IS TRUE;
 IF v_role IS NULL THEN RAISE EXCEPTION 'Account inactive or not authorized' USING ERRCODE='42501'; END IF;
 IF v_role='super_admin' THEN RETURN NEW; END IF;
 IF NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.is_demo IS DISTINCT FROM OLD.is_demo
    OR NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'Identity, tenant and demo classification are immutable' USING ERRCODE='42501';
 END IF;
 IF auth.uid()=OLD.id THEN
   IF NEW.role IS DISTINCT FROM OLD.role OR NEW.is_active IS DISTINCT FROM OLD.is_active
      OR NEW.client_id IS DISTINCT FROM OLD.client_id THEN
     RAISE EXCEPTION 'A user cannot edit their own privileges' USING ERRCODE='42501';
   END IF;
 ELSE
   IF v_role<>'agency_owner' OR v_org IS DISTINCT FROM OLD.organization_id
      OR OLD.role IN ('agency_owner','super_admin','client_admin','client_viewer')
      OR NEW.role IN ('agency_owner','super_admin','client_admin','client_viewer') THEN
     RAISE EXCEPTION 'Only the owner can update agency team members' USING ERRCODE='42501';
   END IF;
 END IF;
 RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_guard_profile_privileges ON public.profiles;
CREATE TRIGGER trg_guard_profile_privileges BEFORE UPDATE ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.guard_profile_privileges();
REVOKE ALL ON FUNCTION public.guard_profile_privileges() FROM PUBLIC, anon, authenticated;

-- Profile enrollment/deletion must happen through permission-checked RPCs, not table REST writes.
DROP POLICY IF EXISTS profiles_insert ON public.profiles;
DROP POLICY IF EXISTS profiles_delete ON public.profiles;
DROP POLICY IF EXISTS profiles_update ON public.profiles;
CREATE POLICY profiles_update ON public.profiles FOR UPDATE TO authenticated
 USING (public.current_is_active() AND
   (id=auth.uid() OR (public.current_role()='agency_owner' AND organization_id=public.current_org_id() AND role NOT IN ('agency_owner','super_admin','client_admin','client_viewer'))))
 WITH CHECK (public.current_is_active() AND
   (id=auth.uid() OR (public.current_role()='agency_owner' AND organization_id=public.current_org_id() AND role NOT IN ('agency_owner','super_admin','client_admin','client_viewer'))));

-- Restrictive policies AND with every legacy/additive policy, including forgotten OR policies.
-- This guarantees an inactive token cannot use direct REST routes, even if auth JWT is still valid.
DO $policy$
DECLARE t record;
BEGIN
 FOR t IN SELECT n.nspname AS schema_name,c.relname AS table_name
   FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='public' AND c.relkind IN ('r','p') AND c.relrowsecurity
 LOOP
   EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I', 'security_active_session',t.schema_name,t.table_name);
   EXECUTE format('CREATE POLICY %I ON %I.%I AS RESTRICTIVE FOR ALL TO authenticated USING (public.current_is_active()) WITH CHECK (public.current_is_active())',
     'security_active_session',t.schema_name,t.table_name);
 END LOOP;
END $policy$;

-- Minimal data visibility for field roles: assigned sites, not all sites in their agency.
CREATE OR REPLACE FUNCTION public.can_access_field_shop(p_shop uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_catalog AS $$
 SELECT public.current_role() IN ('surveyor','installer') AND EXISTS(
  SELECT 1 FROM public.shop_assignments a
  WHERE a.shop_id=p_shop AND a.user_id=auth.uid()
    AND a.organization_id=public.current_org_id() AND a.role=public.current_role() AND a.status<>'declined')
  OR (public.current_role()='installer' AND EXISTS (
    SELECT 1 FROM public.installation_jobs j WHERE j.shop_id=p_shop AND j.installer_id=auth.uid()
    AND j.organization_id=public.current_org_id()))
  OR (public.current_role()='surveyor' AND EXISTS (
    SELECT 1 FROM public.surveys s WHERE s.shop_id=p_shop AND s.surveyor_id=auth.uid()
    AND s.organization_id=public.current_org_id()));
$$;
REVOKE ALL ON FUNCTION public.can_access_field_shop(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_access_field_shop(uuid) TO authenticated;

DROP POLICY IF EXISTS security_field_shop_read ON public.shops;
CREATE POLICY security_field_shop_read ON public.shops AS RESTRICTIVE FOR SELECT TO authenticated
 USING (public.current_role() NOT IN ('surveyor','installer') OR public.can_access_field_shop(id));
DROP POLICY IF EXISTS security_field_assignments_read ON public.shop_assignments;
CREATE POLICY security_field_assignments_read ON public.shop_assignments AS RESTRICTIVE FOR SELECT TO authenticated
 USING (public.current_role() NOT IN ('surveyor','installer') OR user_id=auth.uid());
DROP POLICY IF EXISTS security_field_survey_read ON public.surveys;
CREATE POLICY security_field_survey_read ON public.surveys AS RESTRICTIVE FOR SELECT TO authenticated
 USING (public.current_role() NOT IN ('surveyor','installer') OR public.can_access_field_shop(shop_id));
DROP POLICY IF EXISTS security_field_survey_photos_read ON public.survey_photos;
CREATE POLICY security_field_survey_photos_read ON public.survey_photos AS RESTRICTIVE FOR SELECT TO authenticated
 USING (public.current_role() NOT IN ('surveyor','installer') OR public.can_access_field_shop(shop_id));
DROP POLICY IF EXISTS security_field_work_items_read ON public.work_items;
CREATE POLICY security_field_work_items_read ON public.work_items AS RESTRICTIVE FOR SELECT TO authenticated
 USING (public.current_role() NOT IN ('surveyor','installer') OR public.can_access_field_shop(shop_id));
DROP POLICY IF EXISTS security_field_install_jobs_read ON public.installation_jobs;
CREATE POLICY security_field_install_jobs_read ON public.installation_jobs AS RESTRICTIVE FOR SELECT TO authenticated
 USING (public.current_role() NOT IN ('surveyor','installer') OR public.can_access_field_shop(shop_id));
DROP POLICY IF EXISTS security_field_install_proofs_read ON public.installation_proofs;
CREATE POLICY security_field_install_proofs_read ON public.installation_proofs AS RESTRICTIVE FOR SELECT TO authenticated
 USING (public.current_role() NOT IN ('surveyor','installer') OR public.can_access_field_shop(shop_id));
DROP POLICY IF EXISTS security_field_clients_read ON public.clients;
CREATE POLICY security_field_clients_read ON public.clients AS RESTRICTIVE FOR SELECT TO authenticated
 USING (public.current_role() NOT IN ('surveyor','installer') OR EXISTS(
   SELECT 1 FROM public.shops s WHERE s.client_id=clients.id AND public.can_access_field_shop(s.id)));
DROP POLICY IF EXISTS security_field_po_assignments_read ON public.po_assignments;
CREATE POLICY security_field_po_assignments_read ON public.po_assignments AS RESTRICTIVE FOR SELECT TO authenticated
 USING (public.current_role() NOT IN ('surveyor','installer') OR user_id=auth.uid());
DROP POLICY IF EXISTS security_field_routes_read ON public.routes;
CREATE POLICY security_field_routes_read ON public.routes AS RESTRICTIVE FOR SELECT TO authenticated
 USING (public.current_role() NOT IN ('surveyor','installer') OR user_id=auth.uid());
DROP POLICY IF EXISTS security_field_worker_locations_read ON public.worker_locations;
CREATE POLICY security_field_worker_locations_read ON public.worker_locations AS RESTRICTIVE FOR SELECT TO authenticated
 USING (public.current_role() NOT IN ('surveyor','installer') OR user_id=auth.uid());

-- Read policies are unchanged for linked client organizations. Master-data mutations
-- are restricted server-side to authorized agency office roles, never demo/field/clients.
DO $policy$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['clients','projects','work_types','shops','zones'] LOOP
   EXECUTE format('DROP POLICY IF EXISTS security_office_insert ON public.%I',t);
   EXECUTE format('CREATE POLICY security_office_insert ON public.%I AS RESTRICTIVE FOR INSERT TO authenticated WITH CHECK (organization_id=public.current_org_id() AND public.current_role() IN (''agency_owner'',''admin'',''client_manager''))',t);
   EXECUTE format('DROP POLICY IF EXISTS security_office_update ON public.%I',t);
   EXECUTE format('CREATE POLICY security_office_update ON public.%I AS RESTRICTIVE FOR UPDATE TO authenticated USING (organization_id=public.current_org_id() AND public.current_role() IN (''agency_owner'',''admin'',''client_manager'')) WITH CHECK (organization_id=public.current_org_id() AND public.current_role() IN (''agency_owner'',''admin'',''client_manager''))',t);
   EXECUTE format('DROP POLICY IF EXISTS security_office_delete ON public.%I',t);
   EXECUTE format('CREATE POLICY security_office_delete ON public.%I AS RESTRICTIVE FOR DELETE TO authenticated USING (organization_id=public.current_org_id() AND public.current_role() IN (''agency_owner'',''admin''))',t);
 END LOOP;
END $policy$;

-- Keep unauthenticated visitors away from profile lookups; phone-password remains email-only
-- until implemented through a rate-limited credential-verifying server endpoint.
REVOKE ALL ON FUNCTION public.get_login_email_by_phone(text) FROM PUBLIC, anon, authenticated;

-- Public REST RPC functions default to EXECUTE for PUBLIC in Postgres.
-- Revoke anonymous execution across the entire app API, not just one known function.
DO $revoke$
DECLARE f record;
BEGIN
 FOR f IN SELECT p.oid, p.proname, pg_get_function_identity_arguments(p.oid) args
   FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.prokind='f'
 LOOP
   EXECUTE format('REVOKE ALL ON FUNCTION public.%I(%s) FROM PUBLIC, anon', f.proname, f.args);
 END LOOP;
END $revoke$;
-- Functions accessed by the API as authenticated users must retain explicit EXECUTE.
GRANT EXECUTE ON FUNCTION public.current_org_id() TO authenticated;
GRANT EXECUTE ON FUNCTION public.current_role() TO authenticated;
GRANT EXECUTE ON FUNCTION public.current_org_type() TO authenticated;
GRANT EXECUTE ON FUNCTION public.current_is_super_admin() TO authenticated;
GRANT EXECUTE ON FUNCTION public.current_is_active() TO authenticated;
GRANT EXECUTE ON FUNCTION public.current_client_id() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_active_client_agency_link(uuid,uuid) TO authenticated;
-- No public/anonymous business RPCs are required: marketing pages are static.
