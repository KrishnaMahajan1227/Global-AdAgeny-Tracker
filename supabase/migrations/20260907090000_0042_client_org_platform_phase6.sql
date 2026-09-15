/*
# Phase 6 — Client app: Reports + notification/realtime polish

  Final slice of GLOBAL_ARCHITECTURE.md's rollout plan for the Client
  Organization portal, on top of Phases 3-5 (Overview/Campaigns/PO Detail,
  Map Feed, Billing). Two pieces:

  1. v_po_line_item_burndown_events (migration 0032) gets a client-org read
     branch, extended in place rather than mirrored into a separate view
     like v_client_po_line_item_progress (migration 0039) was — unlike
     v_po_line_item_utilization, THIS view carries no `rate` or money
     figures at all (just qty/area deltas dated by pipeline timestamps),
     so there's no cost/margin data to keep out of a client's hands here.
     Powers the Reports page's burndown chart (doc section 4.7), reusing
     the exact same BurndownChart.tsx / lib/poBurndown.ts the agency side
     already uses.

  2. Doc section 6 ("Notifications / Handshake Flow"), steps 3-4:
       "Stage change (survey done, design approved, installed) -> Client
       dashboard auto-updates ... Billing milestone (invoice raised/paid)
       -> Client notified"
     Phase 2/3 only ever notified a client for PO accept/reject/withdraw
     (manual RPC calls from the frontend, see notify_linked_org_users).
     Every deeper pipeline milestone (a specific site getting surveyed /
     design-approved / installed, an invoice being raised or paid) never
     reached a client's notification bell at all. This adds two small
     AFTER-trigger functions that close that gap automatically at the
     database level — the frontend doesn't have to remember to call
     anything, and (being triggers, not RPCs) they fire no matter which
     agency screen made the change. Both silently no-op for any shop/
     invoice whose PO isn't client_org-linked, so nothing changes for the
     purely agency-led flow that predates this platform.
*/

-- ============ 1. v_po_line_item_burndown_events — client-org read branch ============
DROP VIEW IF EXISTS public.v_po_line_item_burndown_events;
CREATE VIEW public.v_po_line_item_burndown_events AS
WITH events AS (
-- surveyed
SELECT
  wi.id AS work_item_id,
  wi.po_line_item_id,
  wi.organization_id,
  'surveyed'::text AS stage,
  COALESCE(s.submitted_at, wi.created_at)::date AS event_date,
  COALESCE(wi.survey_area, 0) AS area_delta,
  COALESCE(wi.survey_quantity, 0) AS qty_delta
FROM public.work_items wi
LEFT JOIN public.surveys s ON s.id = wi.survey_id
WHERE wi.po_line_item_id IS NOT NULL
  AND (wi.survey_area IS NOT NULL OR wi.survey_quantity IS NOT NULL)

UNION ALL
-- approved
SELECT
  wi.id AS work_item_id,
  wi.po_line_item_id,
  wi.organization_id,
  'approved'::text AS stage,
  COALESCE(s.reviewed_at, wi.updated_at)::date AS event_date,
  COALESCE(wi.approved_area, 0) AS area_delta,
  COALESCE(wi.approved_quantity, 0) AS qty_delta
FROM public.work_items wi
LEFT JOIN public.surveys s ON s.id = wi.survey_id
WHERE wi.po_line_item_id IS NOT NULL
  AND (wi.approved_area IS NOT NULL OR wi.approved_quantity IS NOT NULL)

UNION ALL
-- produced
SELECT
  wi.id AS work_item_id,
  wi.po_line_item_id,
  wi.organization_id,
  'produced'::text AS stage,
  COALESCE(wi.produced_at, wi.updated_at)::date AS event_date,
  0 AS area_delta,
  COALESCE(wi.produced_quantity, 0) AS qty_delta
FROM public.work_items wi
WHERE wi.po_line_item_id IS NOT NULL
  AND wi.produced_quantity IS NOT NULL

UNION ALL
-- installed
SELECT
  wi.id AS work_item_id,
  wi.po_line_item_id,
  wi.organization_id,
  'installed'::text AS stage,
  COALESCE(wi.installed_at, wi.updated_at)::date AS event_date,
  COALESCE(wi.installed_area, 0) AS area_delta,
  COALESCE(wi.installed_quantity, 0) AS qty_delta
FROM public.work_items wi
WHERE wi.po_line_item_id IS NOT NULL
  AND (wi.installed_area IS NOT NULL OR wi.installed_quantity IS NOT NULL)
)
SELECT e.* FROM events e
WHERE e.organization_id = public.current_org_id()
  OR (
    public.current_org_type() = 'client'
    AND EXISTS (
      SELECT 1 FROM public.po_line_items pli
      JOIN public.purchase_orders po ON po.id = pli.purchase_order_id
      WHERE pli.id = e.po_line_item_id
        AND po.client_org_id = public.current_org_id()
    )
  );

GRANT SELECT ON public.v_po_line_item_burndown_events TO authenticated;

-- ============ 2a. Auto-notify client on a site's pipeline stage change ============
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

  -- Only the milestones doc section 6 calls out by name, so a client
  -- isn't pinged for every minor internal-queue transition (e.g.
  -- 'assigned', 'production_pending') that means nothing to them.
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
  WHERE p.organization_id = v_client_org_id AND p.is_active = true;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notify_client_on_shop_stage_change ON public.shops;
CREATE TRIGGER trg_notify_client_on_shop_stage_change
  AFTER UPDATE ON public.shops
  FOR EACH ROW EXECUTE FUNCTION public.notify_client_on_shop_stage_change();

-- ============ 2b. Auto-notify client on a billing milestone ============
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
  WHERE p.organization_id = v_client_org_id AND p.is_active = true;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notify_client_on_invoice_insert ON public.invoices;
CREATE TRIGGER trg_notify_client_on_invoice_insert
  AFTER INSERT ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.notify_client_on_invoice_event();

DROP TRIGGER IF EXISTS trg_notify_client_on_invoice_update ON public.invoices;
CREATE TRIGGER trg_notify_client_on_invoice_update
  AFTER UPDATE ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.notify_client_on_invoice_event();

-- ============ Realtime ============
-- purchase_orders was already in the supabase_realtime publication (it's
-- one of the base tables agency screens already subscribe to). No change
-- needed there for the new client-side subscription (see
-- useClientRealtimeInvalidate.ts) to work — Realtime broadcasts row
-- changes to anyone whose RLS SELECT policy would return that row, and
-- purchase_orders_select already has the client-org branch (migration
-- 0037).
