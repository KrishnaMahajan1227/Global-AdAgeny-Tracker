/*
# Phase 2 — Agency side: invite a client to the platform + Client Requests inbox

  Builds the second slice of GLOBAL_ARCHITECTURE.md's rollout plan, on top
  of Phase 1 (migration 0037: org_type, client_agency_links, PO
  origin/client_org_id/assigned_agency_id/assignment_status + RLS). Nothing
  here touches the existing agency-internal pipeline; it only ADDS:

   1. client_agency_links.agency_client_id — links a platform link to the
      agency's own internal `clients` row for that client. This is what
      lets a client-org-created PO satisfy purchase_orders.client_id
      (still NOT NULL by design — see 0037's header note) once Phase 3
      (client-side PO creation) starts inserting rows; Phase 2 itself
      creates this row automatically as part of the invite below, so it
      already exists by the time it's needed.
   2. organizations RLS — a user can now also SELECT the organization on
      the other side of any of their own org's client_agency_links rows
      (so an agency can show "Acme Retail" instead of a bare UUID in its
      Client Requests / linked-clients list, and vice versa for a client
      org showing its linked agencies' names). Every existing branch
      (own org only) is untouched, this is purely additive.
   3. agency_invite_client_org(...) — SECURITY DEFINER RPC. Lets an
      agency_owner/admin onboard a client onto the platform in one step:
      creates the Client Organization, its first client_admin login, a
      matching row in the agency's own `clients` table (so existing
      PO/billing screens keep working unchanged), and an ACTIVE
      client_agency_links row — all in one transaction. Mirrors the
      existing admin_create_user pattern (same auth.users/identities
      insert technique) since this also has to create a login without
      the service_role key.
   4. notify_linked_org_users(...) — SECURITY DEFINER RPC. The existing
      notifications_insert RLS policy only allows inserting within your
      own org, which is correct for every existing notification path but
      blocks the one new cross-org case: telling a client org's users
      their PO was accepted/rejected (doc section 6, steps 1-2). This
      function re-checks server-side that an ACTIVE link exists between
      the caller's org and the target org before writing anything, so it
      cannot be used to spam an unrelated org.

  Explicitly still out of scope (Phase 3+): client-side PO creation UI,
  Overview/Campaigns/Map Feed/Billing/Agencies screens, and the fuller
  realtime/notification polish across every pipeline stage (Phase 6).
*/

