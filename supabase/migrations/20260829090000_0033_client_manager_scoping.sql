/*
# Phase — Client Manager scoped to their own client (Section 9 gap)

  ARCHITECTURE doc Section 9 (Role-Screen Data Visibility matrix) lists
  `client_manager` as seeing only "their client's" shops/PO/rate/billing
  data. Migration 0029 (Phase H) correctly kept `client_manager` in the
  list of roles allowed to see financial data at all, but never actually
  scoped it to one client — every `client_manager` account could see every
  client's PO/invoice/rate data org-wide, because `profiles` had no
  `client_id` column to scope by. Flagged explicitly in 0029's own
  CHANGES.md entry as a known gap; closed here.

  DESIGN — backward compatible, opt-in scoping:
  - `profiles.client_id` is nullable. An agency_owner assigns it per
    client_manager account from Owner Console (User Management).
  - If a client_manager's `client_id` IS NULL (not yet assigned — e.g. an
    account created before this migration, or one deliberately meant to
    see all clients), RLS falls back to the old org-wide behaviour for
    that account. This means running this migration does not silently
    lock out any existing client_manager login — an Owner has to
    deliberately assign a client to actually narrow anyone's access.
  - Once a client_id IS set on a client_manager profile, that account is
    hard-restricted at the RLS layer (not just the UI) to rows belonging
    to that client, on every table this migration touches.
  - Every other role is completely unaffected — the added condition is
    only ever evaluated for `current_role() = 'client_manager'`.
*/

-- ============ profiles: client_id ============
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS client_id uuid REFERENCES public.clients(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_profiles_client_id ON public.profiles(client_id);

-- ============ helper: current_client_id() ============
CREATE OR REPLACE FUNCTION public.current_client_id()
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT client_id FROM public.profiles WHERE id = auth.uid();
$$;

-- ============ clients: a scoped client_manager only sees their own row ============
DROP POLICY IF EXISTS "clients_select" ON public.clients;
CREATE POLICY "clients_select" ON public.clients FOR SELECT
  TO authenticated USING (
    organization_id = public.current_org_id()
    AND (
      public.current_role() <> 'client_manager'
      OR public.current_client_id() IS NULL
      OR id = public.current_client_id()
    )
  );

-- ============ projects ============
DROP POLICY IF EXISTS "projects_select" ON public.projects;
CREATE POLICY "projects_select" ON public.projects FOR SELECT
  TO authenticated USING (
    organization_id = public.current_org_id()
    AND (
      public.current_role() <> 'client_manager'
      OR public.current_client_id() IS NULL
      OR client_id = public.current_client_id()
    )
  );

-- ============ shops ============
-- Every other role keeps org-wide read (surveyor/installer/production need
-- to see shops outside a client scope for their own assigned-work queries)
-- — only client_manager gets the extra restriction.
DROP POLICY IF EXISTS "shops_select" ON public.shops;
CREATE POLICY "shops_select" ON public.shops FOR SELECT
  TO authenticated USING (
    organization_id = public.current_org_id()
    AND (
      public.current_role() <> 'client_manager'
      OR public.current_client_id() IS NULL
      OR client_id = public.current_client_id()
    )
  );

-- ============ purchase_orders (re-tighten on top of Phase H's 0029 policy) ============
DROP POLICY IF EXISTS "purchase_orders_select" ON public.purchase_orders;
CREATE POLICY "purchase_orders_select" ON public.purchase_orders FOR SELECT
  TO authenticated USING (
    organization_id = public.current_org_id()
    AND public.current_role() IN ('agency_owner','admin','accounts','client_manager')
    AND (
      public.current_role() <> 'client_manager'
      OR public.current_client_id() IS NULL
      OR client_id = public.current_client_id()
    )
  );

-- ============ po_line_items (client_id lives on the parent PO) ============
DROP POLICY IF EXISTS "po_line_items_select" ON public.po_line_items;
CREATE POLICY "po_line_items_select" ON public.po_line_items FOR SELECT
  TO authenticated USING (
    organization_id = public.current_org_id()
    AND public.current_role() IN ('agency_owner','admin','accounts','client_manager')
    AND (
      public.current_role() <> 'client_manager'
      OR public.current_client_id() IS NULL
      OR EXISTS (
        SELECT 1 FROM public.purchase_orders po
        WHERE po.id = po_line_items.purchase_order_id
          AND po.client_id = public.current_client_id()
      )
    )
  );

-- ============ rate_cards (client_id nullable = org-wide default rate) ============
DROP POLICY IF EXISTS "rate_cards_select" ON public.rate_cards;
CREATE POLICY "rate_cards_select" ON public.rate_cards FOR SELECT
  TO authenticated USING (
    organization_id = public.current_org_id()
    AND public.current_role() IN ('agency_owner','admin','accounts','client_manager')
    AND (
      public.current_role() <> 'client_manager'
      OR public.current_client_id() IS NULL
      OR client_id IS NULL
      OR client_id = public.current_client_id()
    )
  );

-- ============ invoices ============
DROP POLICY IF EXISTS "invoices_select" ON public.invoices;
CREATE POLICY "invoices_select" ON public.invoices FOR SELECT
  TO authenticated USING (
    organization_id = public.current_org_id()
    AND public.current_role() IN ('agency_owner','admin','accounts','client_manager')
    AND (
      public.current_role() <> 'client_manager'
      OR public.current_client_id() IS NULL
      OR client_id = public.current_client_id()
    )
  );

-- ============ invoice_items (client_id lives on the parent invoice) ============
DROP POLICY IF EXISTS "invoice_items_select" ON public.invoice_items;
CREATE POLICY "invoice_items_select" ON public.invoice_items FOR SELECT
  TO authenticated USING (
    organization_id = public.current_org_id()
    AND public.current_role() IN ('agency_owner','admin','accounts','client_manager')
    AND (
      public.current_role() <> 'client_manager'
      OR public.current_client_id() IS NULL
      OR EXISTS (
        SELECT 1 FROM public.invoices inv
        WHERE inv.id = invoice_items.invoice_id
          AND inv.client_id = public.current_client_id()
      )
    )
  );

-- ============ admin_create_user: accept an optional client_id ============
-- Owner Console's "Add User" form can now assign a client at creation time
-- when role = client_manager. The old 5-argument signature is dropped (not
-- just replaced) so there is only ever one version of this function to
-- resolve against — otherwise Postgres would keep both overloads and a
-- 5-arg call from anywhere still on the old signature would silently never
-- write client_id.
DROP FUNCTION IF EXISTS public.admin_create_user(text, text, text, text, text);

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
  SELECT role, organization_id INTO v_caller_role, v_org_id
  FROM public.profiles
  WHERE id = auth.uid();

  IF v_caller_role IS DISTINCT FROM 'agency_owner' THEN
    RAISE EXCEPTION 'Only the Agency Owner can create users';
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

REVOKE ALL ON FUNCTION public.admin_create_user(text, text, text, text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_create_user(text, text, text, text, text, uuid) TO authenticated;
