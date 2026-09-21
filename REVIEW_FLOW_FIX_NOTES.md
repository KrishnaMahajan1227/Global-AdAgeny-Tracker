# Review / Redo / Availability Final Fix

## Required deployment step
Run `npx supabase db push --include-all` before testing the new frontend.
Migration `20261022150000_0091_review_flow_authoritative_fix.sql` replaces the broken review RPC behavior and repairs stale rows created by earlier redo logic.

## Flow now
- Item-level Approve/Redo updates exact evidence only.
- Redo immediately creates a `field_corrections` task and re-opens the matching Surveyor/Installer assignment.
- Item-level actions do not prematurely finalize the parent Survey/Installation review.
- Final Survey/Installation action is the only stage-closing action.
- Historical rejected photos are preserved for audit and remain visible in Shop Details.
- Shop Details fetches survey/install proof rows independently of nested relation cache.
- Work Item Not Available can be set by Owner/Admin or the assigned Installer.
- Not Available items are excluded from installed/billing totals and installed dimensions are cleared.
- Existing stale open-redo parent rows are normalized back into pending review by migration 0091.
