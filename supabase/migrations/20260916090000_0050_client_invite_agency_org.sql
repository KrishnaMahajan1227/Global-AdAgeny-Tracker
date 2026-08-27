/*
# Phase 21 — Client-initiated "Add Agency" (client onboards a NEW agency + its first login)

## Why
Per explicit correction: the Client Organization (the brand/company that
hands out work) needs to be the one deciding which agency does what — so
the client must be able to build and manage their OWN list of agencies,
not just wait to be invited by one. This is the mirror image of
`agency_invite_client_org` (migration 0038): there, an agency creates a
brand-new Client Organization + its first client_admin login in one step.
Here, a client_admin creates a brand-new Agency Organization + its first
agency_owner login in one step — same technique, same atomicity,
direction reversed. The existing agency-invites-client flow is untouched
and still works exactly as it did (kept "on the side", per instruction).

## Design
1. `client_invite_agency_org(...)` — SECURITY DEFINER RPC. Only a
   client_admin from a `client` org may call it. Creates:
   - the new Agency Organization (`organizations.org_type = 'agency'`),
   - its first login (`agency_owner` role) — same
     `auth.users`/`auth.identities` insert technique
     `agency_invite_client_org` already uses (no service_role key
     available to the browser),
   - a matching row in the NEW agency's own `clients` table representing
     the client org that just created it (mirrors how
     `agency_invite_client_org` creates a `clients` row on the agency's
     side) — this is what lets a future client-created PO against this
     agency satisfy `purchase_orders.client_id`'s NOT NULL constraint,
   - an ACTIVE `client_agency_links` row between the two, with
     `agency_client_id` already resolved to that new `clients` row and
     `invited_by = auth.uid()`.
   Since the client is the one who created this agency in the first
   place, the link goes straight to 'active' — no separate accept step
   (same reasoning `agency_invite_client_org` uses for its own direction).

2. `organizations` UPDATE RLS — additive branch: a client_admin may now
   also update the basic profile (name/phone/email/address/gst_number) of
   an agency org, but ONLY when there's an ACTIVE `client_agency_links`
   row between their own client org and that agency AND that link's
   `invited_by` is a user from their OWN org (i.e. only an agency this
   client themselves added — never an agency that invited THEM, whose
   own tenant identity isn't the client's to rewrite). The existing
   "owner can edit their own org" branch is untouched; this is a second,
   narrowly-scoped OR branch, same pattern as every other additive RLS
   change in this platform.

## Deliberately NOT included
No client-side DELETE of the `organizations` row itself — that would
cascade into real operational data (POs, work items, the agency's own
login) even for an agency the client created by mistake. "Removing" an
agency from the client's list is the existing `client_agency_links`
UPDATE-to-'revoked' path (already RLS-permitted per migration 0037,
already used by the Agencies page's Unlink action) — a safe, reversible
soft-delete of the relationship, not a destructive delete of the tenant.
*/

