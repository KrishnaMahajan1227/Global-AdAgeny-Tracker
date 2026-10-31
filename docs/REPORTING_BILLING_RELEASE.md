# AdRoute – navigation, billing and exports release
**Source revision:** 31 October 2026. **Base:** 31 October security-hardened AdRoute source. **Deployment state:** NOT RELEASE-CERTIFIED.

This archive contains source changes and a new additive PostgreSQL migration. It is **not** proof that the deployed Supabase database has been migrated or that PDF/PPT/Excel output renders correctly on every browser/printer. Existing tables, invoices, payments, photos and migrations are retained; no live DB was modified.

## Files changed in this release

- `src/components/AdminLayout.tsx` – remove demo's misleading Production navigation, filter stale recent-page links against permitted nav.
- `src/pages/BillingPage.tsx` – atomic RPC-based create/revise, server-checked payment status, hide create/edit actions from viewer roles, guard crafted `?create=1` links, lock paid/partial invoices for editing, confirm payment transitions.
- `src/pages/ReportsPage.tsx` – consistent evidence-aware PDF/PPT/XLSX formats; pagination for invoices; real full tax invoice PDF instead of a generic list; scoped options/errors.
- `src/lib/reportPortfolio.ts` – duplicate-free shop/work/photo/proof/mark records, full marked photo evidence in spreadsheet/PDF/decks, no expiring private document links, safe hyperlink protocol and spreadsheet text, actual PO Utilization view fields, before-after installation evidence.
- `src/lib/reports.ts` – client site detailed Excel workbook includes marked photos; PDF includes both survey/installation and correct two-column pagination; old report paths group each survey photo once with all available marked boards, fail clearly on unreadable evidence.
- `src/pages/client/ClientReportsPage.tsx` – load linked markings from authorized client records; export fully embedded site photos, with real error reporting.
- `src/lib/reportImage.ts` – isolate raw decrypted photo cache by authenticated user and clear it on identity switch.
- `src/lib/secureMedia.tsx` – helper identifies private Supabase URLs (prior auth compatibility preserved).
- `supabase/migrations/20261031133000_0114_atomic_invoice_posting.sql` – NEW: atomic invoice RPC and audited payment status RPC, work-item allocation/PO rate verification, tenant-identity checks, PO transaction locking, no raw authenticated invoice writes.
- `scripts/verify-reporting-billing-release.cjs` – deterministic unit/source contract checks; `scripts/verify-reports-evidence.mjs` updated for secure media import; `docs/EXISTING_REGRESSION_RUNS.json` captures regression results.

## Important invoice behavior / compatibility

1. `billing_save_invoice` is SECURITY DEFINER, only for active `agency_owner`, `admin`, `accounts` users. It locks the selected PO, validates the client/tenant/project, work item/shop/PO line, completion stage and remaining quantity, computes totals and inserts header and lines in one DB transaction. If any check fails, **no invoice is created**.
2. Original invoices remain unchanged. Paid/partial invoices cannot be edited as unpaid invoices. Previous invoices with ambiguous legacy item links are intentionally blocked from automatic revision or double billing until reconciled.
3. Invoice payment statuses are audit-logged. Paid cannot be reverted via dropdown. This workflow **does not implement a full ledger, credit notes, refunds or payment transaction reconciliation**; those require separate accounting decisions.
4. Client Manager and Demo may only view billing as allowed by existing route/RLS; creating an invoice via a button or crafted URL is disabled in React **and** rejected by database RPC.
5. Direct authenticated invoice header/line writes are denied via restrictive RLS. Existing historical migrations must stay applied. Deploy **migration and frontend together**; deploying the frontend first leaves invoice posting unavailable, and applying the migration while the old frontend is still posting invoices may block old flows.
6. `billing_archive_delete_invoice` from an earlier migration is not removed. Verify its business authorization in staging and that its definer owner can still update/delete records.
7. Unit/rate authority: current PO rate; capped against recorded billable completed quantity, previously invoiced quantities. Legacy work items without a unique matching PO line fail closed pending reconciliation. More complex partial-unit, custom-stage and cross-tenant historical cases need real DB testing.

## Deployment instructions – backup and staging first

1. Preserve the current production archive/build and capture a verified Supabase DB backup. Verify a restore before using any new migration.
2. Create a separate staging environment with **representative anonymized** data and the real existing migration history (0105 through 0113 included). Never rerun seed credentials in production.
3. Run `npm ci` in an environment with registry access. Then run `npm run build` and the project typecheck/lint/test scripts. Resolve any dependency/vulnerability errors before signing off.
4. On **staging**, review/apply only unapplied migrations in timestamp order, including `20261031133000_0114_atomic_invoice_posting.sql`. Validate invoice RPC creation, revision, archive and status changes for each role using authenticated Supabase calls.
5. Deploy frontend against staging; check direct URLs, photos from private Storage, role navigation, invoice creation, PDFs, Excel and PowerPoints with real field images; inspect output pages/slides/cells visually.
6. Validate with two distinct agencies, two designer/printing assignments, client_admin/viewer, Accounts, inactive users, and Demo. Check direct API as well as UI; no client-side guard alone is a security boundary.
7. Validate export with 0, 1, 2, 50 sites; no/multiple markings, long addresses, portrait/landscape images, expired signed URLs and missing evidence. A PDF with >40 client sites intentionally fails with a clear filter instruction rather than silently truncating.
8. Review known legacy `xlsx@0.18.5` dependency (in file-import paths) with a supported secure replacement. This release uses ExcelJS for the new report writer but **does not remove that vulnerable dependency**.
9. Confirm real build, all E2E cases, recovery procedures and backup; then coordinate the DB migration and UI switch in a maintenance window. If a migration fails, restore from backup; do not edit already-applied migration history.

