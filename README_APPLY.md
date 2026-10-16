# Apply to existing AdRoute main

1. Ensure local `main` is clean and based on the five source versions recorded in `APPLY_MAIN.ps1`. **Do not force-push or pull**.
2. Unzip to Downloads, then in **PowerShell** (from any folder):

```powershell
$zip = "$HOME\Downloads\AdRoute_Completed_Shops_Progress_Billing_MAIN_FIX.zip"
$temp = Join-Path $env:TEMP 'AdRoute_Completion_Fix'
Expand-Archive -LiteralPath $zip -DestinationPath $temp -Force
& "$temp\APPLY_MAIN.ps1" -ProjectRoot 'D:\DarshanAdField' -PatchRoot $temp
Set-Location D:\DarshanAdField
npm ci
node scripts/verify-completed-work.cjs .
npm run typecheck
npm run lint --if-present
npm run build
npm run dev
```

If a step fails, stop. A backup is saved in `%TEMP%`. Full production release requires staging verification with Supabase.

3. In **Git Bash**, only after review passes:

```bash
cd /d/DarshanAdField
git diff --check
git add src/lib/workCompletion.ts src/lib/poBilling.ts src/pages/BillingPage.tsx src/pages/WorkProgressPage.tsx src/pages/PurchaseOrdersPage.tsx src/pages/DashboardPage.tsx scripts/verify-completed-work.cjs
git commit -m "fix: reconcile shop completion across work orders and billing"
git push origin main
```

There is **no automatic database change**. In Supabase SQL Editor you can run the `READ_ONLY_COMPLETION_AUDIT.sql` query for exact record counts. Backfill records missing real finished measurements require owner verification. `OPTIONAL_SAFE_SINGLE_LINE_LINK_REPAIR.sql` ends with ROLLBACK intentionally.
