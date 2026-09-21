-- Review/redo evidence integrity hardening.
-- Returned evidence must remain auditable and correction tasks must survive a
-- proof/photo replacement.  Earlier CASCADE FKs could erase the redo task when
-- a rejected proof was deleted.
DO $$ BEGIN
  ALTER TABLE public.field_corrections DROP CONSTRAINT IF EXISTS field_corrections_installation_proof_id_fkey;
  ALTER TABLE public.field_corrections ADD CONSTRAINT field_corrections_installation_proof_id_fkey
    FOREIGN KEY (installation_proof_id) REFERENCES public.installation_proofs(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.field_corrections DROP CONSTRAINT IF EXISTS field_corrections_survey_photo_id_fkey;
  ALTER TABLE public.field_corrections ADD CONSTRAINT field_corrections_survey_photo_id_fkey
    FOREIGN KEY (survey_photo_id) REFERENCES public.survey_photos(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_field_review_decisions_entity ON public.field_review_decisions(stage, entity_type, entity_id, decision);
CREATE INDEX IF NOT EXISTS idx_installation_proofs_shop_work_item ON public.installation_proofs(shop_id, work_item_id);
CREATE INDEX IF NOT EXISTS idx_survey_photos_shop ON public.survey_photos(shop_id);
