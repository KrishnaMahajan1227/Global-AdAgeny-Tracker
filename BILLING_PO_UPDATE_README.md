# AdRoute Billing — PO-first consolidation update

## Scope and baseline

Changes **only** `src/pages/BillingPage.tsx` and adds the pure calculation helper `src/lib/poBilling.ts` plus tests. The installer accepts one of two audited BillingPage baselines: upstream `main` blob `26a7ae2404061dd8bba1b969371fde5ea7fd73a2` or the prior consolidated Billing patch blob `cb12cb7142ad4d3d08631390155c671f2d8deea9`.

## New billing workflow

1. Open Billing → Create invoice.
2. Select Work Order once. Client, billing address, GST rate from PO and payment terms auto-populate.
3. Completed and unbilled work items from that PO are auto-selected. Expand **Adjust completed shop scope** only when billing a subset.
4. Invoice summary groups results by canonical PO line item, showing PO scope, completed, previously billed, current invoice, rate, and amount. One confirmation issues one PO-level invoice; shop names do not become invoice descriptions.
5. Underlying `invoice_items` retain `shop_id` and `work_item_id` so follow-up invoice calculations subtract previously billed quantities/area. Work-item status remains `installed` / `dispatched` and is **not** overwritten with `billed`.

## Calculation and safety

- Quantity/area is driven by **actually completed** field work. Approved or budgeted scope is NOT treated as completed.
- Sq.ft rows use installed area; supply-only produced area uses approved area × produced quantity / approved quantity when both exist.
- Past invoiced quantity/area is subtracted per linked work item; overbilling or ambiguous legacy invoice allocations block the affected bill.
- PO rate and HSN/SAC are read from the PO line. Rates cannot silently be invented.
- GST split uses existing CGST/SGST or IGST calculation. **Verify place of supply**, organization GSTIN, HSN/SAC, rate and invoice numbering before using a live tax invoice.
- Current code rechecks completion and history before writing but it still uses the existing multi-request invoice write. **It is not a serializable database transaction**; do not post concurrent invoices for the same PO until server-side atomic posting is implemented.

## Historical billing cleanup

No automatic deletion or reset is included. Historical issued/paid GST invoices, linked invoice items and payment status must not be blindly erased. First run `BILLING_RECORDS_AUDIT.sql` (read-only), export an immutable backup, identify genuinely unissued demo/test rows, and have your accountant approve legally compliant cleanup or credit-note corrections.

CGST Act Section 36 generally requires relevant accounting records retained for 72 months from the annual-return due date (longer in specified proceedings): https://taxinformation.cbic.gov.in/content-page/explore-act/1000306/1000001

## Files

- `src/pages/BillingPage.tsx` — WO-first workflow, compact grouped invoice preview, scoped historical billing checks, safe confirmation
- `src/lib/poBilling.ts` — single PO billing calculation source
- `scripts/verify-po-billing.mjs` — pure 17-case arithmetic regression test
- `BILLING_RECORDS_AUDIT.sql` — read-only legacy billing inventory

## Required verification

- `node scripts/verify-po-billing.mjs`
- `npm ci && npm run typecheck && npm run lint && npm run build`
- Owner/admin roles: one PO, multiple completed shops, partial previous bills, missing PO rate and old invoice with no work-item links
- Supply-only produced vs installed units, survey+install status, GST and HSN/SAC, PDF totals and grouped display
- Concurrent posting, network retry, Supabase RLS and tax invoice sequence require live staging validation

No SQL migrations. No changes to sidebar, breadcrumbs, reports, other pages, database rows or historical invoices.