CREATE OR REPLACE FUNCTION public.client_invite_agency_org(
  p_agency_org_name text,
  p_admin_full_name text,
  p_admin_email text,
  p_admin_phone text,
  p_admin_password text,
  p_contact_person text DEFAULT NULL,
  p_contact_phone text DEFAULT NULL,
  p_contact_email text DEFAULT NULL,
  p_city text DEFAULT NULL,
  p_state text DEFAULT NULL,
  p_gst_number text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, extensions
AS $$
DECLARE
  v_caller_role text;
  v_caller_org_id uuid;
  v_caller_org_type text;
  v_caller_org_name text;
  v_agency_org_id uuid;
  v_client_id uuid;
  v_new_user_id uuid;
BEGIN
  -- Server-side authorization: only a client_admin, from a client org,
  -- may add a new agency. Enforced here so it can't be bypassed from the
  -- browser even though this function runs with elevated (definer)
  -- privileges.
  SELECT p.role, p.organization_id, o.org_type, o.name
  INTO v_caller_role, v_caller_org_id, v_caller_org_type, v_caller_org_name
  FROM public.profiles p
  JOIN public.organizations o ON o.id = p.organization_id
  WHERE p.id = auth.uid();

  IF v_caller_org_type IS DISTINCT FROM 'client' OR v_caller_role <> 'client_admin' THEN
    RAISE EXCEPTION 'Only a Client Admin can add a new agency';
  END IF;

  IF p_agency_org_name IS NULL OR btrim(p_agency_org_name) = '' THEN
    RAISE EXCEPTION 'Agency name is required';
  END IF;

  IF EXISTS (SELECT 1 FROM auth.users WHERE email = p_admin_email) THEN
    RAISE EXCEPTION 'A user with this email already exists';
  END IF;

  -- 1. The new Agency Organization tenant.
  INSERT INTO public.organizations (name, org_type, default_currency, default_unit)
  VALUES (btrim(p_agency_org_name), 'agency', 'INR', 'ft')
  RETURNING id INTO v_agency_org_id;

  -- 2. A matching row in the NEW agency's own clients table, representing
  --    the client org that just created it — so a future client-created
  --    PO against this agency has a client_id to satisfy the NOT NULL
  --    constraint, and so this client immediately shows up on the
  --    agency's own Clients/PO screens exactly like any other client.
  INSERT INTO public.clients (
    organization_id, name, contact_person, contact_phone, contact_email, city, state, gst_number
  ) VALUES (
    v_agency_org_id, v_caller_org_name,
    NULLIF(p_contact_person, ''), NULLIF(p_contact_phone, ''), NULLIF(p_contact_email, ''),
    NULLIF(p_city, ''), NULLIF(p_state, ''), NULLIF(p_gst_number, '')
  )
  RETURNING id INTO v_client_id;

  -- 3. The agency_owner login itself — same technique
  --    agency_invite_client_org uses (no service_role key available to
  --    the browser).
  v_new_user_id := gen_random_uuid();

  INSERT INTO auth.users (
    id, instance_id, aud, role, email, encrypted_password,
    email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
    created_at, updated_at, confirmation_token, recovery_token,
    email_change, email_change_token_new, email_change_token_current,
    phone_change, phone_change_token, reauthentication_token
  ) VALUES (
    v_new_user_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
    p_admin_email, extensions.crypt(p_admin_password, extensions.gen_salt('bf')), now(),
    jsonb_build_object('provider', 'email', 'providers', jsonb_build_array('email'), 'role', 'agency_owner'),
    jsonb_build_object('full_name', p_admin_full_name, 'phone', p_admin_phone),
    now(), now(), '', '', '', '', '', '', '', ''
  );

  INSERT INTO auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at)
  VALUES (
    v_new_user_id, v_new_user_id,
    jsonb_build_object('sub', v_new_user_id::text, 'email', p_admin_email),
    'email', now(), now()
  );

  INSERT INTO public.profiles (id, organization_id, full_name, role, phone, is_active, is_demo)
  VALUES (v_new_user_id, v_agency_org_id, p_admin_full_name, 'agency_owner', NULLIF(p_admin_phone, ''), true, false);

  -- 4. The link — client-initiated, so it goes straight to 'active' (the
  --    client created this agency, there's no separate party who needs
  --    to accept it).
  INSERT INTO public.client_agency_links (client_org_id, agency_org_id, status, invited_by, agency_client_id)
  VALUES (v_caller_org_id, v_agency_org_id, 'active', auth.uid(), v_client_id);

  RETURN v_agency_org_id;
END;
$$;

REVOKE ALL ON FUNCTION public.client_invite_agency_org(text, text, text, text, text, text, text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.client_invite_agency_org(text, text, text, text, text, text, text, text, text, text, text) TO authenticated;

-- ============ organizations UPDATE RLS — additive client-originated-agency branch ============
DROP POLICY IF EXISTS "orgs_update" ON public.organizations;
CREATE POLICY "orgs_update" ON public.organizations FOR UPDATE
  TO authenticated USING (
    (id = public.current_org_id() AND public.current_role() = 'agency_owner')
    OR
    (
      org_type = 'agency'
      AND public.current_org_type() = 'client'
      AND public.current_role() = 'client_admin'
      AND EXISTS (
        SELECT 1 FROM public.client_agency_links l
        JOIN public.profiles p ON p.id = l.invited_by
        WHERE l.agency_org_id = organizations.id
          AND l.client_org_id = public.current_org_id()
          AND l.status = 'active'
          AND p.organization_id = public.current_org_id()
      )
    )
  )
  WITH CHECK (
    (id = public.current_org_id() AND public.current_role() = 'agency_owner')
    OR
    (
      org_type = 'agency'
      AND public.current_org_type() = 'client'
      AND public.current_role() = 'client_admin'
      AND EXISTS (
        SELECT 1 FROM public.client_agency_links l
        JOIN public.profiles p ON p.id = l.invited_by
        WHERE l.agency_org_id = organizations.id
          AND l.client_org_id = public.current_org_id()
          AND l.status = 'active'
          AND p.organization_id = public.current_org_id()
      )
    )
  );
