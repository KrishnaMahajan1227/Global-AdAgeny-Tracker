/*
# Designer marking system: link uploaded design files to the specific
# work items (boards) they cover

## Why this migration exists
Until now `design_versions` (an uploaded design file) only ever pointed at
`design_tasks` (one row per *shop*). A shop with three boards to design
(e.g. Fascia Signboard + Glow Sign + Standee) had no way to record which
of those three a given uploaded file actually covered — the Designer
screen could only say "a file was uploaded for this shop", never "2 of 3
boards designed, 1 pending". That's the gap the user is asking to close:
a real marking system so a designer can see, per shop, which board still
needs a design and which is done.

`work_items.status` already had `'designing'` / `'designed'` in its CHECK
constraint (added back in 0001/0011) but nothing in the app ever wrote
those values — this migration is what finally uses them.

## What this adds
1. `design_version_items` — a join row per (uploaded file, work item)
   pairing, so one upload can cover many boards and the app can query
   "which boards does this file cover" / "which boards for this shop have
   no covering file yet".
2. Realtime on the new table, same pattern as 0013, so the pending/done
   marking updates live across sessions.
*/

CREATE TABLE IF NOT EXISTS public.design_version_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  design_version_id uuid NOT NULL REFERENCES public.design_versions(id) ON DELETE CASCADE,
  work_item_id uuid NOT NULL REFERENCES public.work_items(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (design_version_id, work_item_id)
);
ALTER TABLE public.design_version_items ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_design_version_items_version ON public.design_version_items(design_version_id);
CREATE INDEX IF NOT EXISTS idx_design_version_items_work_item ON public.design_version_items(work_item_id);

-- Same org-scoped policy shape as every other pipeline table (work_items,
-- design_tasks, design_versions) — see 0001c for the pattern.
DROP POLICY IF EXISTS "design_version_items_select" ON public.design_version_items;
CREATE POLICY "design_version_items_select" ON public.design_version_items FOR SELECT
  TO authenticated USING (organization_id = public.current_org_id());

DROP POLICY IF EXISTS "design_version_items_insert" ON public.design_version_items;
CREATE POLICY "design_version_items_insert" ON public.design_version_items FOR INSERT
  TO authenticated WITH CHECK (organization_id = public.current_org_id());

DROP POLICY IF EXISTS "design_version_items_update" ON public.design_version_items;
CREATE POLICY "design_version_items_update" ON public.design_version_items FOR UPDATE
  TO authenticated USING (organization_id = public.current_org_id())
  WITH CHECK (organization_id = public.current_org_id());

DROP POLICY IF EXISTS "design_version_items_delete" ON public.design_version_items;
CREATE POLICY "design_version_items_delete" ON public.design_version_items FOR DELETE
  TO authenticated USING (organization_id = public.current_org_id());

-- Realtime, same as 0013 Part A.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'design_version_items'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.design_version_items;
  END IF;
END $$;
