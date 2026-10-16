# Billing QA — manual acceptance checklist

- [ ] Owner/admin opens Billing; all 3 Work Order types appear with correct client/name/number.
- [ ] Supply Only: production_done shops NOT ready; dispatched shops eligible, produced units and per-sqft proportions correct.
- [ ] Survey + Installation: installation_review NOT eligible; installed shops and quantities available.
- [ ] Direct Installation: installed final shops available; approved-only records NOT billable.
- [ ] Legacy backfill with installed item status and approved measurement produces an explainable billable quantity.
- [ ] Backfilled PO-linked work with missing shop purchase_order_id is discovered only for correct client/PO.
- [ ] Missing measurements, PO line rate, ambiguous invoice allocations produce visible errors (not zero success).
- [ ] PO has more than 1,000 linked work items/shops; no silent truncation.
- [ ] Billing summary groups PO line items, NOT customer-facing shop names.
- [ ] Previously billed work is deducted and cannot be double-invoiced.
- [ ] GST type, GSTIN, HSN, taxable amount, invoice sequence, dates and payment terms verified.
- [ ] Save uses only selected eligible completed work, rechecks fresh rates & amounts, and never changes shop operational status.
- [ ] Old invoice preview performed with actual organization UUID; separate backup verified.
- [ ] Manual archive/clear SQL tested on staging and counts reconciled; existing POs/shops/evidence unchanged.
- [ ] PDF invoice accurately matches grouped totals and linked quantity/area.
- [ ] Build, lint, typecheck pass on current main; browser/mobile tests pass.
- [ ] Realtime refresh and direct URL role/RLS checks pass.

NOT VERIFIED in this environment: live Supabase SQL execution, full Vite build, concurrent server posting and real invoice PDF review.
