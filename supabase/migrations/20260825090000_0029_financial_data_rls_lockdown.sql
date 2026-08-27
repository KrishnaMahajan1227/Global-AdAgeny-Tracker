/*
# Phase H — Column-level lockdown of rate/payment data from non-financial roles

  ARCHITECTURE doc Section 9 (Role-Screen Data Visibility matrix): Surveyor,
  Designer, Printing/Production, Installer must NEVER see rate/price/payment
  data, and this must be "enforced at RLS/column level, not just hiding it in
  the UI" — a printing-role query should not even receive rate_cards/invoices
  columns.

  WHAT WAS TRUE BEFORE THIS MIGRATION:
  purchase_orders, po_line_items, rate_cards, invoices, invoice_items, and
  v_po_line_item_utilization (migration 0025) all had SELECT policies that
  only checked organization_id — ANY authenticated org member, regardless of
  role, could read full rows including total_amount, gst_amount,
  payment_terms, po_line_items.rate, rate_cards.rate, invoices.total,
  invoice_items.rate/amount. The frontend never rendered this to
  surveyor/designer/printing/installer, but a direct REST call with their
  session token could pull it — exactly the gap the doc calls out.

  WHY A VIEW, NOT JUST A TIGHTER RLS POLICY:
  Postgres RLS is row-level, not column-level, and every business role here
  shares one Postgres "authenticated" role (Supabase's model), so there's no
  native per-app-role column ACL. The doc's own suggested pattern (a
  "production_work_items_view that simply does not select rate/amount
  columns") is the right mechanism: two new views below expose ONLY the
  non-financial PO/line-item fields that Production/Designer/Shop-detail
  screens legitimately need (po_number, fulfillment_type, budgeted_qty/area
  for Phase G's survey banner, etc). They run as the view owner (Postgres
  default), so they bypass the now-tightened base-table RLS, and they
  manually re-scope by organization_id themselves — so every org member can
  still read PO *context*, just never rate/amount/payment_terms, because
  those columns simply don't exist in the view's output. There is no query
  a client can send through PostgREST that gets a rate figure out of these
  views, regardless of role.

  WHAT THIS MEANS FOR EXISTING APP CODE:
  ProductionPage.tsx and DesignerPage.tsx currently embed
  `purchase_orders(...)` / `po_line_items(purchase_orders(...))` through
  PostgREST's FK-embedding — that stops returning data for restricted roles
  once the base tables are locked down (this is the point). Both pages are
  updated in this same pass to fetch PO/line-item context from the new
  views instead (separate query, merged client-side) — see CHANGES.md.
  Office-role pages (PurchaseOrdersPage, SupplyOrdersPage, BillingPage,
  ShopsPages' PO line-item picker) are used only by agency_owner/admin/
  accounts/client_manager already (nav-gated) and keep querying the full
  base tables directly, since those roles are now the only ones RLS allows
  to do so anyway.
*/

-- ============ Tighten SELECT RLS: financial tables ============
-- Only roles that are actually supposed to see money (Section 9 of the
-- doc): agency_owner, admin, accounts, client_manager. Surveyor, designer,
-- printing, installer, demo are excluded — demo is intentionally NOT
-- included here even though it's normally treated as "sees everything
-- (seeded)" elsewhere, because a demo account is the easiest one to hand
-- to an outside party for a walkthrough; if that's wrong for your rollout,
-- add 'demo' back to these four IN-lists.

DROP POLICY IF EXISTS "purchase_orders_select" ON public.purchase_orders;
CREATE POLICY "purchase_orders_select" ON public.purchase_orders FOR SELECT
  TO authenticated USING (
    organization_id = public.current_org_id()
    AND public.current_role() IN ('agency_owner','admin','accounts','client_manager')
  );

DROP POLICY IF EXISTS "po_line_items_select" ON public.po_line_items;
CREATE POLICY "po_line_items_select" ON public.po_line_items FOR SELECT
  TO authenticated USING (
    organization_id = public.current_org_id()
    AND public.current_role() IN ('agency_owner','admin','accounts','client_manager')
  );

DROP POLICY IF EXISTS "rate_cards_select" ON public.rate_cards;
CREATE POLICY "rate_cards_select" ON public.rate_cards FOR SELECT
  TO authenticated USING (
    organization_id = public.current_org_id()
    AND public.current_role() IN ('agency_owner','admin','accounts','client_manager')
  );

DROP POLICY IF EXISTS "invoices_select" ON public.invoices;
CREATE POLICY "invoices_select" ON public.invoices FOR SELECT
  TO authenticated USING (
    organization_id = public.current_org_id()
    AND public.current_role() IN ('agency_owner','admin','accounts','client_manager')
  );

DROP POLICY IF EXISTS "invoice_items_select" ON public.invoice_items;
CREATE POLICY "invoice_items_select" ON public.invoice_items FOR SELECT
  TO authenticated USING (
    organization_id = public.current_org_id()
    AND public.current_role() IN ('agency_owner','admin','accounts','client_manager')
  );

