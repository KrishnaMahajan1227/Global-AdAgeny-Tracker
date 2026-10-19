# Adroute — Phase 6: role-based UI, contextual navigation & usability

**Base:** Phase 5 Work Order & Billing Reconciliation source.
**Change type:** Frontend/UI only. No additional Supabase migration, no rate/quantity/approval logic mutation.

## Delivered

### Agency owner & admin
- Shared `src/lib/operationalNavigation.ts` resolves Work Order's **actual next-action destination**, rather than sending every click to a generic Shops stage filter.
- Design and Production stage tasks open PO-scoped queues directly; Installation review opens the PO-scoped evidence review; Supply dispatch / pending receipt opens the matching Supply dispatch workflow.
- Acceptance, missing scope, and already-completed jobs return to the appropriate Work Order detail.
- Work Order detail's redundant delivered/site/next-action tile row simplified to one clear next-action bar. The site delivery statistics and milestone evidence stay visible elsewhere in the detail.
- Dashboard remains operations-first. The **Financial · private** view is owner-only and off by default; no financial totals are fetched on default view.

### Team workflows
- Designer and Printing employees now land directly on their work lists instead of a general folder/overview step; their server-side assignment restriction remains unchanged.
- Incoming `/design?po=<UUID>` and `/production?po=<UUID>` open the correct team queue, filter on the PO, and show a dismissible context indication. The URL input is validated to avoid passing arbitrary strings into UUID database filters.
- `/survey-review?po=<UUID>` and `/installation-review?po=<UUID>` narrow the **server-side** review query to only the selected PO. Review decisions still use existing gated review/RPC paths.
- Each PO-scoped queue includes a **Show all** action. Installation Review's Clear Filters now also clears the PO URL filter.

### Client manager and client portal
- Client Manager's sidebar now exposes the routes their existing authorization rules permit: Dashboard, Clients, Campaigns, Work Orders, Reports and Billing. (This release does **not** expand server permissions.)
- Client overview has a direct Campaigns & Work Orders shortcut, tighter section spacing, and an accurate **Auto-refresh** label instead of claiming instant live updates while using 20-second polling.

### Navigation accessibility
- Agency mobile nav traps keyboard focus when open, supports Escape dismissal, and restores focus on closing; `aria-controls`/`aria-expanded` applied to the toggle.
- Sidebar remains scrollable while its scrollbar stays visually hidden. Footer remains reachable.

## Important preserved boundaries
- No changes to business rules for Survey + Installation, Production + Installation, Production + Delivery, On-site Execution, or historical Custom work.
- No changes to client-company approval, production/dispatch transactions, billing math, invoice generation, or database schema.
- No automatic money visibility in owner Dashboard/Work Order Work mode.
- Existing Agency Owner/Admin/Accounts permissions remain effective; Client Manager's sidebar merely catches up with already-allowed route permissions.
- Deep-link filters never grant access to otherwise unauthorized data; existing Supabase RLS and route guards remain authoritative.

## Verification performed
- `node scripts/verify-phase6-role-ux.cjs` — 17 pass
- `node scripts/verify-owner-dashboard-compact.cjs` — 8 pass
- `node scripts/verify-owner-ux-stage-routing.cjs` — 15 pass (assertions updated for Phase 4 receipt logic and new contextual routing)
- `node scripts/verify-phase1-fulfillment.cjs` — 16 pass
- `node scripts/verify-phase2-approvals.cjs` — 21 pass
- `node scripts/verify-phase3-handoffs.cjs` — 21 pass
- `node scripts/verify-phase4-fulfillment.cjs` — 19 pass
- `node scripts/verify-phase5-billing-reconciliation.cjs` — 18 pass
- `node scripts/verify-owner-billing-readiness.cjs` — 23 pass
- `node scripts/verify-runtime-jsx-symbols.cjs` — 62 TSX files parsed and JSX components resolved

### Not verified in this environment
- Complete npm install / Vite build: dependency retrieval timed out and the npm offline cache was missing `zip-stream`. A full TypeScript/build/browser test should be performed in the deployment environment.
- Browser walkthrough on all device sizes and staging-backed Supabase role/RLS smoke tests. No production-readiness guarantee without them.

## Developer steps (from project directory)

```bash
npm ci
npm run typecheck
npm run build
node scripts/verify-phase6-role-ux.cjs
node scripts/verify-runtime-jsx-symbols.cjs
```

**Supabase:** Phase 6 does not add a migration. To inspect existing applied migrations:

```bash
supabase link --project-ref YOUR_STAGING_PROJECT_REF
supabase migration list
```

Check that prior Phase 1–4 migrations (0097–0100) are applied as planned. Do NOT run `supabase db reset` on production. `supabase db push` is not needed solely for Phase 6.

**Git (apply ZIP source into your existing repository before committing):**

```bash
git switch -c feature/phase6-role-ux
git status
git add src scripts/verify-phase6-role-ux.cjs scripts/verify-owner-dashboard-compact.cjs scripts/verify-owner-ux-stage-routing.cjs PHASE_6_ROLE_BASED_UX_RELEASE.md
git diff --cached --check
git commit -m "feat: Phase 6 contextual role-based UX"
git push -u origin feature/phase6-role-ux
```

### Staging acceptance checks
1. Owner opens each non-completed Work Order; next action opens correct team queue and PO filter; compare with shop status.
2. Survey, Design, Production and Installation reviewers cannot see another organization's records by modifying `?po=`.
3. Supply receipt-pending PO opens its correct Dispatch/Receipt tab, and its billing gate is unaffected.
4. Client Manager has navigation for authorized business screens, without accessing Owner Console.
5. Financial values stay hidden on Work mode even after changing Work Orders.
6. Designer and Printing employee only sees assigned work and may clear an incoming PO filter.
7. On mobile, sidebar opens/closes with touch, keyboard and Escape; footer accessible on short screens.
8. Client Portal still exposes no agency-private pricing and shows periodically refreshed data accurately.