-- ============ 1. client_agency_links.agency_client_id ============
ALTER TABLE public.client_agency_links
  ADD COLUMN IF NOT EXISTS agency_client_id uuid REFERENCES public.clients(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.client_agency_links.agency_client_id IS
  'The agency''s own internal clients.id row that represents this client org — auto-created by agency_invite_client_org, consumed by future client-created PO inserts to satisfy purchase_orders.client_id.';

-- ============ 2. organizations RLS — see the org on the other side of your links ============
DROP POLICY IF EXISTS "orgs_select" ON public.organizations;
CREATE POLICY "orgs_select" ON public.organizations FOR SELECT
  TO authenticated USING (
    id = public.current_org_id()
    OR EXISTS (
      SELECT 1 FROM public.client_agency_links l
      WHERE l.status <> 'revoked'
        AND (
          (l.agency_org_id = public.current_org_id() AND l.client_org_id = organizations.id)
          OR
          (l.client_org_id = public.current_org_id() AND l.agency_org_id = organizations.id)
        )
    )
  );

-- ============ 3. agency_invite_client_org ============
CREATE OR REPLACE FUNCTION public.agency_invite_client_org(
  p_client_org_name text,
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
  v_client_org_id uuid;
  v_client_id uuid;
  v_new_user_id uuid;
BEGIN
  -- Server-side authorization: only an agency_owner/admin, from an agency
  -- org, may invite a client onto the platform. Enforced here so it can't
  -- be bypassed from the browser even though this function runs with
  -- elevated (definer) privileges.
  SELECT p.role, p.organization_id, o.org_type
  INTO v_caller_role, v_caller_org_id, v_caller_org_type
  FROM public.profiles p
  JOIN public.organizations o ON o.id = p.organization_id
  WHERE p.id = auth.uid();

  IF v_caller_org_type IS DISTINCT FROM 'agency' OR v_caller_role NOT IN ('agency_owner','admin') THEN
    RAISE EXCEPTION 'Only an Agency Owner/Admin can invite a client to the platform';
  END IF;

  IF p_client_org_name IS NULL OR btrim(p_client_org_name) = '' THEN
    RAISE EXCEPTION 'Client organization name is required';
  END IF;

  IF EXISTS (SELECT 1 FROM auth.users WHERE email = p_admin_email) THEN
    RAISE EXCEPTION 'A user with this email already exists';
  END IF;

  -- 1. The new Client Organization tenant.
  INSERT INTO public.organizations (name, org_type, default_currency, default_unit)
  VALUES (btrim(p_client_org_name), 'client', 'INR', 'sqft')
  RETURNING id INTO v_client_org_id;

  -- 2. A matching row in the AGENCY's own clients table, so this client
  --    immediately shows up everywhere the agency's existing screens
  --    (Clients, PO client dropdown, Billing) already expect one — and so
  --    a future client-created PO has a client_id to satisfy the NOT NULL
  --    constraint on purchase_orders.client_id.
  INSERT INTO public.clients (
    organization_id, name, contact_person, contact_phone, contact_email, city, state, gst_number
  ) VALUES (
    v_caller_org_id, btrim(p_client_org_name),
    NULLIF(p_contact_person, ''), NULLIF(p_contact_phone, ''), NULLIF(p_contact_email, ''),
    NULLIF(p_city, ''), NULLIF(p_state, ''), NULLIF(p_gst_number, '')
  )
  RETURNING id INTO v_client_id;

  -- 3. The client_admin login itself — same technique admin_create_user
  --    uses (no service_role key available to the browser).
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
    jsonb_build_object('provider', 'email', 'providers', jsonb_build_array('email'), 'role', 'client_admin'),
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
  VALUES (v_new_user_id, v_client_org_id, p_admin_full_name, 'client_admin', NULLIF(p_admin_phone, ''), true, false);

  -- 4. The link itself — agency-initiated, so it goes straight to
  --    'active' (the client can log in and see data immediately; there is
  --    no separate accept step on their side for an agency-created
  --    invite, unlike a client-initiated invite of an agency).
  INSERT INTO public.client_agency_links (client_org_id, agency_org_id, status, invited_by, agency_client_id)
  VALUES (v_client_org_id, v_caller_org_id, 'active', auth.uid(), v_client_id);

  RETURN v_client_org_id;
END;
$$;

REVOKE ALL ON FUNCTION public.agency_invite_client_org(text, text, text, text, text, text, text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.agency_invite_client_org(text, text, text, text, text, text, text, text, text, text, text) TO authenticated;

-- ============ 4. notify_linked_org_users ============
CREATE OR REPLACE FUNCTION public.notify_linked_org_users(
  p_target_org_id uuid,
  p_title text,
  p_message text,
  p_type text DEFAULT 'info',
  p_link text DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_org_id uuid;
  v_count integer;
BEGIN
  SELECT organization_id INTO v_caller_org_id FROM public.profiles WHERE id = auth.uid();

  IF v_caller_org_id IS NULL OR v_caller_org_id = p_target_org_id THEN
    RAISE EXCEPTION 'Invalid notification target';
  END IF;

  -- Only allowed between two orgs that currently have an active link —
  -- this is what stops the function being used to message an unrelated
  -- organization.
  IF NOT EXISTS (
    SELECT 1 FROM public.client_agency_links
    WHERE status = 'active'
      AND (
        (agency_org_id = v_caller_org_id AND client_org_id = p_target_org_id)
        OR (client_org_id = v_caller_org_id AND agency_org_id = p_target_org_id)
      )
  ) THEN
    RAISE EXCEPTION 'No active link between these organizations';
  END IF;

  INSERT INTO public.notifications (organization_id, user_id, title, message, type, link)
  SELECT p_target_org_id, id, p_title, p_message, p_type, p_link
  FROM public.profiles
  WHERE organization_id = p_target_org_id AND is_active = true;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.notify_linked_org_users(uuid, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.notify_linked_org_users(uuid, text, text, text, text) TO authenticated;
