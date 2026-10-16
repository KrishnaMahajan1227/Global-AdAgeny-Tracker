# AdRoute — PO Billing Staging QA

## Validation before main push

- [ ] `git branch --show-current` = main, clean baseline before applying
- [ ] `node scripts/verify-po-billing.mjs` passes all 17 arithmetic checks
- [ ] `npm run typecheck`, `npm run lint`, `npm run build` all pass
- [ ] No console errors in Billing or Work Orders

## PO-first invoice UI

- [ ] Select a Work Order directly (client auto-populates), with no required second Client click
- [ ] Completed and unbilled shops auto-include; expand scope for a subset
- [ ] One displayed invoice row per PO item (not one invoice per shop)
- [ ] PO line shows planned, completed, previously invoiced, current invoice and rate
- [ ] Printed PDF and View Invoice group by PO line; no new invoice description includes shop names
- [ ] Every stored invoice_items row retains shop_id, work_item_id and po_line_item_id links
- [ ] Existing invoice PDF, payment status and historical data stay unchanged

## Data and security

- [ ] Survey + Installation uses installed area/qty; not approved quantities
- [ ] Supply Only uses produced quantities; sqft uses approved area ratio when needed
- [ ] Non-completed shops never included
- [ ] Previously billed item quantity deducted; repeat does not bill it again
- [ ] Invoice-linked legacy items with no work_item_id block re-billing pending reconciliation
- [ ] Owner/Admin creation works; field/client roles cannot create or query restricted money data
- [ ] Verify GSTIN, HSN/SAC, intra/inter state GST, PO terms and tax invoice numbering
- [ ] Verify actual invoice number is unique/serial and issued PDF is compliant
- [ ] Marking invoice paid no longer offers client-side Delete action
- [ ] No shop is moved into `billed` status by invoice creation
- [ ] Test two concurrent invoice posts to the same PO and network failure / resume: current frontend precheck is not a transaction; **do not release for concurrent posting without server-side atomic enforcement**

## Historical billing cleanup

- [ ] Back up invoice and invoice_item tables with external immutable records
- [ ] Review `BILLING_RECORDS_AUDIT.sql` counts, paid statuses, linked items and invoice numbers
- [ ] Accountant confirms statutory retention and test-vs-issued status; no historical deletion is included or automatic
