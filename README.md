# AdRoute — Work Order billing, safe invoice actions, historical cleanup

## Exact scope

**Only BillingPage, existing poBilling helper, regression scripts and isolated SQL/PowerShell instructions are included.** Nothing changes Reports, routes, nav, breadcrumbs, other CRUD screens, shops or installation stages. All UI copy is English.

Billing screen changes: compact searchable/filtered invoice list with Client, Work Order, Payment and Period visible, page-size selector, concise Work Order context, small New invoice button, view/PDF actions, More menu, and a typed invoice-number confirmation. No shop-name itemization on customer invoices. Existing completed-work calculation, invoice editing and file/PDF generation retained.

## One invoice from completed Work Order scope

Select **New invoice** → select Work Order → auto-load all eligible completed and not-yet-invoiced work → verify PO line/qty or area/rates/GST and create. Optional internal shop scope is collapsed. Supply-only dispatch, accepted installations/direct installations and backfill final stages use the existing `poBilling.ts` helper. No arbitrary new calculations.

## Delete / Archive semantics

The normal row action is **Archive & remove**, under More, for agency owner/admin **unpaid** invoices only. Exact invoice number must be typed. The optional migration `supabase/migrations/20261026110000_0096_invoice_archive_delete_rpc.sql` creates a PostgreSQL function that atomically archives the invoice, line items and audit log, then removes the invoice from active Billing. Paid, partial and overdue invoices cannot use this action. SQL privileges are enforced on the server. This is not the same as a credit note or legal cancellation of a real issued tax invoice.

The migration only creates objects. It does not automatically delete invoices. Run it via your controlled Supabase SQL migration workflow on **staging first**, then production after review.

## PowerShell historical cleanup

`RESET_OLD_BILLING.ps1` can preview, back up, archive and clear **all historical invoices in ONE identified agency** after explicit confirmation. Requires `psql`, `pg_dump` and `pg_restore` from PostgreSQL client tools. Inputs: database host, port, database user and agency UUID from **Supabase → Connect**. Password entered interactively and never stored in this project. It creates a **full custom-format database backup**, lists its contents and requires you to type the exact confirmation text AND agency UUID. The SQL archives all affected invoice headers and lines in a private schema and removes only those from the active invoice tables. The script NEVER drops shops, POs, work items or evidence.

**An SQL archive and backup file do not automatically satisfy tax-law requirements.** Do not run the cleanup on legally issued/paid GST invoices without accounting approval, retention checks, separate securely stored backup, and a successful restore test on staging. The backup can include sensitive data: store it encrypted and restricted.

Commands (Windows PowerShell, after `main` code and migration are tested):

```powershell
cd D:\DarshanAdField
# Ensure PostgreSQL command-line tools are on PATH:
Get-Command psql, pg_dump, pg_restore
# Use actual values from Supabase dashboard -> Connect. Do not paste password into commands.
.\RESET_OLD_BILLING.ps1 -DbHost "<SUPABASE_DB_HOST>" -DbPort 5432 -DbUser "<SUPABASE_DB_USER>" -AgencyId "<ORGANIZATION_UUID>"
```

Default backup folder: `$HOME\AdRoute-Billing-Backups`. If connection is through transaction pooler, use the **session/direct** connection appropriate for pg_dump; verify your database connection options first. Run `supabase db reset` **never** for this task.

## Safe installation

Use this ZIP **after** `AdRoute_Billing_Final_Completed_Work_Main.zip` has been applied on a clean `main`. `APPLY_MAIN.ps1` compares exact SHA256 source hashes; it refuses to overwrite newer local changes, then writes backups into `.git`. No automatic SQL execution.

```powershell
$project="D:\DarshanAdField"
$zip="$HOME\Downloads\AdRoute_Billing_Safe_Actions_Main.zip"
$temp=Join-Path $env:TEMP "AdRoute-Billing-Safe"
Expand-Archive -LiteralPath $zip -DestinationPath $temp -Force
& "$temp\APPLY_MAIN.ps1" -ProjectRoot $project -PatchRoot $temp
cd $project
node scripts/verify-po-billing-final.mjs
node scripts/verify-billing-safe-ui.mjs
npm run typecheck
npm run lint --if-present
npm run build
```

Run GUI and staging tests before Git commit. On clean `main`, stage **only** the listed files and `git push origin main`; no force push is needed.

## QA limitations

Static regression checks and TSX parser checks do not substitute for live Supabase row-level permission tests or actual invoice posting. The existing multi-request invoice **create/edit** path is not a database transaction and requires staging validation before using it for legally issued tax invoices. This patch makes deletion archival/atomic; creation concurrency remains a separate known limitation. No database reset has been executed by this package.
