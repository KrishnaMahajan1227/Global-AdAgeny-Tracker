# Install this patch on current `main`

Use this **targeted patch**, not a 54MB source snapshot, to preserve all previous AdRoute functionality. The installer is version-guarded and creates backup copies. No database SQL is included.

```powershell
$project = 'D:\DarshanAdField'
$zip = "$env:USERPROFILE\Downloads\AdRoute_Reports_Billing_Main_Refinement.zip"
$temp = "$env:TEMP\AdRoute_Reports_Billing_Refinement"
Expand-Archive -LiteralPath $zip -DestinationPath $temp -Force
& "$temp\APPLY_MAIN.ps1" -ProjectRoot $project -PatchRoot $temp
Set-Location $project
node scripts/verify-report-billing.mjs
npm run typecheck
npm run lint --if-present
npm run build
npm run dev
```

If any of the three baseline hashes mismatches, **stop**. Compare local code to this patch; do not force-overwrite newer changes.

After tests pass, use Git Bash:

```bash
cd /d/DarshanAdField
git branch --show-current
git diff --check
git add src/pages/BillingPage.tsx src/pages/ReportsPage.tsx src/lib/reportPortfolio.ts scripts/verify-report-billing.mjs
git commit -m "fix: portrait evidence reports and consolidated completed-shop billing"
git push origin main
```

No pull, no new branch, and no force push required for this patch.
