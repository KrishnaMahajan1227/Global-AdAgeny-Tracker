# AdRoute Design Review – multi-shop / multi-board release (v12)

Base: `AdRoute_Design_Review_OneStep_Full_Updated_Project.zip` (migration 0119).

## Changes

1. Owner/Admin: Action Queue / In Review → select shops → **Review N shops**. Reviews load one shop at a time with board-by-board site/marking → artwork comparison. Approve & Next, Request Changes for selected boards, or Skip this shop. The previous blind `Approve N` toolbar action is intentionally replaced with guided, individually inspected decisions; the atomic per-shop database RPC remains.
2. One shop with many work items: all mapped current artwork for each item is shown separately with correct size and quantity. Many files uploaded together for **one** board are shown as one current upload batch (e.g. front/back artwork), rather than suppressing all but the last file.
3. Different shops: files loaded only for that shop's design task. Review selections do not spill over to other shops, and every approve/correction is separately atomic with company sign-off gate unchanged.
4. Production receives the approved file(s) for the latest upload batch **per work item**. Old shared file revisions cannot reappear on a separately revised board. Old uploaded file rows are retained as history; none are deleted.
5. The Designer and Shop Details upload paths assign the same `upload_batch_id` to files from a single upload. Old versions without this column remain readable as single-file legacy batches.

## Database migration

`supabase/migrations/20261118140000_0120_design_review_board_artwork_approval.sql`

- Creates nullable `design_versions.upload_batch_id` and an index.
- Replaces the `design_review_decide` RPC introduced by 0119, keeping role/organization protection, validation, company approval, audit, and correction handling.
- Marks the effective latest mapped upload batch **per board** approved, preserving complementary files within the batch; superseded versions get `uploaded` status, not deleted.
- Does **not** bulk change past already-approved tasks; historical tasks without batch metadata retain their old mapping and can be re-reviewed as applicable. Test with staging data before production.

## PowerShell deployment – compatible with your installed Supabase CLI

```powershell
cd D:\DarshanAdField
# Extract/replace source from the complete ZIP (keep your own environment variables).
npm ci
npm run typecheck
npm run build
node scripts/verify-design-review-v11.cjs
node scripts/verify-design-review-v12-multishop.cjs
node scripts/verify-production-v11-sizefirst.cjs
npm run verify:security

# Verify the linked target before pushing migrations.
npx supabase --version
npx supabase migration list --linked
npx supabase db push --linked --dry-run
# Only if correct project + intended migrations (0119 and 0120) are shown:
npx supabase db push --linked
```

**CLI note:** Your installed CLI supports `--linked`, not `--remote`; do not use `--remote` without upgrading to v3. Earlier logs show 0117 and 0118 applied successfully. `DEP0174` is a Node deprecation warning, not a database migration error. Repeated `npx` installation prompts are from CLI not being installed locally; do not blindly change CLI versions before deploying.

Do **not** run `supabase db reset` or repair migration history without specific investigation.

### Staging smoke tests required

- A: 1 shop / 1 board / 1 artwork → approve → Production artwork shown.
- B: 1 shop / 3 boards / 3 different files → review all; each board gets its own approved Production file.
- C: 1 shop / 1 board / 2 files in **one upload** (front/back) → both visible in Review and Production.
- D: 1 shared file mapped to boards A and B, later new file only for board A → Review and Production show new A and original B, not old A.
- E: 3 selected shops with multiple boards each → guided Approve & Next / Skip / Request Changes; verify no cross-shop mapping.
- F: company approval required → internal check/company confirmation first; no bypass on individual or guided reviews.
- G: selected board needs correction → only that board returns to Designer; reupload a **new** mapped artwork before resubmission; other boards remain covered.
- H: PDF/JPG/PNG previews, correct filenames, long Shop names, and mobile layout.
- I: pagination (50 rows/page) and review of shops outside the current page; no stale selected IDs.

## Validation done in this environment

- New multi-shop assertions: 33 passed; previous one-step review: 39 passed; production artwork runtime: 37 passed.
- 20/25 selected workflow/security/source test scripts passed; five older source-pattern scripts also fail **unchanged** on the previous ZIP. See QA file.
- TS/TSX syntax parse passes (130 files), and security source check passes (27 checks).
- **Not verified**: `npm run build` (missing local Vite installation), `npm run typecheck` (missing local @types packages), real database execution/RLS on a connected Supabase instance, production browser and real-user stress tests.
