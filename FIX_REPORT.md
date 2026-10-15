# Installer crash correction

Changed: `src/pages/InstallerPage.tsx` only. Apply on top of the **AdRoute_Field_Capture_Marking_Units_Final_Patch.zip** version, not on an unrelated source revision.

## Fixed
- `InstallationWizard` photo synchronization effect referred to an undefined `isOnline` variable. It now consistently uses the existing `online = useOnlineStatus()` hook and lists `online` as the effect dependency. This eliminates the reported `ReferenceError` and the attempted `online2` temporal-dead-zone workaround.
- Installation correction reads no longer silently treat a missing `replacement_saved_at` schema column as an empty correction queue. A legacy read loads existing correction descriptions if that field is unavailable. Other query errors are shown to the user rather than hidden.

## Important database prerequisite
- The column `field_corrections.replacement_saved_at` is added by previously provided migration `20261024100000_0091_field_redo_atomic_replacement.sql`.
- This UI fix does not apply that migration or enable atomic redo saves without it. Verify database migration history against the linked Supabase project, then apply reviewed missing migrations on staging after backup.
- No SQL files or destructive database operations are included here.

## Verification
- TSX syntax: parsed successfully with TypeScript 5.8.3.
- Static inspection: no `isOnline` or `online2` identifiers remain in the patched Installer page.
- Full app build, lint, live Supabase, device testing: NOT verified in this environment.

## Regression tests
1. Open installer My Work > Start Install on a ready shop; no error boundary.
2. Open a submitted installation; view photos without starting new job.
3. With offline network, ensure unsynced proofs remain present, and retry when online.
4. With migration 0091, open redo and replace returned evidence, review on owner side.
5. Without migration 0091, ensure existing redo notes load, and do not attempt final redo submission.
