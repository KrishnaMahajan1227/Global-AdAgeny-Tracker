/*
# Phase 2 — Zones (upgrade shops.zone from free text to a structured table)

   - New `zones` table: org-scoped, optionally tied to a project (so the
     same "Rajkot"/"Jalgaon" zone can be reused project-wide or scoped
     tighter if the agency wants that later).
   - `shops.zone_id` added as a NEW nullable column pointing at zones.
   - The old `shops.zone` text column is LEFT IN PLACE (not dropped, not
     renamed) so nothing existing breaks: old reports/exports/queries that
     still read shop.zone keep working. Going forward the app writes to
     zone_id instead.
   - Backfill: every distinct non-blank (project_id, zone-text) pair
     already sitting in shops is turned into a zones row automatically,
     and every shop is pointed at it — so zone-wise filtering works
     immediately on existing data, with zero manual re-entry.
*/

-- ZONES
CREATE TABLE IF NOT EXISTS public.zones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  project_id uuid REFERENCES public.projects(id) ON DELETE CASCADE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.zones ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_zones_org ON public.zones(organization_id);
CREATE INDEX IF NOT EXISTS idx_zones_project ON public.zones(project_id);
-- Same zone name shouldn't be entered twice for the same project (or
-- twice at org-level, when project_id is null — the two partial indexes
-- below cover both cases since a plain UNIQUE would let NULLs repeat).
CREATE UNIQUE INDEX IF NOT EXISTS uq_zones_org_project_name
  ON public.zones(organization_id, project_id, name) WHERE project_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_zones_org_name_no_project
  ON public.zones(organization_id, name) WHERE project_id IS NULL;

-- SHOPS: add zone_id (new, nullable — old `zone` text column untouched)
ALTER TABLE public.shops ADD COLUMN IF NOT EXISTS zone_id uuid REFERENCES public.zones(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_shops_zone_id ON public.shops(zone_id);

-- ============ RLS: zones ============
DROP POLICY IF EXISTS "zones_select" ON public.zones;
CREATE POLICY "zones_select" ON public.zones FOR SELECT
  TO authenticated USING (organization_id = public.current_org_id());

DROP POLICY IF EXISTS "zones_insert" ON public.zones;
CREATE POLICY "zones_insert" ON public.zones FOR INSERT
  TO authenticated WITH CHECK (organization_id = public.current_org_id());

DROP POLICY IF EXISTS "zones_update" ON public.zones;
CREATE POLICY "zones_update" ON public.zones FOR UPDATE
  TO authenticated USING (organization_id = public.current_org_id())
  WITH CHECK (organization_id = public.current_org_id());

DROP POLICY IF EXISTS "zones_delete" ON public.zones;
CREATE POLICY "zones_delete" ON public.zones FOR DELETE
  TO authenticated USING (organization_id = public.current_org_id() AND public.current_role() IN ('agency_owner','admin'));

-- ============ Backfill: distinct existing shops.zone text -> zones rows ============
DO $$
DECLARE
  r RECORD;
  z_id uuid;
BEGIN
  FOR r IN
    SELECT DISTINCT organization_id, project_id, trim(zone) AS zone_name
    FROM public.shops
    WHERE zone IS NOT NULL AND trim(zone) <> ''
  LOOP
    -- Reuse a zone if one with the same name already exists for this
    -- org+project (or org-level if project_id is null), else create it.
    SELECT id INTO z_id FROM public.zones
      WHERE organization_id = r.organization_id
        AND name = r.zone_name
        AND ((project_id IS NULL AND r.project_id IS NULL) OR project_id = r.project_id)
      LIMIT 1;

    IF z_id IS NULL THEN
      INSERT INTO public.zones (organization_id, project_id, name)
      VALUES (r.organization_id, r.project_id, r.zone_name)
      RETURNING id INTO z_id;
    END IF;

    UPDATE public.shops
      SET zone_id = z_id
      WHERE organization_id = r.organization_id
        AND trim(zone) = r.zone_name
        AND (project_id IS NOT DISTINCT FROM r.project_id)
        AND zone_id IS NULL;
  END LOOP;
END $$;

-- ============ Realtime ============
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'zones'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.zones;
  END IF;
END $$;
