/*
# Phase 8 — Production-side Vehicle Load register

## Problem this closes
Today the only "what's physically loaded on the vehicle" record is filled
in by the INSTALLER, self-declared, right before they mark a job started
(migration 0044's material_check_* columns on installation_jobs). Nothing
captures the PRODUCTION side of that same handover: how much of each
board Production actually finished, and how much of that they physically
handed off — to which installer, in which vehicle — before it ever leaves
the workshop. Owner/Admin has no way to see "kitna maal ready hua, kitna
kiske vehicle me gaya" (how much material is ready vs. how much has
actually gone out, and in whose vehicle) side by side, per shop.

## Design
Two new tables, additive only — no existing table's shape changes except
one new nullable FK column on installation_jobs for traceability:

- `vehicle_loads` — one header row per loading event: which shop, which
  installer it's being handed to, who in Production loaded it, the
  vehicle number/driver, and a status ('loaded' → 'delivered', or
  'cancelled' if entered by mistake).
- `vehicle_load_items` — one row per board on that load, snapshotting the
  ready quantity at load time alongside the quantity actually loaded (a
  genuine partial load — e.g. one board held back — is recorded honestly,
  exactly like the installer-side register already does).
- `installation_jobs.vehicle_load_id` — set when the installer's wizard
  starts a job for a shop that already has a Production-side load on
  file, so the installer's own material check step can be pre-filled
  from what Production actually loaded instead of re-typed from scratch,
  and Installation Review can trace the full chain.

## Reporting
`v_vehicle_load_shop_summary` gives one row per shop that has at least
one production-done board: ready qty, loaded qty, pending (gap) qty, and
the latest vehicle/installer/loaded-by — exactly the "kuch missing to
nahi" reconciliation Owner/Admin needs, computed in SQL instead of
summed client-side. `vehicle_load_stats()` rolls that up into the
Overview counters (shops not yet loaded / partially loaded / fully
loaded, and today's vehicle count).

Supply Only shops are deliberately excluded from this feature (they
already have their own zone-wise dispatch/route flow in
SupplyOrdersPage.tsx — this is specifically the survey+install handover).
*/

-- ============================================================
-- 1. vehicle_loads
-- ============================================================
CREATE TABLE IF NOT EXISTS public.vehicle_loads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
  production_order_id uuid REFERENCES public.production_orders(id) ON DELETE SET NULL,
  installer_id uuid NOT NULL REFERENCES public.profiles(id),
  loaded_by uuid NOT NULL REFERENCES public.profiles(id),
  vehicle_number text NOT NULL,
  driver_name text,
  status text NOT NULL DEFAULT 'loaded' CHECK (status IN ('loaded', 'delivered', 'cancelled')),
  notes text,
  loaded_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  delivered_by uuid REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.vehicle_loads ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_vehicle_loads_org ON public.vehicle_loads(organization_id);
CREATE INDEX IF NOT EXISTS idx_vehicle_loads_shop ON public.vehicle_loads(shop_id);
CREATE INDEX IF NOT EXISTS idx_vehicle_loads_installer ON public.vehicle_loads(installer_id);
CREATE INDEX IF NOT EXISTS idx_vehicle_loads_status ON public.vehicle_loads(status);

DROP TRIGGER IF EXISTS trg_vehicle_loads_updated_at ON public.vehicle_loads;
CREATE TRIGGER trg_vehicle_loads_updated_at
  BEFORE UPDATE ON public.vehicle_loads
  FOR EACH ROW EXECUTE FUNCTION public.trigger_set_updated_at();

-- ============================================================
-- 2. vehicle_load_items
-- ============================================================
CREATE TABLE IF NOT EXISTS public.vehicle_load_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  vehicle_load_id uuid NOT NULL REFERENCES public.vehicle_loads(id) ON DELETE CASCADE,
  work_item_id uuid NOT NULL REFERENCES public.work_items(id) ON DELETE CASCADE,
  work_type_name text,
  material text,
  qty_ready numeric NOT NULL DEFAULT 0,
  qty_loaded numeric NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.vehicle_load_items ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_vehicle_load_items_org ON public.vehicle_load_items(organization_id);
CREATE INDEX IF NOT EXISTS idx_vehicle_load_items_load ON public.vehicle_load_items(vehicle_load_id);
CREATE INDEX IF NOT EXISTS idx_vehicle_load_items_item ON public.vehicle_load_items(work_item_id);

-- ============================================================
-- 3. installation_jobs traceability link
-- ============================================================
ALTER TABLE public.installation_jobs
  ADD COLUMN IF NOT EXISTS vehicle_load_id uuid REFERENCES public.vehicle_loads(id) ON DELETE SET NULL;

