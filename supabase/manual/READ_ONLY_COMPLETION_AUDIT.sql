-- READ ONLY: paste into Supabase SQL Editor. No table is changed.
-- Compare operationally completed shops with linked work items and measured units.
-- Filter by an exact Work Order number in the outermost SELECT if needed.
WITH scoped AS (
 SELECT po.id, po.organization_id, po.po_number, po.name, po.fulfillment_type,
        s.id AS shop_id, s.name AS shop_name, s.status AS shop_status,
        CASE WHEN po.fulfillment_type='supply_only'
             THEN s.status IN ('dispatched','billed')
             ELSE s.status IN ('installed','billed') END AS is_final
 FROM public.purchase_orders po JOIN public.shops s
   ON s.purchase_order_id=po.id AND s.organization_id=po.organization_id
 WHERE s.status NOT IN ('cancelled','rejected')
), item_counts AS (
 SELECT b.*, COALESCE(wi.work_count,0) AS work_count,
   COALESCE(wi.missing_po_links,0) AS missing_po_links,
   COALESCE(wi.missing_finished_units,0) AS missing_finished_units
 FROM scoped b LEFT JOIN LATERAL (
   SELECT count(*) AS work_count,
          count(*) FILTER (WHERE w.po_line_item_id IS NULL) AS missing_po_links,
          count(*) FILTER (
            WHERE NOT COALESCE(w.excluded_from_calculations,false)
              AND (CASE WHEN b.fulfillment_type='supply_only'
                THEN COALESCE(w.produced_quantity,0)=0
                ELSE COALESCE(w.installed_quantity,0)=0 AND COALESCE(w.installed_area,0)=0 END)
          ) AS missing_finished_units
   FROM public.work_items w WHERE w.shop_id=b.shop_id AND w.organization_id=b.organization_id
 ) wi ON true
)
SELECT organization_id, id AS purchase_order_id, po_number, name, fulfillment_type,
 count(*) AS all_shops,
 count(*) FILTER (WHERE is_final) AS finished_shops,
 count(*) FILTER (WHERE is_final AND work_count=0) AS finished_without_work_items,
 count(*) FILTER (WHERE is_final AND missing_po_links>0) AS finished_with_unlinked_po_items,
 count(*) FILTER (WHERE is_final AND missing_finished_units>0) AS finished_with_missing_measured_units
FROM item_counts
GROUP BY organization_id,id,po_number,name,fulfillment_type
ORDER BY finished_without_work_items DESC, finished_with_missing_measured_units DESC, po_number;

-- For a specific PO, locate actual shops to reconcile:
-- SELECT shop_id,shop_name,shop_status,work_count,missing_po_links,missing_finished_units
-- FROM item_counts WHERE po_number='9011566350' AND is_final ORDER BY work_count,shop_name;
