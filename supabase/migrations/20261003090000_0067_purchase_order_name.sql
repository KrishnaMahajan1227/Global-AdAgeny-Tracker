/*
# Work Order (PO) name

Every Work Order has always been identified only by `po_number` (a short
code like "PO-2026-0417") — fine for internal reference, but meaningless
to skim in a list. This adds an optional, human-readable `name` (e.g.
"Q3 Andheri Dealer Boards") that both the agency and the client can set
when creating a Work Order, shown alongside the number everywhere a PO is
listed.

Purely additive: `name` is nullable, existing POs are unaffected, nothing
that reads `po_number` needs to change to keep working.
*/

ALTER TABLE public.purchase_orders
  ADD COLUMN IF NOT EXISTS name text;

COMMENT ON COLUMN public.purchase_orders.name IS
  'Optional human-readable label for this Work Order (e.g. "Q3 Andheri Dealer Boards"), shown alongside po_number everywhere a PO is listed. Settable by either side (agency or client) that creates the PO.';
