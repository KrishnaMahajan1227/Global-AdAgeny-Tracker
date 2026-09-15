/*
# Phase 16 — expose requires_* stage flags on v_po_line_item_work_context (Architecture v2.0 §3.4 queue-wiring, step 1 of N)

Every role that isn't locked out of financial data (surveyor, designer,
printing, plus admin/owner) reads PO line item context through this
view, never the base `po_line_items` table directly (migration 0029's
RLS lockdown). It carries budgeted_qty/area but never `rate` — safe for
every role. The `requires_survey/design/production/installation` flags
added in migration 0046 need the same treatment: additive columns,
CREATE OR REPLACE (same view, same security definition, nothing else
changes) so Survey Review can start actually reading them.
*/

CREATE OR REPLACE VIEW public.v_po_line_item_work_context AS
SELECT
  pli.id,
  pli.organization_id,
  pli.purchase_order_id,
  po.po_number,
  po.fulfillment_type,
  po.status AS po_status,
  pli.work_type_id,
  pli.description,
  pli.uom,
  pli.budgeted_qty,
  pli.budgeted_area,
  pli.requires_survey,
  pli.requires_design,
  pli.requires_production,
  pli.requires_installation
FROM public.po_line_items pli
JOIN public.purchase_orders po ON po.id = pli.purchase_order_id
WHERE pli.organization_id = public.current_org_id();

GRANT SELECT ON public.v_po_line_item_work_context TO authenticated;
