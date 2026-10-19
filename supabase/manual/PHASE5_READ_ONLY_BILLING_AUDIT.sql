-- PHASE 5 — READ-ONLY BILLING & PO LINK AUDIT
-- For Supabase SQL Editor on STAGING, then production with care.
-- Replace each REPLACE_ORGANIZATION_UUID with the intended agency organization UUID.
-- This SQL does NOT modify the database. Large organizations may take time to scan.

-- 1) Invoice item linked to a PO line that disagrees with its invoice header.
SELECT ii.id AS invoice_item_id, i.invoice_number, i.purchase_order_id AS invoice_po,
       pli.purchase_order_id AS item_po, ii.work_item_id, ii.shop_id
FROM public.invoice_items ii
JOIN public.invoices i ON i.id=ii.invoice_id
JOIN public.po_line_items pli ON pli.id=ii.po_line_item_id
WHERE i.organization_id='REPLACE_ORGANIZATION_UUID'::uuid
  AND i.purchase_order_id IS NOT NULL
  AND i.purchase_order_id IS DISTINCT FROM pli.purchase_order_id
ORDER BY i.invoice_number LIMIT 200;

-- 2) Invoice items with no work-item allocation (must be manually reconciled
-- before assuming they are new unbilled execution).
SELECT i.invoice_number, ii.id AS invoice_item_id, ii.shop_id,
       ii.po_line_item_id, ii.quantity, ii.area, ii.amount
FROM public.invoice_items ii
JOIN public.invoices i ON i.id=ii.invoice_id
WHERE i.organization_id='REPLACE_ORGANIZATION_UUID'::uuid
  AND ii.work_item_id IS NULL
  AND (ii.shop_id IS NOT NULL OR ii.po_line_item_id IS NOT NULL)
ORDER BY i.invoice_date DESC LIMIT 200;

-- 3) Repeated invoice allocations per work item (can be legitimate partial
-- invoices; inspect summed quantities/area versus item execution separately).
SELECT ii.work_item_id, COUNT(*) AS invoice_lines,
       SUM(COALESCE(ii.quantity,0)) AS total_invoice_quantity,
       SUM(COALESCE(ii.area,0)) AS total_invoice_area,
       SUM(COALESCE(ii.amount,0)) AS total_invoice_amount
FROM public.invoice_items ii
WHERE ii.organization_id='REPLACE_ORGANIZATION_UUID'::uuid
  AND ii.work_item_id IS NOT NULL
GROUP BY ii.work_item_id HAVING COUNT(*)>1
ORDER BY invoice_lines DESC LIMIT 200;

-- 4) New receipt-gated Supply Work Orders: dispatched is NOT complete.
SELECT po.id AS po_id, po.po_number, s.status, COUNT(*) AS site_count
FROM public.purchase_orders po
JOIN public.shops s ON s.purchase_order_id=po.id
WHERE po.organization_id='REPLACE_ORGANIZATION_UUID'::uuid
  AND po.fulfillment_type='supply_only'
  AND po.delivery_receipt_required=true
  AND s.status IN ('dispatched','delivered')
GROUP BY po.id,po.po_number,s.status
ORDER BY po.po_number,s.status LIMIT 200;
