-- Owner-only credential reset. Never returns, reads or logs existing passwords.
CREATE OR REPLACE FUNCTION public.owner_reset_team_password(p_user_id uuid, p_new_password text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth, extensions AS $$
DECLARE
  v_org uuid;
  v_target_org uuid;
  v_target_role text;
BEGIN
  SELECT organization_id INTO v_org FROM public.profiles
  WHERE id = auth.uid() AND role = 'agency_owner' AND is_active = true;
  IF v_org IS NULL THEN RAISE EXCEPTION 'Only an active agency owner can reset team passwords'; END IF;
  SELECT organization_id, role INTO v_target_org, v_target_role FROM public.profiles WHERE id = p_user_id;
  IF v_target_org IS DISTINCT FROM v_org OR v_target_role = 'agency_owner' OR v_target_org IS NULL THEN
    RAISE EXCEPTION 'Target account is not eligible for reset';
  END IF;
  IF p_new_password IS NULL OR length(p_new_password) < 12 OR length(p_new_password) > 128 THEN
    RAISE EXCEPTION 'Password length must be between 12 and 128 characters';
  END IF;
  UPDATE auth.users SET encrypted_password = extensions.crypt(p_new_password, extensions.gen_salt('bf')),
    updated_at = now() WHERE id = p_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Authentication account not found'; END IF;
  INSERT INTO public.audit_logs (organization_id, user_id, table_name, record_id, action, field_name, description)
  VALUES (v_org, auth.uid(), 'profiles', p_user_id, 'update', 'password', 'Agency owner reset a team member password');
END;
$$;
REVOKE ALL ON FUNCTION public.owner_reset_team_password(uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.owner_reset_team_password(uuid,text) TO authenticated;
