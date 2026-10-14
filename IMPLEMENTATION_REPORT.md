# Agency Progress Update — 2026-10-14

## Existing flow
Agency owner/admin -> agency clients (`clients`) -> agency campaigns (`projects`) or client-created campaigns (`campaigns`) -> Work Orders (`purchase_orders`) -> operational team queues (surveyor, designer, printing, installer). The client portal is separate and has client-owned campaigns. These are distinct models and must not be merged or relabeled in the database.

## Changed files and purposes
- `src/lib/agencyProgress.ts` — shared completion, order status, date, overdue helpers.
- `src/pages/DashboardPage.tsx` — progress-first owner dashboard and URL-persisted filters; no monetary widgets.
- `src/pages/AgencyHierarchyPage.tsx` — client/campaign overview and work-order tables.
- `src/pages/ShopsPages.tsx` — live progress on client cards, direct client links and agency campaign detail links.
- `src/components/AdminLayout.tsx` — remove redundant Work Progress nav entry, retain `/progress` route.
- `src/App.tsx` — guarded client and campaign detail routes.
- `src/pages/PurchaseOrdersPage.tsx` — deep-link into existing work-order details via `?order=ID`.

## Gaps and data limitations
- `purchase_orders` does not expose an authoritative PO-level due date, priority, assignee or completed timestamp in the inspected schema. Fields are explicitly displayed as unavailable, rather than manufactured. Overdue totals and on-time rating cannot be computed without a migration and authoritative data. Campaign deadlines are separate, tracked at campaign level.
- Team leaderboard is not fabricated: the app uses role-specific assignment in surveys/design/production/install flows. Those records are not equivalent to one unified Work Order assignee.
- Client-created campaigns have no agency-owned `client_id`; they can be related to agency clients only through connected orders, rather than assuming an invalid FK.
- The campaign completion measure is completed Work Orders / total Work Orders; active orders count as 0%, completed orders as 100%, because no authoritative per-PO progress value was present in this model.
- Work Progress remains routable at `/progress` for old deep links. The requested unnamed sidebar item was interpreted as the duplicate Work Progress link.

## Navigation click count
- Dashboard -> Client: click the client name (1)
- Client -> Work Order: click the order title in the client's work-order list (2)
- Optional campaign drilldown: Dashboard -> Client -> Campaign -> Work Order requires 3 clicks, so the client direct link is the 2-click shortcut.

## Manual checks (deployment needed)
- [ ] Owner/admin: dashboard loads organization-scoped data; progress counts match actual POs.
- [ ] Team roles: direct URL navigation to owner detail pages redirects; team queues show only assigned items per existing RLS.
- [ ] Client role: `/client` remains read-only where already enforced; owner detail URLs denied.
- [ ] Clients with zero campaigns and zero work orders render empty states and 0%.
- [ ] Clients/campaigns display overdue/date accurately when those data are available; missing values never imply known deadline.
- [ ] View/range/metric filter changes update without reload and persist in URL after refresh.
- [ ] Purchase orders create/edit/delete and `?order=ID` details flow.
- [ ] Tablet/mobile layouts and keyboard selection.
- [ ] Supabase RLS policies with test users from separate agencies.

## Validation
Automated TypeScript/build validation was not completed: the ZIP did not include `node_modules`, and `npm ci` was unable to complete in the sandbox. Do not deploy the archive as a pre-tested production build. Install dependencies and run `npm run typecheck` and `npm run build` in an environment with npm registry access.
