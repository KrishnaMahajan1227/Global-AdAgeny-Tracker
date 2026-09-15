/*
# Phase 10 — Bulk shop upload must resolve a real zone_id, not just free text

## The problem
Migration 0021 upgraded `shops.zone` (free text) to `shops.zone_id`
(foreign key to a proper `zones` table) so zone-wise filtering/reporting
would work, and updated the manual "Add Shop" form to use it. But all
THREE bulk-upload code paths (agency's own Shops page, and both
client-side flows — ClientShopsPage and ClientPODetailPage) were left
writing only the old free-text `zone` column and never resolving/creating
a `zone_id`. Net effect: every shop added via Excel/CSV upload — which is
most shops, in practice — silently fell outside zone-based filtering
forever, and any zone name typed in a client's spreadsheet never became a
zone the agency could actually use, even though it displayed as text on
the shop card. This looked like "zone details aren't reaching the
agency properly."

## The fix
The app-side fix (this migration's companion frontend change) now
resolves each parsed sheet's zone names against the `zones` table —
reusing an existing zone by (organization_id, project_id, name) or
creating a new one — before inserting shops, exactly like the manual
Add Shop form already does via its zone_id dropdown + "Add Zone" flow.

For the agency's OWN bulk upload this needs no RLS change: the agency
inserts under its own organization_id, already covered by migration
0021's `organization_id = current_org_id()` policies.

For the CLIENT-side bulk upload flows, shops are inserted under the
AGENCY's organization_id (a client never owns shops directly — see
migration 0051/0053's shops_insert exception for the established
pattern). Resolving/creating a zone the same way requires the identical
cross-org exception on `zones` SELECT and INSERT: a client_admin acting
on their own client_created Work Order may read and create zones under
that Work Order's assigned agency, mirroring shops_insert exactly
(same EXISTS check, same columns, same origin restriction).
*/

DROP POLICY IF EXISTS "zones_select" ON public.zones;
CREATE POLICY "zones_select" ON public.zones FOR SELECT
  TO authenticated USING (
    organization_id = public.current_org_id()
    OR
    (
      public.current_org_type() = 'client'
      AND public.current_role() = 'client_admin'
      AND EXISTS (
        SELECT 1 FROM public.purchase_orders po
        WHERE po.assigned_agency_id = zones.organization_id
          AND po.client_org_id = public.current_org_id()
          AND po.origin = 'client_created'
      )
    )
  );

DROP POLICY IF EXISTS "zones_insert" ON public.zones;
CREATE POLICY "zones_insert" ON public.zones FOR INSERT
  TO authenticated WITH CHECK (
    organization_id = public.current_org_id()
    OR
    (
      public.current_org_type() = 'client'
      AND public.current_role() = 'client_admin'
      AND EXISTS (
        SELECT 1 FROM public.purchase_orders po
        WHERE po.assigned_agency_id = zones.organization_id
          AND po.client_org_id = public.current_org_id()
          AND po.origin = 'client_created'
      )
    )
  );
