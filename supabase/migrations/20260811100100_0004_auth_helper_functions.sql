/*
# Auth helper functions

The frontend runs only with the publishable/anon key, so it can never call
Supabase's admin auth API (supabase.auth.admin.*) — that requires the
service_role key, which must never ship to the browser. These two
SECURITY DEFINER functions give the frontend safe, narrow, server-side
capability instead, without needing a separate Edge Function.

1. get_login_email_by_phone(p_phone)
   - Called by the LOGIN SCREEN before the user is authenticated (anon role).
   - Only returns an email address for an ACTIVE profile with a matching phone.
   - Does not expose any other profile data.

2. admin_create_user(...)
   - Called from the Owner Console "Create User" form.
   - Internally checks that the CALLER is already an authenticated
     'agency_owner' before doing anything — this check happens inside the
     function (server-side), so it cannot be bypassed from the client even
     though the function itself runs with elevated (definer) privileges.
   - Creates the auth.users + auth.identities rows (same pattern used by the
     seed data migration) and the matching public.profiles row, in the
     caller's own organization only.
*/

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================
-- 1. Phone -> email lookup for the phone+password login screen
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_login_email_by_phone(p_phone text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, extensions
AS $$
DECLARE
  v_user_id uuid;
  v_email text;
BEGIN
  SELECT id INTO v_user_id
  FROM public.profiles
  WHERE phone = regexp_replace(p_phone, '\s', '', 'g')
    AND is_active = true
  LIMIT 1;

  IF v_user_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT email INTO v_email FROM auth.users WHERE id = v_user_id;
  RETURN v_email;
END;
$$;

-- Anyone (including a not-yet-logged-in visitor) can call this — it only
-- ever returns an email address, nothing else, and only for an existing
-- active phone-login account.
REVOKE ALL ON FUNCTION public.get_login_email_by_phone(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_login_email_by_phone(text) TO anon, authenticated;

-- ============================================================
-- 2. Owner-only user creation (replaces supabase.auth.admin.createUser)
-- ============================================================
CREATE OR REPLACE FUNCTION public.admin_create_user(
  p_full_name text,
  p_email text,
  p_phone text,
  p_role text,
  p_password text
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
  -- Server-side authorization check: only an agency_owner may create users,
  -- and only within their own organization. This cannot be bypassed from
  -- the client since it is enforced here, inside the definer function.
  SELECT role, organization_id INTO v_caller_role, v_org_id
  FROM public.profiles
  WHERE id = auth.uid();

  IF v_caller_role IS DISTINCT FROM 'agency_owner' THEN
    RAISE EXCEPTION 'Only the Agency Owner can create users';
  END IF;

  IF EXISTS (SELECT 1 FROM auth.users WHERE email = p_email) THEN
    RAISE EXCEPTION 'A user with this email already exists';
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

  INSERT INTO public.profiles (id, organization_id, full_name, role, phone, is_active, is_demo)
  VALUES (v_new_id, v_org_id, p_full_name, p_role, NULLIF(p_phone, ''), true, false);

  RETURN v_new_id;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_create_user(text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_create_user(text, text, text, text, text) TO authenticated;
