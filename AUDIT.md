# AUDIT — Surveyor and Installer field refinement

- Existing role entry and My Work routing remain unchanged from the latest field redo patch.
- Canonical capture: `src/components/CameraCapture.tsx` and the SurveyorPage capture/marking wizard. It previously required Capture → Use Photo → Mark, and duplicate photo/back controls existed.
- Canonical board/polygon input: `BoardMarkerCanvas`; marking points remain percentages (0–100), bound to their photo, and multiple board IDs remain independent.
- Canonical rendered evidence: `renderMarkedImage` / `MarkedPhotoGrid`; not replaced. The shared caption now honors separately entered width and height units.
- Canonical physical calculation: `toFeet` / `areaSqFt` in `src/lib/units.ts`. `src/lib/syncManager.ts` already stores survey_width, survey_height in feet and survey_area in square feet; entered widths/heights and units are stored separately. These write paths are preserved.
- Existing installer direct-install write path was inconsistent: raw width/height with non-foot units; now it normalizes dimensions to feet while storing entered dimensions and original units.
- Previous `field_redo_save` RPC only supported a single unit for both corrected dimensions. Migration 0092 extends it with optional `heightUnit` while preserving compatibility with old queued drafts.
- Survey submission previously allowed unmarked or invalid-size boards; it now refuses incomplete submissions before server writes or offline queueing.
- Survey capture original draft and current photo are retained in IndexedDB. The active-photo pointer was not persisted: new optional field restores it without modifying Dexie indexes or tables.
- Unsafe Installer thumbnail X previously filtered React state without a correct server deletion; it was removed. The one canonical handler manages local/remote deletion with explicit in-app confirmation.
- Owner dashboard/work-order screens, approval calculations, review components and past image records are not modified in this patch.

**Limitations:** Source-level validation is not live QA. Full build/lint/typecheck, Supabase staging migration, permissions, photo capture and offline retry still require execution on a configured environment. Existing old Direct Install records are not rewritten. Cached drafts can be lost if device/browser storage is cleared.
