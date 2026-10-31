-- Prevent inactive-account or unauthorized cross-org notifications through definer RPC.
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
  v_target_org_type text;
  v_count integer;
BEGIN
  IF public.current_role() NOT IN ('agency_owner','admin','client_admin')
     OR NOT public.current_is_active() THEN
    RAISE EXCEPTION 'Only active authorized administrators can send cross-org notifications' USING ERRCODE='42501';
  END IF;
  IF length(p_title)>160 OR length(p_message)>2000 OR length(COALESCE(p_link,''))>500 THEN
    RAISE EXCEPTION 'Notification too long';
  END IF;
  v_caller_org_id := public.current_org_id();

  IF v_caller_org_id IS NULL OR v_caller_org_id = p_target_org_id THEN
    RAISE EXCEPTION 'Invalid notification target';
  END IF;

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

  SELECT org_type INTO v_target_org_type FROM public.organizations WHERE id = p_target_org_id;

  -- Only the role that can actually act on a PO/campaign in the target
  -- org: client_admin on the client side, agency_owner/admin on the
  -- agency side. client_viewer and every operational agency role
  -- (designer/printing/installer/surveyor/accounts) never had a reason
  -- to receive these.
  INSERT INTO public.notifications (organization_id, user_id, title, message, type, link)
  SELECT p_target_org_id, id, p_title, p_message, p_type, p_link
  FROM public.profiles
  WHERE organization_id = p_target_org_id
    AND is_active = true
    AND role = ANY (
      CASE v_target_org_type
        WHEN 'client' THEN ARRAY['client_admin']
        ELSE ARRAY['agency_owner', 'admin']
      END
    );

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;
REVOKE ALL ON FUNCTION public.notify_linked_org_users(uuid,text,text,text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.notify_linked_org_users(uuid,text,text,text,text) TO authenticated;

-- Validate user credentials within the privileged platform RPCs.
-- Existing UI sends passwords through HTTPS to a SECURITY DEFINER routine;
-- no password is ever returned or logged.
