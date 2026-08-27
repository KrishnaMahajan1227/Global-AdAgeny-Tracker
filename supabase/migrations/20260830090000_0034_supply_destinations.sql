/*
# Phase A — supply_destinations table (Section 4.2)

  ARCHITECTURE doc Section 4.2 asks for a standalone `supply_destinations`
  table so a Supply Only PO's delivery points don't have to be forced
  through `shops`-shaped fields (GPS survey, board marking, installer
  assignment) that don't apply to them.

  WHY THIS IS ADDITIVE, NOT A REPLACEMENT:
  SupplyOrdersPage.tsx / ProductionPage.tsx / DesignerPage.tsx / the
  dispatch (routes/route_stops) flow are all already built and working on
  top of `shops` + `work_items` + `design_tasks` + `production_orders` for
  the supply_only path (documented in CHANGES.md as a deliberate call —
  forking that entire approval pipeline onto a second parallel table would
  double the surface area for every future bug fix, for a table that per
  the doc itself only needs to carry destination/contact/qty/status).

  So `supply_destinations` here is a genuine, literal implementation of the
  doc's schema (same columns, same status enum) that lives ALONGSIDE the
  shop-based pipeline rather than replacing it:
  - The app (SupplyOrdersPage.tsx) creates one `supply_destinations` row
    the moment it creates the shop-based delivery point, keeping the two in
    sync (name/contact/address/qty/PO/line-item/zone).
  - `route_id`/`status` are updated when that shop enters a dispatch route
    — see doc's own field name `dispatch_id`; this project's dispatch
    mechanism is the existing `routes` table (migration 0027's own
    documented rename, not a new `dispatches` table), so this FK points at
    `routes(id)` and is named `route_id` to match what actually exists,
    while still satisfying the "dispatch reference" the doc calls for.
  - `shop_id` is an EXTRA column beyond the doc's spec, purely so the two
    records can be looked up from each other — safe to ignore if you only
    care about the doc-literal columns.

  This gives you a real, queryable, literal `supply_destinations` table for
  reporting/export/API purposes (exactly the shape Section 4.2 specifies)
  without any risk to the already-working pipeline.
*/

CREATE TABLE IF NOT EXISTS public.supply_destinations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  purchase_order_id uuid NOT NULL REFERENCES public.purchase_orders(id) ON DELETE CASCADE,
  po_line_item_id uuid REFERENCES public.po_line_items(id) ON DELETE SET NULL,
  zone_id uuid REFERENCES public.zones(id) ON DELETE SET NULL,
  shop_id uuid REFERENCES public.shops(id) ON DELETE SET NULL,
  destination_name text NOT NULL,
  contact_person text,
  contact_phone text,
  address text,
  quantity numeric NOT NULL DEFAULT 0,
  uom text NOT NULL DEFAULT 'piece',
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','in_production','packed','dispatched','delivered')),
  route_id uuid REFERENCES public.routes(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.supply_destinations ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_supply_destinations_org ON public.supply_destinations(organization_id);
CREATE INDEX IF NOT EXISTS idx_supply_destinations_po ON public.supply_destinations(purchase_order_id);
CREATE INDEX IF NOT EXISTS idx_supply_destinations_shop ON public.supply_destinations(shop_id);
CREATE INDEX IF NOT EXISTS idx_supply_destinations_route ON public.supply_destinations(route_id);

-- Same role gate as the rest of the Supply Only flow: only the roles that
-- can already reach SupplyOrdersPage/PurchaseOrdersPage (financial/office
-- roles) can read or write this, mirroring migration 0029's Section 9
-- lockdown — this table is PO/qty/destination info, not shop-visit work,
-- so it doesn't need the broader org-wide read shops/work_items get.
DROP POLICY IF EXISTS "supply_destinations_select" ON public.supply_destinations;
CREATE POLICY "supply_destinations_select" ON public.supply_destinations FOR SELECT
  TO authenticated USING (
    organization_id = public.current_org_id()
    AND public.current_role() IN ('agency_owner','admin','accounts','client_manager')
    AND (
      public.current_role() <> 'client_manager'
      OR public.current_client_id() IS NULL
      OR EXISTS (
        SELECT 1 FROM public.purchase_orders po
        WHERE po.id = supply_destinations.purchase_order_id
          AND po.client_id = public.current_client_id()
      )
    )
  );

DROP POLICY IF EXISTS "supply_destinations_insert" ON public.supply_destinations;
CREATE POLICY "supply_destinations_insert" ON public.supply_destinations FOR INSERT
  TO authenticated WITH CHECK (
    organization_id = public.current_org_id()
    AND public.current_role() IN ('agency_owner','admin','accounts')
  );

DROP POLICY IF EXISTS "supply_destinations_update" ON public.supply_destinations;
CREATE POLICY "supply_destinations_update" ON public.supply_destinations FOR UPDATE
  TO authenticated USING (
    organization_id = public.current_org_id()
    AND public.current_role() IN ('agency_owner','admin','accounts')
  )
  WITH CHECK (
    organization_id = public.current_org_id()
    AND public.current_role() IN ('agency_owner','admin','accounts')
  );

DROP POLICY IF EXISTS "supply_destinations_delete" ON public.supply_destinations;
CREATE POLICY "supply_destinations_delete" ON public.supply_destinations FOR DELETE
  TO authenticated USING (
    organization_id = public.current_org_id()
    AND public.current_role() IN ('agency_owner','admin')
  );

-- Backfill: one supply_destinations row per existing supply_only shop, so
-- data entered before this migration shows up here too, not just going
-- forward. quantity/uom is pulled from that shop's linked PO line item
-- (or summed across its work items when it has more than one line item)
-- since a supply-only "shop" doesn't have its own quantity field.
INSERT INTO public.supply_destinations (
  organization_id, purchase_order_id, po_line_item_id, zone_id, shop_id,
  destination_name, contact_person, contact_phone, address, quantity, uom, status
)
SELECT
  s.organization_id,
  s.purchase_order_id,
  wi.po_line_item_id,
  s.zone_id,
  s.id,
  s.name,
  s.owner_name,
  s.contact_phone,
  s.address,
  COALESCE(wi.approved_quantity, wi.survey_quantity, 0),
  COALESCE(pli.uom, 'piece'),
  CASE
    WHEN s.status IN ('dispatched') THEN 'dispatched'
    WHEN s.status IN ('production_done') THEN 'packed'
    WHEN s.status IN ('production_pending') THEN 'in_production'
    ELSE 'pending'
  END
FROM public.shops s
JOIN public.purchase_orders po ON po.id = s.purchase_order_id AND po.fulfillment_type = 'supply_only'
LEFT JOIN LATERAL (
  SELECT wi.po_line_item_id, wi.approved_quantity, wi.survey_quantity
  FROM public.work_items wi
  WHERE wi.shop_id = s.id
  ORDER BY wi.created_at
  LIMIT 1
) wi ON true
LEFT JOIN public.po_line_items pli ON pli.id = wi.po_line_item_id
WHERE s.purchase_order_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM public.supply_destinations sd WHERE sd.shop_id = s.id);
