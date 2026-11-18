# AdRoute: Fulfillment-aware sizing, artwork & Officer fields

## What changed

- **Production & Installation / Production & Delivery:** Agency Owner/Admin records approved Work Order item dimensions and quantity in **Shops → Shop Details → Work Items → Record missing size**. Existing PO-generated work-item placeholders are edited instead of duplicated. The Designer does **not** edit sizes.
- Saving a valid measurement changes an unstarted **pending** no-survey work item to **approved** (design-mapping ready). Survey-required work orders retain their survey approval flow. No fake survey is written for no-survey orders.
- Area-based `sqft` work requires Width, Height and Qty. `piece`/`lot` require Qty; physical dimensions optional, but if used both width and height are required.
- No-survey item sizes become locked when artwork/production progresses; revisions use existing authorized workflow.
- Design artwork remains linked per uploaded file to exact work-item IDs using existing `design_version_items`; newer versions are displayed preferentially. No extra Designer-side form.
- Client PO progress/report display now skips inapplicable survey stages; non-survey work orders are not wrongly marked photo-noncompliant for lacking a survey photo.
- Shop form, spreadsheet and shop reports now say **Officer Name** and **Officer Number**; schema names stay `contact_person_name` and `contact_phone` for backwards compatibility. Old Excel headers are still accepted. User-added Excel columns remain in `extra_details` JSONB.
- Added scoped shop/work-item/design-link indexes and changed PO line initialization to set-based SQL for large production-install work orders. No existing records are rewritten.

## Deployment commands

From your full-project folder (after making a backup and checking the linked project):

```powershell
cd D:\DarshanAdField
npm ci
npm run typecheck
npm run build
npx supabase --version
npx supabase migration list --remote  # CLI v3; v2 uses without --remote
# Supabase CLI v2: use `npx supabase db push --dry-run` then `npx supabase db push`.
# Supabase CLI v3: use `npx supabase db push --remote --dry-run` then `npx supabase db push --remote`.
```

Run **only** the matching CLI version's db push command after reviewing migrations and confirming correct linked Supabase project. This migration is `20261117200000_0118_shop_scale_and_no_survey_size_indexes.sql`, plus any older pending migrations. Deploy Vercel **after** successful DB migration.

## Existing working project

Extract the FULL zip and keep your Vercel Supabase environment secrets and project link outside the downloaded source. Do not run `db reset` or delete migration history. This release keeps old schema names `contact_phone` and `contact_person_name` on purpose, so it does **not** require a breaking rename migration. No designer screen or permission is extended to edit dimensions.

## Staging smoke checks

1. PO type Production & Installation, create 2 shops (bulk); verify one scope placeholder for each PO line per shop.
2. Owner/Admin opens Shop Details, records 6 ft × 4 ft × Qty 2; Work Item becomes `approved`; the Designer maps 1 image to one item, or multiple images/boards, submits to review.
3. Confirm Owner/Admin review → Production → Dispatch → Installation → approval; previews stay linked to correct shop/board.
4. Test a 1-piece work item with Qty and no dimensions, and a sqft work item with mandatory Width+Height.
5. Test Survey & Installation (survey approval still mandatory), Production & Delivery (no installer), and On-site Execution (no design/production).
6. Import Officer Excel with additional `FMM/FSM Name` column, verify mapping and export labels.
7. Test 500+ shops, filtered paging, designer, production, PDF/PPT/Excel exports with real RLS and auth.

## Verification limitations

Offline source parsing and targeted logic/regression scripts only. NPM dependency installation failed in this sandbox, so `npm run typecheck` / `npm run build`, live Supabase/PostGIS operations, camera, and phone browser tests are **not** verified. SQL migration requires staging-first evaluation and index-lock monitoring.