## Offline evidence – what actually ran

- `node scripts/check-syntax.cjs`: **127 TypeScript/TSX files parsed, 0 syntax errors**. This is not typechecking.
- `node scripts/verify-reporting-billing-release.cjs`: **40 PASS, 0 FAIL** (pure buildSections fixture plus source-contract checks).
- Actual offline PPTX smoke generation with `pptxgenjs` and **synthetic sample images**: **PASS**, 2 slides, 2 images embedded, PPTX ZIP integrity valid. This does not verify authenticated images or live rendering.
- `node scripts/verify-reports-evidence.mjs`: **16 assertions PASS** (source/fixture grouping); image downloads/real rendering not tested.
- `node scripts/verify-security-release.cjs`: **27 PASS** source checks.
- `node scripts/verify-phase7-security.cjs`: **16 PASS** source checks.
- `node scripts/verify-owner-dashboard-demo.cjs`: **10 PASS** source checks.
- Other existing `verify-*` scripts: **37 PASS, 16 FAIL** from 53 runs. See `docs/EXISTING_REGRESSION_RUNS.json` for exact errors. A number of failures are missing `typescript`/`exceljs`, obsolete snapshots, or tests requiring a built/live site; they **were not waived**. The regression suite was not all green.
- `npm ci --offline`: **FAILED (ENOTCACHED: zip-stream-4.1.1)**. This environment has no registry/package cache.
- `npm run build`: **FAILED (`vite: not found`)** because dependencies were not installed.
- PostgreSQL migration execution, real role login, direct API request, browser UI testing and PDF/Excel/PPT output-file generation: **NOT RUN** (no Supabase staging credentials and unavailable frontend package install).

## Staging acceptance cases (manual, must run before production)

| ID | Action / role | Expected |
|---|---|---|
| NAV01 | Demo opens sidebar, tries `/production` directly | No Production menu; route denies entry |
| NAV02 | Designer/Printing tests Owner/Billing URL | UI protected; API RLS denies sensitive data |
| NAV03 | Client Viewer types another client's report URL | No unauthorized client/site evidence |
| NAV04 | Recent nav after changing user role | No stale or unauthorized links |
| BILL01 | Accounts creates invoice for completed single-shop PO | 1 invoice, exact line allocation, tax and correct PDF |
| BILL02 | Accounts creates invoice for multi-shop PO | All selected unique lines, consistent subtotal and GST |
| BILL03 | 2 sessions post same completed work simultaneously | Only valid remaining allocation posted, no duplicates |
| BILL04 | Interrupted network during posting | Either full invoice with all lines or no invoice |
| BILL05 | Attempt bill unfinished/excluded/cancelled work item | RPC refuses without changing DB |
| BILL06 | Work item from another org or altered rate/PO line | RPC refuses without data disclosure |
| BILL07 | Client Manager or Demo constructs invoice posting REST request | Permission denied |
| BILL08 | Revise an unpaid invoice | Single transaction, preserved ID/number, audit entry |
| BILL09 | Revise paid/partially paid invoice | Permission refused; original immutable |
| BILL10 | Change paid -> unpaid via direct API | Refused; reconciliation required |
| BILL11 | invoice PDF with CGST/SGST and IGST examples | Correct layout, tax amounts, bill-to snapshot, multipage pagination |
| REP01 | Survey: 2+ board markings on 1 original photo | 1 image with all polygons/labels |
| REP02 | Many survey + installation photos | Every unique photo appears, correct captions and ordering |
| REP03 | Before/after PPT | Both survey and installation evidence present across slides |
| REP04 | PDF long item descriptions/site addresses | No clipped data; page breaks preserve grouping |
| REP05 | XLSX image worksheet | Images embedded and visible after reopening offline |
| REP06 | Private photos and expired signed URL | Authorized exporter succeeds; unauthenticated access denied |
| REP07 | Missing/forbidden photo | Clear failure; no false success or silent dropped evidence |
| REP08 | Source repeats the same proof row | Once in output, not duplicated |
| REP09 | PO utilization sample figures vs DB | Budget, produced, installed, invoiced and variance match SQL |
| REP10 | Large export >40 client sites PDF | Clear limit error; no partial "complete" PDF |
| REP11 | Other user's cached photo after signout/signin | Not reused; access revalidated |

**Approval gate:** NO-GO for production until clean build, DB staging transactions, client-rendered PDF/PPTX/XLSX output inspections, full security/role E2E and all critical regression failures are resolved.
