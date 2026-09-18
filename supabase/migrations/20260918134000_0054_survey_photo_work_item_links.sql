-- Explicit Survey Photo -> Work Item relationship.
-- A board_marking still stores polygon geometry; this table stores semantic
-- association even when an Owner/Admin uploads a reference photo without drawing a polygon.
CREATE TABLE IF NOT EXISTS public.survey_photo_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  survey_photo_id uuid NOT NULL REFERENCES public.survey_photos(id) ON DELETE CASCADE,
  work_item_id uuid NOT NULL REFERENCES public.work_items(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (survey_photo_id, work_item_id)
);
CREATE INDEX IF NOT EXISTS idx_survey_photo_items_photo ON public.survey_photo_items(survey_photo_id);
CREATE INDEX IF NOT EXISTS idx_survey_photo_items_work_item ON public.survey_photo_items(work_item_id);
ALTER TABLE public.survey_photo_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "survey_photo_items_select" ON public.survey_photo_items;
CREATE POLICY "survey_photo_items_select" ON public.survey_photo_items FOR SELECT TO authenticated USING (organization_id = public.current_org_id());
DROP POLICY IF EXISTS "survey_photo_items_insert" ON public.survey_photo_items;
CREATE POLICY "survey_photo_items_insert" ON public.survey_photo_items FOR INSERT TO authenticated WITH CHECK (organization_id = public.current_org_id());
DROP POLICY IF EXISTS "survey_photo_items_update" ON public.survey_photo_items;
CREATE POLICY "survey_photo_items_update" ON public.survey_photo_items FOR UPDATE TO authenticated USING (organization_id = public.current_org_id()) WITH CHECK (organization_id = public.current_org_id());
DROP POLICY IF EXISTS "survey_photo_items_delete" ON public.survey_photo_items;
CREATE POLICY "survey_photo_items_delete" ON public.survey_photo_items FOR DELETE TO authenticated USING (organization_id = public.current_org_id());

-- Backfill semantic links for existing marked photos so old data participates too.
INSERT INTO public.survey_photo_items (organization_id, survey_photo_id, work_item_id)
SELECT DISTINCT bm.organization_id, bm.survey_photo_id, bm.work_item_id
FROM public.board_markings bm
WHERE bm.work_item_id IS NOT NULL
ON CONFLICT (survey_photo_id, work_item_id) DO NOTHING;
