/*
# Phase 7 cont'd — Vehicle / Load Check gate (Architecture v2.0 §3.2, §8 item 3, §9.4 Step 2)

## What was wrong
The pen-and-paper flow calls for an explicit "is the right material actually
loaded before we leave for the shop" checkpoint, separate from "installer
marks the job complete". Today `installation_jobs` goes straight from
`assigned` -> `started` -> `completed`/`exception` with no such checkpoint
at all — nothing stops an installer from showing up without the right
boards.

## Design (per Assumption A2 in the doc — a checklist gate, not a new role)
- Four new columns on `installation_jobs`: `material_check_confirmed`
  (boolean gate), `material_check_confirmed_by`/`_at` (who/when — "any of
  {installer, admin} can tick", captured as whoever is logged in when they
  confirm it — in this pass that's always the installer, self-checking
  before they leave, matching §9.4's wizard spec), `material_check_photo_url`
  (photo of the loaded material), and `material_check_items` (jsonb array of
  the `work_items.id`s the installer physically ticked off as loaded).
- A gate trigger, same "flag/block at the DB layer too" pattern as 0011,
  0013, 0014: an `installation_jobs` row can't move to `completed` or
  `exception` unless `material_check_confirmed = true` first. This is
  intentionally the *only* enforcement point — an exception (shop closed,
  etc.) still requires the load check to have happened, since the installer
  already left with the material by the time an exception is reported.
*/

ALTER TABLE public.installation_jobs
  ADD COLUMN IF NOT EXISTS material_check_confirmed boolean NOT NULL DEFAULT false;
ALTER TABLE public.installation_jobs
  ADD COLUMN IF NOT EXISTS material_check_confirmed_by uuid REFERENCES public.profiles(id);
ALTER TABLE public.installation_jobs
  ADD COLUMN IF NOT EXISTS material_check_confirmed_at timestamptz;
ALTER TABLE public.installation_jobs
  ADD COLUMN IF NOT EXISTS material_check_photo_url text;
ALTER TABLE public.installation_jobs
  ADD COLUMN IF NOT EXISTS material_check_items jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE OR REPLACE FUNCTION public.enforce_material_check_before_completion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status IN ('completed', 'exception') AND OLD.status NOT IN ('completed', 'exception') THEN
    IF NEW.material_check_confirmed IS NOT TRUE THEN
      RAISE EXCEPTION 'Vehicle/load material check must be confirmed before this installation can be completed';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_material_check_before_completion ON public.installation_jobs;
CREATE TRIGGER trg_material_check_before_completion
  BEFORE UPDATE ON public.installation_jobs
  FOR EACH ROW EXECUTE FUNCTION public.enforce_material_check_before_completion();

-- Existing in-flight jobs (created before this migration) that are already
-- completed/exception obviously never went through this gate — backfill
-- them as confirmed so the trigger's OLD.status<>NEW.status guard above
-- never has to re-check history, and so Installation Review's "material
-- check" badge (if ever added) doesn't show old jobs as unchecked.
UPDATE public.installation_jobs
SET material_check_confirmed = true
WHERE status IN ('completed', 'exception') AND material_check_confirmed = false;
