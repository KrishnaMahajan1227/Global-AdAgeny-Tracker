> **Historical note:** This earlier release is superseded by `README_GEOTAG_FLEXIBLE_SHOPS_RELEASE.md` (flexible Excel fields + contact person + GPS proof).

# AdRoute Shops — final 10-field new-shop upload (17 Nov 2026)

## Exactly 10 columns

The three **Bulk Upload Shops** dialogs — Agency Shops, Client Shops, and Client Work Order Shops — download the same file:
`public/templates/AdRoute_Universal_Shops_Bulk_Upload_Template.xlsx`

The downloaded filename is `AdRoute_Shops_10_Field_Template.xlsx`. On its `Shops - Fill Here` sheet the only headers, in order, are:

1. Shop Name **required**
2. Address **required**
3. Owner Number optional
4. Contact Person Number optional
5. Village optional
6. Taluka optional
7. City optional
8. District optional
9. State optional
10. Zone optional

There are NO owner-name, PIN, GPS, landmark, store-code, notes, custom field, or Work Order/Project columns on this template. Two fictional examples are on a separate sheet. Enter rows on the **first, blank fill sheet**, not the example sheet. Avoid adding more headers: the import deliberately rejects extra columns rather than silently discarding customer data or creating surprise DB columns.

## Mapping / persistence

- `Owner Number` -> nullable **`shops.owner_phone`** (new migration 0116).
- `Contact Person Number` -> existing **`shops.contact_phone`**.
- `Shop Name`, `Address`, `Village`, `Taluka`, `City`, `District`, `State`, `Zone` -> respective `shops` columns. The `zone_id` FK is resolved in the **same organization + selected project**.
- Client, Project and Work Order IDs are taken from the selected AdRoute context, **not** from user-entered Excel text.
- Old `owner_name`, `pincode`, location and workflow columns remain in the database for historical shops; creating new shops does not ask users to fill them. Existing records are not reset.
- Client manual-add and edit forms also show the two phone numbers separately; manual zone creation resolves `zone_id` against the selected Work Order. Existing zone keys are retained on edits when Zone hasn't changed.
- No GPS coordinates are fabricated from an address. Maps may open an address **search**, which is NOT a verified precise pin. For accurate navigation, field survey/installer GPS verification is still needed.
- All existing fulfillment types and job/assignment workflows are preserved; this release does not change fulfillment processing or automatically create boards/line-items per shop. On-site Execution continues to require installer-driven creation/evidence.

## Safe deployment order

1. Deploy migration **0115** if not previously applied:
   `supabase/migrations/20261117170000_0115_shop_bulk_location_fields.sql` (taluka and pincode, both optional).
2. Deploy NEW migration **0116**:
   `supabase/migrations/20261117180000_0116_shop_owner_number.sql` (nullable owner_phone). No database reset.
3. Deploy the updated frontend and the template inside `public/templates` while keeping your existing environment variables on the host. **Do not deploy frontend first**: client queries read `owner_phone`.
4. Staging check: real owner/agency + client-admin logins; upload the new Excel in each of the 3 screens; confirm `shops.owner_phone` vs `shops.contact_phone`, address and zone_id; refresh and check detail, map-search, reports and shop assignment. Check duplicate, wrong-project, missing address and extra header. Verify site/fulfillment flow for relevant Work Order types.
5. Production release after staging validations. This ZIP intentionally does not contain local `.env` secrets.

## Local validation

```bash
npm ci
npm run typecheck
npm run build
npm run verify:bulk-shops
npm run verify:po-line-items
node scripts/verify-universal-upload-fulfillment.cjs
npm run verify:security
```

Source-level/mocked runtime tests were run for the release and passed (see `QA_TEN_FIELD_SHOPS_RELEASE.md`). **Full dependency installation, production build and live Supabase/Vercel/Google Maps end-to-end checks have not been completed in this environment.** Staging validation remains essential before calling this production-ready.
