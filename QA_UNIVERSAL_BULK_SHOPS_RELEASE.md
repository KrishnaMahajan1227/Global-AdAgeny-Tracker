# AdRoute — Universal Bulk Shops release checks

**Reviewed:** 17 November 2026

## Automated checks passed (source/mock/runtime, not live hosted deployment)

| Area | Result |
|---|---|
| Universal bulk upload fields, optional/location/address, custom column consent, role+map behaviors | 19 passed |
| Existing bulk scope/zone/client/PO payloads + mocked inserts | 30 passed |
| Work Order line item add/edit/delete + UOM and query refresh | 10 passed |
| Fulfillment phase 1 presets, progress, DB source contracts | 16 passed |
| Fulfillment phase 4 receipt gates, direct-install RPC, static contracts | 19 checks + 7 syntax passed |
| Handoff phase 3 | 21 checks + 3 TSX parses passed |
| Role navigation phase 6 | 17 passed |
| Owner dashboard regression | 10 passed |
| Static project release security | 27 passed |
| TypeScript/TSX parse | 128 files, 0 errors |
| Workbook | 4 sheets; empty first input sheet, 2 fictional sample rows on second sheet, Instructions, Field Guide; key-cell inspect and Excel formula error scan passed |

## Data contracts

- Required: shop name, full address.
- Optional: owner, phone, village, city, taluka, district, state, PIN, zone, GPS.
- Lat/long must either both be absent or both be valid coordinates (including 0); no arbitrary default geotags.
- Identity links are fixed from selected client/Work Order; no spreadsheet overrides allowed.
- Extra headers with actual values require Keep/Skip approval, and kept values are stored by name in `shops.extra_details` JSONB (migration 0054). New optional SQL columns are `shops.taluka` and `shops.pincode` (migration 0115).
- New records are `pending`; assignment, design, fabrication, dispatch, install evidence, billing readiness, and PO line work item creation are separate stages, not automatically fabricated from shop rows.

## Mandatory staging checks that were NOT performed here

1. Apply the `20261117170000_0115_shop_bulk_location_fields.sql` migration to staging **before** deploying frontend.
2. `npm ci`, `npm run typecheck`, `npm run build`, and a browser smoke test using the deployed build.
3. Real agency owner and client admin bulk uploads, including cross-org RLS, tenant-safe Project/PO IDs and zone creation.
4. Verify address-only and GPS-provided shops on client PO map and Surveyor/Installer navigation; configure Google Maps API only where appropriate.
5. Verify assignments on `survey_install`, `production_install`, `supply_only`, `direct_install` and historical `custom` orders; for direct-install use on-site installer creation.
6. Verify existing active worker assignment reassignment, failure handling, and stock/production/billing progress across all supported UOMs.
7. Confirm fields are visible in shop details, client drawer, Surveyor/Installer details, and that customer-specific report exports include any extras they explicitly need.

**Known legacy check issue:** `scripts/verify-supply-workflow.mjs` has one stale static assertion looking for direct `.from('routes').insert` while current dispatch uses server RPC; it does not prove a dispatch runtime regression. Full production environment tests are required to certify deployment.
