/*
# Phase 9 — Invoice section: precise auto-fill, editable Bill To, GST/HSN,
  payment/bank details, and full edit support

## Problem this closes
The Billing page could create an invoice but:
  1. Never captured *who* the invoice was actually billed to beyond a bare
     client_id — no address/GST snapshot, so the PDF's "Bill To" block was
     only ever as good as today's `clients` row. If a client's address/GST
     changed later, every OLD invoice's PDF silently changed with it —
     wrong for a legal billing document, which must freeze what was true
     the day it was raised.
  2. Had no HSN code on invoice_items for GST-compliant billing, even
     though po_line_items already carry hsn_code (migration 0027) — an
     invoice raised against a PO line item had no way to carry that HSN
     through.
  3. Had no payment/bank details anywhere on the organization, so the PDF
     could never tell the client HOW to actually pay.
  4. Had no per-invoice terms text (separate from the free-text `notes`),
     even though purchase_orders.payment_terms already exists and should
     be able to flow onto the invoice it's billed against.
  5. Invoices could never be edited after creation (only payment_status
     could change) — a mistyped line item or rate meant the only fix was
     delete + recreate, losing the audit trail. RLS already allows
     UPDATE/DELETE for agency_owner/admin/accounts (migration 0001c) — this
     was a frontend gap, not a database one, but invoices.updated_at is
     added here so the UI can show "last edited" honestly.

Everything below is purely ADDITIVE (new nullable columns only, one
backfill UPDATE). Nothing existing is renamed, dropped, or has its
behaviour changed.
*/

-- ============ invoices: frozen Bill To snapshot + terms + edit tracking ============
ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS bill_to_name text,
  ADD COLUMN IF NOT EXISTS bill_to_address text,
  ADD COLUMN IF NOT EXISTS bill_to_city text,
  ADD COLUMN IF NOT EXISTS bill_to_state text,
  ADD COLUMN IF NOT EXISTS bill_to_gst text,
  ADD COLUMN IF NOT EXISTS terms text,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz;

-- Backfill existing invoices from their client's CURRENT record, so old
-- invoices don't suddenly render with a blank Bill To block. From this
-- point forward the Billing page writes these at create/edit time instead
-- of the PDF ever reading `clients` live.
UPDATE public.invoices i
SET
  bill_to_name = c.name,
  bill_to_address = c.address,
  bill_to_city = c.city,
  bill_to_state = c.state,
  bill_to_gst = c.gst_number
FROM public.clients c
WHERE c.id = i.client_id AND i.bill_to_name IS NULL;

-- ============ invoice_items: HSN code (GST compliance, mirrors po_line_items.hsn_code) ============
ALTER TABLE public.invoice_items
  ADD COLUMN IF NOT EXISTS hsn_code text;

-- ============ organizations: payment/bank details shown on the invoice PDF ============
ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS bank_account_name text,
  ADD COLUMN IF NOT EXISTS bank_name text,
  ADD COLUMN IF NOT EXISTS bank_account_number text,
  ADD COLUMN IF NOT EXISTS bank_ifsc text,
  ADD COLUMN IF NOT EXISTS bank_branch text,
  ADD COLUMN IF NOT EXISTS upi_id text;

-- ============ v_po_line_item_utilization: expose hsn_code ============
-- So picking a PO line item on the Billing page can auto-fill the invoice
-- item's HSN code too, the same way it already auto-fills description/rate.
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
  pli.hsn_code,
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

-- ============ keep updated_at current on every edit ============
CREATE OR REPLACE FUNCTION public.set_invoice_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_invoices_updated_at ON public.invoices;
CREATE TRIGGER trg_invoices_updated_at
  BEFORE UPDATE ON public.invoices
  FOR EACH ROW
  EXECUTE FUNCTION public.set_invoice_updated_at();
