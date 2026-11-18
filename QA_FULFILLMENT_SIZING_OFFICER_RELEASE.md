# Release QA — Fulfillment-aware size entry, artwork, Officer labels, and scale

## Test coverage

**Executed in source workspace:**

- `scripts/verify-fulfillment-sizes-officers.cjs`: 18 passed (scope, validation, size gating, dedupe, selected fulfillment stages, large-query paging/lazy photo fetching, officer aliases, SQL safety, report mapping).
- `scripts/verify-shop-bulk-mapping.cjs`: 30 passed (including >500 row payload and actual mocked agency/client mutation paths).
- `scripts/verify-flexible-shops-geotag.cjs`: 20 checks + 2 canvas cases passed (Officer rename in canonical template, legacy header acceptance, custom columns, geotag stamping).
- `scripts/verify-po-line-items-runtime.cjs`: 10 passed.
- `scripts/verify-designer-size-first-v10.cjs`: 28 passed.
- `scripts/verify-production-v11-sizefirst.cjs`: 35 passed.
- `scripts/verify-phase1-fulfillment.cjs`: 16 passed.
- `scripts/verify-phase4-fulfillment.cjs`: 19 passed.
- `scripts/verify-reports-evidence.mjs`: 16 passed.
- `scripts/verify-security-release.cjs`: 27 passed.
- `scripts/check-syntax.cjs`: 129 TS/TSX source files parsed successfully.

Prior baseline also passed phase3 handoffs and task-first design/production tests, but these were not independently completed again after this patch. These checks are NOT browser or database E2E verification.

## Gaps / limitations

- Full `npm ci`, `npm run typecheck`, and `npm run build` could not run successfully in the sandbox. Global TypeScript typecheck fails early because the partial npm installation is missing type-definition packages, e.g. React and Node.
- Migration `0118` reviewed at source level, **not** applied to hosted Supabase. RLS, row locks, trigger interactions and actual multi-user races require staging checks.
- Single- vs multiple-file artwork and shop mapping was checked using static / mocked suites and existing architecture, not real authenticated designer-to-production browser E2E.
- Real browser/mobile photo previews, print-perfect PDF/PPT reports, and 5000-shop latency benchmarks have not been measured; no hard performance SLA is claimed.
- Historical broad `verify:release` suite still contains Campaign/deployment source assertion failures from previous baseline.

## Required release acceptance steps

1. Backup **current remote database** and Vercel environment settings; work with a linked **staging** Supabase project first.
2. Use the correct CLI target; v3 defaults to local: `npx supabase migration list --remote`, then `npx supabase db push --remote --dry-run`, then `npx supabase db push --remote`. See main README for v2 compatibility.
3. `npm ci`, `npm run typecheck`, `npm run build` and `npm run verify:security` on clean developer machine.
4. Check Production & Installation PO: 2 shops × 2 line items. Owner/Admin enters one 4×6 sqft board; one piece-only board Qty 3. Confirm no duplicate placeholders, no generated survey rows.
5. Assigned Designer uploads 2 files to 2 boards and 1 file covering multiple approved boards; verify exact `design_version_items` mappings in DB, preview, review, production dispatch and shop details, and correct status transitions.
6. Test Survey & Installation (survey gating unchanged), Production & Delivery (no required installer), On-site Execution (field photo/GPS site creation), and custom workflow gating.
7. Verify Agency/Client report export PDF/PPT/Excel (multi-page text and photos), Officer columns, FMM/FSM Name additional columns, and full shop counts above 1000 in Client PO detail.
8. Deploy staging frontend only after successful migration, then production following acceptance.
