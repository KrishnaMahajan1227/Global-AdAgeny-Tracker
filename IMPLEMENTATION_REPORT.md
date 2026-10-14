# AdRoute — Dashboard correction (14 October 2026)

## Scope and source mapping
- `src/App.tsx`: existing admin, field and client portal routes; UI-level role guards.
- `src/components/AdminLayout.tsx`: existing sidebar; no new section added.
- `src/pages/DashboardPage.tsx`: redesigned in place; no new hierarchy module.
- `src/pages/ShopsPages.tsx`: existing Clients/Campaigns CRUD and inline detail views retained unchanged in this correction.
- `src/pages/PurchaseOrdersPage.tsx`: existing Work Orders module retained unchanged.
- `src/lib/agencyProgress.ts`: shared order progress/date helpers retained.
- `supabase/migrations`: existing policies; no new migration added.

## Updated files
1. `src/pages/DashboardPage.tsx`: dashboard KPIs, priorities, work-order status overview, short client health list, approaching deadlines and period trend controls. Real data from existing tables; no assignee feature or extra management screens.
2. `src/App.tsx`: route-level client/campaign role checks; retired duplicate `/progress` destination redirects to existing dashboard.

## Important security and data caveats
- URL access is restricted by the React auth/role guards for protected routes. Strong per-record authorization *depends on the deployed Supabase Row Level Security policies*, which cannot be verified offline. Do not claim that a client can never bypass access until deployed policies are audited and tested using separate accounts.
- The existing `campaigns` table is cross-organization and visibility relies on existing RLS. Only campaigns linked to agency-visible work orders contribute to the dashboard.
- Deadline counts use campaign/project end dates because work orders have no reliable per-order due date.
- Period statistics are grouped by **creation date**, not completion date.
- No production browser verification or TypeScript build was possible in this environment because the package dependencies were not available and installation failed/timed out.

## Developer validation
- `npm ci`
- `npm run typecheck`
- `npm run lint`
- `npm run build`
- `npm run dev`
- Test dashboard, clients, campaigns and work orders with real records (including >1000 clients), zero records and null dates.
- Test direct URL entry with agency owner/admin, client manager, designer, printing, client portal and signed-out identities.
- Verify RLS policies using different organization accounts; never trust a UI redirect as a database security boundary.
- Check existing create/edit/delete functions and mobile overflow before deploying.

No SQL change is included. Preserve your existing `.env` securely (not included in ZIP).
