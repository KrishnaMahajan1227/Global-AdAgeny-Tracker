-- Release safeguard: invalidate ONLY unchanged known seed passwords. Existing users with
-- custom passwords are untouched. These accounts will need admin-driven reset.
-- Apply after securing a verified Supabase Auth administrator recovery path.
DO $credential_rotation$
DECLARE v_count int;
BEGIN
  UPDATE auth.users SET encrypted_password=extensions.crypt(encode(extensions.gen_random_bytes(32),'hex'),extensions.gen_salt('bf')), updated_at=now()
  WHERE lower(email)=lower('owner@darshanadagency.com') AND encrypted_password=extensions.crypt('Owner@12345',encrypted_password);
  GET DIAGNOSTICS v_count=ROW_COUNT;
  IF v_count>0 THEN RAISE NOTICE 'A known seed credential was disabled; reset the affected account before login'; END IF;
  UPDATE auth.users SET encrypted_password=extensions.crypt(encode(extensions.gen_random_bytes(32),'hex'),extensions.gen_salt('bf')), updated_at=now()
  WHERE lower(email)=lower('demo@darshanadagency.com') AND encrypted_password=extensions.crypt('Demo@2026',encrypted_password);
  GET DIAGNOSTICS v_count=ROW_COUNT;
  IF v_count>0 THEN RAISE NOTICE 'A known seed credential was disabled; reset the affected account before login'; END IF;
  UPDATE auth.users SET encrypted_password=extensions.crypt(encode(extensions.gen_random_bytes(32),'hex'),extensions.gen_salt('bf')), updated_at=now()
  WHERE lower(email)=lower('admin@darshanadagency.com') AND encrypted_password=extensions.crypt('Admin@2026',encrypted_password);
  GET DIAGNOSTICS v_count=ROW_COUNT;
  IF v_count>0 THEN RAISE NOTICE 'A known seed credential was disabled; reset the affected account before login'; END IF;
  UPDATE auth.users SET encrypted_password=extensions.crypt(encode(extensions.gen_random_bytes(32),'hex'),extensions.gen_salt('bf')), updated_at=now()
  WHERE lower(email)=lower('surveyor1@darshanadagency.com') AND encrypted_password=extensions.crypt('Surveyor@2026',encrypted_password);
  GET DIAGNOSTICS v_count=ROW_COUNT;
  IF v_count>0 THEN RAISE NOTICE 'A known seed credential was disabled; reset the affected account before login'; END IF;
  UPDATE auth.users SET encrypted_password=extensions.crypt(encode(extensions.gen_random_bytes(32),'hex'),extensions.gen_salt('bf')), updated_at=now()
  WHERE lower(email)=lower('designer@darshanadagency.com') AND encrypted_password=extensions.crypt('Designer@2026',encrypted_password);
  GET DIAGNOSTICS v_count=ROW_COUNT;
  IF v_count>0 THEN RAISE NOTICE 'A known seed credential was disabled; reset the affected account before login'; END IF;
  UPDATE auth.users SET encrypted_password=extensions.crypt(encode(extensions.gen_random_bytes(32),'hex'),extensions.gen_salt('bf')), updated_at=now()
  WHERE lower(email)=lower('printing@darshanadagency.com') AND encrypted_password=extensions.crypt('Printing@2026',encrypted_password);
  GET DIAGNOSTICS v_count=ROW_COUNT;
  IF v_count>0 THEN RAISE NOTICE 'A known seed credential was disabled; reset the affected account before login'; END IF;
  UPDATE auth.users SET encrypted_password=extensions.crypt(encode(extensions.gen_random_bytes(32),'hex'),extensions.gen_salt('bf')), updated_at=now()
  WHERE lower(email)=lower('installer1@darshanadagency.com') AND encrypted_password=extensions.crypt('Installer@2026',encrypted_password);
  GET DIAGNOSTICS v_count=ROW_COUNT;
  IF v_count>0 THEN RAISE NOTICE 'A known seed credential was disabled; reset the affected account before login'; END IF;
  UPDATE auth.users SET encrypted_password=extensions.crypt(encode(extensions.gen_random_bytes(32),'hex'),extensions.gen_salt('bf')), updated_at=now()
  WHERE lower(email)=lower('accounts@darshanadagency.com') AND encrypted_password=extensions.crypt('Accounts@2026',encrypted_password);
  GET DIAGNOSTICS v_count=ROW_COUNT;
  IF v_count>0 THEN RAISE NOTICE 'A known seed credential was disabled; reset the affected account before login'; END IF;
  UPDATE auth.users SET encrypted_password=extensions.crypt(encode(extensions.gen_random_bytes(32),'hex'),extensions.gen_salt('bf')), updated_at=now()
  WHERE lower(email)=lower('client-demo@darshanadagency.com') AND encrypted_password=extensions.crypt('ClientDemo@2026',encrypted_password);
  GET DIAGNOSTICS v_count=ROW_COUNT;
  IF v_count>0 THEN RAISE NOTICE 'A known seed credential was disabled; reset the affected account before login'; END IF;
  UPDATE auth.users SET encrypted_password=extensions.crypt(encode(extensions.gen_random_bytes(32),'hex'),extensions.gen_salt('bf')), updated_at=now()
  WHERE lower(email)=lower('mahajankrishna2212@gmail.com') AND encrypted_password=extensions.crypt('SuperAdmin@2026',encrypted_password);
  GET DIAGNOSTICS v_count=ROW_COUNT;
  IF v_count>0 THEN RAISE NOTICE 'A known seed credential was disabled; reset the affected account before login'; END IF;
END $credential_rotation$;
