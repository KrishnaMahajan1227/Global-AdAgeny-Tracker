/*
# Fix over-broad cross-org notifications

## The bug
Every notification path *within* one organization already targets the
right person or role — a single user (`createNotification`), or
specifically `agency_owner`/`admin` for review-type events (survey
submitted, installation awaiting approval, design ready for review, and
so on). That part of the app was correct.

The three functions below are the exception, and they're exactly the
ones that fire on cross-org (agency <-> client) events — the most
frequent, automatic ones a client org sees:

1. `notify_linked_org_users()` — the generic RPC behind "PO accepted/
   rejected/deleted" notifications (migration 0038).
2. `notify_client_on_shop_stage_change()` — trigger on `shops`, fires on
   every survey-completed / design-approved / installed / dispatched
   milestone (migration 0042).
3. `notify_client_on_invoice_event()` — trigger on `invoices`, fires on
   every invoice raised / paid (migration 0042).

All three did `WHERE organization_id = <target> AND is_active = true`
with no role filter — every active login in the target org got every
one of these, including roles that can't act on any of it. On the
agency side that's every designer/production/installer/surveyor seeing
client billing and PO traffic that's none of their business; on the
client side it's every `client_viewer` getting paged for milestones only
a `client_admin` can do anything about.

Compare this to the *other* cross-org functions added later in the same
feature area (migration 0050's `client_request_agency_link` /
`agency_accept_client_link`), which already correctly filter to
`role IN ('agency_owner','admin')` / `role = 'client_admin'` — this
migration just brings these three up to that same, already-established
pattern. Nothing about who gets notified *within* an org changes; this
is purely the cross-org broadcast radius.
*/

-- ============================================================
-- 1. notify_linked_org_users — now role-aware per org_type
-- ============================================================
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
  SELECT organization_id INTO v_caller_org_id FROM public.profiles WHERE id = auth.uid();

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

-- ============================================================
-- 2. notify_client_on_shop_stage_change — client_admin only
-- ============================================================
CREATE OR REPLACE FUNCTION public.notify_client_on_shop_stage_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_client_org_id uuid;
  v_title text;
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;
  IF NEW.purchase_order_id IS NULL THEN
    RETURN NEW;
  END IF;

  v_title := CASE NEW.status
    WHEN 'surveyed' THEN 'Survey completed'
    WHEN 'design_approved' THEN 'Design approved'
    WHEN 'installed' THEN 'Site installed'
    WHEN 'dispatched' THEN 'Order dispatched'
    ELSE NULL
  END;
  IF v_title IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT po.client_org_id INTO v_client_org_id
  FROM public.purchase_orders po
  WHERE po.id = NEW.purchase_order_id;

  IF v_client_org_id IS NULL THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.notifications (organization_id, user_id, title, message, type, link)
  SELECT v_client_org_id, p.id, v_title, v_title || ' — ' || NEW.name, 'info',
         '/client/campaigns/' || NEW.purchase_order_id::text
  FROM public.profiles p
  WHERE p.organization_id = v_client_org_id AND p.role = 'client_admin' AND p.is_active = true;

  RETURN NEW;
END;
$$;

-- ============================================================
-- 3. notify_client_on_invoice_event — client_admin only
-- ============================================================
CREATE OR REPLACE FUNCTION public.notify_client_on_invoice_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_client_org_id uuid;
  v_title text;
  v_message text;
BEGIN
  IF NEW.purchase_order_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    v_title := 'Invoice raised';
    v_message := NEW.invoice_number || ' — Rs ' || round(NEW.total)::text;
  ELSIF TG_OP = 'UPDATE' AND NEW.payment_status = 'paid' AND OLD.payment_status IS DISTINCT FROM 'paid' THEN
    v_title := 'Invoice paid';
    v_message := NEW.invoice_number || ' has been marked paid';
  ELSE
    RETURN NEW;
  END IF;

  SELECT po.client_org_id INTO v_client_org_id
  FROM public.purchase_orders po
  WHERE po.id = NEW.purchase_order_id;

  IF v_client_org_id IS NULL THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.notifications (organization_id, user_id, title, message, type, link)
  SELECT v_client_org_id, p.id, v_title, v_message, 'success', '/client/billing'
  FROM public.profiles p
  WHERE p.organization_id = v_client_org_id AND p.role = 'client_admin' AND p.is_active = true;

  RETURN NEW;
END;
$$;

-- Triggers already exist and point at these function names — CREATE OR
-- REPLACE above updates their bodies in place, no need to re-create them.
