# Adroute Review Workspace V3 — Scale, Safety and Speed

## Basis
Complete project source based on the supplied **Survey & Installation Review V2** ZIP. Previous Phase 1–7 migrations, review RPCs, external company-approval gates, Shop/Work Item mapping, photo evidence, billing and the field apps are retained. This update does **not** create or apply a Supabase migration.

## Actual workflow
1. In Survey Review / Installation Review, filter the queue by Work Order, area, worker or search. Use **Review page (N)** for all visible records, or select only specified shops and press **Review N selected**.
2. The batch workspace shows one shop at a time. It loads detailed evidence **for that active shop**. Multiple Work Items inside that shop remain visible together, along with the existing per-item approve/redo controls.
3. Use **Reviewed & next shop** after **actually inspecting** that shop's evidence. This is only an inspection marker; it does NOT record the approval in the database. Missing/unloaded evidence prevents marking.
4. At any point use **Approve X reviewed shops** (plus valid designer for survey). Only inspected shops are sent to the existing review RPC. No accidental approval of uninspected shops.
5. The server separately checks organization, roles, evidence, review status and relevant company approval. Failed shops stay in the queue and remain selected. Successful shops are removed so a retry does not resubmit them.
6. Redo/correction continues to support affected Work Items/photos only. Installation bulk redo remains note-gated. Company PDF/PPT and manual external approval tracking is intact.

## Scale/performance
- Main queues stay **server-filtered, server-paginated**. Page size options go up to **250**; an agency with thousands of shops handles multiple bounded worksets, not a single 10,000-image browser render.
- Batch navigator has shop / city / PO search, jump, next pending, and flag-first shortcut. It does not show hundreds of numbered buttons.
- Batch operations use up to **3 parallel shop-level RPC calls**, with per-shop success/error isolation and progress. Server-side per-shop atomicity comes from existing RPCs, not from this client helper.
- Installation table thumbnails use native lazy loading to limit image requests while scrolling.
- Changing evidence invalidates its 'inspected' check; submissions never use selection alone as evidence review.
- Navigation and evidence editing are disabled while a batch write is active. Closing an unsubmitted inspected batch warns before discarding in-memory checks.

## Role & security invariants
- Owner/Admin existing review access and Supabase RLS remain authoritative.
- Field workers/client users gain no new approval permissions.
- Historical vs new Work Order company-approval rules are unchanged; no backfill.
- Work Item evidence selection is scoped to the current Shop/PO; no invoice/financial data or billing status is modified.
- Do **not** assume 'reviewed' equals 'approved'. The approval RPC can fail because a company response or item proof is missing.

## Changed source
- `src/lib/reviewBatchSafety.ts`: reviewed target filtering and bounded, failure-isolated batch processing
- `src/components/ReviewBatchStepper.tsx`: searchable & flag-aware compact navigator
- `src/pages/SurveyReviewPage.tsx`: one-click page review, inspected-only partial approvals, progress and partial failure recovery
- `src/pages/InstallationReviewPage.tsx`: same model, streamlined bulk redo, lazy table images
- `src/components/CompanyApprovalHandoff.tsx`: less verbose legacy-PO message, without changing authorization
- `scripts/verify-review-workspace-v3.cjs`: 1,000-shop simulation and bounded concurrency tests
- Previously bundled review verification scripts modernized to match V3 semantics, without removing approval/evidence safeguards.

## Windows local commands
Stop Vite/Node dev servers first (avoid locked `esbuild.exe` or Rollup native binary), then from `Darshan_Ad_Agency`:

```powershell
npm ci --include=dev
npm run typecheck
npm run build
node scripts/verify-review-workspace-v3.cjs
node scripts/verify-fast-review-workspace.cjs
node scripts/verify-review-workspace-v2.cjs
node scripts/verify-runtime-jsx-symbols.cjs
```

If `npm ci` returns `EPERM`, do **not** delete `package-lock.json` or `.env`. Close Vite/Node processes and retry in a fresh terminal. `tsc` or `vite` missing means dependencies did not install fully, not necessarily a project syntax issue.

## Supabase
**No new migration**. Check previously applied migration history on staging, if needed:

```powershell
supabase link --project-ref YOUR_STAGING_REF
supabase migration list
```

A `db push` is **not** necessary for this UI-only update. Never `db reset` production.

## Staging acceptance checklist
- Survey: 1 shop with 5+ Work Items, mark some for redo; approve only eligible reviewed shops, verify Designer handoff and company approval gate.
- Installation: linked proof missing on one of 5 items; blanket approval fails for that shop; other valid reviewed shops succeed.
- Multi-shop: 150/250 shops, review 10, approve 10, confirm 140 remain; retry one with missing company approval after recording confirmation.
- Search for shop within 250, navigate flagged shops and next pending; no duplicate checkboxes or numeric-button overflow.
- Load and process 1,000+ pending shops across several server-paginated batches; confirm count reductions and frontend responsiveness.
- Check keyboard focus, 375px mobile view, 768px tablet, desktop and zoom; inspect photo lightbox and correction actions.
- Verify Owner/Admin can review; Surveyor/Installer/Client cannot invoke privileged review RPC.
- Two admins reviewing overlapping shops: later RPC should fail/reconcile safely on changed status, not double-progress; this requires real database testing.

## Verification boundary
Targeted Node/TypeScript source regressions run locally. Full Vite build, live authenticated Supabase staging transactions, browser/image loading, cross-role concurrency and mobile visual QA require an environment with installed npm dependencies and a connected staging database. This is **source-tested**, not yet production certified.
