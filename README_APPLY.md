# Apply AdRoute Supply Only in Work Orders — existing main branch

The ZIP contains a minimal-diff installer and the existing updated `SupplyOrdersPage.tsx` (not a full repository). Extract it to a temporary folder, NOT over the project root. Running the installer updates exactly 4 existing source files. It does not perform a Git push or a database operation.

## PowerShell

```powershell
$project = 'D:\DarshanAdField'
$zip = "$env:USERPROFILE\Downloads\AdRoute_WorkOrders_SupplyOnly_Main_Update.zip"
$temp = Join-Path $env:TEMP 'AdRoute_SupplyInsideWorkOrders'
Expand-Archive -LiteralPath $zip -DestinationPath $temp -Force
& "$temp\APPLY_MAIN.ps1" -ProjectRoot $project
Set-Location $project
npm run typecheck
npm run lint
npm run build
npm run dev
```

The installer checks the Git branch is `main`, the working tree is clean, and the original SHA for every changed file matches the verified `main` baseline. Source mismatches abort BEFORE modifying any file. A backup of the 4 files is created inside `.git/adroute-supply-backup-<timestamp>/` before writing. If your source has changed since the audit, do not force-apply this ZIP; merge against that newer version.

## Git Bash — after successful build and browser tests

```bash
cd /d/DarshanAdField
git branch --show-current
git diff --check
git add src/components/AdminLayout.tsx src/App.tsx src/pages/PurchaseOrdersPage.tsx src/pages/SupplyOrdersPage.tsx
git commit -m "feat: integrate supply-only execution into work orders"
git push origin main
```

No Git pull/reset/force-push, SQL migration or new dependency is required by this patch. See CHANGES.md and QA_CHECKLIST.md.
