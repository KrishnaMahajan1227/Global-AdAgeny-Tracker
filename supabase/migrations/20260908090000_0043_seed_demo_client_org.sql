/*
# Demo seed — a Client Organization login

  The login page has offered a one-click "Try Demo" (agency side,
  demo@darshanadagency.com) since the app's original single-agency build.
  Now that the platform is a genuine multi-tenant Client + Agency system
  (Phases 1-6), the login page needs an equivalent one-click demo for the
  CLIENT side too, so a first-time visitor can see both halves of the
  platform without anyone having to hand-provision an account for them.

  This is pure seed data — no schema/RLS change. It:
   1. Creates a demo Client Organization ('Mahadhan Fertilizers — Client
      Portal') and its client_admin login, using the exact same
      auth.users/auth.identities technique seed_data.sql (migration 0002)
      already uses for every other demo login.
   2. Links it to the existing demo agency (Darshan Ad Agency,
      'a0000000-0000-0000-0000-000000000001') via an ACTIVE
      client_agency_links row, reusing the agency's existing
      'Mahadhan Fertilizers' clients row (seeded in migration 0002) as
      agency_client_id — exactly the shape agency_invite_client_org
      (migration 0038) would have produced had someone actually run that
      invite flow for this client.

  Idempotent (ON CONFLICT DO NOTHING throughout), safe to re-run.
*/

INSERT INTO public.organizations (id, name, org_type, default_currency, default_unit)
VALUES ('c0000000-0000-0000-0000-000000000001', 'Mahadhan Fertilizers — Client Portal', 'client', 'INR', 'sqft')
ON CONFLICT (id) DO NOTHING;

INSERT INTO auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change, email_change_token_new,
  email_change_token_current, phone_change, phone_change_token, reauthentication_token
)
VALUES
  ('c1000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'client-demo@darshanadagency.com', extensions.crypt('ClientDemo@2026', extensions.gen_salt('bf')), now(),
   '{"provider":"email","providers":["email"],"role":"client_admin"}', '{"full_name":"Rajesh Nair"}',
   now(), now(), '', '', '', '', '', '', '', '')
ON CONFLICT (id) DO NOTHING;

INSERT INTO auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at)
SELECT id, id, jsonb_build_object('sub', id::text, 'email', email), 'email', now(), now()
FROM auth.users
WHERE id = 'c1000000-0000-0000-0000-000000000001'
ON CONFLICT DO NOTHING;

INSERT INTO public.profiles (id, organization_id, full_name, role, is_active, is_demo)
VALUES ('c1000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', 'Rajesh Nair', 'client_admin', true, true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.client_agency_links (client_org_id, agency_org_id, status, agency_client_id)
VALUES (
  'c0000000-0000-0000-0000-000000000001',
  'a0000000-0000-0000-0000-000000000001',
  'active',
  '20000000-0000-0000-0000-000000000001' -- existing 'Mahadhan Fertilizers' clients row, migration 0002
)
ON CONFLICT (client_org_id, agency_org_id) DO NOTHING;
