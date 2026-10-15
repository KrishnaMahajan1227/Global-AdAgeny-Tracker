# AdRoute Clients ↔ Work Orders synchronization

## Files changed
- `src/pages/AgencyHierarchyPage.tsx`: Client detail stops rendering a second simplified work-order table; provides one direct link into canonical, client-filtered Work Orders list. Other legacy detail modes unchanged.
- `src/pages/ShopsPages.tsx`: Client list adds a direct Work Orders shortcut per client, preserving client editing and existing actions.
- `src/pages/PurchaseOrdersPage.tsx`: Reads client filter from `?client=<id>`, keeps filter selection synchronized with URL changes, and provides a visible scoped-client banner and clear action. Existing order table, detailed drawer, status/zone/campaign filters, and CRUD stay in place.

## Navigation
- Clients → Work orders: one click using each client's shortcut.
- Clients → Client detail → Work orders: two clicks.
- Work Orders → existing order drawer: click a work-order row.
- A client-scoped Work Orders URL is bookmarkable and can be refreshed. Filtering is client-ID based and still uses the existing organization's order query and backend policies.

## Deleted files / database
- None. No SQL/migrations. No dependencies. No schema or data modifications.

## Validation
- Source patch and paths packaged only; ZIP integrity checked.
- `npm ci` did not finish (tool transport timeout in this environment).
- `npm run typecheck` blocked by incomplete `node_modules` (missing React/Babel and other @types), not reported as passed.
- Vite production build, lint, mobile browsers and real Supabase CRUD require local verification before deployment.

## Verify before deployment
1. Client list: use Work orders shortcut; only selected client's orders appear.
2. Client detail: no duplicate order table; View client work orders opens canonical Work Orders screen.
3. Filter drawer: client preselected; changing it changes `?client=`; clearing it removes query param.
4. Refresh and browser Back/Forward restore correct client scope.
5. Open an order; existing drawer/edit/line items/shops still work; close/reopen.
6. Test clients with 0 orders, many orders, and inactive clients; confirm pagination and no cross-client leakage.
7. Test direct URLs for a different organization with non-owner accounts and verify Supabase RLS.
8. Run `npm ci`, `npm run typecheck`, `npm run lint`, `npm run build`.