-- ============================================================
-- 4. RLS — same shape as the rest of the production/installation
--    pipeline: office roles that run Production Studio (owner/admin/
--    printing/demo) can read & write everything in their org; an
--    installer can only see (and mark delivered) loads addressed to them.
-- ============================================================
DROP POLICY IF EXISTS "vehicle_loads_select" ON public.vehicle_loads;
CREATE POLICY "vehicle_loads_select" ON public.vehicle_loads FOR SELECT
  TO authenticated USING (
    organization_id = public.current_org_id()
    AND (
      public.current_role() IN ('agency_owner', 'admin', 'printing', 'demo')
      OR (public.current_role() = 'installer' AND installer_id = auth.uid())
    )
  );

DROP POLICY IF EXISTS "vehicle_loads_insert" ON public.vehicle_loads;
CREATE POLICY "vehicle_loads_insert" ON public.vehicle_loads FOR INSERT
  TO authenticated WITH CHECK (
    organization_id = public.current_org_id()
    AND public.current_role() IN ('agency_owner', 'admin', 'printing', 'demo')
    AND loaded_by = auth.uid()
  );

DROP POLICY IF EXISTS "vehicle_loads_update" ON public.vehicle_loads;
CREATE POLICY "vehicle_loads_update" ON public.vehicle_loads FOR UPDATE
  TO authenticated USING (
    organization_id = public.current_org_id()
    AND (
      public.current_role() IN ('agency_owner', 'admin', 'printing', 'demo')
      OR (public.current_role() = 'installer' AND installer_id = auth.uid())
    )
  )
  WITH CHECK (
    organization_id = public.current_org_id()
    AND (
      public.current_role() IN ('agency_owner', 'admin', 'printing', 'demo')
      OR (public.current_role() = 'installer' AND installer_id = auth.uid())
    )
  );

DROP POLICY IF EXISTS "vehicle_loads_delete" ON public.vehicle_loads;
CREATE POLICY "vehicle_loads_delete" ON public.vehicle_loads FOR DELETE
  TO authenticated USING (
    organization_id = public.current_org_id()
    AND public.current_role() IN ('agency_owner', 'admin')
  );

DROP POLICY IF EXISTS "vehicle_load_items_select" ON public.vehicle_load_items;
CREATE POLICY "vehicle_load_items_select" ON public.vehicle_load_items FOR SELECT
  TO authenticated USING (
    organization_id = public.current_org_id()
    AND (
      public.current_role() IN ('agency_owner', 'admin', 'printing', 'demo')
      OR (
        public.current_role() = 'installer'
        AND EXISTS (SELECT 1 FROM public.vehicle_loads vl WHERE vl.id = vehicle_load_items.vehicle_load_id AND vl.installer_id = auth.uid())
      )
    )
  );

DROP POLICY IF EXISTS "vehicle_load_items_insert" ON public.vehicle_load_items;
CREATE POLICY "vehicle_load_items_insert" ON public.vehicle_load_items FOR INSERT
  TO authenticated WITH CHECK (
    organization_id = public.current_org_id()
    AND public.current_role() IN ('agency_owner', 'admin', 'printing', 'demo')
  );

DROP POLICY IF EXISTS "vehicle_load_items_update" ON public.vehicle_load_items;
CREATE POLICY "vehicle_load_items_update" ON public.vehicle_load_items FOR UPDATE
  TO authenticated USING (
    organization_id = public.current_org_id()
    AND public.current_role() IN ('agency_owner', 'admin', 'printing', 'demo')
  )
  WITH CHECK (
    organization_id = public.current_org_id()
    AND public.current_role() IN ('agency_owner', 'admin', 'printing', 'demo')
  );

DROP POLICY IF EXISTS "vehicle_load_items_delete" ON public.vehicle_load_items;
CREATE POLICY "vehicle_load_items_delete" ON public.vehicle_load_items FOR DELETE
  TO authenticated USING (
    organization_id = public.current_org_id()
    AND public.current_role() IN ('agency_owner', 'admin')
  );

