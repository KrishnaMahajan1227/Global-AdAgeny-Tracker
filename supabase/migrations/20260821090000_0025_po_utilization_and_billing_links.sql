/*
# Phase 6 — PO Utilization / reconciliation + Billing links

   Two small, additive pieces:

   1. invoices.purchase_order_id + invoice_items.po_line_item_id — lets an
      invoice (and each of its line items) optionally point back at the PO
      / PO line item it's being billed against, so the Billing page can
      show "PO 2999025524 — balance remaining" and warn before an invoice
      over-bills a line item. Both columns are nullable: invoices created
      the old way (no PO picked) behave exactly as before.

   2. v_po_line_item_utilization — a read view joining po_line_items to
      the existing work_items rollup columns (survey_area, approved_area,
      produced_quantity, installed_area — already maintained per shop by
      the untouched survey/design/production/installation pipeline) and
      to invoice_items for the amount already invoiced. One row per PO
      line item with budgeted vs actual at every stage, so PO Utilization
      reporting is a straight SELECT instead of re-deriving this in every
      page that needs it (Purchase Orders page, Billing page, Reports).

      Scoped with `WHERE pli.organization_id = current_org_id()` the same
      way v_pipeline_pending_counts is (see migration 0013/0014) — no
      separate RLS needed on a view built that way.
*/

ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS purchase_order_id uuid REFERENCES public.purchase_orders(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_invoices_purchase_order_id ON public.invoices(purchase_order_id);

ALTER TABLE public.invoice_items ADD COLUMN IF NOT EXISTS po_line_item_id uuid REFERENCES public.po_line_items(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_invoice_items_po_line_item_id ON public.invoice_items(po_line_item_id);

DROP VIEW IF EXISTS public.v_po_line_item_utilization;
CREATE VIEW public.v_po_line_item_utilization AS
SELECT
  pli.id AS po_line_item_id,
  pli.organization_id,
  pli.purchase_order_id,
  po.po_number,
  po.po_date,
  po.fulfillment_type,
  po.status AS po_status,
  po.client_id,
  c.name AS client_name,
  po.project_id,
  pr.name AS project_name,
  pli.description,
  pli.work_type_id,
  wt.name AS work_type_name,
  pli.uom,
  pli.budgeted_qty,
  pli.budgeted_area,
  pli.rate,
  COALESCE((SELECT sum(wi.survey_area) FROM public.work_items wi WHERE wi.po_line_item_id = pli.id), 0) AS surveyed_area,
  COALESCE((SELECT sum(wi.survey_quantity) FROM public.work_items wi WHERE wi.po_line_item_id = pli.id), 0) AS surveyed_qty,
  COALESCE((SELECT sum(wi.approved_area) FROM public.work_items wi WHERE wi.po_line_item_id = pli.id), 0) AS approved_area,
  COALESCE((SELECT sum(wi.approved_quantity) FROM public.work_items wi WHERE wi.po_line_item_id = pli.id), 0) AS approved_qty,
  COALESCE((SELECT sum(wi.produced_quantity) FROM public.work_items wi WHERE wi.po_line_item_id = pli.id), 0) AS produced_qty,
  COALESCE((SELECT sum(wi.installed_area) FROM public.work_items wi WHERE wi.po_line_item_id = pli.id), 0) AS installed_area,
  COALESCE((SELECT sum(wi.installed_quantity) FROM public.work_items wi WHERE wi.po_line_item_id = pli.id), 0) AS installed_qty,
  COALESCE((SELECT count(*) FROM public.work_items wi WHERE wi.po_line_item_id = pli.id), 0) AS linked_work_item_count,
  COALESCE((SELECT sum(ii.amount) FROM public.invoice_items ii WHERE ii.po_line_item_id = pli.id), 0) AS invoiced_amount
FROM public.po_line_items pli
JOIN public.purchase_orders po ON po.id = pli.purchase_order_id
LEFT JOIN public.clients c ON c.id = po.client_id
LEFT JOIN public.projects pr ON pr.id = po.project_id
LEFT JOIN public.work_types wt ON wt.id = pli.work_type_id
WHERE pli.organization_id = public.current_org_id();

GRANT SELECT ON public.v_po_line_item_utilization TO authenticated;
