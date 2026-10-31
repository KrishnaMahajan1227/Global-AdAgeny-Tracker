# Darshan Ad Agency — No Campaigns / streamlined Work Orders release
**Source release: 31 October 2026** | Based on the previous Production Completion Fix source package.

## Implemented

1. **Retired Campaign UI, preserved historical data.** Removed the agency Campaigns page and sidebar entry, client Campaigns overview/detail creation pages, client sidebar entry, Campaign filters from Shops/Reports/Work Orders, and retired campaign report labels. The unreferenced Agency Hierarchy page was removed. Existing `campaigns`, `projects`, `campaign_id`, and `project_id` database records remain unchanged. Old URLs redirect to Work Orders (including old client PO deep links). No `DROP TABLE`, destructive data migration, or historical record rewrite introduced.
2. **Client Organization: direct Work Orders.** Client Overview links to Work Orders, with search, status/agency filtering, pagination, order detail, and a direct `Create & Send to Agency` form (agency, PO number/date, scope items). New orders have `campaign_id: null`; agency acceptance still controls the handoff. `client_admin` can create; `client_viewer` gets a read-only list. Agency choice must correspond to an active link with an agency-side client record. Old PO details remain accessible.
3. **Owner/agency Work Orders and billing.** Removed retired Campaign selection in agency PO forms and Project selection in Billing form (historical references remain on edits / old invoices), and simplified Reports and Shops filters. Previous fulfillment/billing/approval operations are preserved.
4. **Design and Production:** optional folder navigation now follows **Client → Work Order → Zone**, one fewer click, with Action Queue always available. Existing linked-PO filters, bulk actions, design review, production quantity logs, and handoff RPC are maintained.
5. **Speed/accuracy:** client Work Order list uses server-side aggregate `client_shop_status_counts()` rather than downloading every shop for counts; client Work Order/progress lists fetch in pages, and client reports use paginated reads beyond PostgREST's default 1,000 records. Work Order list displays 100% **stage indicator** when status is completed without fabricating physical quantities. Shop Detail survey assignment checks its actual joined PO type (fixes an undefined variable bug). Public page wording now matches the Work Order product model.
6. **Prior production fix retained:** SQL migrations `0103` + `0104` and the prior completion-stage status, safety and historical board behavior; see `README_PRODUCTION_COMPLETION_FIX.md`.

## Verification performed OFFLINE

- `npm run verify:release` (or `node scripts/check-syntax.cjs`, `node scripts/verify-runtime-jsx-symbols.cjs`, `node scripts/verify-campaign-removal.cjs`, `node scripts/verify-production-completion-fix.mjs`).
- 122 TypeScript/TSX source files syntax parsed; 62 TSX component/JSX symbol checks; 21 explicit Campaign removal and workflow assertions; 7 prior production-completion checks.
- Workflow regression scripts for Design/Production/Dispatch V5, Task-first Design/Production/Dispatch and Owner role navigation re-baselined for the *intentional* direct-Work-Order flow and passed.
- An additional 47 legacy automated scripts exist in the package. Some require unavailable npm dependencies or assert older UI signatures; **not all pass** in this container. Refer to specific scripts rather than assuming a full regression pass.

**NOT performed / NOT verified:** End-to-end Playwright/browser tests, real role-by-role Supabase RLS tests, database migration execution, staging/live API flows, and complete Vite build. Dependencies were not installable in the build environment; the global TypeScript audit cannot resolve missing React/Vite/Supabase packages. No production database was contacted. The package is updated source code **not a certified production deployment**. Do not treat an offline green static check as a substitute for staging approval.

## Required deployment sequence

1. Back up the Supabase database, storage, auth configuration, and current deployed frontend. Check that the DB already contains migrations through `0102`; apply previous packaged `0103` then `0104` in staging **if not already applied**. This release adds no new SQL migration.
2. Run `npm ci` in a network-enabled CI environment. Run `npm run typecheck`, `npm run lint`, `npm run build`, and `npm run verify:release`. Address any *actual* dependency/type/lint build failures before deploying.
3. Test with staging accounts from **agency_owner**, **admin**, **client_manager**, **designer**, **printing**, **accounts**, **surveyor**, **installer**, **client_admin**, and **client_viewer**. Check unauthorized access, tenant isolation, mobile responsive layouts and nested URL redirects. Do not expose agency billing/rates to client roles.
4. Test new and historical Work Orders with/without `campaign_id` or `project_id`, 0/1/multiple linked agencies, inactive agency links, duplicate PO numbers, line-item validation, partial insertion failure, and simultaneous edits. **Important:** current browser-driven create flow inserts a PO, then line items. If line insertion fails, the client cannot necessarily DELETE the PO due to RLS. The UI explicitly alerts the operator that the incomplete draft may require admin recovery. Atomic server-side creation RPC would be preferable before declaring guaranteed zero-partial-write production readiness.
5. Test Production `Completed` status with missing boards/installed shops as per prior README; separately check physical quantity totals and invoicing. Test design review, production logs, dispatch, installation photos, rejected/cancelled orders, financial reconciliations and PDF/XLSX exports (particularly 1,000+ rows).
6. Deploy frontend only after staging checks, using your own existing `.env` / Supabase credentials / deploy settings. This ZIP excludes local `.env` files, `.git`, `node_modules` and Supabase local metadata; **do not overwrite the working environment config**.

## Workflow / click audit

| User flow | Previously | This release | Further improvement requiring separate scoped implementation |
|---|---|---|---|
| Client opens PO | Campaign list → Campaign → Work Order | Work Orders → Work Order | One-screen site search by PO on mobile |
| Client creates PO | Create Campaign → add PO | One modal: PO + items + send | Atomic DB RPC for PO + items; server-confirmed notification |
| Designer folder browsing | Client → Campaign → PO → Zone | Client → PO → Zone; Action Queue direct | Per-user saved filters if needed |
| Production folder browsing | Client → Campaign → PO → Zone | Client → PO → Zone; Action Queue direct | Virtualized large-folder browsing if real usage demands |
| Agency client drill-down | Clients → nested Campaign | Clients → filtered Work Orders | Further unify Shop Detail/PO context to reduce tab changes |
| Client reports | Campaign filter + agency + PO | Agency + PO only | Move large reporting exports to a server job for >10k rows |

**Historical records:** No automatic deletion of old campaigns/projects/links was performed. Treat retained DB metadata as archival references; new UI does not require a Campaign.
