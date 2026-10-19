# Adroute Phase 4 — Production, Dispatch, Delivery Receipts & Field Reliability

## Important: source release, **not** production-approved

This build extends Phase 1–3. All changes described below are in source; PostgreSQL functions/triggers **must** be installed by migration 0100 before this frontend can execute the new RPCs. This environment did not have a local PostgreSQL/Supabase instance or a complete npm dependency cache, so the migration and browser flow were not executed live. Stage in a clone before production.

### Scope

1. **Atomic Production & Delivery dispatch** — `phase4_create_supply_dispatch` creates route, stops, changes linked Shop and Supply Destination statuses and audits inside one PostgreSQL transaction. Request UUID + advisory lock + shop row locks prevent duplicate dispatch on timeout/retry or overlap. Assignee role and organization are checked server-side. Existing Production completion RPC from Phase 3 remains unchanged.
2. **Per-destination Received confirmation** — Owner/Admin enters recipient name (optional LR/proof reference and note), calling `phase4_confirm_supply_receipt`. One receipt per site, one-time audit, Shop + destination `delivered` and route-stop visited in a single transaction. Partial route delivery is supported. Existing route Owner acknowledgment is separate and **not** a substitute for delivery proof.
3. **New Supply billing gate only** — migration adds immutable `purchase_orders.delivery_receipt_required=true` automatically **only on newly inserted `supply_only` orders**. Historical POs remain `false`. New orders consider `dispatched` incomplete and `delivered` complete. Billing page, readiness, owner/client progress and invoice-item database trigger follow this policy. No synthetic measurements; production quantity and PO-rate reconciliation still apply. Existing orders/invoices not bulk-updated.
4. **Direct / On-site Execution atomic creation** — `phase4_create_direct_install_site` inserts Shop + linked PO Work Item + Installation Job + assignment + audit atomically. Only an active installer assigned to that direct-install PO may call it. UUID retries resolve the original IDs. Actual area is computed from submitted canonical ft dimensions on the server, not multiplied from a shop count.
5. **Durable-first installation proof** — Direct Install now uses the project's **existing IndexedDB offline photo queue**, shared photo syncing and retry logic, rather than directly uploading without a durable copy. Submit is disabled while a proof is queued. `phase4_submit_direct_install` validates proof exists, audits and notifies Owner/Admin only once. This does not mean the entire Direct Install form can be created offline: initial PO/site creation still requires internet.
6. **Fewer clicks & consistent status** — zone Select All/Clear selection, only valid dispatch assignees, single-staff default, inline per-destination confirmation, contextual "awaiting delivery receipt" next action, client site map/status and report completion based on received locations where the policy is enabled.

### Major files

- `supabase/migrations/20261030100000_0100_phase4_supply_delivery_integrity.sql` (new, after 0097–0099)
- `src/pages/SupplyOrdersPage.tsx`, `src/pages/InstallerPage.tsx`, `src/pages/BillingPage.tsx`
- `src/lib/workCompletion.ts`, `src/lib/agencyDelivery.ts`, `src/lib/agencyProgress.ts`, `src/lib/ownerOperations.ts`, `src/lib/poBilling.ts`, `src/lib/billingReadiness.ts`, `src/lib/types.ts`, `src/lib/clientPortal.ts`
- `src/pages/DashboardPage.tsx`, `src/pages/PurchaseOrdersPage.tsx`, `src/pages/AgencyHierarchyPage.tsx`
- Client Portal overview, campaign detail, campaign list, PO detail/map, map feed and reports
- `scripts/verify-phase4-fulfillment.cjs` (new)

## Local commands

```bash
cd Darshan_Ad_Agency
npm ci
npm run typecheck
npm run build
node scripts/verify-phase1-fulfillment.cjs
node scripts/verify-phase2-approvals.cjs
node scripts/verify-phase3-handoffs.cjs
node scripts/verify-phase4-fulfillment.cjs
node scripts/verify-owner-billing-readiness.cjs
```

`npm ci --offline` failed in this execution environment because `zip-stream@4.1.1` is not cached. Run `npm ci` with normal internet access. Do not deploy if typecheck/build fails.

