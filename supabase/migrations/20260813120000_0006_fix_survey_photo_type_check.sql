-- Fix: survey submission was failing on every survey that had at least one
-- photo (i.e. basically every real survey).
--
-- Root cause: `survey_photos.photo_type` has a CHECK constraint that only
-- allows ('shop_front','interior','other','marked'), but the Surveyor app
-- (src/lib/offlineDb.ts, src/lib/syncManager.ts, src/pages/SurveyorPage.tsx)
-- has always inserted photo_type = 'survey' for photos captured during a
-- survey. Every insert into survey_photos was therefore rejected by
-- Postgres with a check-constraint violation, syncDraft() threw, and
-- submitSurvey() caught it and silently fell back to "Saved — Waiting to
-- Sync" (or, if offline, queued forever and kept failing on every retry).
--
-- Fix: allow 'survey' as a valid photo_type. No application code changes
-- needed — this brings the DB in line with what the app has always sent.

ALTER TABLE public.survey_photos
  DROP CONSTRAINT IF EXISTS survey_photos_photo_type_check;

ALTER TABLE public.survey_photos
  ADD CONSTRAINT survey_photos_photo_type_check
  CHECK (photo_type IN ('shop_front','interior','other','marked','survey'));
