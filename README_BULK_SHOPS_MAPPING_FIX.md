# AdRoute | Bulk Shops Mapping Fix (17 November 2026)

## Included in this release

**This is an update to the Work Order line-item fix, not a new database.** No migration or data reset is required.

### Entry points reviewed and patched
1. Agency: **Shops > Bulk Upload** (`src/pages/ShopsPages.tsx`).
2. Client portal: **Shops > Bulk Upload** (`src/pages/client/ClientShopsPage.tsx`).
3. Client portal: **Work Order > Shops > Bulk Upload** (`src/pages/client/ClientPODetailPage.tsx`).

### Fixes
- Prevent a stale project or Work Order from remaining selected when the agency changes the client.
- Infer the agency shop `project_id` from the selected Work Order when it has a project; reject a client/project/Work Order mismatch **before inserting shops**.
- Client portal imports now persist the Work Order's `project_id` on every shop, not just its `purchase_order_id`. Client single-shop creation in those same screens has been aligned.
- All three bulk upload paths use `buildBulkShopRecords()` to map organization, client, Work Order, project, zone, addresses, contact details, extra fields, and pending status consistently.
- Zone names resolve to `zone_id` only within the correct agency organization **and project**. The unique-constraint retry no longer silently reuses a zone from another project.
- Unsupported zone mapping now blocks insert rather than silently saving an empty `zone_id`.
- Detect duplicate identical site rows with identifiers and report the actual spreadsheet row numbers before inserting any shops.
- Reject data rows missing a shop name instead of quietly skipping them.
- Preserve useful Excel formatting (`raw: false`), including leading-zero formatted phone numbers when preserved in the workbook.
- Support common headers including Store Name, Outlet Name, Mobile No, Phone No, Contact Number, and more; handle multiple aliases for the Name column without losing data.
- Refresh the relevant agency/client portal shop, zone, PO site count, overview, and report caches after successful imports.
- Single POST `shops.insert(rows)` is retained for atomic **shop row inserts**. Zone creation is a separate request and is not in the same database transaction.

### Important distinction: shops versus PO line items
A bulk upload creates **shop/site records linked to a Work Order**. It does **not** create physical board/work-item records for every PO line item at each shop: those are added/mapped to `po_line_items` during the site's survey/work-item process. This is intentional, so ordered quantities are not duplicated across every shop. The existing work-item / PO-line mapping workflow is unchanged by this patch.

- Workbook import scans sheets in order and skips cover/instructions tabs until it finds a valid shop-table header.

### Quality assurance performed offline
- `node scripts/verify-shop-bulk-mapping.cjs` – 21 regression scenarios, including actual mutation functions with mocked Supabase, 500-site mapping, wrong-client rejection, duplicate rows, and zone conflict retry.
- `node scripts/verify-po-line-items-runtime.cjs` – 10 prior Work Order line-item scenarios.
- `node scripts/check-syntax.cjs` – all 127 source TS/TSX files parse without syntax errors.
- Other source/security and workflow checks are recorded below if they run in this environment.

### Verification limits and deployment
The above tests use mocks, not live data. No real Supabase import, RLS integration session, Vercel deployment, or complete production build has been verified here. Before a client demo, install dependencies in your normal Node build environment and run:

```
npm ci
npm run typecheck
npm run build
npm run verify:bulk-shops
npm run verify:po-line-items
```

Deploy to staging first. With an **authorized test client and Work Order**, import a two-shop workbook containing multiple zones and extra columns; then verify `organization_id`, `client_id`, `project_id`, `purchase_order_id`, and `zone_id` in the database, app lists, reports, and dashboard. Repeat from the client portal. Confirm the Work Order's line items remain unchanged until work items are actually added.

### Security and packaging
- Full-project ZIP excludes the real local `.env` and `supabase/.temp` files. Continue using your existing securely configured Vercel/Supabase environment variables.
- No schema migration or destructive cleanup was added.
- The existing `README_WORK_ORDER_LINE_ITEM_FIX.md` remains in the full project.
