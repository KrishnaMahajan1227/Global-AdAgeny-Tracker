-- READ-ONLY financial history inventory. Do not execute any DELETE/TRUNCATE.
-- Before retiring legacy invoice data, obtain a database backup and review
-- the records with your accountant for GST statutory retention.
-- Run as an authorized organization administrator; RLS will scope visibility.
SELECT i.organization_id, i.payment_status, count(*) AS invoices,
       sum(i.subtotal) AS taxable_value, sum(i.tax_amount) AS tax_value,
       sum(i.total) AS gross_value
FROM public.invoices AS i
GROUP BY i.organization_id, i.payment_status
ORDER BY i.organization_id, i.payment_status;

SELECT i.organization_id, i.invoice_number, i.invoice_date, i.payment_status,
       po.po_number, po.name AS work_order_name,
       i.subtotal, i.tax_amount, i.total,
       count(ii.id) AS source_line_count,
       count(ii.work_item_id) AS work_item_linked_lines,
       count(ii.id) FILTER (WHERE ii.work_item_id IS NULL) AS lines_needing_reconciliation
FROM public.invoices i
LEFT JOIN public.invoice_items ii ON ii.invoice_id = i.id
LEFT JOIN public.purchase_orders po ON po.id = i.purchase_order_id
GROUP BY i.organization_id, i.id, po.po_number, po.name
ORDER BY i.invoice_date DESC;
