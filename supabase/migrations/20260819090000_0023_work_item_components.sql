/*
# Phase 4 — Work Item Components (BOM / assembly readiness)

   A single shop's board is often not one homogeneous item — e.g. an ACP
   dealer board needs Frame, Vinyl print, Acrylic cut, Logo apply, each
   tracked and readied separately before the board counts as "produced".

   - work_item_components: one row per component/part of a work item
     (board). Purely additive — a work item with zero rows here behaves
     exactly as it does today (no BOM, produced as soon as qty is logged).
   - Nothing existing is altered or dropped. The production gate this
     enables lives in the app layer (ProductionPage): a board only flips
     to `produced` once (a) the logged qty meets target AND (b) every
     component on it is `ready` — if it has no components at all, only
     (a) applies, so old boards/behaviour are untouched.
*/

CREATE TABLE IF NOT EXISTS public.work_item_components (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  work_item_id uuid NOT NULL REFERENCES public.work_items(id) ON DELETE CASCADE,
  component_name text NOT NULL,
  required_qty numeric,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','ready')),
  assigned_to uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.work_item_components ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_work_item_components_org ON public.work_item_components(organization_id);
CREATE INDEX IF NOT EXISTS idx_work_item_components_work_item ON public.work_item_components(work_item_id);
CREATE INDEX IF NOT EXISTS idx_work_item_components_status ON public.work_item_components(status);

DROP TRIGGER IF EXISTS set_updated_at_work_item_components ON public.work_item_components;
CREATE TRIGGER set_updated_at_work_item_components
  BEFORE UPDATE ON public.work_item_components
  FOR EACH ROW EXECUTE FUNCTION public.trigger_set_updated_at();

-- ============ RLS: work_item_components ============
-- Same org-scoped pattern as everything else: any office/production role
-- in the org can read/write; delete restricted to owner/admin.
DROP POLICY IF EXISTS "work_item_components_select" ON public.work_item_components;
CREATE POLICY "work_item_components_select" ON public.work_item_components FOR SELECT
  TO authenticated USING (organization_id = public.current_org_id());

DROP POLICY IF EXISTS "work_item_components_insert" ON public.work_item_components;
CREATE POLICY "work_item_components_insert" ON public.work_item_components FOR INSERT
  TO authenticated WITH CHECK (organization_id = public.current_org_id());

DROP POLICY IF EXISTS "work_item_components_update" ON public.work_item_components;
CREATE POLICY "work_item_components_update" ON public.work_item_components FOR UPDATE
  TO authenticated USING (organization_id = public.current_org_id())
  WITH CHECK (organization_id = public.current_org_id());

DROP POLICY IF EXISTS "work_item_components_delete" ON public.work_item_components;
CREATE POLICY "work_item_components_delete" ON public.work_item_components FOR DELETE
  TO authenticated USING (organization_id = public.current_org_id() AND public.current_role() IN ('agency_owner','admin','printing'));

-- ============ Realtime ============
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'work_item_components'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.work_item_components;
  END IF;
END $$;
