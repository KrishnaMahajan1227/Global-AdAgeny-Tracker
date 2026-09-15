/*
# Super Admin — create organizations, and reset any user's login

Two gaps in what the Super Admin dashboard could actually do:
  1. No way to create a brand-new Agency or Client organization from
     scratch — every existing "create an org" RPC (agency_invite_client_org,
     client_invite_agency_org) requires calling FROM an existing org's own
     context, which a Super Admin, sitting above every org, doesn't have.
  2. No way to reset a login's email/password on a customer's behalf — a
     realistic, recurring support need for anyone running this as a
     subscription business ("client locked out, agency owner changed
     email", etc.).

Both are SECURITY DEFINER RPCs gated on current_is_super_admin() (from
migration 0072) — nobody else can call either one.
*/

-- ============ 1. super_admin_create_organization ============
CREATE OR REPLACE FUNCTION public.super_admin_create_organization(
  p_org_name text,
  p_org_type text,
  p_admin_full_name text,
  p_admin_email text,
  p_admin_phone text,
  p_admin_password text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org_id uuid;
  v_user_id uuid;
  v_role text;
BEGIN
  IF NOT public.current_is_super_admin() THEN
    RAISE EXCEPTION 'Only a Super Admin can create organizations';
  END IF;
  IF p_org_type NOT IN ('agency', 'client') THEN
    RAISE EXCEPTION 'Organization type must be agency or client';
  END IF;
  IF EXISTS (SELECT 1 FROM auth.users WHERE email = p_admin_email) THEN
    RAISE EXCEPTION 'A login with that email already exists on this platform';
  END IF;

  INSERT INTO public.organizations (name, org_type, subscription_status)
  VALUES (p_org_name, p_org_type, 'trial')
  RETURNING id INTO v_org_id;

  v_role := CASE WHEN p_org_type = 'agency' THEN 'agency_owner' ELSE 'client_admin' END;
  v_user_id := gen_random_uuid();

  INSERT INTO auth.users (
    id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, recovery_token, email_change, email_change_token_new,
    email_change_token_current, phone_change, phone_change_token, reauthentication_token
  )
  VALUES (
    v_user_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
    p_admin_email, extensions.crypt(p_admin_password, extensions.gen_salt('bf')), now(),
    jsonb_build_object('provider', 'email', 'providers', jsonb_build_array('email'), 'role', v_role),
    jsonb_build_object('full_name', p_admin_full_name),
    now(), now(), '', '', '', '', '', '', '', ''
  );

  INSERT INTO auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at)
  VALUES (v_user_id, v_user_id, jsonb_build_object('sub', v_user_id::text, 'email', p_admin_email), 'email', now(), now());

  INSERT INTO public.profiles (id, organization_id, full_name, role, phone, is_active, is_demo)
  VALUES (v_user_id, v_org_id, p_admin_full_name, v_role, NULLIF(p_admin_phone, ''), true, false);

  RETURN v_org_id;
END;
$$;

REVOKE ALL ON FUNCTION public.super_admin_create_organization(text, text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.super_admin_create_organization(text, text, text, text, text, text) TO authenticated;

-- ============ 2. super_admin_update_user_credentials ============
-- Either argument can be left blank to leave that credential unchanged —
-- the RPC only touches what was actually filled in on the form.
CREATE OR REPLACE FUNCTION public.super_admin_update_user_credentials(
  p_user_id uuid,
  p_new_email text,
  p_new_password text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.current_is_super_admin() THEN
    RAISE EXCEPTION 'Only a Super Admin can reset another user''s login';
  END IF;

  IF p_new_email IS NOT NULL AND btrim(p_new_email) <> '' THEN
    IF EXISTS (SELECT 1 FROM auth.users WHERE email = p_new_email AND id <> p_user_id) THEN
      RAISE EXCEPTION 'Another login already uses that email';
    END IF;
    UPDATE auth.users SET email = p_new_email, email_confirmed_at = now() WHERE id = p_user_id;
    UPDATE auth.identities
    SET identity_data = jsonb_set(identity_data, '{email}', to_jsonb(p_new_email))
    WHERE user_id = p_user_id AND provider = 'email';
  END IF;

  IF p_new_password IS NOT NULL AND length(p_new_password) >= 8 THEN
    UPDATE auth.users SET encrypted_password = extensions.crypt(p_new_password, extensions.gen_salt('bf')) WHERE id = p_user_id;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.super_admin_update_user_credentials(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.super_admin_update_user_credentials(uuid, text, text) TO authenticated;

-- ============ 3. super_admin_list_users ============
-- profiles carries no email column (it lives in auth.users, which isn't
-- exposed via the API) — without this, the Super Admin dashboard had no
-- way to even show what email a "reset credentials" action would be
-- changing. Returns every user on the platform with their email attached,
-- gated the same way as everything else here.
CREATE OR REPLACE FUNCTION public.super_admin_list_users()
RETURNS TABLE (
  id uuid,
  organization_id uuid,
  full_name text,
  role text,
  is_active boolean,
  email text
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT p.id, p.organization_id, p.full_name, p.role, p.is_active, u.email::text
  FROM public.profiles p
  JOIN auth.users u ON u.id = p.id
  WHERE public.current_is_super_admin();
$$;

REVOKE ALL ON FUNCTION public.super_admin_list_users() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.super_admin_list_users() TO authenticated;
