# AdRoute — Shops listing: focused UI and safety patch

## Scope
This patch modifies **only** `src/pages/ShopsPages.tsx`, based on the agency app's latest provided Clients/Work Orders source patch. It targets the existing agency `/shops` listing (`ShopsPage`) and does not add a route, table, migration, dependency, or new screen.

## Changes
- Always-visible, accessible selection checkboxes are the **leftmost column**, including select-all-on-current-page. Row clicks no longer toggle selection accidentally.
- Selection clears on page, sort, search, size, or filter changes. All bulk operations apply only to checked, currently rendered shop IDs.
- Denser, horizontally scrollable listing: shop/client, location/contact, work order, assigned, current stage and compact actions. Selection stays pinned to the left during horizontal scroll.
- Removes redundant two-line assignment lists and repeated action buttons from each row. The full detail remains available via shop name.
- Keeps search and database-side filtering/sorting/pagination. Original 25/50/100/200 row-page options and default 50 are unchanged.
- Secondary import/backfill actions consolidated under **More**; create and bulk upload remain accessible.
- Individual Reject / Cancel / Delete actions moved behind the **More actions** modal instead of being adjacent to routine row controls. Reject requires a reason (existing behavior).
- Cancel/Delete requires typing the exact shop name; bulk Delete/Cancel requires typing `DELETE N` / `CANCEL N`, where N is the selected count.
- Delete/Cancel database responses are now checked for errors and **one actual affected row**; partial bulk failures are reported. Cache is invalidated on errors so the displayed list can reconcile.
- Existing edit, stage-change, bulk assign, reject, cancel/delete, Excel import, backfill and shop details behaviors are preserved.

## Database safety
- **No SQL. No schema changes. No migration. No bulk operation run by applying this ZIP.**
- Existing admin deletion remains a *permanent delete* only after typed confirmation; others retain existing cancellation semantics. Back up important production data separately before testing any destructive action.
- Multi-row deletes remain sequential because the existing app has no transactional bulk-delete RPC. If an error occurs after some rows are changed, the UI reports a partial operation. This patch does not claim atomic rollback.
- UI confirmation is an accident-prevention measure, **not** an authorization boundary; existing Supabase RLS must continue to enforce access.

## Files
| File | Change |
| --- | --- |
| `src/pages/ShopsPages.tsx` | Existing Shops list selection, density, action placement and safe confirmations. |
| `SHOPS_UI_PATCH_README.md` | This manifest and validation instructions. |

**Deleted files:** None.  **Dependencies:** None.  **Migrations:** None.

## Validation performed here
- TSX parser syntax check using global TypeScript: **PASS (0 parse diagnostics)**.
- Patch ZIP integrity and file manifest: **PASS**.
- Full Vite build: **NOT VERIFIED**, project `node_modules` is incomplete (`vite: not found`).
- Lint, full TS type-check, live database, owner/non-owner browser and mobile checks: **NOT VERIFIED**.

## Apply with PowerShell (project root where `package.json` exists)
```powershell
$zip = "$env:USERPROFILE\Downloads\AdRoute_Shops_Listing_Safe_UI_PATCH.zip"
if (!(Test-Path './package.json')) { throw 'Open PowerShell in your AdRoute project root' }
if (git status --porcelain) { throw 'Commit or safely stash your changes before applying the patch' }
if (!(Test-Path $zip)) { throw "ZIP not found: $zip" }

# This patch is based on the latest ShopsPages.tsx from the provided project.
# Stop rather than overwriting a newer/different local version.
$expected = '545ecfd7f41583075625b567f06d6396271df78d54169a1fd8c81dd203db95da'
$actual = (Get-FileHash -Path 'src/pages/ShopsPages.tsx' -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $expected) { throw 'ShopsPages.tsx differs from the audited version. Do not overwrite. Merge the patch against your latest file.' }

git switch -c fix/shops-listing-ux
Expand-Archive -LiteralPath $zip -DestinationPath . -Force
git diff --check
git diff -- src/pages/ShopsPages.tsx
npm ci
npm run typecheck
npm run lint
npm run build
npm run dev
```
After checking the list, checkbox scope, Reject flow, typed delete confirmation, bulk assignment, pagination, Work Order prefilter and mobile horizontal scroll **and only if checks pass**:
```powershell
git add src/pages/ShopsPages.tsx SHOPS_UI_PATCH_README.md
git diff --cached --check
git commit -m "fix: safer compact shop listing and bulk selection"
git push -u origin HEAD
```
Review/merge into `main` only after verifying in a deployment preview.
