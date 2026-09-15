/*
# Phase 4 — Client app: Map Feed

  Builds on Phase 3 (0039 — Overview / Campaigns / PO Detail). Nothing here
  touches the operational pipeline or any agency-side screen. Map Feed
  (GLOBAL_ARCHITECTURE.md section 4.4) itself needs no new tables or views
  — `shops` already has lat/long + status and already has a client-org SELECT
  branch (migration 0037), which is 90% of what the map needs. The one real
  gap: the popup's "before/after photos" requirement (section 4.4) needs
  `survey_photos` / `installation_proofs` rows, and neither table had a
  client-org SELECT branch yet (Phase 1 only extended shops/invoices/
  po_line_items/purchase_orders).

  Both underlying storage buckets (survey-photos, installation-proof) are
  already PUBLIC READ (migration 0003) — this migration only needs to let a
  client_org user read the *row* (to get the photo_url/caption at all),
  scoped the same way shops_select already is: only photos belonging to a
  shop that's linked to one of their own client-created POs.
*/

DROP POLICY IF EXISTS "survey_photos_select" ON public.survey_photos;
CREATE POLICY "survey_photos_select" ON public.survey_photos FOR SELECT
  TO authenticated USING (
    organization_id = public.current_org_id()
    OR
    (
      public.current_org_type() = 'client'
      AND EXISTS (
        SELECT 1 FROM public.shops s
        JOIN public.purchase_orders po ON po.id = s.purchase_order_id
        WHERE s.id = survey_photos.shop_id
          AND po.client_org_id = public.current_org_id()
      )
    )
  );

DROP POLICY IF EXISTS "installation_proofs_select" ON public.installation_proofs;
CREATE POLICY "installation_proofs_select" ON public.installation_proofs FOR SELECT
  TO authenticated USING (
    organization_id = public.current_org_id()
    OR
    (
      public.current_org_type() = 'client'
      AND EXISTS (
        SELECT 1 FROM public.shops s
        JOIN public.purchase_orders po ON po.id = s.purchase_order_id
        WHERE s.id = installation_proofs.shop_id
          AND po.client_org_id = public.current_org_id()
      )
    )
  );
