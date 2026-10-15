# AdRoute Installer — runtime and query-safety hotfix

## Scope

Only `src/pages/InstallerPage.tsx` is modified. No database tables, evidence, photos, RLS policies, or records are changed by this ZIP. No new dependencies.

## Root causes fixed

1. `InstallationWizard` declared `const online = useOnlineStatus()` but used `isOnline` in the photo sync effect and its dependency array, causing `ReferenceError: isOnline is not defined`. All references now use the declared variable; the reconnect callback uses a different name so it cannot create a temporal-dead-zone error.
2. Normal installations queried `field_corrections.replacement_saved_at` (new in migration 0091) even when no redo existed. This could produce HTTP 400 if 0091 wasn't deployed. The query now checks the original 0057 columns first and requests the acknowledgement column **only when returned corrections actually exist**. If absent for a redo, it displays a clear schema error rather than silently losing the correction.
3. `InstallerEntry` formerly ignored Supabase errors and treated a failed correction count as zero; it now stops safely with Retry/Back rather than accidentally routing redo into fresh installation.
4. Installer My Work previously returned an empty correction list on some schema errors. Errors are now visible and retryable, while the assignment list stays available.
5. The installer assignment list and compact wizard job queue used the same React Query key for different-shaped responses. The compact queue now has its own key.
6. A fresh `installation_jobs` row could be inserted while correction status was pending or errored. New inserts are now guarded, but an existing job ID can still be loaded for redo proof display.
7. Reconnect photo-sync effect now catches async rejections instead of leaking unhandled promises. Existing IndexedDB photo queue and evidence sync logic are unchanged.

## Verification and limits

- TypeScript/TSX parsing: passed using TypeScript AST.
- Source-level regression checks: passed (included script).
- Full `npm run typecheck`, `npm run lint`, `npm run build`: **not verified** in the available environment (node_modules dependencies unavailable).
- Actual Supabase request/authorization, migrations 0091/0092, offline photo capture and reconnect on physical devices: **not tested**.
- If `field_corrections` table or 0091 is not deployed, the code cannot create database columns. Run `CHECK_FIELD_MIGRATIONS.sql` read-only to diagnose; use your previously supplied, reviewed migrations on staging with a backup before production.

## Baseline

This update is based on `AdRoute_Field_Capture_Marking_Units_Final_Patch.zip` and prior `AdRoute_Field_Review_Redo_Safe_Patch.zip`. Do not overwrite further local changes without reviewing the diff. The source in the ZIP replaces the complete InstallerPage file; it does not touch Surveyor UI or other project modules.
