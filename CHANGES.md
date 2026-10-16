# Billing-only changes against the previous Work Order First Billing patch

- `src/pages/BillingPage.tsx`: fixes completed-stage eligibility for each fulfillment type, PO rate reads, missing backfill linkage discovery, billable data preview and current-rate revalidation.
- `src/lib/poBilling.ts`: canonical per-stage completion and quantity/area calculation with narrow final-stage backfill fallback.
- `scripts/verify-po-billing-final.mjs`: expanded pure regression checks.
- `supabase/manual/BILLING_RESET_PREVIEW_READ_ONLY.sql`: preview historical invoices without mutation.
- `supabase/manual/ARCHIVE_AND_CLEAR_OLD_BILLING.sql`: optional manual archive and agency-specific active invoice removal; NOT automatically executed.
- `supabase/manual/BACKFILL_FINAL_STAGE_RECONCILIATION_READ_ONLY.sql`: audit incomplete old production/installation stage metrics.
- `BILLING_FINAL_README.md`, `QA_CHECKLIST.md`: apply and validation instructions.

No unrelated routes, sidebar, breadcrumbs, reports, photos, shops, review panels, migrations, dependencies or lockfiles modified.
