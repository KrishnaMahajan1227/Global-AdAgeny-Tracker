/*
# Cascade delete for Campaigns and Work Orders

## The gap
`shops.project_id`, `purchase_orders.project_id`, `invoices.project_id`
and `shops.purchase_order_id`, `invoices.purchase_order_id` are all
`ON DELETE SET NULL` — a deliberate original design so that deleting a
campaign or Work Order could never silently destroy a shop's survey/
installation history or an invoice just because its parent record was
removed. In practice this meant "Delete Campaign" / "Delete Work Order"
only ever unlinked its shops and invoices and left them behind — every
one of their child records (surveys, work items, design tasks/versions,
production orders, installation jobs, shop assignments, invoice line
items, everything) stayed in the database, orphaned. That's the "delete
isn't actually deleting anything" behaviour being fixed here.

## Fix
Two narrow, SECURITY DEFINER RPCs — `delete_campaign_cascade` and
`delete_purchase_order_cascade` — that an Owner/Admin calls explicitly
to genuinely remove a campaign/Work Order AND every shop under it
(which in turn cascades to that shop's own survey/design/production/
installation records via their existing ON DELETE CASCADE foreign
keys) AND every invoice raised under it. This is intentionally NOT a
change to the underlying SET NULL foreign keys themselves — those stay
exactly as protective as before for any other path (e.g. moving a shop
between campaigns, or a PO's normal lifecycle) — this is one explicit,
audited, all-or-nothing action a person consciously chooses, returning
counts of what it removed so the calling UI can warn before, and
confirm after.
*/

CREATE OR REPLACE FUNCTION public.delete_campaign_cascade(p_project_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_role text;
  v_caller_org_id uuid;
  v_project record;
  v_shop_count int;
  v_po_count int;
  v_invoice_count int;
BEGIN
  SELECT p.role, p.organization_id INTO v_caller_role, v_caller_org_id
  FROM public.profiles p WHERE p.id = auth.uid();

  IF v_caller_role NOT IN ('agency_owner', 'admin') THEN
    RAISE EXCEPTION 'Only an Owner or Admin can delete a campaign and everything in it';
  END IF;

  SELECT * INTO v_project FROM public.projects WHERE id = p_project_id;
  IF v_project IS NULL OR v_project.organization_id IS DISTINCT FROM v_caller_org_id THEN
    RAISE EXCEPTION 'Campaign not found';
  END IF;

  SELECT count(*) INTO v_shop_count FROM public.shops WHERE project_id = p_project_id;
  SELECT count(*) INTO v_po_count FROM public.purchase_orders WHERE project_id = p_project_id;
  SELECT count(*) INTO v_invoice_count FROM public.invoices WHERE project_id = p_project_id;

  -- Deleting the shops cascades to every survey, work item, design
  -- task/version, production order/item, installation job, shop
  -- assignment, vehicle-load link and share link hung off them.
  DELETE FROM public.shops WHERE project_id = p_project_id;
  -- Deleting the Work Orders cascades to their own line items, supply
  -- destinations and PO assignments the same way.
  DELETE FROM public.purchase_orders WHERE project_id = p_project_id;
  -- Invoices raised directly under this campaign — cascades to their line items.
  DELETE FROM public.invoices WHERE project_id = p_project_id;

  DELETE FROM public.projects WHERE id = p_project_id;

  INSERT INTO public.audit_logs (organization_id, user_id, table_name, record_id, action, field_name, description)
  VALUES (
    v_caller_org_id, auth.uid(), 'projects', p_project_id, 'delete', null,
    format('Deleted campaign "%s" and everything in it — %s shop(s), %s Work Order(s), %s invoice(s)',
      v_project.name, v_shop_count, v_po_count, v_invoice_count)
  );

  RETURN jsonb_build_object('shops', v_shop_count, 'purchase_orders', v_po_count, 'invoices', v_invoice_count);
END;
$$;

REVOKE ALL ON FUNCTION public.delete_campaign_cascade(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_campaign_cascade(uuid) TO authenticated;


CREATE OR REPLACE FUNCTION public.delete_purchase_order_cascade(p_po_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_role text;
  v_caller_org_id uuid;
  v_po record;
  v_shop_count int;
  v_invoice_count int;
BEGIN
  SELECT p.role, p.organization_id INTO v_caller_role, v_caller_org_id
  FROM public.profiles p WHERE p.id = auth.uid();

  IF v_caller_role NOT IN ('agency_owner', 'admin') THEN
    RAISE EXCEPTION 'Only an Owner or Admin can delete a Work Order and everything in it';
  END IF;

  SELECT * INTO v_po FROM public.purchase_orders WHERE id = p_po_id;
  IF v_po IS NULL OR v_po.organization_id IS DISTINCT FROM v_caller_org_id THEN
    RAISE EXCEPTION 'Work Order not found';
  END IF;

  SELECT count(*) INTO v_shop_count FROM public.shops WHERE purchase_order_id = p_po_id;
  SELECT count(*) INTO v_invoice_count FROM public.invoices WHERE purchase_order_id = p_po_id;

  DELETE FROM public.shops WHERE purchase_order_id = p_po_id;
  DELETE FROM public.invoices WHERE purchase_order_id = p_po_id;
  -- The PO row itself cascades to its own line items, supply
  -- destinations and PO assignments via their existing foreign keys.
  DELETE FROM public.purchase_orders WHERE id = p_po_id;

  INSERT INTO public.audit_logs (organization_id, user_id, table_name, record_id, action, field_name, description)
  VALUES (
    v_caller_org_id, auth.uid(), 'purchase_orders', p_po_id, 'delete', null,
    format('Deleted Work Order %s and everything in it — %s shop(s), %s invoice(s)',
      v_po.po_number, v_shop_count, v_invoice_count)
  );

  RETURN jsonb_build_object('shops', v_shop_count, 'invoices', v_invoice_count);
END;
$$;

REVOKE ALL ON FUNCTION public.delete_purchase_order_cascade(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_purchase_order_cascade(uuid) TO authenticated;
