/*
# Backfill: installation_jobs.review_status left at 'not_applicable' for
# installs that happened before the review-gate column existed

## What was wrong
Migration 0014 added `installation_jobs.review_status` (default
'not_applicable') and made the Shop Detail Timeline's "Installed
(Approved)" step depend on it being 'approved'. Any installation_jobs row
inserted *before* 0014 ran — including every shop seeded straight to
'installed' by migration 0008 — never had this column set, so it silently
kept the default 'not_applicable' forever. The shop itself, its work
items, design, and production were all genuinely complete and
`shops.status` correctly says 'installed'/'billed', but the Timeline had
no way to know that from `installation_jobs` alone, so "Installation
Submitted" and "Installed (Approved)" stayed stuck on pending even though
the job finished. (The app code has since been changed to also fall back
to `shops.status` for this reason — this migration fixes the underlying
data so the detail tables themselves are consistent too.)

## Fix
For any installation_jobs row that is actually finished (`status =
'completed'`) but still shows the pre-review-gate default
('not_applicable'), backfill it based on what the shop's own status
already tells us really happened:
  - shop is 'installed' or 'billed'          -> review_status 'approved'
  - shop is still short of that (e.g. sent   -> review_status 'pending'
    back for installation_pending/review)       (matches a real completed
                                                   job still awaiting review)
Reviewed_at/reviewed_by are only backfilled for the 'approved' case, using
the job's own completed_at as the best available timestamp (there's no
record of who clicked Approve for these, so reviewed_by is left null
rather than guessed).
*/

UPDATE public.installation_jobs ij
SET
  review_status = 'approved',
  reviewed_at = COALESCE(ij.reviewed_at, ij.completed_at, ij.updated_at)
FROM public.shops s
WHERE ij.shop_id = s.id
  AND ij.status = 'completed'
  AND ij.review_status = 'not_applicable'
  AND s.status IN ('installed', 'billed');

UPDATE public.installation_jobs ij
SET review_status = 'pending'
FROM public.shops s
WHERE ij.shop_id = s.id
  AND ij.status = 'completed'
  AND ij.review_status = 'not_applicable'
  AND s.status NOT IN ('installed', 'billed');
