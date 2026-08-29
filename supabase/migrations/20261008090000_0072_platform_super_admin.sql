/*
# Platform Super Admin

A new account type that sits ABOVE every organization instead of
belonging to one — for running this platform as a subscription business:
seeing every agency and client org that exists, who's linked to whom,
how much work each is actually doing (counts only — never rates,
invoices, or rupee figures), and turning an organization's subscription
on/off.

## Design
- `profiles.role` gains 'super_admin'. `profiles.organization_id` was
  already nullable, so a super admin is just a profile row with
  organization_id = NULL — reuses the exact same auth/session plumbing
  every other role already goes through, no parallel login system.
- `public.current_is_super_admin()` — SECURITY DEFINER helper, same
  shape as current_org_id()/current_role() already in this schema.
- Every new RLS policy below is ADDITIVE (a new policy alongside the
  existing ones, not a replacement) — Postgres OR's permissive policies
  for the same command together, so this can only ever grant the super
  admin extra visibility, never narrow what any existing role can already
  see. Existing org-scoped policies are untouched.
- `organizations` gains subscription tracking columns — this is the
  on/off switch for "is this org actually allowed to use the product",
  independent of anything else in the schema.
- Deliberately NOT granted: rate_cards, invoices, invoice_items,
  po_line_items' rate/budget columns — a super admin running the
  business side of this platform has no reason to see any individual
  agency's client pricing, and explicitly shouldn't.
*/

-- ============ 1. profiles.role gains 'super_admin' ============
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_role_check;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_role_check
  CHECK (role IN ('agency_owner','admin','client_manager','surveyor','designer','printing','installer','accounts','demo','client_admin','client_viewer','super_admin'));

-- ============ 2. organizations — subscription tracking ============
ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS subscription_status text NOT NULL DEFAULT 'trial'
    CHECK (subscription_status IN ('trial', 'active', 'inactive', 'suspended')),
  ADD COLUMN IF NOT EXISTS subscription_plan text,
  ADD COLUMN IF NOT EXISTS subscription_notes text,
  ADD COLUMN IF NOT EXISTS subscription_updated_at timestamptz;

COMMENT ON COLUMN public.organizations.subscription_status IS
  'trial = new, not yet a paying customer. active = paying / allowed to use the product. inactive = the org itself paused it. suspended = platform-side shutoff by a Super Admin (e.g. non-payment).';

-- ============ 3. current_is_super_admin() ============
CREATE OR REPLACE FUNCTION public.current_is_super_admin()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'super_admin'
  );
$$;

-- ============ 4. Additive cross-org SELECT policies for Super Admin ============
-- Counts-and-relationships only — every table below is read for "how many
-- / who's linked to whom", never for money. rate_cards/invoices/
-- invoice_items are deliberately excluded from this list.

DROP POLICY IF EXISTS "orgs_select_super_admin" ON public.organizations;
CREATE POLICY "orgs_select_super_admin" ON public.organizations FOR SELECT
  TO authenticated USING (public.current_is_super_admin());

DROP POLICY IF EXISTS "orgs_update_super_admin" ON public.organizations;
CREATE POLICY "orgs_update_super_admin" ON public.organizations FOR UPDATE
  TO authenticated USING (public.current_is_super_admin());

DROP POLICY IF EXISTS "profiles_select_super_admin" ON public.profiles;
CREATE POLICY "profiles_select_super_admin" ON public.profiles FOR SELECT
  TO authenticated USING (public.current_is_super_admin());

DROP POLICY IF EXISTS "clients_select_super_admin" ON public.clients;
CREATE POLICY "clients_select_super_admin" ON public.clients FOR SELECT
  TO authenticated USING (public.current_is_super_admin());

DROP POLICY IF EXISTS "projects_select_super_admin" ON public.projects;
CREATE POLICY "projects_select_super_admin" ON public.projects FOR SELECT
  TO authenticated USING (public.current_is_super_admin());

DROP POLICY IF EXISTS "purchase_orders_select_super_admin" ON public.purchase_orders;
CREATE POLICY "purchase_orders_select_super_admin" ON public.purchase_orders FOR SELECT
  TO authenticated USING (public.current_is_super_admin());

DROP POLICY IF EXISTS "shops_select_super_admin" ON public.shops;
CREATE POLICY "shops_select_super_admin" ON public.shops FOR SELECT
  TO authenticated USING (public.current_is_super_admin());

DROP POLICY IF EXISTS "work_items_select_super_admin" ON public.work_items;
CREATE POLICY "work_items_select_super_admin" ON public.work_items FOR SELECT
  TO authenticated USING (public.current_is_super_admin());

DROP POLICY IF EXISTS "client_agency_links_select_super_admin" ON public.client_agency_links;
CREATE POLICY "client_agency_links_select_super_admin" ON public.client_agency_links FOR SELECT
  TO authenticated USING (public.current_is_super_admin());

-- ============ 5. Seed the actual Super Admin login ============
-- Same auth.users/auth.identities technique already used for every other
-- seeded login in this codebase (see migration 0002, 0043) — but written
-- to also handle the case where this email already has an auth.users row
-- (e.g. someone signed up with it before this migration ran, or a prior
-- partial run of this same migration got interrupted after creating the
-- user but before this statement). In that case we just take over the
-- existing account — reset its password to the one below and make sure
-- its profile is the super_admin — instead of trying to insert a second
-- row with the same email, which the email-uniqueness constraint on
-- auth.users correctly rejects.
DO $$
DECLARE
  v_user_id uuid;
BEGIN
  SELECT id INTO v_user_id FROM auth.users WHERE email = 'mahajankrishna2212@gmail.com';

  IF v_user_id IS NULL THEN
    v_user_id := '00000000-0000-0000-0000-00000000a001';

    INSERT INTO auth.users (
      id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
      confirmation_token, recovery_token, email_change, email_change_token_new,
      email_change_token_current, phone_change, phone_change_token, reauthentication_token
    )
    VALUES (
      v_user_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
      'mahajankrishna2212@gmail.com', extensions.crypt('SuperAdmin@2026', extensions.gen_salt('bf')), now(),
      '{"provider":"email","providers":["email"],"role":"super_admin"}', '{"full_name":"Krishna Mahajan"}',
      now(), now(), '', '', '', '', '', '', '', ''
    );

    INSERT INTO auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at)
    VALUES (v_user_id, v_user_id, jsonb_build_object('sub', v_user_id::text, 'email', 'mahajankrishna2212@gmail.com'), 'email', now(), now())
    ON CONFLICT DO NOTHING;
  ELSE
    -- Account already existed — bring it in line with what this migration
    -- documents as the Super Admin login, so the password in the handoff
    -- notes actually works regardless of how the account first got created.
    UPDATE auth.users
    SET encrypted_password = extensions.crypt('SuperAdmin@2026', extensions.gen_salt('bf')),
        email_confirmed_at = COALESCE(email_confirmed_at, now())
    WHERE id = v_user_id;
  END IF;

  INSERT INTO public.profiles (id, organization_id, full_name, role, is_active, is_demo)
  VALUES (v_user_id, NULL, 'Krishna Mahajan', 'super_admin', true, false)
  ON CONFLICT (id) DO UPDATE SET role = 'super_admin', organization_id = NULL, is_active = true;
END $$;
