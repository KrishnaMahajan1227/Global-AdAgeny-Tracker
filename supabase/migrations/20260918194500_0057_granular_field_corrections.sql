-- Granular correction queue: only the exact measurement/photo that failed review
-- is returned to the already-assigned field worker.
CREATE TABLE IF NOT EXISTS public.field_corrections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
  stage text NOT NULL CHECK (stage IN ('survey','installation')),
  survey_id uuid REFERENCES public.surveys(id) ON DELETE CASCADE,
  installation_job_id uuid REFERENCES public.installation_jobs(id) ON DELETE CASCADE,
  work_item_id uuid REFERENCES public.work_items(id) ON DELETE CASCADE,
  survey_photo_id uuid REFERENCES public.survey_photos(id) ON DELETE CASCADE,
  installation_proof_id uuid REFERENCES public.installation_proofs(id) ON DELETE CASCADE,
  assigned_to uuid NOT NULL REFERENCES public.profiles(id),
  requested_by uuid NOT NULL REFERENCES public.profiles(id),
  issue_type text NOT NULL CHECK (issue_type IN ('measurement','survey_photo','installation_photo','work_item')),
  note text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resubmitted','resolved','cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  resubmitted_at timestamptz,
  resolved_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_field_corrections_assignee_open ON public.field_corrections(assigned_to, status);
CREATE INDEX IF NOT EXISTS idx_field_corrections_shop_stage ON public.field_corrections(shop_id, stage, status);
ALTER TABLE public.field_corrections ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "field_corrections_select" ON public.field_corrections;
CREATE POLICY "field_corrections_select" ON public.field_corrections FOR SELECT TO authenticated USING (organization_id = public.current_org_id());
DROP POLICY IF EXISTS "field_corrections_insert" ON public.field_corrections;
CREATE POLICY "field_corrections_insert" ON public.field_corrections FOR INSERT TO authenticated WITH CHECK (organization_id = public.current_org_id());
DROP POLICY IF EXISTS "field_corrections_update" ON public.field_corrections;
CREATE POLICY "field_corrections_update" ON public.field_corrections FOR UPDATE TO authenticated USING (organization_id = public.current_org_id()) WITH CHECK (organization_id = public.current_org_id());
DROP POLICY IF EXISTS "field_corrections_delete" ON public.field_corrections;
CREATE POLICY "field_corrections_delete" ON public.field_corrections FOR DELETE TO authenticated USING (organization_id = public.current_org_id());
