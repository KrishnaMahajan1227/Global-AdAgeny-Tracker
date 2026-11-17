# AdRoute – GeoTag Proof Photos & Flexible Shops Excel (2026-11-17)

This is the current release guide. Earlier `README_TEN_FIELD_SHOPS_RELEASE.md` describes a superseded fixed-column release.

## Changes included

### 1. One flexible Excel for all three bulk-entry points

The downloadable workbook under `public/templates/AdRoute_Universal_Shops_Bulk_Upload_Template.xlsx` is linked from Agency Shops, Client Shops, and Client Work Order detail. The blank first worksheet has these eleven fixed headers:

`Shop Name | Address | Owner Number | Contact Person | Contact Person Number | Zone | State | Village | Taluka | City | District`

* `Shop Name` and `Address` must have values. Other base columns are optional.
* Users may add any additional non-duplicate, safe heading (e.g. `FMM/FSM Name`, `Branding Type`, `Sales Rep`). Populated values are **kept by default**, including for preexisting client spreadsheet formats; the optional Skip selector is still available. Unexpected columns are **not** rejected just because they do not appear in the template.
* Additional columns are persisted per shop as key/value pairs in the **existing** `public.shops.extra_details` JSONB field. This is intentional: spreadsheet headers must not run arbitrary `ALTER TABLE` operations, affect database schema, or override canonical `organization_id`, `client_id`, `project_id`, `purchase_order_id`, or `zone_id` values from the selected in-app context.
* Contacts and phone numbers are not mixed: `owner_phone` = Owner Number, `contact_person_name` = Contact Person, `contact_phone` = Contact Person Number. The older `owner_name` column is retained for historical rows.
* Custom details are visible in shop detail / client detail and in field views through `ShopAdditionalDetails`. Client site Excel reports and agency shop Excel exports include custom fields.
* An Excel column named `FMM/FSM Name` is **informational metadata**, not a field-staff user ID. It does not silently assign real AdRoute accounts. Normal role-checked assignment workflows continue to apply.
* Existing project/work-order/zone validations and fulfillment restrictions are retained. In particular, `direct_install`/On-site Execution still uses the installer-created site workflow rather than precreating empty shops.

### 2. Four-field geo-tag on evidence photography

Shared implementation: `src/lib/geoStamp.ts`. Standard proof photo badge:

1. Shop or site name, where known.
2. Full postal address (combines village/taluka/city/district/state where needed without obvious repeats).
3. Latitude and longitude from a **fresh device geolocation** fix for a **live camera** capture; otherwise explicitly show unavailable/unverified GPS.
4. Date/time of capture or, for imported photos, *date/time of import* clearly labelled `Imported`.

A left-side thumbnail uses live OpenStreetMap tiles with a mathematically centered pin, plus attribution. No fake tile/pin or inferred geolocation is substituted. Offline/CORS/tile provider failure falls back to `MAP UNAVAILABLE` and does not block photo capture. Evidence is rendered into the JPEG itself, so downstream grids and downloadable evidence display the same stamp.

Updated flows:

- Surveyor camera and survey gallery imports
- Installer camera and installation gallery imports
- Direct/on-site installation camera
- Installation correction / re-do camera and gallery paths
- Agency Shop Detail manager-imported survey/install proof photographs

**Authenticity:** A shop's master GPS coordinates or a searchable address must not be passed off as proof that an old gallery photo was taken there. Live camera evidence asks the browser for a fresh device fix. Gallery / native file pickers and manager uploads are marked `Imported`, with unverified GPS unless independently supported by captured evidence. Photo stamps are not cryptographic attestations. Browser geolocation requires HTTPS and permissions.

## Database migration (must run BEFORE new frontend)

Previous releases introduced 0115 (`taluka`, `pincode`) and 0116 (`owner_phone`). This release adds:

`supabase/migrations/20261117190000_0117_shop_contact_person_name.sql`

It adds only nullable `shops.contact_person_name`; does not drop, truncate, or reset data. No new SQL migration is needed for extra Excel columns because `shops.extra_details` JSONB exists already (migration 0054). Confirm the correct linked Supabase project, back up production data, and apply only pending migrations on staging before production. For example, depending on the Supabase CLI version, use `npx supabase db push --dry-run` followed by `npx supabase db push` (v2), or the `--remote` form in v3. Check `npx supabase --version` and the CLI's `--help` before running. `db push` does not deploy the Vercel frontend.

## Validation performed in this release

- `node scripts/check-syntax.cjs` – 128 TS/TSX files parsed, 0 syntax errors.
- `node scripts/verify-runtime-jsx-symbols.cjs` – 67 TSX symbols verified.
- `node scripts/verify-shop-bulk-mapping.cjs` – 30 scenarios passed.
- `node scripts/verify-flexible-shops-geotag.cjs` – 20 integration checks, 2 canvas rendering checks passed (includes FMM/FSM, 500 shops, zone/PO scope, import versus live metadata).
- `node scripts/verify-ten-field-shops.cjs` – compatibility wrapper for new flexible suite.
- `node scripts/verify-universal-upload-fulfillment.cjs` – 19 scenarios passed.
- `node scripts/verify-po-line-items-runtime.cjs` – 10 scenarios passed.
- `node scripts/verify-owner-dashboard-demo.cjs` – 10 scenarios passed.
- `node scripts/verify-security-release.cjs` – 27 static checks passed.
- `node scripts/verify-phase7-security.cjs` – 16 checks passed.
- Production-completion static regressions passed.

### Known limits / mandatory staging checks

This ZIP is **updated and source-checked**, not a claim of a fully verified live deployment. Full `npm ci`, TypeScript typechecking, Vite production build and real Supabase/Vercel/RLS/browser geolocation were **not** completed here. Offline `npm ci` was blocked by a missing cached dependency (`zip-stream@4.1.1`). The wider historical `verify:release` suite still fails 4 unrelated Campaign/deployment source assertions; targeted relevant suites pass.

Before client demo or production, on staging: `npm ci`, `npm run typecheck`, `npm run build`, `npm run verify:bulk-shops`, `npm run verify:security`; upload the workbook with `FMM/FSM Name` and 100+ shops in all three routes, confirm correct client/PO/project/zone rows; assign a shop and verify custom details visible to authorized field staff; test live phone camera with/without GPS permission, gallery, correction, direct-install, OSM tile loading and photo exports. Then promote the tested build to Vercel.

**Do not reset production DB. Do not upload a local `.env` or Supabase access tokens.**
