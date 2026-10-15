# APPLY_FIELD_PATCH.md

**DO NOT extract over an uncommitted or unknown-newer source tree.** Start from your real AdRoute project root. Keep a full Git copy and take a Supabase database backup before running any SQL.

## PowerShell source installation (staging branch first)
```powershell
$ErrorActionPreference = 'Stop'
if (!(Test-Path 'package.json')) { throw 'Open PowerShell in the AdRoute project root.' }
if (git status --porcelain) { throw 'Commit or stash existing changes before applying.' }
$zip = Join-Path $env:USERPROFILE 'Downloads\AdRoute_Field_Review_Redo_Safe_Patch.zip'
if (!(Test-Path $zip)) { throw "ZIP not found: $zip" }
$temp = Join-Path $env:TEMP 'adroute-field-redo-patch'
if (Test-Path $temp) { Remove-Item -LiteralPath $temp -Recurse -Force }
Expand-Archive -LiteralPath $zip -DestinationPath $temp
Get-Content (Join-Path $temp 'CHANGES.md') | Select-Object -First 25
# Compare against your current source / resolve any changes newer than this patch before overwriting.
git switch -c fix/field-redo-evidence-safe
$paths = Get-Content (Join-Path $temp 'PATCH_FILES.txt')
foreach ($path in $paths) {
  $source = Join-Path $temp $path
  $target = Join-Path (Get-Location) $path
  New-Item -ItemType Directory -Force -Path (Split-Path $target -Parent) | Out-Null
  Copy-Item -LiteralPath $source -Destination $target -Force
}
Copy-Item (Join-Path $temp 'CHANGES.md') -Destination . -Force
Copy-Item (Join-Path $temp 'FIELD_QA_CHECKLIST.md') -Destination . -Force
Copy-Item (Join-Path $temp 'APPLY_FIELD_PATCH.md') -Destination . -Force
git diff --check
git diff --stat
npm ci
if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
npm run typecheck
if ($LASTEXITCODE -ne 0) { throw 'typecheck failed' }
npm run lint
if ($LASTEXITCODE -ne 0) { throw 'lint failed' }
npm run build
if ($LASTEXITCODE -ne 0) { throw 'build failed' }
npm run dev
```

## Database — staging FIRST
The new frontend calls the new RPC `field_redo_save`. It **will not work correctly for redo without the accompanying migration**. Create and verify a Supabase database backup and confirm the prior migrations (especially `0090_final_review_redo_availability`) are installed. **Do not run `db reset` or blindly `db push`.**

For a controlled rollout, copy ONLY the new migration SQL from:
`supabase/migrations/20261024100000_0091_field_redo_atomic_replacement.sql`
into the connected *staging* Supabase SQL Editor after verification; run the staging QA checklist, then repeat on production only after backup and approval. To copy from PowerShell:
```powershell
Get-Content 'supabase/migrations/20261024100000_0091_field_redo_atomic_replacement.sql' -Raw | Set-Clipboard
```

The script alters one table additively, defines the protected redo RPC, and replaces the existing correction-resubmission RPC. It does not delete photo/evidence records. It does clear superseded decisions for returned work items when they are resubmitted, following the preexisting review behavior, and records the replacement's before/after storage path in audit_logs.

## Git after staging QA passes
```powershell
git add src/App.tsx src/pages/SurveyorPage.tsx src/pages/InstallerPage.tsx src/components/SurveyCorrectionFixer.tsx src/components/BoardMarkerCanvas.tsx src/components/MarkedPhotoGrid.tsx src/lib/offlineDb.ts src/lib/fieldDialogs.tsx src/lib/fieldRedo.ts src/lib/fieldAssignments.ts src/lib/installationSync.ts src/lib/syncManager.ts supabase/migrations/20261024100000_0091_field_redo_atomic_replacement.sql CHANGES.md FIELD_QA_CHECKLIST.md APPLY_FIELD_PATCH.md
git diff --cached --check
git commit -m 'fix: safe field redo evidence and compact survey installer UX'
git push -u origin HEAD
```
This pushes the test branch, not production main automatically. Merge to main only after staging and permission checks pass.
