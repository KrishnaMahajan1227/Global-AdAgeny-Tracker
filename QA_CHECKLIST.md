# Staging QA — Billing

- [ ] `main` has expected Billing source SHA before ZIP applied (script stops on mismatch)
- [ ] `npm run typecheck`, `npm run lint --if-present`, `npm run build` pass locally
- [ ] Owner/admin can create one invoice for completed PO scope, correct PO rate & GST
- [ ] Supply Only dispatched, Survey+Install installed, Direct Install installed and final backfill recognized
- [ ] Incomplete/awaiting-review shops excluded; unknown measurements flagged
- [ ] Prior invoiced units subtracted; billed scope not silently counted twice
- [ ] Large list pagination, search, Client/PO, Payment, Period, Sort and clear filters work
- [ ] Desktop/tablet/mobile actions and More menu do not clip
- [ ] Non-owner roles cannot invoke invoice deletion RPC even if URL/code manipulated
- [ ] Unpaid invoice requires exact typed number; single RPC archives header, lines and audit
- [ ] Paid, partial, overdue invoices blocked server-side
- [ ] No invoice removed if permissions, confirmation, or RPC fail
- [ ] SQL audit archive accessible only to privileged database administrators
- [ ] External backup succeeds and restore verified on isolated staging database
- [ ] Old invoices preview count/amount match before organization-scoped archive/clear
- [ ] Only chosen organization invoice rows removed; unaffected agency invoices intact
- [ ] Work Orders, shops, area, evidence, breadcrumb, Reports, field assignments unchanged
- [ ] Existing invoice PDF, invoice edit, payment update, new invoice posting behave as before
