# Darshan Ad Agency — Agency-side progress & invoice navigation update

## What changed
- Added a shared, order-scoped shop delivery rollup (`src/lib/agencyDelivery.ts`). An installed shop now contributes to its Work Order's visible **site-delivery progress**, and the same calculation feeds agency Dashboard, Clients, individual Work Orders and client/campaign/project detail pages. Supply-only dispatch is its delivery milestone. Cancelled/rejected shops and orders are excluded from active site denominators.
- Dashboard pipeline shows mutually exclusive stages, not overlapping totals. Client/portfolio site delivery percentages are weighted by actual linked sites rather than treating a 144-site order as equivalent to a one-site order.
- Preserved measured execution (surveyed/approved/produced/installed quantities or square feet) **separately** from shop/site delivery. These are different measures. Completed shop statuses never fabricate piece/area measurements.
- Added separate agency financial rollup (`src/lib/agencyFinance.ts`) that reconciles ex-GST invoice-item amounts by Work Order, without double-counting individual invoice items. Dashboard, Clients, Work Orders and entity details expose invoiced/planned/remaining values when available.
- Replaced right-side Work Order detail drawer with a centered, responsive and keyboard-accessible modal. It shows site-wise stage counts and percentages, measured line-item utilization, and independent Work / Financial completion views.
- Added direct **Prepare invoice** navigation from Work Orders to Billing using `?po=<id>&create=1`; pre-selects the Work Order/client and initializes the existing completed, unbilled work-item selection workflow. The owner still verifies the scope before posting.
- Expanded query pagination and realtime/polling invalidation for cross-page progress so changes are reflected without browser hard reload.

## Data integrity: important differences
- **Site delivery %** = delivered linked, non-rejected shops / all linked, non-rejected shops in an order.
- **Measured execution %** = logged unit/area quantities / budgeted unit/area from PO line utilization. It can legitimately remain 0% when shop delivery is nonzero, until actual measured quantities are posted/linked.
- **Financial progress %** = invoiced ex-GST invoice-item amount / PO budget amount; it is **not** payment collection and not inferred from the count of installed sites.
- Work Orders with no linked shops use the recorded measured-progress fallback in their Work Orders list; missing budgets do not generate a misleading financial percentage.
- Orphan shops (missing `purchase_order_id`), missing line-item associations, invalid scope links and stale database views require data-level reconciliation. The UI deliberately doesn't guess their links or invent quantities.

## Verification performed in this environment
- `node scripts/verify-agency-progress.cjs` — PASS, including 96 installed of 144 sites = 67%, stage transitions, scope isolation, cancellations, supply-only finalization, and financial-vs-site independence.
- `node scripts/verify-unified-progress.cjs <typescript-module-path>` — PASS, 14 pre-existing regression scenarios.
- TypeScript transpile/parser diagnostics on all edited TS/TSX files — 0 syntax diagnostics.
- **Full npm build, real Supabase integration test and production deployment were not verified** here because package dependencies could not be downloaded/installed in this runtime. This is an updated source package, not a claim of a live deployed fix.

## Recommended deployment checks
1. Back up production database. Check currently installed migrations and RLS policies.
2. Run `npm ci`, `npm run typecheck` and `npm run build` with a working package registry before deployment.
3. Sign in as Agency Owner. Open a 144-shop Work Order and confirm its installed/dispatched counts match the Shops filter. Verify Work Orders, Dashboard and client detail percentages agree.
4. Verify live stage changes from survey/design/production/dispatch/installation trigger page refreshes. Use `supabase/manual/READ_ONLY_COMPLETION_AUDIT.sql` if site vs measured quantities disagree.
5. Verify the centered Work Order dialog on desktop and mobile. Open Work Order -> Prepare invoice; verify prefilled PO and **eligible, completed, unbilled** work allocations before confirming any invoice.
6. Verify planned vs invoiced amounts and tax basis for representative client Work Orders against Billing. Do not post an invoice if source quantities/areas are missing or incorrect.

No destructive database changes or automatic writes/backfills were added for this UI/source correction.

---

## Owner progress & billing-readiness follow-up — 16 October 2026

**Operational milestone inference**
- Work Order details now show stage milestones derived from actual downstream `shops.status` per Work Order. An **installed** survey+install site counts all applicable upstream stages as passed. A **dispatched** supply-only site counts production and dispatch as passed. A **direct-install** site counts only installation.
- Custom Work Orders respect PO-line `requires_survey`, `requires_design`, `requires_production`, and `requires_installation` flags; production-only/design-only/survey-only contracts are not forced through installation. Unknown/absent evidence is shown as unknown rather than completed. Pending approvals remain pending until evidence exists, unless a later shop status proves the step was passed.
- This is a **read-only derived operational completion**. It does not invent survey/design approval timestamps, backdate validation records, override reviewer decisions, or automatically mutate raw database statuses. A record-level audit still depends on underlying evidence.

**Financial KPI and calculations**
- The selected Work Order fetches its own completed shops, completed work items, PO-line rates/flags and historical invoice items (paginated and tenant-scoped) only while the details dialog is open.
- Shares Billing's `buildPendingAllocations` engine, including measured `installed`, `produced`, `approved` or `survey` scope for each fulfillment/line requirement, subtracting previously invoiced area or quantity to four decimal places, and rounding currency to two decimals.
- The detail financial view shows **Already invoiced + Verified ready to invoice + Not yet billable** against the valid ex-GST PO budget; budget gaps and reconciliation errors never become a guessed percentage. A shop with some ready items and some unresolved items stays flagged for review. Missing rate/work-item links, ambiguous historical billing and missing measured area remain blockers.
- `src/lib/poBillingHistory.ts` loads both PO-header-linked and PO-line-linked invoice histories and deduplicates by invoice-item ID; reused in the Billing page and detailed Work Order readiness.
- Preparing an invoice remains a direct Work Order deep link, auto-selecting eligible work. The owner reviews/authorizes the draft; the UI never posts an invoice on its own.

**Agency-owner Dashboard / navigation**
- Operations-first owner view with client/order/site/delivery KPIs, stage pipeline, review decisions, action shortcuts, client delivery, and direct Work Order links.
- **Private financial progress hidden by default.** Its amounts are absent from the initial Dashboard UI and its financial query is disabled until an `agency_owner` explicitly expands the section. Client delivery table no longer exposes invoice amounts.
- Common navigation routes use the application's existing `/purchase-orders`, `/shops`, `/survey-review`, `/design`, `/production`, `/installation-review`, `/reports`, and `/billing` routes.

**Verification and constraints**
- `node scripts/verify-owner-billing-readiness.cjs` — covers downstream stage cascade, no false validation, all fulfillment presets, custom stage flags, recorded area and quantity billing, partial/fully billed units, legacy invoice blockers, missing budgets and partially ready sites.
- `node scripts/verify-agency-progress.cjs` and `node scripts/verify-unified-progress.cjs src/lib/workCompletion.ts` — regression checks.
- TS/TSX transpilation/parse checks on every edited source file — no syntax errors.
- **Live Supabase testing, end-to-end build and production deployment are not verified in this environment.** Its existing `node_modules` directory lacks the Vite binary and required type definitions. Run `npm ci`, `npm run typecheck`, `npm run build` with a functional dependency registry, then smoke-test a real set of multi-stage orders, historical invoices, custom flags, RLS permissions and UI on desktop/mobile.
- No destructive migrations, approval rewrites or auto-created financial entries were added.

---

## 17 October 2026 — Owner UX release
See `OWNER_DASHBOARD_UX_RELEASE_NOTES.md` for details, drill-down contracts, tests and remaining deployment checks.
