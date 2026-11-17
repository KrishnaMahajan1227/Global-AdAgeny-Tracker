# Work Order line items — QA evidence

## Verified locally (Nov 17, 2026)

| Check | Result |
| --- | --- |
| `npm run verify:po-line-items` (actual modal transpiled and rendered in a React-hook mock) | **PASS — 10 runtime scenarios** |
| `node scripts/check-syntax.cjs` | **PASS — 127 TS/TSX source files parse** |
| `node scripts/verify-runtime-jsx-symbols.cjs` | **PASS — 66 TSX files, no missing JSX names** |
| `npm run verify:security` on sanitized source (no `.env`) | **PASS — Phase 7 security/source checks** |
| `node scripts/verify-po-execution-reconciliation.cjs` | **PASS** |
| `node scripts/verify-workorders-supply.mjs` | **PASS — 13 checks** |
| `node scripts/verify-production-completion-fix.mjs` | **PASS** |
| `node scripts/verify-production-v11-sizefirst.cjs` | **PASS — 35 checks** |
| `node scripts/verify-production-v12-workflow.cjs` | **PASS — 36 checks** |
| `node scripts/verify-production-v13-fast-worksets.cjs` | **PASS — 24 checks** |
| `node scripts/verify-owner-dashboard-compact.cjs` | **PASS — 8 checks** |
| `node scripts/verify-billing-safe-ui.mjs` | **PASS — 19 checks** |
| `node scripts/verify-unified-progress.cjs` | **PASS — 14 checks** |

The 10 line-item scenarios cover modal rendering; insert for `sqft`, `piece`,
`lot`; UOM switching; numeric input constraints; edit with changed UOM;
failed insert; failed delete; and successful delete with dependent-cache
invalidation. The regression harness exercises the project's actual
`POLineItemsModal` function, though with mocked hooks and data services.

## Not certified / existing blockers

- `npm ci` cannot complete in this environment: npm registry is unreachable
  and required dependency tarballs are not in the local cache. `npm run
  typecheck`/`npm run build` could not be validated with installed
  dependencies. A normal CI/build machine must run both before deployment.
- The **existing** `npm run verify:release` checks unrelated to this fix have
  failed assertions about retired Campaign components and missing deployment
  verification artifacts. Those were present in the supplied project state.
- The **existing** `scripts/verify-supply-workflow.mjs` has one failing static
  check (`Supply only fetch and dispatch retained`).
- No real user session, live database writes/RLS, network execution, or Vercel
  deployment was performed. A staging smoke test remains mandatory.

No change to any Supabase migration is included in this patch. The ZIP omits
`.env`, Supabase CLI `.temp` connection files, and generated dependencies.
