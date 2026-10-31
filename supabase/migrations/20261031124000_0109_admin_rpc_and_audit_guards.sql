-- Owner-created accounts: only approved team roles, no Owner/Super Admin promotion,
-- only when actor is ACTIVE. Replaces the latest 6-argument function from 0033.
CREATE OR REPLACE FUNCTION public.admin_create_user(
  p_full_name text,
  p_email text,
  p_phone text,
  p_role text,
  p_password text,
  p_client_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, extensions
AS $$
DECLARE
  v_caller_role text;
  v_org_id uuid;
  v_new_id uuid;
BEGIN
  v_caller_role := public.current_role();
  v_org_id := public.current_org_id();

  IF v_caller_role IS DISTINCT FROM 'agency_owner' THEN
    RAISE EXCEPTION 'Only the Agency Owner can create users';
  END IF;

  IF p_role NOT IN ('admin','client_manager','surveyor','designer','printing','installer','accounts','demo') THEN
    RAISE EXCEPTION 'This role cannot be created through the Owner Console' USING ERRCODE='42501';
  END IF;
  IF p_password IS NULL OR length(p_password)<12 OR length(p_password)>128 THEN
    RAISE EXCEPTION 'Password must contain 12 to 128 characters';
  END IF;
  IF nullif(btrim(p_full_name),'') IS NULL OR p_email IS NULL OR p_email !~* '^[^@ ]+@[^@ ]+\.[^@ ]+$' THEN
    RAISE EXCEPTION 'Valid name and email are required';
  END IF;
  IF p_client_id IS NOT NULL AND p_role <> 'client_manager' THEN
    RAISE EXCEPTION 'Client scope is only supported for client managers';
  END IF;

  IF EXISTS (SELECT 1 FROM auth.users WHERE email = p_email) THEN
    RAISE EXCEPTION 'A user with this email already exists';
  END IF;

  -- A client_id only makes sense scoped to the caller's own org — reject
  -- silently-wrong cross-org assignment rather than trusting the client.
  IF p_client_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.clients WHERE id = p_client_id AND organization_id = v_org_id
  ) THEN
    RAISE EXCEPTION 'Selected client does not belong to your organization';
  END IF;

  v_new_id := gen_random_uuid();

  INSERT INTO auth.users (
    id, instance_id, aud, role, email, encrypted_password,
    email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
    created_at, updated_at, confirmation_token, recovery_token,
    email_change, email_change_token_new, email_change_token_current,
    phone_change, phone_change_token, reauthentication_token
  ) VALUES (
    v_new_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
    p_email, extensions.crypt(p_password, extensions.gen_salt('bf')), now(),
    jsonb_build_object('provider', 'email', 'providers', jsonb_build_array('email'), 'role', p_role),
    jsonb_build_object('full_name', p_full_name, 'phone', p_phone),
    now(), now(), '', '', '', '', '', '', '', ''
  );

  INSERT INTO auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at)
  VALUES (
    v_new_id, v_new_id,
    jsonb_build_object('sub', v_new_id::text, 'email', p_email),
    'email', now(), now()
  );

  INSERT INTO public.profiles (id, organization_id, full_name, role, phone, is_active, is_demo, client_id)
  VALUES (v_new_id, v_org_id, p_full_name, p_role, NULLIF(p_phone, ''), true, false, p_client_id);

  RETURN v_new_id;