-- ============================================================
-- 5. v_vehicle_load_shop_summary — one row per shop with any
--    production-done board, ready vs. loaded qty side by side.
-- ============================================================
CREATE OR REPLACE VIEW public.v_vehicle_load_shop_summary AS
WITH ready_boards AS (
  SELECT
    wi.id AS work_item_id,
    wi.shop_id,
    wi.work_type_name,
    wi.material,
    COALESCE(pi.produced_qty, wi.produced_quantity, wi.approved_quantity, wi.survey_quantity, 1) AS ready_qty
  FROM public.work_items wi
  LEFT JOIN (
    SELECT work_item_id, MAX(produced_qty) AS produced_qty
    FROM public.production_items
    WHERE work_item_id IS NOT NULL
    GROUP BY work_item_id
  ) pi ON pi.work_item_id = wi.id
  WHERE wi.organization_id = public.current_org_id()
    AND wi.status IN ('production_done', 'installed')
),
loaded AS (
  SELECT vli.work_item_id, SUM(vli.qty_loaded) AS loaded_qty
  FROM public.vehicle_load_items vli
  JOIN public.vehicle_loads vl ON vl.id = vli.vehicle_load_id
  WHERE vl.organization_id = public.current_org_id()
    AND vl.status <> 'cancelled'
  GROUP BY vli.work_item_id
),
board_totals AS (
  SELECT
    rb.shop_id,
    COUNT(*) AS boards_total,
    COUNT(*) FILTER (WHERE COALESCE(l.loaded_qty, 0) >= rb.ready_qty) AS boards_fully_loaded,
    SUM(rb.ready_qty) AS total_ready_qty,
    SUM(COALESCE(l.loaded_qty, 0)) AS total_loaded_qty
  FROM ready_boards rb
  LEFT JOIN loaded l ON l.work_item_id = rb.work_item_id
  GROUP BY rb.shop_id
),
latest_load AS (
  SELECT DISTINCT ON (vl.shop_id)
    vl.shop_id, vl.id AS vehicle_load_id, vl.vehicle_number, vl.driver_name,
    vl.status, vl.loaded_at, vl.installer_id,
    lp.full_name AS loaded_by_name, ip.full_name AS installer_name
  FROM public.vehicle_loads vl
  LEFT JOIN public.profiles lp ON lp.id = vl.loaded_by
  LEFT JOIN public.profiles ip ON ip.id = vl.installer_id
  WHERE vl.organization_id = public.current_org_id()
  ORDER BY vl.shop_id, vl.loaded_at DESC
),
current_installer AS (
  SELECT DISTINCT ON (sa.shop_id)
    sa.shop_id, sa.user_id AS installer_id, p.full_name AS installer_name
  FROM public.shop_assignments sa
  JOIN public.profiles p ON p.id = sa.user_id
  WHERE sa.role = 'installer' AND sa.status <> 'declined'
    AND sa.organization_id = public.current_org_id()
  ORDER BY sa.shop_id, sa.assigned_at DESC
)
SELECT
  s.id AS shop_id,
  s.organization_id,
  s.name AS shop_name,
  s.city AS shop_city,
  s.address AS shop_address,
  s.status AS shop_status,
  z.name AS zone_name,
  c.name AS client_name,
  pc.po_number,
  pc.fulfillment_type,
  ci.installer_id AS assigned_installer_id,
  ci.installer_name AS assigned_installer_name,
  COALESCE(bt.boards_total, 0) AS boards_total,
  COALESCE(bt.boards_fully_loaded, 0) AS boards_fully_loaded,
  COALESCE(bt.total_ready_qty, 0) AS total_ready_qty,
  COALESCE(bt.total_loaded_qty, 0) AS total_loaded_qty,
  GREATEST(COALESCE(bt.total_ready_qty, 0) - COALESCE(bt.total_loaded_qty, 0), 0) AS pending_qty,
  CASE
    WHEN COALESCE(bt.total_ready_qty, 0) = 0 THEN 'no_boards'
    WHEN COALESCE(bt.total_loaded_qty, 0) <= 0 THEN 'not_loaded'
    WHEN COALESCE(bt.total_loaded_qty, 0) < COALESCE(bt.total_ready_qty, 0) THEN 'partial'
    ELSE 'loaded'
  END AS load_status,
  ll.vehicle_load_id AS latest_vehicle_load_id,
  ll.vehicle_number AS latest_vehicle_number,
  ll.driver_name AS latest_driver_name,
  ll.status AS latest_load_status,
  ll.loaded_at AS latest_loaded_at,
  ll.loaded_by_name AS latest_loaded_by_name,
  COALESCE(ll.installer_name, ci.installer_name) AS latest_installer_name
FROM public.shops s
JOIN public.clients c ON c.id = s.client_id
LEFT JOIN public.zones z ON z.id = s.zone_id
LEFT JOIN public.v_po_work_context pc ON pc.id = s.purchase_order_id
LEFT JOIN board_totals bt ON bt.shop_id = s.id
LEFT JOIN latest_load ll ON ll.shop_id = s.id
LEFT JOIN current_installer ci ON ci.shop_id = s.id
WHERE s.organization_id = public.current_org_id()
  AND bt.shop_id IS NOT NULL;

GRANT SELECT ON public.v_vehicle_load_shop_summary TO authenticated;

-- ============================================================
-- 6. vehicle_load_stats() — Overview counters. Supply Only excluded
--    (it has its own zone-wise dispatch flow already).
-- ============================================================
CREATE OR REPLACE FUNCTION public.vehicle_load_stats()
RETURNS TABLE (
  shops_not_loaded bigint,
  shops_partial bigint,
  shops_loaded bigint,
  total_ready_qty numeric,
  total_loaded_qty numeric,
  total_pending_qty numeric,
  vehicles_today bigint
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
    ) AS vehicles_today
  FROM public.v_vehicle_load_shop_summary
  WHERE fulfillment_type IS DISTINCT FROM 'supply_only';
$$;

GRANT EXECUTE ON FUNCTION public.vehicle_load_stats() TO authenticated;

-- ============================================================
-- 7. Realtime — so Production/Owner/Installer screens update live,
--    same publication every other operational table is already on.
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'vehicle_loads'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.vehicle_loads';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'vehicle_load_items'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.vehicle_load_items';
  END IF;
END $$;
