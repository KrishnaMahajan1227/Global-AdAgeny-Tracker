/*
# Client visibility into installation completion dates

The Client Organization portal's Agencies page shows overall % complete
per agency, but had no way to show monthly performance (installations
this month vs last month) — `installation_jobs.completed_at` is exactly
that data, but the base `installation_jobs_select` policy only allows the
owning AGENCY's org to read it; a client org had no access at all.

Additive policy, same shape as the existing client-org branch on
`shops_select` (migration 0037): a client org can read an installation
job only when it belongs to a shop on one of ITS OWN Work Orders. No
column here carries money, so there's nothing sensitive being opened up —
just "when did this get installed", which is what a client needs to
actually judge an agency's pace.
*/

DROP POLICY IF EXISTS "installation_jobs_select_client" ON public.installation_jobs;
CREATE POLICY "installation_jobs_select_client" ON public.installation_jobs FOR SELECT
  TO authenticated USING (
    public.current_org_type() = 'client'
    AND EXISTS (
      SELECT 1 FROM public.shops s
      JOIN public.purchase_orders po ON po.id = s.purchase_order_id
      WHERE s.id = installation_jobs.shop_id
        AND po.client_org_id = public.current_org_id()
    )
  );
