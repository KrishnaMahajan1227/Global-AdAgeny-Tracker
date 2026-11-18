# AdRoute — One-Step Design Review (v11, 18 Nov 2026)

This release continues from the **AdRoute_Fulfillment_Sizing_Artwork_Officer_Full_Updated_Project.zip** source, including all previous Shop, Officer, sizes, fulfillment, artwork and reporting changes. It is a targeted Design Review rework, not a replacement of Survey Review or Installation Review.

## Review flow

1. Owner/Admin opens **Design Queue → In Review → Review** for any shop. This opens the detail directly; no folder browsing or row expansion is required.
2. A single board list shows the surveyed marking/photo (where available), recorded size/quantity, and **latest usable mapped artwork** for each board. Image previews open in a lightbox; PDF/non-image artwork opens as a file link. No duplicate item-review panel, duplicate row-level approve/reject controls, or repeated status tiles.
3. **Approve Design** approves all work items with a single atomic database call. **Approve & Next** opens the next visible pending review after success. When a Work Order requires external company sign-off, the existing **Company approval** section must be completed first. The database continues to enforce it.
4. **Request Changes** reveals selection checkboxes. Select only affected boards (one-board shops are preselected; multi-board shops have Select all), enter a meaningful correction note, and choose **Send for Changes**. Unselected boards are approved and selected boards are returned for correction in **one transaction**. The designer receives the existing correction notification. The next visible review opens after success.
5. The assigned designer retains the existing upload/map workflow. For a returned board, a **newer mapped artwork version** must be uploaded before resubmission; merely re-sending the old file cannot close the correction. The production handoff remains the separate existing owner action after approval.

## Scope and data safety

- Design approvals and correction requests both use `public.design_review_decide`, implemented in migration 0119. That function reuses the existing `review_apply` RPC, existing company-approval database guard, correction records, notifications and audit trail.
- The database validates organization, reviewer role, live task state, selected shop board IDs, mapped file evidence and required notes; it locks the task to avoid concurrent double decisions.
- No existing shop data, artwork files, previous migration, purchase orders or fulfillment definitions are removed. No new designer permissions.
- Existing Survey and Installation Review source pages remain unchanged.
- For large organizations, the existing Design Queue remains server-filtered/server-paginated; full board/artwork detail is fetched only for the chosen shop. Multi-shop approve retains bounded concurrency and reports individual failures for retry.

## Production deployment (PowerShell)

1. **Back up** the linked Supabase production database and verify the project ref. Deploy to staging first.
2. Extract the **Full Project ZIP** and run these commands from the extracted project folder, or merge the fix-only ZIP into the exact previous release first:

```powershell
cd D:\DarshanAdField
npm ci
npm run typecheck
npm run build
node scripts/verify-design-review-v11.cjs
npm run verify:security
```

3. Inspect migrations before applying. The new file is:

```
supabase/migrations/20261118110000_0119_design_review_one_step_atomic.sql
```

For Supabase CLI v3, with **correct linked remote project**:

```powershell
npx supabase --version
npx supabase migration list --remote
npx supabase db push --remote --dry-run
npx supabase db push --remote
```

For older CLI v2, use `npx supabase migration list` and `npx supabase db push` for the linked remote project. Check the installed CLI help for exact flags. Never use `db reset` on an existing project.

4. Deploy the built frontend with your existing Vercel pipeline. The ZIP does not automatically deploy or change environment variables. If frontend is deployed **before** migration 0119, review submissions will display an actionable migration error instead of silently approving.

## Staging checklist

- Single board and multiple boards; one artwork shared intentionally across several boards; separate files per board; PDF versus image; old rejected/deleted versions.
- One-click approve; next review; request changes to one out of three boards; request changes to all; mandatory reason; no accidental duplicate board decisions.
- The returned designer's task shows corrections, accepts new mapped files, rejects old-only resubmission, and can submit the corrected artwork back for review.
- Company-approval-required PO (must be confirmed) versus historical PO (no new gate).
- Bulk approve on multiple shops including one already updated elsewhere; complete items proceed to Production only through the existing owner handoff.
- Survey Review, Installation Review, existing Owner/Admin/Designer permissions and reports unaffected.

## Verification and limitations

- `node scripts/verify-design-review-v11.cjs`: **39/39 focused source/runtime-contract checks passed**.
- TypeScript/TSX parsing: **130 files passed**. Related Designer V8/V10, Review V3, review action, fast review, phase 1/3 and security checks passed.
- `npm ci --offline` was blocked by an uncached `zip-stream` archive, and a network install could not finish in this execution environment. Therefore **full typecheck, production build, live Supabase/RLS integration and browser end-to-end testing are not yet verified**. Do not treat this ZIP as a live-production certification.
- The historical `npm run verify:release` suite reports **21/25** in both the *unchanged pre-fix baseline* and this patch. Four Campaign/deployment legacy source-contract assertions are pre-existing and unrelated to the Design Review change. Two older designer source-pattern suites also assume a superseded upload/UI structure; use the newer V8/V10/V11 tests and staging behavior instead of assuming their pattern mismatch is a new defect.
