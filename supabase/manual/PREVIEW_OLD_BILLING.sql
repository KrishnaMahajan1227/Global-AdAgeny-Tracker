-- Run through supplied PowerShell. org_id is passed as a psql variable.
WITH target AS (SELECT :'org_id'::uuid AS id)
SELECT o.name AS agency, inv.organization_id, count(*) AS invoice_count,
       count(*) FILTER (WHERE inv.payment_status='paid') AS paid,
       count(*) FILTER (WHERE inv.payment_status='partial') AS partial,
       count(*) FILTER (WHERE inv.payment_status='unpaid') AS unpaid,
       count(*) FILTER (WHERE inv.payment_status='overdue') AS overdue,
       coalesce(sum(inv.total),0) AS total_rupees,
       (SELECT count(*) FROM public.invoice_items ii JOIN public.invoices i2 ON i2.id=ii.invoice_id WHERE i2.organization_id=t.id) AS line_items
FROM public.organizations o JOIN target t ON o.id=t.id
LEFT JOIN public.invoices inv ON inv.organization_id=t.id
GROUP BY o.name, inv.organization_id, t.id;