END;
$$;
REVOKE ALL ON FUNCTION public.admin_create_user(text,text,text,text,text,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.admin_create_user(text,text,text,text,text,uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_delete_user(p_user_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,auth,pg_catalog AS $$
DECLARE v_org uuid; v_target_org uuid; v_target_role text;
BEGIN
 IF public.current_role()<>'agency_owner' THEN RAISE EXCEPTION 'Active agency owner required' USING ERRCODE='42501'; END IF;
 v_org:=public.current_org_id();
 IF p_user_id=auth.uid() THEN RAISE EXCEPTION 'Cannot delete your own account' USING ERRCODE='42501'; END IF;
 SELECT organization_id,role INTO v_target_org,v_target_role FROM public.profiles WHERE id=p_user_id FOR UPDATE;
 IF v_target_org IS NULL OR v_target_org IS DISTINCT FROM v_org
    OR v_target_role IN ('agency_owner','super_admin','client_admin','client_viewer') THEN
    RAISE EXCEPTION 'User not eligible for deletion' USING ERRCODE='42501';
 END IF;
 INSERT INTO public.audit_logs(organization_id,user_id,table_name,record_id,action,description)
 VALUES (v_org,auth.uid(),'profiles',p_user_id,'delete','Agency owner deleted a team member');
 DELETE FROM auth.identities WHERE user_id=p_user_id;
 DELETE FROM public.profiles WHERE id=p_user_id;
 DELETE FROM auth.users WHERE id=p_user_id;
END;
$$;
REVOKE ALL ON FUNCTION public.admin_delete_user(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.admin_delete_user(uuid) TO authenticated;

-- Even a SECURITY DEFINER account-creation RPC must not bypass an inactive
-- or unauthorized caller; a failed profile insert rolls back auth.users too.
CREATE OR REPLACE FUNCTION public.guard_profile_insert_security()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_catalog AS $$
DECLARE v_role text; v_org uuid;
BEGIN
 IF auth.uid() IS NULL THEN RETURN NEW; END IF;
 v_role:=public.current_role(); v_org:=public.current_org_id();
 IF v_role IS NULL THEN RAISE EXCEPTION 'Inactive account cannot provision logins' USING ERRCODE='42501'; END IF;
 IF v_role='super_admin' THEN RETURN NEW; END IF;
 IF v_role='agency_owner' AND NEW.organization_id=v_org
    AND NEW.role IN ('admin','client_manager','surveyor','designer','printing','installer','accounts','demo') THEN
   RETURN NEW;
 END IF;
 -- Cross-org invitations are possible only through existing elevated RPCs:
 -- REST profile inserts have no permissive policy. Keep the target type exact.
 IF v_role IN ('agency_owner','admin') AND NEW.role='client_admin'
    AND EXISTS(SELECT 1 FROM public.organizations o WHERE o.id=NEW.organization_id AND o.org_type='client') THEN
   RETURN NEW;
 END IF;
 IF v_role='client_admin' AND NEW.role='agency_owner'
    AND EXISTS(SELECT 1 FROM public.organizations o WHERE o.id=NEW.organization_id AND o.org_type='agency') THEN
   RETURN NEW;
 END IF;
 RAISE EXCEPTION 'Profile creation not authorized' USING ERRCODE='42501';
END;
$$;
DROP TRIGGER IF EXISTS trg_guard_profile_insert_security ON public.profiles;
CREATE TRIGGER trg_guard_profile_insert_security BEFORE INSERT ON public.profiles
 FOR EACH ROW EXECUTE FUNCTION public.guard_profile_insert_security();
REVOKE ALL ON FUNCTION public.guard_profile_insert_security() FROM PUBLIC,anon,authenticated;

-- Only the actual actor may author a direct audit event. Audit records may
-- not be edited/deleted from the browser, even if an old permissive policy exists.
DROP POLICY IF EXISTS security_audit_insert ON public.audit_logs;
CREATE POLICY security_audit_insert ON public.audit_logs AS RESTRICTIVE FOR INSERT TO authenticated
 WITH CHECK (organization_id=public.current_org_id() AND user_id=auth.uid());
DROP POLICY IF EXISTS security_audit_update ON public.audit_logs;
CREATE POLICY security_audit_update ON public.audit_logs AS RESTRICTIVE FOR UPDATE TO authenticated USING(false) WITH CHECK(false);
DROP POLICY IF EXISTS security_audit_delete ON public.audit_logs;
CREATE POLICY security_audit_delete ON public.audit_logs AS RESTRICTIVE FOR DELETE TO authenticated USING(false);