## Staging Supabase commands — READ FIRST

Migrations `0097`, `0098`, `0099`, then `0100` must apply in the correct order, along with all earlier pending migrations. The migration filenames include timestamps later than 19 Oct 2026. Dates in a source archive do **not** prove your deployment has applied them.

```bash
supabase login
supabase link --project-ref YOUR_STAGING_PROJECT_REF
supabase migration list
supabase db push --dry-run
# Review EVERY pending SQL and take a staging backup; only then:
supabase db push
supabase migration list
```

Never blindly run `supabase db reset` or `supabase db push` on production. Repeat the migration-list/backup/review process on the correct production project only after staging passes and DB backup/restore is verified. Keep deployment `.env` secrets outside this ZIP.

## Git commands (run inside your own repository)

```bash
git status
git switch -c feature/phase4-field-dispatch-receipts
# Copy relevant updated files/migration into the repo first.
git add src/ supabase/migrations/20261030100000_0100_phase4_supply_delivery_integrity.sql scripts/verify-phase4-fulfillment.cjs PHASE_4_FIELD_DELIVERY_RELEASE.md
git diff --cached --stat
git commit -m "feat: Phase 4 atomic supply dispatch and field delivery"
git push -u origin feature/phase4-field-dispatch-receipts
```

## Mandatory staging acceptance checklist

1. Create a **new** Production & Delivery PO. Confirm `delivery_receipt_required=true`; an **older** supply PO remains `false`.
2. Finish one supply production item -> packed/destination ready. Dispatch selected sites with own staff and with courier; transaction produces route/stops and matching Shop/Supply Destination statuses.
3. Block duplicate requests and overlapping dispatch even when two operators retry simultaneously or the HTTP response is lost; no duplicate route or active site assignment.
4. Dispatch only 2 of 3 sites, receive 1. New PO shows 1 delivered / 2 not final; Client Portal reflects the same. Old PO `dispatched` remains backward compatible.
5. Accounts cannot mark a site received; Owner/Admin can record the recipient and optional reference. Repeating receipt is idempotent. Direct `shops.status='delivered'` cannot bypass the receipt on new POs.
6. On a new PO, try to bill a dispatched/unreceived item; both UI eligibility and database invoice-items trigger must reject it. After receipt and verified **produced** work quantities, item becomes eligible; partial prior invoices must still deduct correctly.
7. Keep existing invoice/PO relationships unmodified; verify older Supply Only billing still works. Generic invoices with no linked Shop/PO cannot be matched to a gated PO by the receipt validator — require PO-linked billing operationally.
8. Direct Install with assigned installer: create field site, work item and job in one RPC; retry with same request ID and observe exactly one set of rows. Unauthorized, foreign-org and unassigned calls must fail.
9. Capture proof offline after site is created online: IndexedDB persists image, reconnect sync restores proof, final submit only after proof exists in DB. Final submit retries send one Owner/Admin notification, not duplicates.
10. Live owner dashboard, Work Order, billing, client portal, report and map progress must stay coherent. Verify routes with 200 destinations and rejected/exception sites; test mobile/tablet/desktop and airplane-mode reconnect.
11. Check actual SQL trigger compilation, privilege grants, Supabase/PostgREST RPC schema cache, no recursive/deadlocked triggers, and Realtime channel permissions. Run invoices and direct install end-to-end with real records on staging.

## Known limitations / additional work

- Full Vite build, live PostgreSQL migration, live browser, RLS integration, actual offline reconnection and all end-to-end tests **remain unverified** in this environment. Source checks do not guarantee zero runtime faults.
- Direct Install **initial** site/job creation still requires connectivity; once created, proofs use the durable offline queue. Multi-device resumption of an unfinished field wizard has not been added.
- Existing historical Supply Work Orders keep old completion/billing semantics deliberately. If you want historical receipt-gated billing, that is a separate audited data-migration project.
- Only PO/item/site-linked invoices can be mechanically tied to a receipt. Unlinked generic manual invoice items are outside that gate until a mandatory association is designed.
- Supplier/delivery recipient confirmation is **manually recorded by agency Owner/Admin**, not electronically signed by external parties.
