# AdRoute — Reports & Consolidated Billing (main branch)

## Source files changed

- `src/lib/reportPortfolio.ts` — A4 **portrait** evidence PDFs with original photographs fitted into wide, borderless slots; linked dimensions below each photo; non-linked work items shown once; PPT image borders removed; Excel marked previews + clickable full-resolution source photo links.
- `src/pages/ReportsPage.tsx` — Main Client, Work Order, Zone and Date filters visible in a compact row; removed duplicate filter controls from advanced drawer. Existing export formats and legacy generators untouched.
- `src/pages/BillingPage.tsx` — One manual consolidated invoice for **selected completed shops belonging to one Work Order**. Uses pre-existing `invoice_items.shop_id/work_item_id`, automatically drafts individual shop work items and PO rates, checks for previously billed shops, and updates only selected shop statuses. Removes unsafe client-wide `billed` update. Adds Client/Work Order/Payment/Date filters, safer edit scope, and smaller create/list controls.
- `scripts/verify-report-billing.mjs` — parser and regression checks.

## Files NOT changed

`src/components/AdminLayout.tsx`, `src/App.tsx`, sidebar, breadcrumbs, Survey Review, Installer/Surveyor, Shop CRUD, invoice PDF generator, financial RLS and all existing Supabase tables/migrations.

## Dependencies and database

No new dependency and **no SQL migration**. Uses existing `jspdf`, `exceljs`, `pptxgenjs` and existing `invoice_items.shop_id`/`work_item_id` fields.

## Important constraints

- The Billing screen now requires selecting a Work Order and a subset of **installed/dispatched** shops when creating a new invoice. Existing invoices retain their historical structure, edit, payment status and PDF download.
- Amounts are a **draft** based on current physical work and mapped PO line-item rates; owner must verify rates, quantities and GST. No auto-billing in the background.
- The new invoice and invoice lines are written through the existing Supabase API. They are **not wrapped in a single server-side transaction**: if a later status update fails, the UI explicitly displays the invoice number for manual reconciliation. Do not click Create again.
- Existing historical invoices that were created before shop-level linking cannot be automatically matched to individual shops. Historic `billed` statuses are not modified or inferred.
- Image hyperlinks in Excel point to the source image, which may require authentication; the **marked composition is embedded** in the workbook.
- A report with only one photo necessarily has one image on its page; two-photo pages are used when space and evidence allow. Long linked descriptions flow onto subsequent portrait pages, never intentionally clipped.

## Source compatibility

Apply to existing clean `main` with the previous **Reports Image Quality** patch installed. The installer checks all source hashes and refuses to overwrite an unrecognized file. Review `QA_CHECKLIST.md` before production deployment.
