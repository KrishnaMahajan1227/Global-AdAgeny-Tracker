/*
# Phase J (optional, gOGig-inspired) — Installation fraud-proofing (Section 7)

  Per ARCHITECTURE doc Section 7, on top of the already-working
  photos+GPS+exceptions+review-gate installation flow:
  - Enforce minimum 2 angle photos per installed board (front + side).
  - Duplicate-image (perceptual hash) check at upload — flag for Admin
    review instead of silently accepting a photo reused across shops.
  - Flag installs where GPS is implausibly far (>500m, configurable) from
    the shop's stored lat/long.

  This migration only adds the columns; the actual hashing / distance math
  runs client-side in the Installer app (src/lib/imageHash.ts,
  src/lib/geoDistance.ts) at capture/submit time — see CHANGES.md. Nothing
  here blocks a submission; every flag is informational for Admin/Owner at
  Installation Review, matching the doc's own "flag, don't block" pattern
  used everywhere else (PO variance banner, GST sanity check).
*/

-- ============ installation_proofs: angle + duplicate-hash detection ============
ALTER TABLE public.installation_proofs
  ADD COLUMN IF NOT EXISTS angle text CHECK (angle IN ('front','side','other')),
  ADD COLUMN IF NOT EXISTS phash text,
  ADD COLUMN IF NOT EXISTS duplicate_flag boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS duplicate_of uuid REFERENCES public.installation_proofs(id) ON DELETE SET NULL;

-- Looked up on every new photo upload (same org, different shop, matching
-- hash) — index it so that check stays cheap as proof volume grows.
CREATE INDEX IF NOT EXISTS idx_installation_proofs_phash ON public.installation_proofs(organization_id, phash) WHERE phash IS NOT NULL;

-- ============ installation_jobs: GPS-distance-from-shop flag ============
ALTER TABLE public.installation_jobs
  ADD COLUMN IF NOT EXISTS gps_distance_meters numeric,
  ADD COLUMN IF NOT EXISTS gps_distance_flag boolean NOT NULL DEFAULT false;
