# Adroute — Faster Survey & Installation Review (Phase 7 base)

## Scope
This update is based on `Adroute_Phase_7_QA_Security_Hardening_Source.zip`. Phases 1–7, RLS rules, company-approval handoff, invoice calculations, historical migrations, and existing work-item correction APIs remain in the project. **No new Supabase migration or RPC is introduced.**

### Survey Review
- A focused, one-shop-at-a-time batch review with Next/Previous and direct numbered shop navigation. Avoids loading several large evidence galleries at once.
- Company's manually recorded approval panel remains available while reviewing the selected shop.
- Multiple linked work items, measured dimensions, board markings and all survey photos remain within the current shop's gallery. In the batch workspace, reviewers can approve individual items or request targeted redo without opening a second modal.
- The reviewer must explicitly check each selected shop's evidence before a **batch** approval can be submitted. Confirmation is disabled before photos and work items finish loading. Approval is still validated by the existing server RPC and company-approval gates.
- One active designer is preselected for item review; organizations with multiple designers still require a deliberate choice.
- Optional auto-open next pending shop after an individual survey review is finalized.
- Successful partial batch actions preserve the remaining selection for safe retry rather than repeating the successful shops.

### Installation Review
- Pending shop checkboxes are available immediately; no need to enable a separate selection mode first.
- One focused shop at a time in the batch workspace with inspection progress, next/previous and jump-to-shop controls.
- Each work item shows all of its linked Survey photos, measurements, design reference and installation proofs. Unlinked/legacy photos remain separately called out.
- Material reconciliation and company approval remain beside the work-item evidence.
- Item-level approve and targeted redo remain available inside a batch. Review state is remounted/reset when advancing between separate jobs so item selections do not leak into another shop.
- Batch approve/redo requires an explicit checked-inspection acknowledgment for **every** selected shop; redo requires a reason. Missing linked installation evidence disables blanket batch approval, but individual targeted redo stays possible.
- Completed batch shops are removed from selected targets. Interrupted batches keep unprocessed shops and show per-shop results. No previously successful shop is automatically repeated.
- Optional auto-open next pending single-shop review after the current installation review leaves the queue.
- Evidence lightbox provides an accessible close button and Escape key support.

### Safety rules and roles
- The backend, not the UI, remains the final authority: existing RLS, organization checks, approval RPCs, audit trail and company-approval controls are unchanged.
- Owner/Admin are the intended review operators. This patch does not grant Surveyor/Installer/Client/Accounts access to the privileged review mutations.
- A selected shop in a batch does **not** count as inspected just because its name is visible or because its gallery was opened. The user explicitly confirms evidence was reviewed.
- Batch selection is page scoped, reset when query/filter/page changes, and resets on opening a new batch. Evidence-changing actions clear the local inspection acknowledgment.
- No automatic approvals, generated historical approval rows, or inferred invoice quantities are introduced.

### Files changed / added
- `src/pages/SurveyReviewPage.tsx`
- `src/pages/InstallationReviewPage.tsx`
- `src/components/SurveyReviewGallery.tsx`
- `src/components/ReviewBatchStepper.tsx` (new)
- `src/lib/reviewBatchSafety.ts` (new)
- `scripts/verify-fast-review-workspace.cjs` (new)
- `FAST_SURVEY_INSTALLATION_REVIEW_RELEASE.md` (new)

## Commands
```bash
npm ci
npm run typecheck
npm run build
node scripts/verify-fast-review-workspace.cjs
node scripts/verify-runtime-jsx-symbols.cjs
node scripts/verify-phase2-approvals.cjs
node scripts/verify-phase7-security.cjs
```
**Supabase:** No new migration in this patch. Use `supabase migration list` to confirm your Phase 1–4 schema is deployed; `supabase db push` is NOT required specifically for this review UI update. Never run `supabase db reset` on production.

**Git:**
```bash
git switch -c feature/faster-survey-install-review
git add .
git diff --cached --check
git commit -m "feat: streamline survey and installation evidence review"
git push -u origin feature/faster-survey-install-review
```

## Mandatory staging acceptance scenarios (live Supabase)
1. Owner/Admin opens a shop with 3+ work items, 5+ photos and multiple survey/design proof links; verifies every item stays attached to the correct shop.
2. Select 3 shops on the same page. Inspect only 2 and verify bulk approve remains disabled; inspect all 3, record company approvals where required and verify batch RPC results.
3. During a batch, return one photo/item for redo. Verify only that entity is returned to the Surveyor/Installer, and successfully reviewed shops are not automatically reprocessed.
4. Switch between shops while item selection is active. Verify none of the previous shop's selected item IDs remain in the next shop.
5. Try bulk approval with missing/unlinked installation proofs; confirm bulk is disabled and item-specific redo still works.
6. Try a batch where one shop lacks company approval. Confirm its backend mutation rejects the approval, other successful shops are not silently rolled back, and retry targets only outstanding shops.
7. Check the Next behavior for last item of a page, after a realtime status update, and after changing a PO filter.
8. Test one or more designers, multiple surveyors and installers, phone/tablet widths, photo lightbox keyboard Escape, and query loading/network errors.
9. Verify Surveyor/Installer/Client/Accounts roles cannot invoke privileged review actions under RLS; confirm cross-organization isolation.
10. Confirm Work Order/Dashboard progress, company approval, downstream handoff and billing quantities have not changed their business rules.

## Verification limitations
Automated source, static JSX parsing, and regression tests can run without the full npm dependency tree. `npm ci --offline` failed because `zip-stream` is not cached; a subsequent `npm ci` failed with the npm runtime error `Exit handler never called`. Therefore full Vite build, browser interactive QA and real Supabase/staging RLS tests **have not been certified**. This ZIP is a source-updated candidate, not a production GO. The existing Phase 7 invoice atomicity/concurrency release blocker remains outside this review UX scope.
