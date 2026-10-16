# PO Billing Update — exact changes

Changed:
- `src/pages/BillingPage.tsx`: PO-first invoice creation, internal completed shop scope, automatic unbilled work allocation, one-line-per-PO-type invoice display, safe GST issue confirmation, separate operating/billing status

Added:
- `src/lib/poBilling.ts`: canonical completed-vs-billed calculations, PO line aggregation, legacy safety checks
- `scripts/verify-po-billing.mjs`: 17 deterministic calculation regressions
- `APPLY_MAIN.ps1`: gated main-only install and source backup
- `BILLING_RECORDS_AUDIT.sql`: read-only inventory of legacy billing records
- `BILLING_PO_UPDATE_README.md`: workflow/financial limitations
- `QA_CHECKLIST.md`: manual validation checklist

Removed: None.
Dependencies: None.
Database migration: None.
Historical invoice deletion: **Not performed; requires lawful retention/audit/backup review.**
Source installation is based on one of the two audited BillingPage blobs detailed in README. Other pages are not modified.
