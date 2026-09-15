/*
# Reset all operational data — keep only Users, Organization, and settings

Requested: clear out every shop / survey / design / production / installation /
billing record (including all the leftover test & demo data from earlier
sessions) and start the pipeline completely clean, while keeping logins
intact.

## What stays
- `organizations` — needed structurally (profiles.organization_id points at it)
- `profiles` / `auth.users` / `auth.identities` — every login you've created
  (MahadhanClient, Darshan Owner, all the field staff, etc.) is untouched
- `work_types` and `rate_cards` — these are organization *settings* (what
  kinds of work you do, what you charge), not shop data, so they're kept so
  you don't have to re-enter them

## What gets wiped
Everything else: clients, projects, shops, shop_assignments, routes/route_stops,
surveys, survey_photos, board_markings, work_items, approvals, design_tasks,
design_versions, production_orders, production_items, installation_jobs,
installation_proofs, invoices, invoice_items, worker_locations, notifications,
audit_logs.

`clients` cascades almost all of this on its own (every one of those tables
is ON DELETE CASCADE, directly or transitively, off clients → shops); the
four tables that aren't reachable that way (notifications, audit_logs,
worker_locations, routes) are cleared explicitly.

This is a one-time reset — nothing here re-runs on future deploys, and
nothing here touches migration 0011's approval-gate triggers/constraints,
which stay in effect for everything created from here on.
*/

DELETE FROM public.notifications;
DELETE FROM public.audit_logs;
DELETE FROM public.worker_locations;
DELETE FROM public.routes;       -- cascades route_stops
DELETE FROM public.clients;      -- cascades: projects, shops, shop_assignments,
                                  -- surveys, survey_photos, board_markings,
                                  -- work_items, approvals, design_tasks,
                                  -- design_versions, production_orders,
                                  -- production_items, installation_jobs,
                                  -- installation_proofs, invoices, invoice_items
