/*
# Phase 3 — Link Purchase Orders into shops and work items

   - shops.purchase_order_id: which PO a shop's board(s) are being billed
     against. Set from a new PO picker in the shop create/edit form.
   - work_items.po_line_item_id: which PO line item (budget row) a specific
     board's survey/approved/produced/installed quantities count against.
     Assignable per work item from the Shop Detail page once the shop has
     a linked PO — the existing survey/design/production/installation
     pipeline and its approval triggers are untouched; this is purely an
     additional, optional link for budget tracking.

   Both columns are new, nullable, additive — no existing data, statuses,
   or triggers are touched.
*/

ALTER TABLE public.shops ADD COLUMN IF NOT EXISTS purchase_order_id uuid REFERENCES public.purchase_orders(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_shops_purchase_order_id ON public.shops(purchase_order_id);

ALTER TABLE public.work_items ADD COLUMN IF NOT EXISTS po_line_item_id uuid REFERENCES public.po_line_items(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_work_items_po_line_item_id ON public.work_items(po_line_item_id);
