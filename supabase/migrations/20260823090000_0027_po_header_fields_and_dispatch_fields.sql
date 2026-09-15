/*
# Phase A+B — PO header fields (payment terms, GST) + dispatch/signage fields

  Per ARCHITECTURE doc Section 3.1, 4.1, 6.4 — all changes here are purely
  ADDITIVE (new nullable columns only). Nothing existing is renamed, dropped,
  or has its behaviour changed, so the current working app (PurchaseOrdersPage,
  SupplyOrdersPage, ShopsPages, Production) keeps running exactly as-is until
  the UI is updated in a later step to actually read/write these columns.

  What this covers:
  - purchase_orders: payment_terms, gst_percentage (admin-entered),
    gst_amount (auto-derived, NOT hand-typed)
      -> lets Billing/PO Utilization show "PO says 18% GST, invoice is
         charging X%" as a sanity check (Section 3.1). gst_amount is a
         generated column = total_amount * gst_percentage / 100, mirroring
         how total_amount itself is already derived from line items
         (migration 0026) rather than hand-typed — so the two numbers can
         never drift apart the way the old free-text total_amount used to.
  - po_line_items: hsn_code
      -> optional, for GST invoicing compliance later (Section 3.1).
  - shops: signage_language
      -> survey+install shops only (Hindi/Marathi/English etc, Section 4.1).
         Left NULL for supply_only "shops" (used as delivery destinations
         today) since it doesn't apply to them.
  - routes: transport_mode, tracking_reference, zone_id
      -> so the existing routes/route_stops dispatch flow (already used by
         both Survey+Install installer routes AND Supply Only zone-wise
         dispatch in SupplyOrdersPage) can record courier/transport company
         info per Section 6.4, without needing a brand-new dispatches table
         that would fork the working flow.
      -> user_id is relaxed to nullable: a courier/transport-company
         dispatch has no internal staff profile to assign, only
         transport_mode + tracking_reference. Existing installer routes are
         unaffected since they always set user_id.
*/

-- ============ purchase_orders: payment terms + GST basis ============
ALTER TABLE public.purchase_orders
  ADD COLUMN IF NOT EXISTS payment_terms text,
  ADD COLUMN IF NOT EXISTS gst_percentage numeric;

-- gst_amount is derived, never hand-typed — same principle as total_amount
-- (migration 0026). Recomputes automatically whenever total_amount (line
-- items change) or gst_percentage (admin edits it) changes.
ALTER TABLE public.purchase_orders
  ADD COLUMN IF NOT EXISTS gst_amount numeric
    GENERATED ALWAYS AS (round(COALESCE(total_amount, 0) * COALESCE(gst_percentage, 0) / 100, 2)) STORED;

-- ============ po_line_items: HSN code (optional, GST compliance) ============
ALTER TABLE public.po_line_items
  ADD COLUMN IF NOT EXISTS hsn_code text;

-- ============ shops: signage language (survey+install only) ============
ALTER TABLE public.shops
  ADD COLUMN IF NOT EXISTS signage_language text;

-- ============ routes: courier/transport dispatch fields ============
ALTER TABLE public.routes
  ADD COLUMN IF NOT EXISTS transport_mode text,
  ADD COLUMN IF NOT EXISTS tracking_reference text,
  ADD COLUMN IF NOT EXISTS zone_id uuid REFERENCES public.zones(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_routes_zone_id ON public.routes(zone_id);

-- user_id relaxed to nullable so a courier/transport-company dispatch
-- (no internal staff assigned, only transport_mode + tracking_reference)
-- can be recorded the same way an installer route is today.
ALTER TABLE public.routes ALTER COLUMN user_id DROP NOT NULL;
