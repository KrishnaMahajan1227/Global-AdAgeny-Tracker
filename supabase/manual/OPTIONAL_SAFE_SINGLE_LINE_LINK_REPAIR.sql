-- MANUAL AND OPTIONAL. Back up the database and inspect READ_ONLY_COMPLETION_AUDIT.sql first.
-- Repairs ONLY a missing PO-line reference on an EXISTING work item when its shop
-- has a PO containing exactly one line. It does NOT invent item measurements,
-- installed quantities, new items, rates, invoices, or shop completion.
-- Run on staging before production. Requires sufficient SQL-editor privileges.
BEGIN;
WITH unique_line AS (
  SELECT organization_id,purchase_order_id, min(id) AS line_id,
         min(work_type_id::text) AS line_work_type
  FROM public.po_line_items
  GROUP BY organization_id,purchase_order_id
  HAVING count(*)=1
), targets AS (
  SELECT wi.id AS work_item_id, u.line_id
  FROM public.work_items wi
  JOIN public.shops s ON s.id=wi.shop_id AND s.organization_id=wi.organization_id
  JOIN unique_line u ON u.organization_id=s.organization_id AND u.purchase_order_id=s.purchase_order_id
  WHERE wi.po_line_item_id IS NULL
    AND (wi.work_type_id IS NULL OR u.line_work_type IS NULL OR wi.work_type_id::text=u.line_work_type)
)
UPDATE public.work_items wi SET po_line_item_id=t.line_id
FROM targets t WHERE wi.id=t.work_item_id AND wi.po_line_item_id IS NULL;
-- Review number of updated rows in the SQL Editor, then COMMIT or ROLLBACK.
-- The statement intentionally ends in ROLLBACK; change it to COMMIT only after verification.
ROLLBACK;
