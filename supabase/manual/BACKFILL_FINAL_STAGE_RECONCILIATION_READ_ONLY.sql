-- READ-ONLY diagnostic of Work Order progress mismatches for finalized shops.
-- A shop may be installed/dispatched but its work items may not contain
-- stage-specific completed units. Review and repair the SOURCE records; do
-- not automatically copy approved quantities into completed quantities.
SELECT s.id AS shop_id, s.name AS shop_name, po.po_number, po.fulfillment_type,
       s.status AS shop_status, wi.id AS work_item_id, wi.work_type_name,
       wi.status AS work_item_status,
       wi.approved_area, wi.approved_quantity,
       wi.installed_area, wi.installed_quantity, wi.produced_quantity,
       wi.po_line_item_id
FROM public.shops s
JOIN public.purchase_orders po ON po.id = s.purchase_order_id
JOIN public.work_items wi ON wi.shop_id = s.id
WHERE po.fulfillment_type = 'supply_only' AND s.status IN ('dispatched','billed')
  AND (wi.produced_quantity IS NULL OR wi.produced_quantity = 0)
UNION ALL
SELECT s.id, s.name, po.po_number, po.fulfillment_type,
       s.status, wi.id, wi.work_type_name,
       wi.status, wi.approved_area, wi.approved_quantity,
       wi.installed_area, wi.installed_quantity, wi.produced_quantity, wi.po_line_item_id
FROM public.shops s
JOIN public.purchase_orders po ON po.id = s.purchase_order_id
JOIN public.work_items wi ON wi.shop_id = s.id
WHERE po.fulfillment_type IN ('survey_install','direct_install','custom') AND s.status IN ('installed','billed')
  AND (wi.installed_area IS NULL AND wi.installed_quantity IS NULL)
ORDER BY po_number, shop_name, work_item_id;
