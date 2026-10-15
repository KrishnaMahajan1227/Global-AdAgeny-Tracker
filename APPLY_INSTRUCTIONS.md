# Installation / staging procedure

1. This is a **targeted patch**, not the full project. Apply only to a clean, backed-up branch. Previous `AdRoute_Field_Review_Redo_Safe_Patch.zip` must already be merged (the source hash guard will confirm). Do not replace your `src/` directory wholesale.
2. Extract this ZIP to a temporary folder and run `APPLY_SAFE.ps1 -ProjectRoot "C:\...\Global-AdAgeny-Tracker"`. It stops on any source mismatch, makes an external backup and copies ONLY the files listed in `PATCH_FILES.txt`. **It does not connect to or change Supabase.**
3. Open PowerShell in your project root:

```powershell
npm ci
if ($LASTEXITCODE -ne 0) { throw "npm ci failed" }
node scripts/verify-field-units.mjs
if ($LASTEXITCODE -ne 0) { throw "Unit checks failed" }
npm run typecheck
if ($LASTEXITCODE -ne 0) { throw "Typecheck failed" }
npm run lint
if ($LASTEXITCODE -ne 0) { throw "Lint failed" }
npm run build
if ($LASTEXITCODE -ne 0) { throw "Build failed" }
npm run dev
```

4. Database: the ZIP contains **only** a new, additive migration `20261025100000_0092_field_redo_mixed_dimension_units.sql`. Do **not** run a production migration until you have an independent verified Supabase backup, the previous redo migration `0091` is present, and migration `0092` plus role-specific redo tests pass on staging. `npx supabase migration list` can show applied migration history; do NOT use `db reset`, `DROP`, `TRUNCATE`, or a blind production `db push`.
5. For staging SQL Editor review/copy only:

```powershell
Get-Content 'supabase/migrations/20261025100000_0092_field_redo_mixed_dimension_units.sql' -Raw | Set-Clipboard
```

6. After successful QA, stage only changed source/tests/migration/doc files and commit on your branch; push for review/merge, not directly to production without testing:

```powershell
git status
git diff --check
git add src/pages/SurveyorPage.tsx src/pages/InstallerPage.tsx src/components/SurveyCorrectionFixer.tsx src/components/CameraCapture.tsx src/lib/units.ts src/lib/markingUtils.ts src/lib/offlineDb.ts
 git add scripts/verify-field-units.mjs supabase/migrations/20261025100000_0092_field_redo_mixed_dimension_units.sql
git diff --cached --check
git commit -m "fix: refine field capture and mixed-unit progress calculations"
git push -u origin HEAD
```

**Deployment limitations**: source TSX parses and local unit tests pass. Complete build, browser/device tests and staging Supabase verification have not been performed in this environment. Do not call this a fully tested production release.
