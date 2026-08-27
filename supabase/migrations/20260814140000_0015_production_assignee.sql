/*
# Production orders need a specific assignee, same as Design already has

## Why

`design_tasks.designer_id` has existed since the original schema, but no
screen in the app ever let anyone set it — so "Designer: Unassigned" was
permanent for any shop created after the seed data. Requested fix: when
Survey Review is approved, the Admin/Owner should pick which designer the
new `design_tasks` row goes to, right there in the same modal.

The same pattern is now requested one stage further: when a Design task is
marked "Ready for Production", the Admin/Owner should pick which
Production/Printing team member the new `production_orders` row is
assigned to. `production_orders` has no assignee column at all today — add
one, mirroring `design_tasks.designer_id` exactly (nullable, SET NULL on
delete, no NOT NULL so existing/older orders aren't broken).

Installation stays on the existing `shop_assignments` mechanism (it already
supports role='installer' and has a dedicated "Assign Installer" flow on
the Shop Detail page) — Production's "Completed" approval now also lets the
Admin/Owner pick/confirm the installer at that moment, writing to the same
`shop_assignments` table, so no schema change is needed there.
*/

ALTER TABLE public.production_orders
  ADD COLUMN IF NOT EXISTS assigned_to uuid REFERENCES public.profiles(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_production_orders_assigned_to ON public.production_orders(assigned_to);
