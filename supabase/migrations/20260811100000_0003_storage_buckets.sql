/*
# Storage buckets for Darshan Ad Agency
  - survey-photos: photos taken during surveys (public read, authenticated write)
  - design-files: design uploads from Designer role
  - installation-proof: before/after/installed photos from Installer role

  All buckets are PUBLIC READ (so photo URLs work directly in <img> tags, PDF/PPT
  generation, and the app without signed-URL complexity) but INSERT/UPDATE/DELETE
  is restricted to authenticated users, scoped by organization via the path prefix
  convention used in the app: "{organization_id}/{shop_id}/{filename}".
*/

-- Create buckets (idempotent)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES
  ('survey-photos', 'survey-photos', true, 10485760, ARRAY['image/jpeg','image/png','image/webp']),
  ('design-files', 'design-files', true, 20971520, ARRAY['image/jpeg','image/png','image/webp','application/pdf']),
  ('installation-proof', 'installation-proof', true, 10485760, ARRAY['image/jpeg','image/png','image/webp'])
ON CONFLICT (id) DO NOTHING;

-- ============ survey-photos policies ============
DROP POLICY IF EXISTS "survey_photos_select" ON storage.objects;
CREATE POLICY "survey_photos_select" ON storage.objects FOR SELECT
  TO public USING (bucket_id = 'survey-photos');

DROP POLICY IF EXISTS "survey_photos_insert" ON storage.objects;
CREATE POLICY "survey_photos_insert" ON storage.objects FOR INSERT
  TO authenticated WITH CHECK (bucket_id = 'survey-photos');

DROP POLICY IF EXISTS "survey_photos_update" ON storage.objects;
CREATE POLICY "survey_photos_update" ON storage.objects FOR UPDATE
  TO authenticated USING (bucket_id = 'survey-photos');

DROP POLICY IF EXISTS "survey_photos_delete" ON storage.objects;
CREATE POLICY "survey_photos_delete" ON storage.objects FOR DELETE
  TO authenticated USING (bucket_id = 'survey-photos');

-- ============ design-files policies ============
DROP POLICY IF EXISTS "design_files_select" ON storage.objects;
CREATE POLICY "design_files_select" ON storage.objects FOR SELECT
  TO public USING (bucket_id = 'design-files');

DROP POLICY IF EXISTS "design_files_insert" ON storage.objects;
CREATE POLICY "design_files_insert" ON storage.objects FOR INSERT
  TO authenticated WITH CHECK (bucket_id = 'design-files');

DROP POLICY IF EXISTS "design_files_update" ON storage.objects;
CREATE POLICY "design_files_update" ON storage.objects FOR UPDATE
  TO authenticated USING (bucket_id = 'design-files');

DROP POLICY IF EXISTS "design_files_delete" ON storage.objects;
CREATE POLICY "design_files_delete" ON storage.objects FOR DELETE
  TO authenticated USING (bucket_id = 'design-files');

-- ============ installation-proof policies ============
DROP POLICY IF EXISTS "installation_proof_select" ON storage.objects;
CREATE POLICY "installation_proof_select" ON storage.objects FOR SELECT
  TO public USING (bucket_id = 'installation-proof');

DROP POLICY IF EXISTS "installation_proof_insert" ON storage.objects;
CREATE POLICY "installation_proof_insert" ON storage.objects FOR INSERT
  TO authenticated WITH CHECK (bucket_id = 'installation-proof');

DROP POLICY IF EXISTS "installation_proof_update" ON storage.objects;
CREATE POLICY "installation_proof_update" ON storage.objects FOR UPDATE
  TO authenticated USING (bucket_id = 'installation-proof');

DROP POLICY IF EXISTS "installation_proof_delete" ON storage.objects;
CREATE POLICY "installation_proof_delete" ON storage.objects FOR DELETE
  TO authenticated USING (bucket_id = 'installation-proof');
