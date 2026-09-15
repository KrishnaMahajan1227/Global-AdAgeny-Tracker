/*
# Phase 21 — Client-initiated "Link an Agency" (self-serve, by invite code)

## The actual block
Today the ONLY way a client_org ever gets an active `client_agency_links`
row is if an agency proactively runs `agency_invite_client_org(...)` for
them (migration 0038) — that RPC creates the client org's very first
login AND an ACTIVE link, atomically, in one step. That's fine for the
common case. But it means: once a client_admin is logged in, if their
org's link is ever missing/paused/revoked for any reason, there has never
been any way for the client to fix that themselves — "New Campaign / PO"
stays permanently disabled with no path forward, since it requires at
least one agency with an ACTIVE link + a resolved `agency_client_id`.
This was flagged as a known gap in 0039's own header comment ("client-
initiated Invite Agency needs a lookup-by-code RPC not built yet —
client_agency_links can still be inserted directly by a client_admin per
0037's insert policy once that RPC exists").

## Design
1. `organizations.agency_invite_code` — a short, unique, human-shareable
   code, auto-generated for every agency org (existing + future, via
   trigger). An agency owner can read their own org's code (existing
   `orgs_select` RLS already covers "your own org", nothing new needed)
   and hand it to a client the same way a person shares a room code.
2. `client_request_agency_link(p_invite_code, ...)` — client_admin calls
   this themselves. Resolves the code to an agency org, and inserts a
   `client_agency_links` row at status='invited' (never 'active' —
   0037's insert policy technically allows a client to set any status,
   but this RPC deliberately always writes 'invited' so an agency still
   has to actively accept before any of their internal `clients` data or
   PO pipeline is touched). Notifies the agency's owner/admin users.
   Idempotent-ish: re-requesting after a 'paused'/'revoked' link just
   flips that same row back to 'invited' rather than erroring on the
   existing unique (client_org_id, agency_org_id) index.
3. `agency_accept_client_link(p_link_id, ...)` — the agency-side mirror.
   Only an agency_owner/admin from the link's own agency_org_id may call
   it, and only on a link currently at status='invited'. Creates the
   matching internal `clients` row (so this client immediately shows up
   everywhere the agency's existing PO/billing screens already expect
   one — same reason `agency_invite_client_org` does this), sets
   `agency_client_id`, flips status to 'active', and notifies the
   client's users. Rejecting a request needs no new RPC — the existing
   `client_agency_links_update` policy already lets an agency_owner/admin
   flip a link they own straight to 'revoked' (same UPDATE the agency
   side already uses for Pause/Reactivate).
*/

-- ============ 1. agency_invite_code ============
ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS agency_invite_code text;

CREATE UNIQUE INDEX IF NOT EXISTS uq_organizations_agency_invite_code
  ON public.organizations(agency_invite_code) WHERE agency_invite_code IS NOT NULL;

CREATE OR REPLACE FUNCTION public.generate_agency_invite_code()
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_chars text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; -- no 0/O/1/I — avoids ambiguous-looking codes
  v_code text;
  v_exists boolean;
BEGIN
  LOOP
    v_code := '';
    FOR i IN 1..7 LOOP
      v_code := v_code || substr(v_chars, floor(random() * length(v_chars) + 1)::int, 1);
    END LOOP;
    SELECT EXISTS (SELECT 1 FROM public.organizations WHERE agency_invite_code = v_code) INTO v_exists;
    EXIT WHEN NOT v_exists;
  END LOOP;
  RETURN v_code;
END;
$$;

CREATE OR REPLACE FUNCTION public.assign_agency_invite_code()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.org_type = 'agency' AND NEW.agency_invite_code IS NULL THEN
    NEW.agency_invite_code := public.generate_agency_invite_code();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_assign_agency_invite_code ON public.organizations;
CREATE TRIGGER trg_assign_agency_invite_code
  BEFORE INSERT ON public.organizations
  FOR EACH ROW EXECUTE FUNCTION public.assign_agency_invite_code();

-- Backfill every existing agency org that doesn't have one yet.
UPDATE public.organizations
SET agency_invite_code = public.generate_agency_invite_code()
WHERE org_type = 'agency' AND agency_invite_code IS NULL;

