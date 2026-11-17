# AdRoute — Work Order line-item crash fix

## Symptoms

The `/purchase-orders` route crashed with `isAreaUom2 is not a function` when
opening or entering Work Order line items. The Vite stack trace pointed at
`PurchaseOrdersPage.tsx` in a minified deployment bundle.

## Root cause and corrections

- `POLineItemsModal` declared a boolean `const isAreaUom = ...`, shadowing the
  imported `isAreaUom()` function from `src/lib/poUtilization.ts`. A later
  `isAreaUom(form.uom)` expression attempted to call that boolean. The boolean
  is now named `isAreaBasedLine`, and the imported helper remains callable.
- Add/Edit payloads continue to store **only one** budget column per line:
  `budgeted_area` for `sqft`; `budgeted_qty` for `piece` or `lot`; the other
  column is explicitly `null`.
- Saving is disabled for an empty description, non-positive/non-finite scope,
  or negative/non-finite rate. A zero rate remains valid when explicitly entered.
  The mutation independently rejects invalid form state if invoked directly.
- Changing UOM uses a functional state update and clears the irrelevant budget
  field to prevent leftover area/quantity being saved accidentally.
- Add/Edit success, as well as Delete success/failure, now refreshes the Work
  Order list, line items, PO utilization, execution reconciliation and billing
  item caches. This updates downstream totals without requiring a reload or
  waiting for real-time database notifications.

No SQL schema changes, destructive migrations, or existing-record rewrites are
needed for this frontend-only correction.

## Files changed

- `src/pages/PurchaseOrdersPage.tsx`
- `scripts/verify-po-line-items-runtime.cjs` (new runtime regression harness)
- `package.json` (adds `verify:po-line-items` and includes it in `verify:release`)
- `README_WORK_ORDER_LINE_ITEM_FIX.md` (this document)

## How to validate after installing dependencies

From the project root:

```bash
npm ci
npm run verify:po-line-items
npm run typecheck
npm run build
```

The dedicated runtime harness tests: modal render (previous error), sqft,
piece and lot insertion, UOM transitions, invalid inputs, editing, failed
insert, failed delete and successful delete, including the dependent queries.

## Deployment

1. **Back up** the current deployed source/branch and any unsaved user changes.
2. Merge or replace these **source** files in the *same* existing Vercel app.
   Keep the existing `.env`/Vercel environment variables and Supabase project
   settings. The ZIP intentionally omits local `.env` and `supabase/.temp` files.
3. On a machine/CI with npm access, run `npm ci`, the test, typecheck and build
   commands above. Deploy the resulting app through the normal Vercel workflow.
4. On the deployed `/purchase-orders` route, create, edit and remove one test
   line in each UOM, and verify its amount, linked PO totals and billing preview.
5. Confirm existing role permissions still apply (a UI validation check is not
   a substitute for Supabase RLS).

**Verification limits in the preparation environment:** The 10 dedicated
line-item runtime scenarios and repository syntax/JSX checks passed. A full
`npm ci` could not complete because the registry was unreachable. Consequently
full `tsc`/Vite builds and live authenticated Supabase/Vercel integration tests
were **not** certified here. Existing broader release-script failures unrelated
to this targeted fix remain and should be resolved before an unconditional
production-ready sign-off.
