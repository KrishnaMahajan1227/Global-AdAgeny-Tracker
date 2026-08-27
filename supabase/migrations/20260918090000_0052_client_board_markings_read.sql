/*
# Phase 23 — client-org read access to board_markings + work_items (marked photos)

## The bug
The client portal's Shops view fetches `survey_photos` rows fine
(migration 0040 already gave a client org a SELECT branch there), but has
always rendered the PLAIN photo — never the marked-up version with board
polygons drawn on top, the way `renderMarkedImage()` (markingUtils.ts)
already does everywhere on the agency side (ShopsPages.tsx,
SurveyReviewPage.tsx, InstallerPage.tsx, report exports). The reason: RLS
on `board_markings` has only ever had an agency-scoped branch
(`organization_id = current_org_id()`), and a client org's
`current_org_id()` is their own client org id, which never matches an
agency's `board_markings.organization_id` — so the client-side query for
markings has always come back empty, with no error to signal why. Same
gap on `work_items` — needed for a marked photo's on-image label (work
type + dimensions), and for the client to see per-shop board specs at all.

## Fix
Two additive SELECT branches, same shape as the existing
`survey_photos_select` / `installation_proofs_select` client branches
from migration 0040: a client_org user may read `board_markings` /
`work_items` rows, but ONLY for a shop that belongs to one of their own
POs (`purchase_orders.client_org_id = current_org_id()`). No rate/cost
data is exposed either way — neither table carries pricing columns.
*/

DROP POLICY IF EXISTS "board_markings_select" ON public.board_markings;
CREATE POLICY "board_markings_select" ON public.board_markings FOR SELECT
  TO authenticated USING (
    organization_id = public.current_org_id()
    OR
    (
      public.current_org_type() = 'client'
      AND EXISTS (
        SELECT 1 FROM public.survey_photos sp
        JOIN public.shops s ON s.id = sp.shop_id
        JOIN public.purchase_orders po ON po.id = s.purchase_order_id
        WHERE sp.id = board_markings.survey_photo_id
          AND po.client_org_id = public.current_org_id()
      )
    )
  );

DROP POLICY IF EXISTS "work_items_select" ON public.work_items;
CREATE POLICY "work_items_select" ON public.work_items FOR SELECT
  TO authenticated USING (
    organization_id = public.current_org_id()
    OR
    (
      public.current_org_type() = 'client'
      AND EXISTS (
        SELECT 1 FROM public.shops s
        JOIN public.purchase_orders po ON po.id = s.purchase_order_id
        WHERE s.id = work_items.shop_id
          AND po.client_org_id = public.current_org_id()
      )
    )
  );
