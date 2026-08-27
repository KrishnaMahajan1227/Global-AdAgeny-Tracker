/*
  # Route Optimization Metadata

  Section (new, closes the gap flagged after the PO/production doc):
  "Google Maps Directions/route optimization (turn-by-turn navigation,
  admin route planning) — sirf basic markers hain abhi."

  The `routes` / `route_stops` tables already existed (migration 0001) and
  were already used for the Supply-Only "zone-wise dispatch" flow (migration
  0027 added transport_mode/tracking_reference/zone_id). What was missing
  was the Survey+Install side: an actual admin route-planning screen that
  calls the Google Directions API to optimize stop order and produce real
  turn-by-turn navigation for surveyors/installers, instead of only ever
  navigating to one shop at a time.

  This migration only adds the columns needed to persist the *result* of
  that optimization (so a saved route remembers its distance/duration and
  each stop remembers its leg from the previous stop) — no behavior change
  for the existing dispatch flow, which simply leaves these columns null.
*/

-- ============ routes: optimization result summary ============
ALTER TABLE public.routes
  ADD COLUMN IF NOT EXISTS optimized boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS total_distance_meters numeric,
  ADD COLUMN IF NOT EXISTS total_duration_seconds numeric,
  ADD COLUMN IF NOT EXISTS origin_lat numeric,
  ADD COLUMN IF NOT EXISTS origin_lng numeric,
  ADD COLUMN IF NOT EXISTS origin_label text,
  ADD COLUMN IF NOT EXISTS notes text;

-- ============ route_stops: per-leg distance/time from the previous stop ============
ALTER TABLE public.route_stops
  ADD COLUMN IF NOT EXISTS leg_distance_meters numeric,
  ADD COLUMN IF NOT EXISTS leg_duration_seconds numeric;

CREATE INDEX IF NOT EXISTS idx_routes_user_date ON public.routes(user_id, route_date);
CREATE INDEX IF NOT EXISTS idx_route_stops_route_id ON public.route_stops(route_id);
CREATE INDEX IF NOT EXISTS idx_route_stops_shop_id ON public.route_stops(shop_id);
