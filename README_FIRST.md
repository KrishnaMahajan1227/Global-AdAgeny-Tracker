# AdRoute — Agency progression: Verified-apply release

## Why the screenshot is still old

As checked against GitHub `KrishnaMahajan1227/Global-AdAgeny-Tracker` branch `main`, the five original source blob hashes remain the audited pre-fix hashes and the shared `src/lib/workCompletion.ts` is absent. A prior ZIP contained a contextual patch script. Extracting it **did not** by itself modify any project TSX files; running its installer and pushing to `main` was essential. This release highlights source application and verifies it.

## Scope

- Dashboard: canonical final-stage grouping, client percent by actual shops; 20-second polling and realtime invalidate.
- Clients directory: per-client actual physical progress, visible 25 clients, page-scoped paginated query.
- Work Orders: desktop and mobile final-stage shop completion; measured financial completion retained separately.
- Work Order details: original content and actions moved from right drawer to the existing centered Modal; measured PO quantities kept distinct from shop completion.
- Client/campaign detail: per-order percent based on shops, not only Work Order `closed` status.
- Work Progress: Supply Only dispatch completes, installation orders require installation final stage.

### How status works

Supply Only: dispatched/delivered/billed is final.
Survey + Install / Direct Install: installed/billed is final.
Surveyed, approved, design, production, dispatched-installation, installing, and installation_review are **not** final. Cancelled/rejected are excluded from active count. No work items are fabricated and quantities are not overwritten. A PO with no linked shops is not assigned an arbitrary completion percentage.

**Shop operational % is distinct from measured PO utilization and invoiced %**. If a historically imported installed shop has no measurements, that shop counts as operationally final but its amount is not fabricated.

## Steps (Windows PowerShell)

1. Save this ZIP to Downloads and extract it to a temporary folder **outside the app project**.
2. Ensure `D:\DarshanAdField` is on clean `main` (script stops if not).
3. Open PowerShell:

```powershell
$zip = "$HOME\Downloads\AdRoute_Agency_Progress_Reliable_MAIN.zip"
$temp = "$env:TEMP\AdRouteAgencyProgress"
Expand-Archive -LiteralPath $zip -DestinationPath $temp -Force
& "$temp\RUN_AND_VERIFY.ps1" -ProjectRoot 'D:\DarshanAdField'
```

`RUN_AND_VERIFY.ps1` checks GitHub-main-matching hashes, generates **actual updated TSX files on disk**, verifies each screen really changed, runs progression regression checks, typecheck and Vite build. If anything fails, **do not push**. A source backup is stored inside `.git/adroute-progress-backup-...`.

4. Test client-specific Work Order `9011566350` with 96 installed of 144, confirming ~67% operational completion in Dashboard/Work Orders/Clients. Open it; detail must appear center, not right.
5. From Git Bash on `main`, after browser QA:

```bash
cd /d/DarshanAdField
git status
git add src/lib/workCompletion.ts src/pages/PurchaseOrdersPage.tsx src/pages/DashboardPage.tsx src/pages/ShopsPages.tsx src/pages/AgencyHierarchyPage.tsx src/pages/WorkProgressPage.tsx
git commit -m "fix: synchronize agency completion and center work order detail"
git push origin main
```

6. Verify the Vercel deployment is using the new main commit. Hard-refresh the PWA if the old service worker is cached.

## Guardrails

No SQL migrations or database writes, no roles/RLS change, no invoice reset, no UI changes to Sidebar/Breadcrumbs/Reports/Field forms. Other current features should be verified manually. If the repository has newer local changes than the audited main, script stops instead of overwriting them; merge these changes in those files rather than forcing an overwrite.

## Limits

Tested source and status calculation logic only. **No direct access to live Supabase or a browser session**; financial reconciliation and browser action correctness require QA. No claim of full project build verification in this environment.
