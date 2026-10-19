# Adroute — Phase 5: Work Order / PO Line / Billing Reconciliation

## Status
**Source implementation and local regression checks complete; staging database/browser verification pending.**
This Phase 5 archive is based on the complete Phase 4 source. No new migration was added in Phase 5. Previous migrations 0097–0100 must be present for their respective workflows. Do NOT assume filenames mean the migrations are installed.

## Changes
1. **Fix real runtime issue:** `billingReadiness.ts` referenced undeclared `receiptRequired` in its Supabase query. It now explicitly loads the selected PO's immutable receipt policy and consistently uses it in shop filters and calculations.
2. **One policy across readiness and invoice:** `buildPendingAllocations()` now receives `receiptRequired` and rejects dispatched/unreceived shops for new Supply POs, even when called independently of the UI eligibility filter. Historical Supply POs remain backward compatible.
3. **Safer invoice scope:** Billing preview excludes Work Items explicitly linked to other PO lines even if they happen to belong to a shop with the selected PO ID. It also verifies the correct client and explicit PO-line affiliation. Final submission reloads the PO policy and current shop statuses.
4. **Historical billing history:** The same de-duplicated invoice-item history now checks PO-header invoices, PO-line-linked invoices, work-item-linked invoices and ambiguous shop-only invoice items. Ambiguous records block accidental repeat billing and require review.
5. **Partial billing:** User-entered amount/area may be smaller than the verified outstanding work, but may never be negative, exceed the unbilled ceiling, alter the approved PO rate/line, duplicate a work item, or change the calculated monetary amount. The same validator runs at preview and immediately before saving.
6. **Work Order detail alignment:** Supply receipt status now controls read-time measured final-site reconciliation. Financial line breakdown lists only positive eligible quantities. Zero reconciliation flags become a clear state instead of another meaningless `0` tile.
7. **Read-only staging audit:** `supabase/manual/PHASE5_READ_ONLY_BILLING_AUDIT.sql` checks mismatched invoice/PO links, unallocated invoice items, repeated work-item invoice allocations and new Supply orders awaiting receipt. It never changes data.

## Core calculation invariants
- Final shop status and measured work-item quantity are **different data**. 96 installed sites DO NOT mean 96 invoice pieces.
- `piece` / `lot` invoice value = **measured outstanding quantity × PO rate**.
- `sqft` invoice value = **verified outstanding area × PO rate** (not quantity × area).
- Already-invoiced quantities/areas are subtracted per Work Item from the same basis.
- Invoices with ambiguous historic shop/line allocations require review, not guessed distribution.
- Delivery receipt required only for new Supply POs flagged by Phase 4 policy; old orders retain their behavior.
- Owner dashboard money visibility remains default-hidden and unchanged. Billing permissions remain role-controlled.

## Local commands
```bash
cd Darshan_Ad_Agency
npm ci
npm run typecheck
npm run build
node scripts/verify-phase5-billing-reconciliation.cjs
node scripts/verify-owner-billing-readiness.cjs
node scripts/verify-phase4-fulfillment.cjs
node scripts/verify-phase3-handoffs.cjs
node scripts/verify-phase2-approvals.cjs
node scripts/verify-phase1-fulfillment.cjs
```

### Supabase (no new Phase 5 migration)
```bash
supabase login
supabase link --project-ref YOUR_STAGING_PROJECT_REF
supabase migration list
supabase db push --dry-run
```
Review the migration list. Install any still-unapplied **prior** migrations on staging only after backup/review and testing; this Phase 5 release adds **no new db push requirement**. To run the read-only audit, paste the supplied manual SQL into the staging SQL Editor and replace the placeholder organization UUID. Never use `db reset` on production.

### Git (after copying the source into your own repository)
```bash
git status
git switch -c feature/phase5-po-billing-reconciliation
git add src/lib/poBilling.ts src/lib/billingReadiness.ts src/lib/poBillingHistory.ts src/lib/poExecutionReconciliation.ts src/pages/BillingPage.tsx src/pages/PurchaseOrdersPage.tsx scripts/verify-phase5-billing-reconciliation.cjs supabase/manual/PHASE5_READ_ONLY_BILLING_AUDIT.sql PHASE_5_BILLING_RECONCILIATION_RELEASE.md
git diff --cached --stat
git commit -m "fix: Phase 5 Work Order billing reconciliation"
git push -u origin feature/phase5-po-billing-reconciliation
```

## Mandatory staging scenarios
1. New Production & Delivery, 2 sites: one dispatched, one delivery-received. Only received site eligible, with actual produced quantity and rate.
2. Historical Supply Only dispatched PO: preserve previous completion/billing behavior.
3. Survey & Installation / Production & Installation: installed-final status required, with measured quantity/area; dispatched alone is not billable.
4. Direct / On-site Execution: approved final photo review, measured area and PO-line association.
5. Mixed custom PO lines: correct independent final-stage measurement; missing links stay blocked.
6. Partly invoiced Work Item: prior invoice quantity/area subtracted; a smaller partial invoice remains valid.
7. Old invoice linked only to Work Item or Shop: de-duplicate and block double billing without fabricating scope.
8. One shop containing several unrelated Work Items: never include those explicitly linked to another PO.
9. Load full agency dashboard, Work Order, Billing and client progress after database changes; verify Realtime.
10. Owner/Admin/Accounts/Client roles tested for allowed screens and hidden monetary values.

## Known limits / release gates
- No full Vite build or live Supabase/SQL/RLS/network/mobile tests were available here; npm dependencies were not installed in the execution environment. Local source syntax/regression checks do not prove production readiness.
- The existing invoice save still consists of a header insert and invoice-item insert, with best-effort rollback. **Concurrent operators may still race between final recheck and database write**. Do NOT advertise database-enforced atomic invoice creation or concurrency-safe anti-double-billing until a dedicated transactional RPC/guard is implemented and staged. The existing Phase 4 server-side receipt guard remains in place.
- Legacy invoice items without any reliable Work Item, Shop or PO link cannot be automatically attributed. Audit and repair with explicit approval.
- The read-only audit is a diagnostic aid, not a migration or automatic repair.
