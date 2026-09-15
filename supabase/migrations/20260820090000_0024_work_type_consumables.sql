/*
# Phase 5 — Fulfillment type branch: supply_only flow

   Per the architecture doc, `purchase_orders.fulfillment_type` (added in
   Phase 1) already distinguishes the two flows:
     - survey_install: existing survey -> design -> production -> install
     - supply_only: no survey, no install job — straight production ->
       packing (with consumables) -> zone-wise dispatch

   No changes to existing pipeline tables/triggers are needed for this —
   production_orders.design_task_id and production_items.work_item_id are
   already nullable, and shops.status already includes 'dispatched'. The
   only genuinely new schema this phase needs is the consumables list a
   work type gets packed with (tape, nails, etc.) — everything else is
   wiring in the app layer (see CHANGES.md).

   work_type_consumables: purely additive, org+work_type scoped.
*/

CREATE TABLE IF NOT EXISTS public.work_type_consumables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  work_type_id uuid NOT NULL REFERENCES public.work_types(id) ON DELETE CASCADE,
  consumable_name text NOT NULL,
  qty_per_unit numeric,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.work_type_consumables ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_work_type_consumables_org ON public.work_type_consumables(organization_id);
CREATE INDEX IF NOT EXISTS idx_work_type_consumables_work_type ON public.work_type_consumables(work_type_id);

-- ============ RLS ============
DROP POLICY IF EXISTS "work_type_consumables_select" ON public.work_type_consumables;
CREATE POLICY "work_type_consumables_select" ON public.work_type_consumables FOR SELECT
  TO authenticated USING (organization_id = public.current_org_id());

DROP POLICY IF EXISTS "work_type_consumables_insert" ON public.work_type_consumables;
CREATE POLICY "work_type_consumables_insert" ON public.work_type_consumables FOR INSERT
  TO authenticated WITH CHECK (organization_id = public.current_org_id());

DROP POLICY IF EXISTS "work_type_consumables_update" ON public.work_type_consumables;
CREATE POLICY "work_type_consumables_update" ON public.work_type_consumables FOR UPDATE
  TO authenticated USING (organization_id = public.current_org_id())
  WITH CHECK (organization_id = public.current_org_id());

DROP POLICY IF EXISTS "work_type_consumables_delete" ON public.work_type_consumables;
CREATE POLICY "work_type_consumables_delete" ON public.work_type_consumables FOR DELETE
  TO authenticated USING (organization_id = public.current_org_id() AND public.current_role() IN ('agency_owner','admin'));

-- ============ Realtime ============
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'work_type_consumables'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.work_type_consumables;
  END IF;
END $$;