-- ============ 2. client_request_agency_link ============
CREATE OR REPLACE FUNCTION public.client_request_agency_link(
  p_invite_code text,
  p_contact_person text DEFAULT NULL,
  p_contact_phone text DEFAULT NULL,
  p_contact_email text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_role text;
  v_caller_org_id uuid;
  v_caller_org_type text;
  v_agency_org_id uuid;
  v_agency_name text;
  v_existing_status text;
  v_link_id uuid;
BEGIN
  SELECT p.role, p.organization_id, o.org_type
  INTO v_caller_role, v_caller_org_id, v_caller_org_type
  FROM public.profiles p
  JOIN public.organizations o ON o.id = p.organization_id
  WHERE p.id = auth.uid();

  IF v_caller_org_type IS DISTINCT FROM 'client' OR v_caller_role <> 'client_admin' THEN
    RAISE EXCEPTION 'Only a Client Admin can request to link an agency';
  END IF;

  SELECT id, name INTO v_agency_org_id, v_agency_name
  FROM public.organizations
  WHERE org_type = 'agency' AND agency_invite_code = upper(btrim(p_invite_code));

  IF v_agency_org_id IS NULL THEN
    RAISE EXCEPTION 'Invite code not recognised. Double-check it with the agency.';
  END IF;

  SELECT id, status INTO v_link_id, v_existing_status
  FROM public.client_agency_links
  WHERE client_org_id = v_caller_org_id AND agency_org_id = v_agency_org_id;

  IF v_existing_status = 'active' THEN
    RAISE EXCEPTION 'You are already linked to %', v_agency_name;
  ELSIF v_existing_status = 'invited' THEN
    RAISE EXCEPTION 'A request to link % is already waiting on their approval', v_agency_name;
  ELSIF v_link_id IS NOT NULL THEN
    -- Was paused/revoked — re-request rather than violating the unique
    -- (client_org_id, agency_org_id) index with a second row.
    UPDATE public.client_agency_links
    SET status = 'invited', invited_by = auth.uid()
    WHERE id = v_link_id;
  ELSE
    INSERT INTO public.client_agency_links (client_org_id, agency_org_id, status, invited_by)
    VALUES (v_caller_org_id, v_agency_org_id, 'invited', auth.uid())
    RETURNING id INTO v_link_id;
  END IF;

  -- Best-effort notify — every active agency_owner/admin at the target
  -- agency. Not routed through notify_linked_org_users() since that
  -- function requires an ACTIVE link first, which doesn't exist yet at
  -- this point (this notification IS the request).
  INSERT INTO public.notifications (organization_id, user_id, title, message, type, link)
  SELECT v_agency_org_id, p.id,
    'New client link request',
    coalesce(p_contact_person, '') || ' has requested to link their organization with you on the platform.',
    'info', '/owner-console'
  FROM public.profiles p
  WHERE p.organization_id = v_agency_org_id AND p.role IN ('agency_owner', 'admin') AND p.is_active = true;

  RETURN v_link_id;
END;
$$;

REVOKE ALL ON FUNCTION public.client_request_agency_link(text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.client_request_agency_link(text, text, text, text) TO authenticated;

-- ============ 3. agency_accept_client_link ============
CREATE OR REPLACE FUNCTION public.agency_accept_client_link(
  p_link_id uuid,
  p_contact_person text DEFAULT NULL,
  p_contact_phone text DEFAULT NULL,
  p_contact_email text DEFAULT NULL,
  p_gst_number text DEFAULT NULL,
  p_city text DEFAULT NULL,
  p_state text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_role text;
  v_caller_org_id uuid;
  v_link record;
  v_client_org_name text;
  v_client_id uuid;
BEGIN
  SELECT p.role, p.organization_id INTO v_caller_role, v_caller_org_id
  FROM public.profiles p WHERE p.id = auth.uid();

  IF v_caller_role NOT IN ('agency_owner', 'admin') THEN
    RAISE EXCEPTION 'Only an Agency Owner/Admin can accept a client link request';
  END IF;

  SELECT * INTO v_link FROM public.client_agency_links WHERE id = p_link_id;
  IF v_link IS NULL OR v_link.agency_org_id <> v_caller_org_id THEN
    RAISE EXCEPTION 'Link request not found';
  END IF;
  IF v_link.status <> 'invited' THEN
    RAISE EXCEPTION 'This request is not pending anymore';
  END IF;

  SELECT name INTO v_client_org_name FROM public.organizations WHERE id = v_link.client_org_id;

  INSERT INTO public.clients (organization_id, name, contact_person, contact_phone, contact_email, city, state, gst_number)
  VALUES (
    v_caller_org_id, v_client_org_name,
    NULLIF(p_contact_person, ''), NULLIF(p_contact_phone, ''), NULLIF(p_contact_email, ''),
    NULLIF(p_city, ''), NULLIF(p_state, ''), NULLIF(p_gst_number, '')
  )
  RETURNING id INTO v_client_id;

  UPDATE public.client_agency_links
  SET status = 'active', agency_client_id = v_client_id
  WHERE id = p_link_id;

  INSERT INTO public.notifications (organization_id, user_id, title, message, type, link)
  SELECT v_link.client_org_id, p.id,
    'Agency link accepted',
    'You are now linked and can create campaigns/POs with this agency.',
    'success', '/client/agencies'
  FROM public.profiles p
  WHERE p.organization_id = v_link.client_org_id AND p.role = 'client_admin' AND p.is_active = true;

  RETURN v_client_id;
END;
$$;

REVOKE ALL ON FUNCTION public.agency_accept_client_link(uuid, text, text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.agency_accept_client_link(uuid, text, text, text, text, text, text) TO authenticated;
