/*
# Phase 6b — Auto-calculate PO total_amount from line items

   Problem: purchase_orders.total_amount was a free-text field the admin
   typed in at PO-header time, completely separate from the line items
   entered afterwards (budgeted_qty/budgeted_area * rate per item). The
   two numbers drifted apart, and the "Invoiced vs budget" figure on the
   Purchase Orders page silently used the (possibly stale/wrong) header
   total instead of what was actually budgeted line-by-line.

   Fix: total_amount is no longer hand-typed. It's now maintained by a
   trigger that recomputes it as the sum of (budgeted_area or
   budgeted_qty, whichever the line item's uom uses) * rate across all of
   a PO's line items, every time a line item is inserted, updated, or
   deleted. Line items with no rate or no budgeted qty/area yet contribute
   0 until the admin fills those in — so the header total always exactly
   matches "what the line items add up to today", no separate manual
   entry required.

   total_amount stays a normal nullable numeric column (no schema change),
   just no longer editable by hand from the client.
*/

CREATE OR REPLACE FUNCTION public.recompute_po_total_amount()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_po_id uuid := COALESCE(NEW.purchase_order_id, OLD.purchase_order_id);
  v_total numeric;
BEGIN
  SELECT COALESCE(SUM(
    (CASE WHEN uom = 'sqft' THEN budgeted_area ELSE budgeted_qty END) * COALESCE(rate, 0)
  ), 0)
  INTO v_total
  FROM public.po_line_items
  WHERE purchase_order_id = v_po_id;

  UPDATE public.purchase_orders SET total_amount = v_total WHERE id = v_po_id;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_recompute_po_total_amount ON public.po_line_items;
CREATE TRIGGER trg_recompute_po_total_amount
  AFTER INSERT OR UPDATE OR DELETE ON public.po_line_items
  FOR EACH ROW EXECUTE FUNCTION public.recompute_po_total_amount();

-- Backfill: bring every existing PO's total_amount in line with its
-- current line items right now, so old POs don't show a stale number
-- until their next line-item edit.
UPDATE public.purchase_orders po SET total_amount = sub.v_total
FROM (
  SELECT
    purchase_order_id,
    COALESCE(SUM(
      (CASE WHEN uom = 'sqft' THEN budgeted_area ELSE budgeted_qty END) * COALESCE(rate, 0)
    ), 0) AS v_total
  FROM public.po_line_items
  GROUP BY purchase_order_id
) sub
WHERE sub.purchase_order_id = po.id;
