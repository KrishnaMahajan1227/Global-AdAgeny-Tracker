> **Historical note:** This earlier release is superseded by `README_GEOTAG_FLEXIBLE_SHOPS_RELEASE.md` (flexible Excel fields + contact person + GPS proof).

# AdRoute 10-field new shops release — verification (17 Nov 2026)

## Scope

Base: `AdRoute_Universal_Shops_Fulfillment_Fixed_Full_Project.zip`, keeping all preceding Work Order / bulk-map / fulfillment changes. These changes narrow **newly-added shop** inputs, not existing historical records.

- Shared 10-column Excel inside three bulk upload dialogs.
- Agency manual shop form and client manual shop forms show the same 10 business fields, in addition to necessary scope selectors such as client/Work Order.
- Owner Number is now `shops.owner_phone` (nullable), distinct from `shops.contact_phone` (Contact Person Number).
- Addresses required; city/taluka/district/state/zone/phone fields optional. No new arbitrary fields.
- Existing location/GPS and historical extra_details remain intact; not part of new import.
- Zone_id resolved from Work Order project scope for bulk AND client manual add/changed-zone edit; unchanged zones preserved.

## Verification run and actual results

| Check | Result |
|---|---|
| 10-column Excel first-sheet OOXML headers | PASS (10 exact, in requested order; 3 sheets total) |
| `node scripts/verify-ten-field-shops.cjs` | 14/14 PASS |
| `node scripts/verify-shop-bulk-mapping.cjs` | 30/30 PASS (including 500 rows and scope) |
| `node scripts/verify-universal-upload-fulfillment.cjs` | 19/19 PASS |
| `node scripts/verify-po-line-items-runtime.cjs` | 10/10 PASS |
| `node scripts/check-syntax.cjs` | 128 TS/TSX files parsed, no syntax errors |
| `node scripts/verify-security-release.cjs` | 27/27 PASS |
| `node scripts/verify-phase7-security.cjs` | 16/16 PASS |
| Full-source ZIP archive integrity | Checked after packaging |

**Important limitations:** These are static/mocked runtime checks, not a real browser with hosted Supabase. No live production database writes were performed. `npm ping` cannot access the registry here, so a fresh `npm ci`, `npm run typecheck` and `npm run build` remain unverified. Geographic address search is not an exact, GPS-verified location pin. Run the listed staging checks before production.

## Existing unrelated release suite limitations

`npm run verify:release` exits with failures in `verify-campaign-removal.cjs`: **21/25** passing. Its four failing assertions concern historical Campaign creation screen removal, legacy client Campaign screens, Shop Detail survey-gate source pattern and deployment verification-file presence. The same 4 failures were reproduced on the pre-10-field source (`/mnt/data/AdRoute_Universal_Bulk_Shops_Fixed`) and were NOT introduced by this change. They have not been silently declared fixed.

## Staging checklist

1. Apply migrations 0115 (if not already) and 0116 **before** the frontend, using the existing deployment procedure. No DB reset.
2. `npm ci && npm run typecheck && npm run build` on a workstation/CI with installed dependencies.
3. Agency owner/Admin: upload 2 shops and 500 shops via the fill sheet; verify database `client_id`, `project_id`, `purchase_order_id`, `zone`, `zone_id`, `owner_phone`, `contact_phone`, `address`. Reload and inspect.
4. Client admin: repeat both Client Shops and Client Work Order Shops uploads; verify RLS permissions and scope; verify mapping is not cross-client.
5. Upload missing Address, duplicate shop, duplicated header, unknown header and 10-column template with optional fields empty; ensure actionable error and no partial import.
6. Check manual add/edit on agency and client pages, including unchanged Zone, changed Zone and historical shop without Work Order; no existing owner_name/PIN data lost on edits.
7. Verify address search vs actual field GPS pin, refresh of dashboards/filters, assignment roles and all used fulfillment types. **Direct install stays installer-created**.
8. Verify updated template is served by Vercel under `/templates/AdRoute_Universal_Shops_Bulk_Upload_Template.xlsx` and downloads as `AdRoute_Shops_10_Field_Template.xlsx`.
