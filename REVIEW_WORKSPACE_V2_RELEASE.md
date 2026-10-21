# Adroute — Fast Survey & Installation Review Workspace V2

This package is a complete updated project source based on the October 21, 2026 fast-review release and includes previously delivered Phases 1–7. All existing SQL migrations and audit/approval RPCs are retained; **no new Supabase migration** is introduced by this review-only UI change.

## Business intent

Survey or Installation review must work for multiple Work Items in one shop, or large batches of shops, with the least number of deliberate reviewer actions consistent with evidence verification and company approval. Shop-selection means *scope*; it is not itself evidence inspection or approval.

## Changed files

- `src/components/ReviewBatchStepper.tsx`: replaced unbounded 1/2/3/… pill bar and separate evidence checkbox with a compact searchable/native dropdown, prev/next, progress and reviewed count. Navigation does not record inspection.
- `src/pages/SurveyReviewPage.tsx`: one **Reviewed & next shop** button after evidence, safe page-wise batches up to 250, one modal scrollbar, scroll back to next shop, existing company handoff and per-shop RPC approvals preserved.
- `src/pages/InstallationReviewPage.tsx`: same one-click review advancement, 250/page, auto-selected pending review items, single-scroll modal, prevent modal closure during bulk database writes, existing proof validation/redo handling preserved.
- `src/components/SurveyReviewGallery.tsx`: automatically select pending logical review units once evidence loads. Reviewers can uncheck any item to send targeted correction; already-approved items aren't reselected.
- `src/lib/reviewBatchSafety.ts`: shared `nextUnreviewedIndex` helper that skips already inspected shops and wraps safely; `allInspected` still blocks unreviewed batch approvals.
- `scripts/verify-fast-review-workspace.cjs`: adjusted legacy UI assumptions while retaining business safety assertions.
- `scripts/verify-review-workspace-v2.cjs`: new 30-case targeted suite including 250-shop batching, guard checks, change invalidation and source parsing.

## Updated review flow

1. Open the pending review queue, select shops on the current page, choose **Review selected**.
2. See the first shop's photos, measurements, Work Items and company approval handoff in the same workspace. **Pending Work Items are already selected**; uncheck only items that should not be included in that decision.
3. After inspecting evidence, click **Reviewed & next shop**. This ONE deliberate click records that shop as inspected and opens the next unreviewed shop; it is not an approval or an authorization bypass.
4. On the final shop, click **Mark final shop reviewed**, then **Approve selected** once. The existing backend approval, designer/installer assignment rules and required company-approval gates still apply individually to each shop.
5. For exceptions use existing item-level Redo/Correction controls; the refreshed shop's previous inspected flag is invalidated. Missing installation proofs cannot pass normal approval.

Batches larger than 250 are handled as page-wise chunks to keep data queries and UI bounded; no infinite list of shop pills and no fetching evidence for hundreds of shops simultaneously.

## Operational/security constraints

- Selecting a shop or navigating to it NEVER confirms its evidence.
- `allInspected` still requires every selected shop explicitly inspected before bulk approve/redo.
- Evidence load errors, missing proofs, approval gates and item-level correction continue to block normal approval through existing RPC behavior.
- Owner/Admin permissions, organization RLS, existing review decisions, company approval handoffs, invoice progress and historical Work Orders unchanged.
- No new SQL/migration commands required for this release.

## Local commands (run from project root, with Vite stopped)

```powershell
npm ci --include=dev
npm run typecheck
npm run build
node scripts/verify-review-workspace-v2.cjs
node scripts/verify-fast-review-workspace.cjs
node scripts/verify-runtime-jsx-symbols.cjs
```

If Windows raises `EPERM` for esbuild/Rollup during `npm ci`, close Vite/related Node processes first; never run npm ci while the development server uses `node_modules`. See the previous support notes about process locks. Do not modify package-lock.json or delete project code to repair these locks.

## Staging acceptance checks (manual)

1. Survey: shop with one photo and multiple work items, mixed pending/already-approved; ensure only pending items preselected and selection can be narrowed for redo.
2. Installation: shop with 3–4 work items, all linked proofs vs one missing proof; missing proof must block bulk approval and allow targeted redo.
3. Multi-shop: choose 3, then 100 and 250 shops; verify one Reviewed & next click/shop, no numbered pill overflow, jump dropdown, progress, and one modal scrollbar.
4. Try bulk approve with even one unreviewed shop; action remains disabled. Navigate to shop without clicking Reviewed & next; count must NOT increase.
5. Change evidence after a shop was marked reviewed; that shop must require reinspection.
6. Company manual approval absent/stale; Survey/Installation approval stays blocked for policy-required new Work Orders.
7. Network fail halfway through bulk operation: succeeded shops not double processed; remaining shops retry; no cross-shop review leakage.
8. Owner/Admin can approve; Surveyor/Installer/Client cannot bypass review via UI or direct RPC.
9. Compare Dashboard, Work Order detail, Client Portal and Billing before/after to ensure progression and rates unchanged.
10. Windows/Android mobile viewport, keyboard navigation, loading/error states and long-name overflow.

## Validation scope / honest limits

Automated TypeScript source/JSX parsing and source-level regression scripts were executed in the packaging environment. A complete dependency-backed Vite build, authenticated browser workflows and live Supabase/RLS tests could **not** be verified here; staging acceptance remains mandatory before production release.
