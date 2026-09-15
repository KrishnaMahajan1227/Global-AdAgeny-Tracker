/*
# Fix "Database error querying schema" on login + add a working delete-user path

## Problem 1 — new users still can't log in
`admin_create_user` (0004) already writes '' instead of NULL into the
GoTrue text columns that are known to crash login with a generic
"Database error querying schema" (Go scans a SQL NULL into a plain
`string` field and panics). That part was correct. What was missing:
nothing ever re-ran this repair for rows created *between* deployments,
and a few more columns GoTrue also scans as plain (non-nullable) Go
values were never covered by 0005's repair list. This migration:
  a) widens the repair to every column GoTrue is known to choke on, and
     re-runs it now, unconditionally, so any row currently in this state
     (e.g. the "MahadhanClient" account) is fixed immediately, and
  b) re-creates `admin_create_user` to set every one of those columns
     explicitly on every future insert (belt-and-suspenders — relying on
     table defaults alone is what got us here).

## Problem 2 — deleting a user from Supabase Studio fails
("Failed to delete selected users: Database error loading user")
Studio's delete button calls the GoTrue Admin API, which has to fully
load the user row first — the exact same Go-struct-scan code path that
breaks on login. So any row with the pre-fix NULLs, or that trips any
other quirk of that endpoint, can never be deleted from Studio either,
independent of the login bug.

The frontend has no service_role key (same reason `admin_create_user`
exists at all — see 0004), so it can't call the Admin API from the app
either. Fix: a matching `admin_delete_user` SECURITY DEFINER function
that deletes the auth.users/auth.identities/public.profiles rows with
plain SQL, entirely bypassing GoTrue. Same caller-is-agency_owner,
same-organization check as `admin_create_user`, plus guards against
deleting the owner account itself or your own account.
*/

-- ============================================================
-- Part A: repair every existing auth.users row right now
-- ============================================================
UPDATE auth.users
SET
  confirmation_token          = COALESCE(confirmation_token, ''),
  recovery_token               = COALESCE(recovery_token, ''),
  email_change                 = COALESCE(email_change, ''),
  email_change_token_new       = COALESCE(email_change_token_new, ''),
  email_change_token_current   = COALESCE(email_change_token_current, ''),
  phone_change                 = COALESCE(phone_change, ''),
  phone_change_token           = COALESCE(phone_change_token, ''),
  reauthentication_token       = COALESCE(reauthentication_token, ''),
  is_sso_user                  = COALESCE(is_sso_user, false),
  is_anonymous                 = COALESCE(is_anonymous, false),
  email_change_confirm_status  = COALESCE(email_change_confirm_status, 0)
WHERE
  confirmation_token IS NULL OR
  recovery_token IS NULL OR
  email_change IS NULL OR
  email_change_token_new IS NULL OR
  email_change_token_current IS NULL OR
  phone_change IS NULL OR
  phone_change_token IS NULL OR
  reauthentication_token IS NULL OR
  is_sso_user IS NULL OR
  is_anonymous IS NULL OR
  email_change_confirm_status IS NULL;

-- Remove any orphaned identities left behind by earlier failed attempts
-- (an identity row whose user no longer exists, or that duplicates the
-- same provider_id, is another known cause of odd Admin API errors).
DELETE FROM auth.identities i
WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = i.user_id);

-- ============================================================
-- Part B: re-create admin_create_user, setting every risky column
-- explicitly rather than trusting defaults
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
    phone_change, phone_change_token, reauthentication_token,
    is_sso_user, is_anonymous, email_change_confirm_status,
    is_super_admin
  ) VALUES (
    v_new_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
    p_email, extensions.crypt(p_password, extensions.gen_salt('bf')), now(),
    jsonb_build_object('provider', 'email', 'providers', jsonb_build_array('email'), 'role', p_role),
    jsonb_build_object('full_name', p_full_name, 'phone', p_phone),
    now(), now(), '', '', '', '', '', '', '', '',
    false, false, 0,
    false
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

-- ============================================================
-- Part C: admin_delete_user — the app-side replacement for the
-- Studio "Delete user" button / auth.admin.deleteUser
-- ============================================================
CREATE OR REPLACE FUNCTION public.admin_delete_user(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, extensions
AS $$
DECLARE
  v_caller_role text;
  v_caller_org_id uuid;
  v_target_org_id uuid;
  v_target_role text;
BEGIN
  SELECT role, organization_id INTO v_caller_role, v_caller_org_id
  FROM public.profiles
  WHERE id = auth.uid();

  IF v_caller_role IS DISTINCT FROM 'agency_owner' THEN
    RAISE EXCEPTION 'Only the Agency Owner can delete users';
  END IF;

  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION 'You cannot delete your own account';
  END IF;

  SELECT role, organization_id INTO v_target_role, v_target_org_id
  FROM public.profiles
  WHERE id = p_user_id;

  IF v_target_org_id IS NULL OR v_target_org_id IS DISTINCT FROM v_caller_org_id THEN
    RAISE EXCEPTION 'User not found in your organization';
  END IF;

  IF v_target_role = 'agency_owner' THEN
    RAISE EXCEPTION 'The Agency Owner account cannot be deleted';
  END IF;

  -- Plain SQL delete — bypasses the GoTrue Admin API entirely, so it
  -- can't fail with "Database error loading user" the way Studio's
  -- delete button does.
  DELETE FROM auth.identities WHERE user_id = p_user_id;
  DELETE FROM public.profiles WHERE id = p_user_id; -- harmless if the users row below cascades it first
  DELETE FROM auth.users WHERE id = p_user_id;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_delete_user(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_delete_user(uuid) TO authenticated;
