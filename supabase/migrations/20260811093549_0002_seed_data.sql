/*
# Seed Data — Organization, Auth Users, Profiles, Clients, Projects, Work Types, Shops
   Uses valid hex UUIDs. Passwords hashed with extensions.crypt(). email in auth.identities is generated.
*/

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ORGANIZATION
INSERT INTO public.organizations (id, name, address, gst_number, default_currency, default_unit, phone, email)
VALUES ('a0000000-0000-0000-0000-000000000001', 'Darshan Ad Agency', 'Plot 14, Industrial Area, Pune, Maharashtra 411019', '27ABCDE1234F1Z5', 'INR', 'ft', '+91 98220 12345', 'info@darshanadagency.com')
ON CONFLICT (id) DO NOTHING;

-- AUTH USERS
-- NOTE: several text columns below (email_change, phone_change, reauthentication_token, etc.)
-- MUST be explicitly set to '' rather than left NULL. Supabase's Auth server (GoTrue) is
-- written in Go and fails with a generic "Database error querying schema" (500) when it
-- scans a NULL value into a non-nullable Go string field for these columns.
INSERT INTO auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change, email_change_token_new,
  email_change_token_current, phone_change, phone_change_token, reauthentication_token
)
VALUES
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner@darshanadagency.com', extensions.crypt('Owner@12345', extensions.gen_salt('bf')), now(), '{"provider":"email","providers":["email"],"role":"agency_owner"}', '{"full_name":"Darshan Owner"}', now(), now(), '', '', '', '', '', '', '', ''),
  ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'demo@darshanadagency.com', extensions.crypt('Demo@2026', extensions.gen_salt('bf')), now(), '{"provider":"email","providers":["email"],"role":"demo"}', '{"full_name":"Demo User"}', now(), now(), '', '', '', '', '', '', '', ''),
  ('10000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'admin@darshanadagency.com', extensions.crypt('Admin@2026', extensions.gen_salt('bf')), now(), '{"provider":"email","providers":["email"],"role":"admin"}', '{"full_name":"Amit Sharma"}', now(), now(), '', '', '', '', '', '', '', ''),
  ('10000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'surveyor1@darshanadagency.com', extensions.crypt('Surveyor@2026', extensions.gen_salt('bf')), now(), '{"provider":"email","providers":["email"],"role":"surveyor"}', '{"full_name":"Rahul Patil","phone":"+919000000001"}', now(), now(), '', '', '', '', '', '', '', ''),
  ('10000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'designer@darshanadagency.com', extensions.crypt('Designer@2026', extensions.gen_salt('bf')), now(), '{"provider":"email","providers":["email"],"role":"designer"}', '{"full_name":"Priya Desai"}', now(), now(), '', '', '', '', '', '', '', ''),
  ('10000000-0000-0000-0000-000000000006', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'printing@darshanadagency.com', extensions.crypt('Printing@2026', extensions.gen_salt('bf')), now(), '{"provider":"email","providers":["email"],"role":"printing"}', '{"full_name":"Suresh Kulkarni"}', now(), now(), '', '', '', '', '', '', '', ''),
  ('10000000-0000-0000-0000-000000000007', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'installer1@darshanadagency.com', extensions.crypt('Installer@2026', extensions.gen_salt('bf')), now(), '{"provider":"email","providers":["email"],"role":"installer"}', '{"full_name":"Vijay More","phone":"+919000000002"}', now(), now(), '', '', '', '', '', '', '', ''),
  ('10000000-0000-0000-0000-000000000008', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'accounts@darshanadagency.com', extensions.crypt('Accounts@2026', extensions.gen_salt('bf')), now(), '{"provider":"email","providers":["email"],"role":"accounts"}', '{"full_name":"Neha Joshi"}', now(), now(), '', '', '', '', '', '', '', '')
ON CONFLICT (id) DO NOTHING;

-- AUTH IDENTITIES (email column is generated from identity_data, must not insert into it)
INSERT INTO auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at)
SELECT id, id, jsonb_build_object('sub', id::text, 'email', email), 'email', now(), now()
FROM auth.users
WHERE id IN ('10000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000004','10000000-0000-0000-0000-000000000005','10000000-0000-0000-0000-000000000006','10000000-0000-0000-0000-000000000007','10000000-0000-0000-0000-000000000008')
ON CONFLICT DO NOTHING;

-- PROFILES
INSERT INTO public.profiles (id, organization_id, full_name, role, phone, is_demo) VALUES
  ('10000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'Darshan Owner', 'agency_owner', null, false),
  ('10000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', 'Demo User', 'demo', null, true),
  ('10000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000001', 'Amit Sharma', 'admin', null, false),
  ('10000000-0000-0000-0000-000000000004', 'a0000000-0000-0000-0000-000000000001', 'Rahul Patil', 'surveyor', '+919000000001', false),
  ('10000000-0000-0000-0000-000000000005', 'a0000000-0000-0000-0000-000000000001', 'Priya Desai', 'designer', null, false),
  ('10000000-0000-0000-0000-000000000006', 'a0000000-0000-0000-0000-000000000001', 'Suresh Kulkarni', 'printing', null, false),
  ('10000000-0000-0000-0000-000000000007', 'a0000000-0000-0000-0000-000000000001', 'Vijay More', 'installer', '+919000000002', false),
  ('10000000-0000-0000-0000-000000000008', 'a0000000-0000-0000-0000-000000000001', 'Neha Joshi', 'accounts', null, false)
ON CONFLICT (id) DO NOTHING;

-- CLIENTS
INSERT INTO public.clients (id, organization_id, name, contact_person, contact_phone, contact_email, address, city, state, gst_number) VALUES
  ('20000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'Mahadhan Fertilizers', 'Rajesh Nair', '+91 98220 11111', 'rajesh@mahadhan.com', 'Nashik Road, Nashik, Maharashtra', 'Nashik', 'Maharashtra', '27MAHAD1234F1Z5'),
  ('20000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', 'Wonder Cement', 'Kavita Rathore', '+91 98220 22222', 'kavita@wondercement.com', 'MIA Alwar, Rajasthan', 'Alwar', 'Rajasthan', '08WONDER5678F1Z2'),
  ('20000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000001', 'Adani Group', 'Sanjay Gupta', '+91 98220 33333', 'sanjay@adani.com', 'Adani House, Ahmedabad, Gujarat', 'Ahmedabad', 'Gujarat', '24ADANI9012F1Z8')
ON CONFLICT (id) DO NOTHING;

-- PROJECTS
INSERT INTO public.projects (id, organization_id, client_id, name, description, start_date, status) VALUES
  ('30000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'Mahadhan Kharif Campaign 2026', 'Dealer boards and glow signs across Nashik district', '2026-06-01', 'active'),
  ('30000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'Mahadhan Rabi Branding', 'Vinyl and flex banners for Rabi season', '2026-07-15', 'active'),
  ('30000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000002', 'Wonder Cement Dealer Network', 'ACP boards and LED boards for all dealers', '2026-06-15', 'active'),
  ('30000000-0000-0000-0000-000000000004', 'a0000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000003', 'Adani Brand Refresh', 'Complete rebranding of Adani retail outlets', '2026-07-01', 'active')
ON CONFLICT (id) DO NOTHING;

-- WORK TYPES
INSERT INTO public.work_types (id, organization_id, name, description) VALUES
  ('40000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'Dealer Board', 'Standard dealer identification board'),
  ('40000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', 'ACP Board', 'Aluminum Composite Panel board'),
  ('40000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000001', 'Foam Sheet', 'Foam sheet printing and mounting'),
  ('40000000-0000-0000-0000-000000000004', 'a0000000-0000-0000-0000-000000000001', 'Sunpack', 'Sunpack sheet printing'),
  ('40000000-0000-0000-0000-000000000005', 'a0000000-0000-0000-0000-000000000001', 'Vinyl', 'Vinyl printing and pasting'),
  ('40000000-0000-0000-0000-000000000006', 'a0000000-0000-0000-0000-000000000001', 'Flex', 'Flex banner printing'),
  ('40000000-0000-0000-0000-000000000007', 'a0000000-0000-0000-0000-000000000001', 'Banner', 'Banner printing'),
  ('40000000-0000-0000-0000-000000000008', 'a0000000-0000-0000-0000-000000000001', 'Glow Sign', 'Glow sign board with backlight'),
  ('40000000-0000-0000-0000-000000000009', 'a0000000-0000-0000-0000-000000000001', 'LED Board', 'LED display board'),
  ('40000000-0000-0000-0000-00000000000a', 'a0000000-0000-0000-0000-000000000001', 'Desk Mat', 'Desk mat printing'),
  ('40000000-0000-0000-0000-00000000000b', 'a0000000-0000-0000-0000-000000000001', 'Acrylic', 'Acrylic board'),
  ('40000000-0000-0000-0000-00000000000c', 'a0000000-0000-0000-0000-000000000001', 'Other', 'Other work type')
ON CONFLICT (id) DO NOTHING;

-- SHOPS (18 shops)
INSERT INTO public.shops (id, organization_id, client_id, project_id, name, owner_name, contact_phone, address, city, district, zone, state, latitude, longitude, status) VALUES
  ('50000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'Mahadhan Krushi Kendra', 'Bharat Jadhav', '+91 98220 30001', 'Main Road, Nashik Road', 'Nashik', 'Nashik', 'Central', 'Maharashtra', 19.9816, 73.7756, 'installed'),
  ('50000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'Shri Ganesh Fertilizers', 'Ganesh Pawar', '+91 98220 30002', 'College Road, Nashik', 'Nashik', 'Nashik', 'North', 'Maharashtra', 20.0090, 73.7913, 'production_done'),
  ('50000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'Sai Krushi Bhandar', 'Sai Deshmukh', '+91 98220 30003', 'Gangapur Road, Nashik', 'Nashik', 'Nashik', 'North', 'Maharashtra', 20.0174, 73.7645, 'design_approved'),
  ('50000000-0000-0000-0000-000000000004', 'a0000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'Balaji Agro Center', 'Balaji Shinde', '+91 98220 30004', 'Sinnar, Nashik', 'Sinnar', 'Nashik', 'South', 'Maharashtra', 19.8376, 73.9912, 'surveyed'),
  ('50000000-0000-0000-0000-000000000005', 'a0000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'Krushi Seva Kendra', 'Mahesh Chaudhari', '+91 98220 30005', 'Malegaon, Nashik', 'Malegaon', 'Nashik', 'North', 'Maharashtra', 20.5555, 74.5239, 'assigned'),
  ('50000000-0000-0000-0000-000000000006', 'a0000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000002', 'Jai Durga Fertilizers', 'Jai Durga Kulkarni', '+91 98220 30006', 'Manmad, Nashik', 'Manmad', 'Nashik', 'North', 'Maharashtra', 20.4239, 74.4902, 'pending'),
  ('50000000-0000-0000-0000-000000000007', 'a0000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000003', 'Shree Cement Store', 'Mohan Lal', '+91 98220 30007', 'Main Bazaar, Alwar', 'Alwar', 'Alwar', 'Central', 'Rajasthan', 27.5700, 76.6250, 'installed'),
  ('50000000-0000-0000-0000-000000000008', 'a0000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000003', 'Raj Cement Depot', 'Raj Verma', '+91 98220 30008', 'Lakher Road, Alwar', 'Alwar', 'Alwar', 'South', 'Rajasthan', 27.5497, 76.6174, 'production_done'),
  ('50000000-0000-0000-0000-000000000009', 'a0000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000003', 'Gupta Cement Agency', 'Gupta Sharma', '+91 98220 30009', 'Kishangarhbas, Alwar', 'Alwar', 'Alwar', 'North', 'Rajasthan', 27.6836, 76.7114, 'design_approved'),
  ('50000000-0000-0000-0000-00000000000a', 'a0000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000003', 'Bansal Hardware & Cement', 'Bansal Jain', '+91 98220 30010', 'Behror, Alwar', 'Behror', 'Alwar', 'South', 'Rajasthan', 27.8800, 76.2836, 'surveyed'),
  ('50000000-0000-0000-0000-00000000000b', 'a0000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000003', 'Sharma Building Material', 'Sharma Singh', '+91 98220 30011', 'Khairtal, Alwar', 'Khairtal', 'Alwar', 'North', 'Rajasthan', 27.5936, 76.4836, 'assigned'),
  ('50000000-0000-0000-0000-00000000000c', 'a0000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000003', 'Vinayak Trading Co', 'Vinayak Kumar', '+91 98220 30012', 'Tijara, Alwar', 'Tijara', 'Alwar', 'South', 'Rajasthan', 27.9336, 76.8500, 'pending'),
  ('50000000-0000-0000-0000-00000000000d', 'a0000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000003', '30000000-0000-0000-0000-000000000004', 'Adani Fuels - CG Road', 'Hardik Patel', '+91 98220 30013', 'CG Road, Navrangpura, Ahmedabad', 'Ahmedabad', 'Ahmedabad', 'Central', 'Gujarat', 23.0395, 72.5663, 'installed'),
  ('50000000-0000-0000-0000-00000000000e', 'a0000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000003', '30000000-0000-0000-0000-000000000004', 'Adani Retail - Satellite', 'Jignesh Mehta', '+91 98220 30014', 'Satellite Road, Ahmedabad', 'Ahmedabad', 'Ahmedabad', 'West', 'Gujarat', 23.0427, 72.5308, 'production_ready'),
  ('50000000-0000-0000-0000-00000000000f', 'a0000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000003', '30000000-0000-0000-0000-000000000004', 'Adani Mart - Bopal', 'Rohan Shah', '+91 98220 30015', 'Bopal, Ahmedabad', 'Ahmedabad', 'Ahmedabad', 'South', 'Gujarat', 23.0269, 72.4675, 'designing'),
  ('50000000-0000-0000-0000-000000000010', 'a0000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000003', '30000000-0000-0000-0000-000000000004', 'Adani Corner - Maninagar', 'Kunal Desai', '+91 98220 30016', 'Maninagar, Ahmedabad', 'Ahmedabad', 'Ahmedabad', 'East', 'Gujarat', 23.0084, 72.5900, 'approval_pending'),
  ('50000000-0000-0000-0000-000000000011', 'a0000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000003', '30000000-0000-0000-0000-000000000004', 'Adani Express - Naroda', 'Ankit Gandhi', '+91 98220 30017', 'Naroda, Ahmedabad', 'Ahmedabad', 'Ahmedabad', 'North', 'Gujarat', 23.0800, 72.6350, 'pending'),
  ('50000000-0000-0000-0000-000000000012', 'a0000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000003', '30000000-0000-0000-0000-000000000004', 'Adani Mart - Vastral', 'Jay Bhatt', '+91 98220 30018', 'Vastral, Ahmedabad', 'Ahmedabad', 'Ahmedabad', 'East', 'Gujarat', 23.0095, 72.6300, 'pending')
ON CONFLICT (id) DO NOTHING;

-- SHOP ASSIGNMENTS
INSERT INTO public.shop_assignments (organization_id, shop_id, user_id, role, status) VALUES
  ('a0000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000005', '10000000-0000-0000-0000-000000000004', 'surveyor', 'accepted'),
  ('a0000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-00000000000b', '10000000-0000-0000-0000-000000000004', 'surveyor', 'accepted'),
  ('a0000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000004', 'surveyor', 'completed'),
  ('a0000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000004', 'surveyor', 'completed'),
  ('a0000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000007', 'installer', 'assigned'),
  ('a0000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000008', '10000000-0000-0000-0000-000000000007', 'installer', 'assigned')
ON CONFLICT DO NOTHING;

-- RATE CARDS
INSERT INTO public.rate_cards (organization_id, client_id, work_type_id, pricing_type, rate) VALUES
  ('a0000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', 'per_sqft', 45),
  ('a0000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000002', 'per_sqft', 85),
  ('a0000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000008', 'per_sqft', 120),
  ('a0000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000002', '40000000-0000-0000-0000-000000000002', 'per_sqft', 90),
  ('a0000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000002', '40000000-0000-0000-0000-000000000009', 'per_piece', 2500),
  ('a0000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000003', '40000000-0000-0000-0000-000000000002', 'per_sqft', 95),
  ('a0000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000003', '40000000-0000-0000-0000-000000000005', 'per_sqft', 35)
ON CONFLICT DO NOTHING;

-- WORK ITEMS
INSERT INTO public.work_items (organization_id, shop_id, work_type_id, work_type_name, material, survey_width, survey_height, survey_unit, survey_quantity, survey_area, survey_notes, status) VALUES
  ('a0000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', 'Dealer Board', 'ACP', 8, 4, 'ft', 1, 32, 'Front facade, clear visibility from road', 'installed'),
  ('a0000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000002', '40000000-0000-0000-0000-000000000002', 'ACP Board', 'ACP 3mm', 6, 3, 'ft', 2, 36, 'Two boards, one on each side', 'produced'),
  ('a0000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000003', '40000000-0000-0000-0000-000000000008', 'Glow Sign', 'Acrylic with LED', 10, 5, 'ft', 1, 50, 'Backlit glow sign board', 'designing'),
  ('a0000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000004', '40000000-0000-0000-0000-000000000005', 'Vinyl', 'Vinyl self adhesive', 12, 4, 'ft', 1, 48, 'Full front vinyl wrap', 'surveyed'),
  ('a0000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000007', '40000000-0000-0000-0000-000000000002', 'ACP Board', 'ACP 4mm', 8, 4, 'ft', 1, 32, 'Main entrance board', 'installed'),
  ('a0000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000008', '40000000-0000-0000-0000-000000000009', 'LED Board', 'LED with programmable display', 6, 3, 'ft', 1, 18, 'LED board for entrance', 'produced'),
  ('a0000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-00000000000a', '40000000-0000-0000-0000-000000000006', 'Flex', 'Flex 12 oz', 10, 4, 'ft', 1, 40, 'Flex banner above entrance', 'surveyed'),
  ('a0000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-00000000000d', '40000000-0000-0000-0000-000000000002', 'ACP Board', 'ACP 3mm', 10, 5, 'ft', 1, 50, 'Main storefront ACP board', 'installed'),
  ('a0000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-00000000000e', '40000000-0000-0000-0000-000000000002', 'ACP Board', 'ACP 4mm', 8, 4, 'ft', 1, 32, 'Storefront with logo', 'produced'),
  ('a0000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-00000000000f', '40000000-0000-0000-0000-000000000005', 'Vinyl', 'Vinyl self adhesive', 15, 5, 'ft', 1, 75, 'Full front vinyl', 'designing'),
  ('a0000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000010', '40000000-0000-0000-0000-000000000008', 'Glow Sign', 'Acrylic with LED', 8, 3, 'ft', 1, 24, 'Glow sign for entrance', 'surveyed')
ON CONFLICT DO NOTHING;