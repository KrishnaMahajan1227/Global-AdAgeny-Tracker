/*
# Let a client fix Work Order details after the agency has accepted it

## The gap
`purchase_orders_client_update` (migration 0037) deliberately only lets a
client_admin edit their own client-created PO while it's still
`pending_acceptance` — once the agency accepts, the PO "is agency-owned
from that point" per that policy's own comment, and RLS locks the client
out of UPDATE entirely. That's the right call for anything that affects
budget or execution (po_number, po_date, fulfillment_type, line items) —
but it also means a client who made a typo in the Work Order Name, notes,
or payment terms, or who simply needs to update payment terms later, has
no way to fix it themselves post-acceptance. They currently have to ask
the agency to edit it on their behalf.

## Fix
`client_update_po_details(...)` — a narrow, SECURITY DEFINER RPC that:
  - only lets the client_org that owns the PO's `client_org_id` call it,
  - only ever writes `name`, `notes`, `payment_terms` — never po_number,
    po_date, line items, status, or anything that touches money/budget,
  - works at ANY assignment_status (not just pending_acceptance),
  - writes the audit log row into the PO's *agency* organization_id (not
    the caller's own client org), because `purchase_orders.organization_id`
    IS the agency's org — a plain client-side `logAudit()` call would
    write into the client's own audit_logs table instead (RLS forbids a
    client_admin from inserting into another org's audit_logs directly),
    and the whole point here is that the agency actually SEES who changed
    what on their own Recent Activity feed.
  - notifies the agency's owner/admin users, same as every other
    cross-org client action in this platform.

Line items and the identifying fields stay exactly as locked down as
before — this does not reopen 0037's original boundary, it adds one
narrow, explicitly-scoped exception to it.
*/

CREATE OR REPLACE FUNCTION public.client_update_po_details(
  p_po_id uuid,
  p_name text,
  p_notes text,
  p_payment_terms text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_role text;
  v_caller_org_id uuid;
  v_caller_name text;
  v_po record;
BEGIN
  SELECT p.role, p.organization_id, p.full_name
  INTO v_caller_role, v_caller_org_id, v_caller_name
  FROM public.profiles p WHERE p.id = auth.uid();

  IF v_caller_role <> 'client_admin' THEN
    RAISE EXCEPTION 'Only a Client Admin can edit a Work Order';
  END IF;

  SELECT * INTO v_po FROM public.purchase_orders WHERE id = p_po_id;
  IF v_po IS NULL OR v_po.client_org_id IS DISTINCT FROM v_caller_org_id THEN
    RAISE EXCEPTION 'Work Order not found';
  END IF;

  UPDATE public.purchase_orders
  SET name = NULLIF(p_name, ''), notes = NULLIF(p_notes, ''), payment_terms = NULLIF(p_payment_terms, '')
  WHERE id = p_po_id;

  INSERT INTO public.audit_logs (organization_id, user_id, table_name, record_id, action, field_name, description)
  VALUES (
    v_po.organization_id, auth.uid(), 'purchase_orders', p_po_id, 'update', 'name/notes/payment_terms',
    format('%s (client) updated Work Order %s — name, notes and/or payment terms', COALESCE(v_caller_name, 'A client user'), v_po.po_number)
  );

  INSERT INTO public.notifications (organization_id, user_id, title, message, type, link)
  SELECT v_po.organization_id, p.id,
    'Work Order details updated by client',
    format('%s updated the name/notes/payment terms on %s.', COALESCE(v_caller_name, 'The client'), v_po.po_number),
    'info', '/purchase-orders'
  FROM public.profiles p
  WHERE p.organization_id = v_po.organization_id AND p.role IN ('agency_owner', 'admin') AND p.is_active = true;
END;
$$;

REVOKE ALL ON FUNCTION public.client_update_po_details(uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.client_update_po_details(uuid, text, text, text) TO authenticated;
