/*
# CGST / SGST / IGST breakdown on invoices

Invoices only ever had one flat `tax_rate`/`tax_amount` — fine for the
total, but not what a GST-compliant Indian tax invoice actually has to
show: intra-state supply splits the rate into CGST + SGST (each half),
inter-state supply charges IGST instead. Billing had no way to pick
either, so every invoice was really only correct by accident.

`tax_rate`/`tax_amount` are kept exactly as before — they now hold the
*combined* total (cgst+sgst+igst), so every existing read of them
(reports, PDF fallback, PO reconciliation) keeps working unchanged.
Everything new here is additive.
*/

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS cgst_rate numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cgst_amount numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sgst_rate numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sgst_amount numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS igst_rate numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS igst_amount numeric NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.invoices.cgst_rate IS 'Central GST %, used for intra-state supply. tax_rate = cgst_rate + sgst_rate + igst_rate.';
COMMENT ON COLUMN public.invoices.sgst_rate IS 'State GST %, used for intra-state supply alongside cgst_rate.';
COMMENT ON COLUMN public.invoices.igst_rate IS 'Integrated GST %, used instead of CGST+SGST for inter-state supply.';
