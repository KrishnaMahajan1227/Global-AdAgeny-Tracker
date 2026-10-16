-- READ-ONLY. Replace UUID with the agency organization_id before running in Supabase SQL Editor.
-- This DOES NOT modify or delete anything.
WITH target AS (
  SELECT '00000000-0000-0000-0000-000000000000'::uuid AS organization_id
)
SELECT
  COUNT(*) AS total_old_invoices,
  COUNT(*) FILTER (WHERE payment_status = 'paid') AS paid,
  COUNT(*) FILTER (WHERE payment_status = 'partial') AS partially_paid,
  COUNT(*) FILTER (WHERE payment_status = 'unpaid') AS unpaid,
  COUNT(*) FILTER (WHERE payment_status = 'overdue') AS overdue,
  COALESCE(SUM(total), 0) AS historical_invoice_total,
  (SELECT COUNT(*) FROM public.invoice_items ii JOIN public.invoices inv ON inv.id = ii.invoice_id JOIN target t ON inv.organization_id = t.organization_id) AS old_invoice_items
FROM public.invoices inv JOIN target t ON inv.organization_id = t.organization_id;
