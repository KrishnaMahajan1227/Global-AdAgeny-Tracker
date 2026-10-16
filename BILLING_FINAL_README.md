# AdRoute — Completed Work Order billing + historical invoice reset

## Exactly what changes

- `src/pages/BillingPage.tsx`: PO-first data query, reliable direct PO rates, full pagination, completion-stage filter and legacy backfill linkage discovery; auto-select billable completed work; revalidation at posting time. No changes to other page, nav, breadcrumbs or reports.
- `src/lib/poBilling.ts`: one completion rule and one allocation calculation. Reconciles prior billed units, PO units, final stage, and uniquely identifiable legacy work item links.
- `scripts/verify-po-billing-final.mjs`: 26 pure regression cases.
- `supabase/manual/BILLING_RESET_PREVIEW_READ_ONLY.sql`: count and summarize previous invoices and invoice items.
- `supabase/manual/ARCHIVE_AND_CLEAR_OLD_BILLING.sql`: MANUAL, guarded transaction. Archives the selected agency's old billing records outside public schema and removes their active rows after explicit confirmation. Does not change shops/POs/work items.
- `supabase/manual/BACKFILL_FINAL_STAGE_RECONCILIATION_READ_ONLY.sql`: lists finalized shops whose stage quantities were not recorded. Data should be corrected at the source, not fabricated.

## Completion criteria

- Supply Only: final **dispatched**; production_done is not final because dispatch is pending.
- Survey + Installation and Direct Installation: final **installed** after accepted installation. Being surveyed, approved, produced, dispatched, or awaiting review is not final.
- Historical **billed** shop status is recognized as a terminal legacy state without changing the actual shop status.
- Backfilled records follow the same stage criteria. A backfill without recorded final stage is not silently treated as complete.
- Excluded work items do not generate billable units.
- Work items with status `installed` and missing installed measurement can use their recorded *approved* measurement if their shop is finalized. This narrowly covers historical work-item backfill; pending items do not get that fallback.
- Supply-only square footage = approved area × produced qty ÷ approved qty (when all supporting values are present). Installation square footage uses installed area. Piece-based PO lines use produced/installed quantity.
- Previous invoice line items linked to the work item are deducted. Ambiguous historical allocations block another invoice until reconciliation.
- Missing rates, missing work/PO linkage, and missing completed values are reported instead of inventing amounts.

## Why old data was not automatically wiped

The user requested clearing all older invoices. That is possible through the included manual SQL, **not by opening the app or extracting ZIP**. It is deliberately separate to prevent wiping the wrong agency or erasing paid GST invoices without an off-platform backup and accountant review.

Run the **preview** in Supabase SQL Editor, export a full database backup, reconcile paid/issued tax invoices and legally required records, then inspect the archive-reset SQL. It requires an explicit organization UUID and exact acknowledgement text; it runs inside a PostgreSQL transaction, preserving a private archive. Its backups are not the same as an external verified backup. Post-reset verify invoice and invoice-item counts and keep the private archive protected.

Do **not** use `supabase db reset`, `TRUNCATE`, or any full operational data reset. No SQL is invoked by `APPLY_MAIN.ps1`. SQL Editor can execute as privileged Postgres; never paste arbitrary SQL into an exposed client.

## Known financial boundary

The existing invoice-posting flow uses multiple Supabase requests (create header then invoice items). It is **not** a single atomic database function, so truly concurrent invoicing can still race. The new code re-fetches finished work and current PO rates just before posting, but a complete production-grade solution requires a single server-side transaction with a PO-level lock and a tax invoice numbering policy. Do not post two invoices for the same Work Order concurrently in production.

## Installation

1. Confirm the prior `AdRoute_WorkOrder_First_Billing_Main_PATCH.zip` is already applied and committed on your local `main`.
2. Start with a clean working tree, then extract this ZIP into an empty temporary directory.
3. In PowerShell: `& "<EXTRACTED_DIR>\APPLY_MAIN.ps1" -ProjectRoot "D:\DarshanAdField" -PatchRoot "<EXTRACTED_DIR>"`.
4. In project root: `node scripts/verify-po-billing-final.mjs`, `npm run typecheck`, `npm run lint --if-present`, `npm run build`.
5. Manually test Supply Only dispatch, installed Survey + Install, Direct Install, backfill and invoice history with real staging data.
6. Git Bash on `main`: stage only the 2 source files, test script, manual SQL and notes; commit and `git push origin main` after QA. No force push or pull needed.

No dependency or schema migrations required for the source update. The manual reset is destructive and separate.
