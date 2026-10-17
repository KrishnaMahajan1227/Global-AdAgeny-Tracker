# Darshan Ad Agency — Owner command-center, KPI and privacy UX update

## Implementation
- Rebuilt Agency Owner Dashboard as an operations-first command center: order-level client context, exact site delivery, prioritized owner actions, current active stages, one-click queue access, client portfolio, and long-running open orders.
- No fake overdue data: the Purchase Orders schema does not define an authoritative delivery deadline. The dashboard calls out orders **open 30+ days**, not *late* or *overdue*.
- Financial dashboard details remain collapsed by default and agency-owner-only. The query is disabled unless the owner explicitly expands the section. The revealed section now gives a client/Work Order invoice history table and per-PO navigation (not just three aggregate monetary numbers).
- Work Orders list now hides amount and invoicing columns, mobile invoice values, default invoice quick actions, and amount-based sorting until an agency owner selects **View financials**. Closing that mode also resets monetary sorting.
- Work Order detail is a centered responsive modal; its **Work / Financial** toggle stays in the modal header, always visible while scrolling. Each new Work Order opens in Work mode. Monetary KPIs and invoice preparation are hidden by default and Financial mode is owner-only.
- Work Order KPIs are clickable: Sites in scope, Delivered, and each *active* stage link to `/shops?po=<id>&stage=<bucket>`. Zero-count pending stage tiles are hidden, and completed work shows a calm all-delivered state. Previously passed milestones become compact green chips instead of repetitious 100% progress bars.
- Shops server-side filter now interprets PO-specific fulfillment and required-stage flags, including supply-only dispatched = finished, installation dispatched = pending. It retains exact server pagination and fallback queries and includes org-scoped PO lookup.
- The private Work Order Financial panel exposes PO-line **eligible unbilled quantity**, ready invoice value and sites/item counts from the *same allocation engine* used to compose the draft invoice. It does **not** infer billing quantity from site counts or manufacture missing proof.
- Stage KPIs, shop drill-down and owner next-step messaging share `src/lib/ownerOperations.ts` with `workCompletion.ts` so current stage semantics are consistent.
- No database migration or historical approval/status rewrite included; edits are read-only rollups and navigation changes.

## Validation in this environment
- `node scripts/verify-owner-ux-stage-routing.cjs` — 15 owner UX, deep-link, privacy and fulfillment stage checks passed.
- `node scripts/verify-owner-billing-readiness.cjs` — 23 billing/readiness calculations including line-level reconciliation passed.
- `node scripts/verify-agency-progress.cjs` — passed (96/144 delivery, cross-screen scope, financial isolation).
- `node scripts/verify-unified-progress.cjs src/lib/workCompletion.ts` — 14 stage regressions passed.
- `node scripts/verify-workorders-supply.mjs` — 13 routing/integration structure checks passed.
- TypeScript compiler transpile/parse of all five edited TS/TSX modules — no syntax errors.

**Not verified:** full production build (`npm ci` fails without registry DNS/network access), Supabase live RLS/invoice reconciliation, browser device visual QA or production deployment. These must be completed before production release. Do not treat zero readiness as zero billing without reviewing missing measurements/legacy invoice links.

## Smoke-test before production
1. Run `npm ci && npm run typecheck && npm run build` on a machine with package-registry access.
2. Open Dashboard logged in as Agency Owner: confirm no amounts load/appear until Private Financial expanded. Inspect each client's Work Orders and next actions.
3. Open the 144-site 7D Standee order: verify 96 Delivered + 48 Dispatched and click the 48-card. The Shops page must show only dispatched sites on that PO.
4. Change one shop to Installation Review, then Installed; verify the Dashboard and Work Order review/delivery totals refresh and click-throughs match.
5. Test supply-only dispatched, direct-install and custom production-only orders: correct terminal stage, completed milestones and zero-count stage hiding.
6. Reveal Financial in the Work Order details: verify per-PO-line ready units/amount with real invoice history and posted invoice, including partially invoiced work. Draft and review a test invoice; do not post without validation.
7. Check responsive modal and touch hit targets at small screen sizes, keyboard tab loop/Escape, browser Back on filtered links, and non-owner access restrictions with RLS.
