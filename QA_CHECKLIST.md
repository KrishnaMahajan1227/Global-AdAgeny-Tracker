# Acceptance QA: do before production

- [ ] Run preflight & apply; verify both `verify-applied.cjs` and `verify-unified-progress.cjs` pass.
- [ ] Verify 96 installed of 144 for 7D Standee = 67% final-stage shop completion (assuming these are all linked and others pending).
- [ ] Ensure 0 measured piece count is shown **separately** and flagged for reconciliation where no item data recorded. Do not show an invented 96/1,000 pieces.
- [ ] Dashboard Client delivery and Clients row show non-zero partial progress; final-stage sites not confused with partially installed sites.
- [ ] Work Order desktop and mobile list shows shop progression, no 0% when installed shops exist.
- [ ] Work Order detail opens **in center** on desktop and mobile; Edit, PO line items, View Shops, Delete/More, and Accept/Reject still work.
- [ ] Supply Only dispatched counts completed; Survey + Install dispatched does not; Direct Install installed counts completed.
- [ ] Cancelled/rejected shops excluded and do not inflate counts.
- [ ] Changing one shop status causes the detail/clients/dashboard figures to refresh without relogin (up to 20 s fallback).
- [ ] Client portal and role-limited routes still protected; no cross-org status leakage.
- [ ] Invoices and Billing retain recorded actual PO quantity/rate calculations; no derived billing from shop count.
- [ ] Browser navigation, breadcrumbs, sidebar, Reports, Surveyor, Installer, marked photos unchanged.
- [ ] Verify git commit pushed to remote **main**, verify Vercel deployed that exact commit, hard refresh PWA/browser cache.
