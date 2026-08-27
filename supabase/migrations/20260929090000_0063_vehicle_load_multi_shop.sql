/*
# Phase 8b — Multi-Shop Vehicle Trips + Vehicle Load Log

## Problem this closes
Migration 0062 modeled a "vehicle load" as one header row per SHOP (one
truck run = one shop). In practice a single vehicle very often carries
material for SEVERAL shops in one trip (a route). Today, doing that means
running "Load Vehicle" once per shop and re-typing the same vehicle
number/driver each time — nothing ties those rows together as one trip,
so Owner/Admin/Production can't see "is trip me kitni dukaanein cover
hui, ek hi gaadi se" (how many shops this one vehicle trip covered) as a
single unit, and reporting has to guess by matching vehicle numbers by
hand.

This migration is additive only:
- `vehicle_loads.vehicle_trip_id` — a plain correlation id (NOT a foreign
  key to a new parent table) stamped on every per-shop `vehicle_loads` row
  created together in one multi-shop loading action. Rows created via the
  existing single-shop flow simply leave this NULL, so nothing about
  migration 0062 changes shape or behaviour. Grouping by this id (falling
  back to the row's own id when null) is enough to reconstruct "which
  shops travelled together in this trip" without a new parent table, new
  RLS policies, or a new realtime subscription.
- `v_vehicle_load_log` — a flat, item-level, org-wide view (one row per
  board on any vehicle load) joining in shop, installer, and loaded-by
  names. This is the actual "kitna saman load hua tha, kisne kiya, kisko
  kiya" log Owner/Admin and Production both need for checking/reporting —
  today that data exists but is only ever fetched pre-filtered to one
  shop at a time (ProductionPage's per-shop history modal). Nothing here
  changes existing tables/views; this only adds a read surface on top of
  them.
- `vehicle_load_stats()` gains `trips_today` — distinct loading events
  today, counting a multi-shop trip as ONE event (grouped by
  vehicle_trip_id, falling back to id) instead of counting it once per
  shop the way `vehicles_today` (distinct vehicle_number) would over-
  count when the same vehicle does multiple trips, or under-count when
  two different vehicles happen to share a number format collision.
*/

-- ============================================================
-- 1. vehicle_loads.vehicle_trip_id — correlation id, not a FK.
--    Multiple vehicle_loads rows sharing the same value were created
--    together, in one multi-shop loading action, for the same vehicle.
-- ============================================================
ALTER TABLE public.vehicle_loads
  ADD COLUMN IF NOT EXISTS vehicle_trip_id uuid;

CREATE INDEX IF NOT EXISTS idx_vehicle_loads_trip ON public.vehicle_loads(vehicle_trip_id);

COMMENT ON COLUMN public.vehicle_loads.vehicle_trip_id IS
  'Correlation id shared by every per-shop vehicle_loads row created in the same multi-shop loading action. NULL for single-shop loads. Not a foreign key — there is no parent trip table.';

-- ============================================================
-- 2. v_vehicle_load_log — flat, item-level, org-wide log for
--    Owner/Admin and Production to check "kitna saman load hua,
--    kisne kiya, kisko kiya" without pre-filtering to one shop.
-- ============================================================
CREATE OR REPLACE VIEW public.v_vehicle_load_log AS
SELECT
  vli.id AS item_id,
  vl.id AS vehicle_load_id,
  vl.vehicle_trip_id,
  vl.organization_id,
  vl.vehicle_number,
  vl.driver_name,
  vl.status,
  vl.notes,
  vl.loaded_at,
  vl.delivered_at,
  s.id AS shop_id,
  s.name AS shop_name,
  s.city AS shop_city,
  vl.loaded_by,
  lp.full_name AS loaded_by_name,
  vl.installer_id,
  ip.full_name AS installer_name,
  vl.delivered_by,
  dp.full_name AS delivered_by_name,
  vli.work_type_name,
  vli.material,
  vli.qty_ready,
  vli.qty_loaded
FROM public.vehicle_load_items vli
JOIN public.vehicle_loads vl ON vl.id = vli.vehicle_load_id
JOIN public.shops s ON s.id = vl.shop_id
LEFT JOIN public.profiles lp ON lp.id = vl.loaded_by
LEFT JOIN public.profiles ip ON ip.id = vl.installer_id
LEFT JOIN public.profiles dp ON dp.id = vl.delivered_by
WHERE vl.organization_id = public.current_org_id();

GRANT SELECT ON public.v_vehicle_load_log TO authenticated;

-- ============================================================
-- 3. vehicle_load_stats() — add trips_today (a multi-shop trip
--    counts once, not once per shop).
--    NOTE: adding a column to RETURNS TABLE changes the function's
--    OUT-parameter signature, which CREATE OR REPLACE FUNCTION is not
--    allowed to do (SQLSTATE 42P13). Drop it first.
-- ============================================================
DROP FUNCTION IF EXISTS public.vehicle_load_stats();

CREATE FUNCTION public.vehicle_load_stats()
RETURNS TABLE (
  shops_not_loaded bigint,
  shops_partial bigint,
  shops_loaded bigint,
  total_ready_qty numeric,
  total_loaded_qty numeric,
  total_pending_qty numeric,
  vehicles_today bigint,
  trips_today bigint
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    COUNT(*) FILTER (WHERE load_status = 'not_loaded') AS shops_not_loaded,
    COUNT(*) FILTER (WHERE load_status = 'partial') AS shops_partial,
    COUNT(*) FILTER (WHERE load_status = 'loaded') AS shops_loaded,
    COALESCE(SUM(total_ready_qty), 0) AS total_ready_qty,
    COALESCE(SUM(total_loaded_qty), 0) AS total_loaded_qty,
    COALESCE(SUM(pending_qty), 0) AS total_pending_qty,
    (
      SELECT COUNT(DISTINCT vehicle_number) FROM public.vehicle_loads
      WHERE organization_id = public.current_org_id()
        AND status <> 'cancelled'
        AND loaded_at::date = now()::date
    ) AS vehicles_today,
    (
      SELECT COUNT(DISTINCT COALESCE(vehicle_trip_id::text, id::text)) FROM public.vehicle_loads
      WHERE organization_id = public.current_org_id()
        AND status <> 'cancelled'
        AND loaded_at::date = now()::date
    ) AS trips_today
  FROM public.v_vehicle_load_shop_summary
  WHERE fulfillment_type IS DISTINCT FROM 'supply_only';
$$;

GRANT EXECUTE ON FUNCTION public.vehicle_load_stats() TO authenticated;
