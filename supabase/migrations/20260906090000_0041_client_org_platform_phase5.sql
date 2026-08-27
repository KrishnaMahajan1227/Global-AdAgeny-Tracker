/*
# Phase 5 — Client app: full Billing screen + PDF downloads

  Builds on Phase 3 (Overview/Campaigns/PO Detail) and Phase 4 (Map Feed).
  `invoices` and `invoice_items` already have a client-org SELECT branch
  (migration 0037), which is most of what this screen needs. The one real
  gap: generating an invoice PDF client-side reuses the existing
  `generateInvoicePDF()` (lib/reports.ts, same function the agency's own
  Billing page already uses), which needs a `clients` row for the "Bill
  To" block — and `clients` never had a client-org SELECT branch at all
  (Phase 1 intentionally left the agency's internal `clients` table alone;
  see 0037's header note on the two different "client" concepts).

  This is purely additive: a second, separate PERMISSIVE policy on
  `clients` (Postgres OR's multiple permissive policies together for the
  same command), so the existing agency-side policy from migration 0033
  is completely untouched. It only ever exposes the ONE clients row that
  represents a given client org at a given agency — `agency_client_id` on
  `client_agency_links`, set automatically by `agency_invite_client_org`
  (Phase 2) — never any other client the agency has.
*/

DROP POLICY IF EXISTS "clients_select_client_org" ON public.clients;
CREATE POLICY "clients_select_client_org" ON public.clients FOR SELECT
  TO authenticated USING (
    EXISTS (
      SELECT 1 FROM public.client_agency_links l
      WHERE l.client_org_id = public.current_org_id()
        AND l.agency_client_id = clients.id
    )
  );
