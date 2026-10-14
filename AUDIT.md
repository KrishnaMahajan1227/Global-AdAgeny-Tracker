# Targeted audit — 14 Oct 2026

Source: uploaded `src.zip` and existing patched source; static review only.

## Canonical screens and route map (agency)
- `/dashboard`: `src/pages/DashboardPage.tsx` via `src/App.tsx`, linked from `AdminLayout.tsx`; agency owner/admin and other explicitly allowed office roles.
- `/clients`: `src/pages/ShopsPages.tsx` `ClientsPage` with detail in `AgencyHierarchyPage.tsx`; sidebar Clients.
- `/purchase-orders`: `src/pages/PurchaseOrdersPage.tsx`, list/detail drawer; sidebar Work Orders, client detail links.
- `/campaigns`, `/projects`, `/progress`: compatibility redirects; not sidebar items.
- `/campaigns/project/:id`, `/campaigns/client/:id`: compatibility redirects to Clients.
- `/supply-orders`, `/survey-review`, `/design`, `/production`, `/installation-review`, `/field-map`, `/route-planning`, `/reports`, `/billing`, `/owner`, `/account`: existing independent screens, unchanged.
- `/client/*`: separate client-organization portal, including its own `/client/campaigns` routes; preserved because client-owned campaign navigation is a separate working role.
- `/mobile`: surveyor/installer; `/superadmin`: super admin; public `/`, `/login`, `/how-it-works`, `/for-agencies`, `/for-clients`.
- Exact permissions/links reside in App.tsx and AdminLayout.tsx; router guards are NOT a substitute for database RLS.

## Data map
- `clients.id` → `purchase_orders.client_id`, `projects.client_id`; organization ownership on agency records.
- `projects.id` → `purchase_orders.project_id`; client-owned `campaigns.id` → `purchase_orders.campaign_id`. These foreign keys must remain intact.
- Work-order completion derives from status (`closed`) or assignment status (`completed`). Assignment status denotes workflow, not a reliable person-level assignee. No trustworthy per-PO due/completed date in inspected type/query.
- `src/lib/agencyProgress.ts` contains shared percent, completion, done and overdue helpers.
- Teams/profiles and invoices/payment/billing are separate existing modules; no schema changes.

## Duplicate report
- Standalone agency Campaigns page in `ShopsPages.tsx` and nested client campaign presentation overlap: canonical agency presentation is now Clients → direct Work Orders. Old standalone route redirects; source CRUD function is retained to avoid destructive code removal.
- Work order drawer in `PurchaseOrdersPage.tsx` remains canonical operational details. Client detail links open this existing drawer.
- Dashboard previously duplicated campaign/client lists and displayed nonfunctional team leaderboard. Removed in favor of compact client delivery and action panels.

## Shared components
- `src/components/ui.tsx`: Card, ProgressBar, StatusBadge, dialogs, inputs, filters and many other reusable primitives. Reused ProgressBar; no new generic UI components.

## Sidebar and clicks
Agency sidebar: Dashboard, Clients, Work Orders, Supply Orders, Survey Review, Design Queue, Production, Installation Review, Live Field Map, Route Planning, Reports, Billing, Owner Console, My Account (conditional by role). No Campaigns.
Dashboard → client row (click 1) → work-order link (click 2) opens the existing drawer.

## Safety
This is a front-end-only presentation change. No migration, no SQL, no destructive DDL/DML. Database record retention does not guarantee that existing RLS policies are correct: verify independently.
