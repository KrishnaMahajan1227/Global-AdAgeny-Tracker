# QA – Design Review guided multi-shop, per-board artwork (v12)

## Targeted suites run

- `node scripts/verify-design-review-v11.cjs`: 39 PASS
- `node scripts/verify-design-review-v12-multishop.cjs`: 33 PASS
- `node scripts/verify-production-v11-sizefirst.cjs`: 37 PASS
- `node scripts/verify-production-v12-workflow.cjs`: 36 PASS
- `node scripts/verify-production-v13-fast-worksets.cjs`: 24 PASS
- `node scripts/verify-designer-marking-upload-v8.cjs`: 35 PASS
- `node scripts/verify-designer-size-first-v10.cjs`: 28 PASS
- `node scripts/verify-po-line-items-runtime.cjs`: 10 PASS
- `node scripts/verify-shop-bulk-mapping.cjs`: 30 PASS
- `node scripts/check-syntax.cjs`: parsed 130 files, 0 errors
- `node scripts/verify-security-release.cjs`: 27 PASS, 0 FAIL
- Additional review, handoff, reporting, security suites passed (20/25 selected scripts overall).

## Existing source-pattern checks that fail on BOTH release v11 and this update

- `verify-designer-fastflow-v9.cjs`: assumes old, narrower statuses in action guard.
- `verify-design-production-oneclick.cjs`: expects old `selectedItemIds` state source pattern.
- `verify-design-production-dispatch-v5.cjs`: expects older 100-row page size pattern.
- `verify-design-production-workbench-v7.cjs`: expects retired literal 'Incomplete board coverage — save draft first'.
- `verify-taskfirst-design-production-dispatch.cjs`: expects old KPI shortcut source pattern.

Compared against prior `AdRoute_Design_Review_OneStep_Full_Updated_Project.zip` with the **same failures**. These are NOT proof that whole-system QA passed. They require a separate test-maintenance audit.

## Environment blockers

`npm run build` → `vite: not found`; `npm run typecheck` → missing `@types/*` libraries. The container's npm dependencies are incomplete. No real Supabase, mobile camera, RLS or browser E2E tests were run. Syntax/source and mocked runtime tests are not a substitute for staging validation.

## Migration integrity

0119 must precede 0120. The new migration changes schema/function only and does not delete shop data. It does not claim historical approvals have been reprocessed. Validate signed-off evidence and correct linked database before executing the push.
