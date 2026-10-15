# AdRoute Work Orders — targeted refinement

## Modified files
- `src/pages/PurchaseOrdersPage.tsx`: compact operational counters, clearer order lookup, keyboard-accessible existing order rows, loading/error/retry states, readable responsive drawer layout; removed redundant Campaign column from the order list while preserving underlying relationships, filter controls and CRUD.

## Unchanged
- No schema, migrations, payment, client, shop, campaign records, API or permissions changes.
- Existing create/edit/delete, line-item management, shop links and client-request acceptance are preserved in place.

## Verification
- TypeScript transpile-module parse diagnostics: 0.
- Full `npm run build`: blocked in provided environment (`vite: not found`). Must pass in the user's project before deployment.
- Live Supabase interactions / cross-role browser tests: not performed.

## Deployment
1. Back up project and verify clean Git tree.
2. Extract archive into project root, overwriting the one modified source file.
3. Run `npm ci`, `npm run typecheck`, `npm run lint`, `npm run build`.
4. Smoke-test all existing work-order actions before push. No SQL is required.
