/*
# Phase 9 — Supply-Only "Confirm to Owner" checkpoint (Architecture v2.0 §3.3, §8 item 4)

Per §3.3's corrected Lane B flow, there should be an explicit
"dispatch confirmed" checkpoint back to the Owner/Admin between Dispatch
and Billing — today a dispatch route is created and that's it, nothing
records that an Owner/Admin actually looked at it. Per §8 item 4 ("confirm
exists or add as a status flag") and Assumption A3 (this stays inside the
existing routes/dispatch flow — no new "Distribution" role/table), this
adds the flag directly to `routes`.

Nothing here blocks billing — same "flag, don't hard-block" pattern used
throughout this codebase (PO variance banner, GST sanity check, GPS
distance flag). The point is visibility, not a gate.
*/

ALTER TABLE public.routes
  ADD COLUMN IF NOT EXISTS owner_confirmed_at timestamptz;
ALTER TABLE public.routes
  ADD COLUMN IF NOT EXISTS owner_confirmed_by uuid REFERENCES public.profiles(id);
