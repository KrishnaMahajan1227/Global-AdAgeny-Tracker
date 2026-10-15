# AdRoute — Shop Details clarity & evidence layout refinement

## What this patch is
Minimal follow-up to the existing `AdRoute_Shops_Detail_Professional_Refinement.zip` version. It **modifies only three existing files**, adds no pages, dependencies, tables, migrations, fields or routes, and makes no database writes simply by installing it.

| Path | Exact change |
| --- | --- |
| `src/components/shop/WorkItemsPanel.tsx` | Keeps all original work-item actions/data but makes the evidence row bounded: one visible, full-image preview for each populated stage (Survey, Design or Installation), without empty photo columns; any other photos expand inline under **Show N more** within that stage. For work items with zero photos, uses a compact single-line empty state. Keeps item search, filters and 10/25/50 item paging. Simplifies the top action bar to Add item + Add evidence. Clearer keyboard/focus labels. |
| `src/components/shop/EvidenceViewer.tsx` | Standardizes preview and document frames at 160px height, uses `object-contain` (never crops photographs), keeps board-marking overlays registered to their actual image, moves photo deletion away from the image click target, and improves keyboard interaction/focus in the original optional photo viewer. |
| `src/pages/ShopsPages.tsx` | Ensures multiple assigned names are not hidden in a short internal scroller; brings unmapped/legacy photo previews into the same 160px uncropped tile system, with fewer columns so evidence stays readable. No change to shop CRUD, assignment handlers or uploads. |

**Deleted files:** None. **Dependencies:** None. **SQL:** None. **Database and storage migration:** None.

## UX decisions
- **One primary work-item preview per stage**, not a 3-column multi-photo gallery on every item. Additional files expand *inside the item* and have a bounded, scrollable list. No new modal/page, and the existing full-size evidence viewer remains available for markings and close inspection.
- All available photographs appear inside equally sized **160px preview frames**. Portrait and landscape originals are fully visible, with letterboxing rather than cutting off shop signage or markings. Small intrinsic source images still depend on image resolution; no UI can restore lost original detail.
- Photo deletion is a discrete secondary control below each preview; the original permanent-delete confirmation remains. Edit/disable/delete work-item actions stay in the existing overflow menu.
- Filters/search/page size continue operating on real work-item records. The default page size is 10; 25/50 available for power users. No new summary dashboard or repeated totals.
- Survey, Design, Installation and legacy/unmapped evidence remain visible and available; no file or DB record is removed.

## Baseline compatibility — STOP if your project differs
This patch was made on top of **the previous Shop Details refinement ZIP** (from this conversation). Before extraction, these hashes should match the current files in your local project. If not, merge manually with newer changes instead of overwriting:

| File | Expected current SHA-256 |
| --- | --- |
| `src/pages/ShopsPages.tsx` | `50d9d953b3db5bdf45c50c28036b206d50bed541c2777d01fb276d7686739f4b` |
| `src/components/shop/WorkItemsPanel.tsx` | `9f5211200b2146820b90462e502c5bf9dc1abed3f05201ceea89d9576cf7f9a9` |
| `src/components/shop/EvidenceViewer.tsx` | `f294de3dcf2dab0a382ec9ea4f3ac33b5a0232593d07e66a322cabd6af2a17d7` |

## Validation performed
- TypeScript parser (`ScriptKind.TSX`) and independent `transpileModule` run on **all three updated files**: **passed; zero syntax diagnostics**.
- Static review: original create/edit/delete/assign/upload handlers remain connected; all photo previews use contained images and shared 160px frames; shop list and all existing routes left unchanged.
- **Not completed:** Full Vite build, ESLint, TypeScript project type-check or browser/E2E live Supabase test. `npm ci --offline` failed due to an uncached `zip-stream` package, and `npm ci` returned an npm internal exit-handler error in this environment. These must be run on a clean local checkout/CI before production use.

## Essential staging QA
1. Open a shop with zero, one, 10 and >50 work items; verify search/status filters, pagination 10/25/50, empty states and no horizontal overflow at mobile/tablet widths.
2. Open items with 0, 1 and 10+ photos per stage. Verify just one preview per populated stage initially, no large empty placeholders, all remaining photos accessible with Show N more, without opening the fullscreen viewer. All preview frames must be uniform and uncropped.
3. Compare marked survey photo polygons against its original full-screen image; test portrait, landscape, small-size and failed-image URLs. Non-image design files should retain Open file.
4. Verify photo deletion remains behind confirmation; check item edit/delete, mark unavailable, PO line assignment, add survey/design/install, and other shop actions still work.
5. Shop with multiple surveyors/installers and reassigned designer: verify all current people and history appear; test mobile keyboard focus, Escape and gallery arrow navigation.
6. Inspect authenticated permissions, direct shop URLs, and the browser console. No changes are made to Supabase policies; RLS still needs live verification.
