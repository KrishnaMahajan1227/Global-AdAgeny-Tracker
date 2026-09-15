/*
# Phase — round board width/height/area to 2 decimal places

## The bug
src/lib/units.ts's `toFeet()` converts a surveyor-entered width/height to
feet before it's saved (every board dimension in this app is stored in
feet, regardless of what unit it was measured in — see that file's own
comment). The conversion factors for inches (1/12), meters (3.28084) and
centimeters (3.28084/100) essentially never land on a clean number: a
board measured as "5 in" saves as survey_width = 0.4166666666666667, "2 m"
saves as 6.56168, and so on. That raw, unrounded value then flowed
straight through everywhere downstream — survey_area (the product of two
already-messy numbers, compounding it further), then copied verbatim into
approved_width/height/area at Survey Review, then again into
installed_width/height/area when the installer confirms — so a surveyor
or installer entering a perfectly reasonable measurement in anything
other than whole feet would see a long, ugly decimal on every screen that
displays it (Survey Review, Shop detail, Installer specs, PDF/PPT
exports), all originating from this one conversion never having rounded
its output. The app-side fix (this migration's companion code change,
src/lib/units.ts) rounds every future measurement to 2 decimal places —
this migration cleans up everything already saved before that fix.

## Fix
Round every non-null width/height/area column on work_items to 2 decimal
places. 2 decimals (0.01 ft, about 1/8 inch) keeps more than enough
precision for board measurements and billing while eliminating the long
repeating decimals that toFeet()'s conversion factors produce. Purely a
data cleanup — no column type or constraint changes, and rounding numbers
that already happened to be clean (whole-foot entries) is a no-op.
*/

UPDATE public.work_items
SET
  survey_width = ROUND(survey_width, 2),
  survey_height = ROUND(survey_height, 2),
  survey_area = ROUND(survey_area, 2),
  approved_width = ROUND(approved_width, 2),
  approved_height = ROUND(approved_height, 2),
  approved_area = ROUND(approved_area, 2),
  installed_width = ROUND(installed_width, 2),
  installed_height = ROUND(installed_height, 2),
  installed_area = ROUND(installed_area, 2)
WHERE
  survey_width IS NOT NULL OR survey_height IS NOT NULL OR survey_area IS NOT NULL
  OR approved_width IS NOT NULL OR approved_height IS NOT NULL OR approved_area IS NOT NULL
  OR installed_width IS NOT NULL OR installed_height IS NOT NULL OR installed_area IS NOT NULL;
