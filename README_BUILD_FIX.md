# AdRoute Installer runtime crash fix

## Cause
`InstallationWizard` already declares `const online = useOnlineStatus();` but its photo auto-sync effect referred to undeclared `isOnline`. This raised `ReferenceError: isOnline is not defined` during component render.

## Change
Only `src/pages/InstallerPage.tsx` changes. The photo auto-sync guard and React effect dependency now use the existing `online` hook result. No evidence, marking, upload, role, or database logic was otherwise changed.

## Apply
Extract this ZIP into your existing AdRoute source root (containing `package.json`). It overwrites `src/pages/InstallerPage.tsx`. Back up/commit the current file first and do not overwrite if you have subsequent unmerged edits.

## Verify on your machine
```powershell
npm run typecheck
npm run build
npm run dev
```
Then sign in as Installer, open an assigned installation, test online/offline/reconnect and photo queue. Also verify Surveyor flow remains unchanged.

## DB
No SQL, migrations, or Supabase changes required.

## Test status
TypeScript transpile/syntax checked; full app typecheck/build/live browser testing not completed in this environment.