-- ============ Restrict the existing utilization view the same way ============
-- v_po_line_item_utilization (migration 0025) carries `rate` and
-- `invoiced_amount` — recreate with the same role check baked into its
-- WHERE clause (views can't have RLS policies of their own, so the check
-- has to live in the query). Everything else about the view is unchanged.
DROP VIEW IF EXISTS public.v_po_line_item_utilization;
CREATE VIEW public.v_po_line_item_utilization AS
SELECT
  pli.id AS po_line_item_id,
  pli.organization_id,
  pli.purchase_order_id,
  po.po_number,
  po.po_date,
  po.fulfillment_type,
  po.status AS po_status,
  po.client_id,
  c.name AS client_name,
  po.project_id,
  pr.name AS project_name,
  pli.description,
  pli.work_type_id,
  wt.name AS work_type_name,
  pli.uom,
  pli.budgeted_qty,
  pli.budgeted_area,
  pli.rate,
  COALESCE((SELECT sum(wi.survey_area) FROM public.work_items wi WHERE wi.po_line_item_id = pli.id), 0) AS surveyed_area,
  COALESCE((SELECT sum(wi.survey_quantity) FROM public.work_items wi WHERE wi.po_line_item_id = pli.id), 0) AS surveyed_qty,
  COALESCE((SELECT sum(wi.approved_area) FROM public.work_items wi WHERE wi.po_line_item_id = pli.id), 0) AS approved_area,
  COALESCE((SELECT sum(wi.approved_quantity) FROM public.work_items wi WHERE wi.po_line_item_id = pli.id), 0) AS approved_qty,
  COALESCE((SELECT sum(wi.produced_quantity) FROM public.work_items wi WHERE wi.po_line_item_id = pli.id), 0) AS produced_qty,
  COALESCE((SELECT sum(wi.installed_area) FROM public.work_items wi WHERE wi.po_line_item_id = pli.id), 0) AS installed_area,
  COALESCE((SELECT sum(wi.installed_quantity) FROM public.work_items wi WHERE wi.po_line_item_id = pli.id), 0) AS installed_qty,
  COALESCE((SELECT count(*) FROM public.work_items wi WHERE wi.po_line_item_id = pli.id), 0) AS linked_work_item_count,
  COALESCE((SELECT sum(ii.amount) FROM public.invoice_items ii WHERE ii.po_line_item_id = pli.id), 0) AS invoiced_amount
FROM public.po_line_items pli
JOIN public.purchase_orders po ON po.id = pli.purchase_order_id
LEFT JOIN public.clients c ON c.id = po.client_id
LEFT JOIN public.projects pr ON pr.id = po.project_id
LEFT JOIN public.work_types wt ON wt.id = pli.work_type_id
WHERE pli.organization_id = public.current_org_id()
  AND public.current_role() IN ('agency_owner','admin','accounts','client_manager');

GRANT SELECT ON public.v_po_line_item_utilization TO authenticated;

-- ============ NEW: non-financial PO context view (all org members) ============
-- Everything a Production/Shop-detail card needs to show ("PO 2999025524",
-- "Supply Only" badge) minus every money column. Runs as owner (default
-- Postgres view behaviour), so it is NOT subject to the tightened
-- purchase_orders RLS above — it re-scopes by org itself instead. No role
-- check here on purpose: PO number/fulfillment-type/status is legitimate
-- "work info" per Section 9's matrix, only the money columns are excluded.
CREATE OR REPLACE VIEW public.v_po_work_context AS
SELECT
  po.id,
  po.organization_id,
  po.client_id,
  po.project_id,
  po.po_number,
  po.po_date,
  po.fulfillment_type,
  po.status
FROM public.purchase_orders po
WHERE po.organization_id = public.current_org_id();

GRANT SELECT ON public.v_po_work_context TO authenticated;

-- ============ NEW: non-financial PO line-item context view (all org members) ============
-- Same idea, at the line-item level — includes budgeted_qty/budgeted_area
-- (needed for Phase G's live survey-vs-budget banner) but never `rate` or
-- hsn_code isn't financial but is admin-only paperwork detail, left off too
-- since nothing non-financial needs it outside the PO editor.
CREATE OR REPLACE VIEW public.v_po_line_item_work_context AS
SELECT
  pli.id,
  pli.organization_id,
  pli.purchase_order_id,
  po.po_number,
  po.fulfillment_type,
  po.status AS po_status,
  pli.work_type_id,
  pli.description,
  pli.uom,
  pli.budgeted_qty,
  pli.budgeted_area
FROM public.po_line_items pli
JOIN public.purchase_orders po ON po.id = pli.purchase_order_id
WHERE pli.organization_id = public.current_org_id();

GRANT SELECT ON public.v_po_line_item_work_context TO authenticated;
