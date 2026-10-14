# CHANGES

## Modified
- `src/App.tsx`: redirect duplicate Campaigns routes to Clients and keep route role guards.
- `src/components/AdminLayout.tsx`: remove Campaigns navigation item.
- `src/pages/DashboardPage.tsx`: remove page title and duplicate widgets; add persisted filter-based table and compact KPI/attention layout.
- `src/pages/AgencyHierarchyPage.tsx`: client campaign accordion with inline order links and shared rendering on bookmarked campaign details.

## Deleted files
None. Legacy `CampaignsPage` remains inside `ShopsPages.tsx` because deleting it safely also requires migrating agency-owned campaign CRUD into the Clients screen; that workflow was not fully implemented here. `WorkProgressPage.tsx` remains unreferenced.

## Dependencies and database
None changed. No SQL migration. **Do not run db push/reset** without RLS migration review.

## Verification
- Reviewed uploaded src.zip and three screenshots.
- Build: NOT VERIFIED (project's pre-existing `node_modules` is incomplete).
- Type-check: BLOCKED (`TS2688` missing Babel/React type definitions in existing project install).
- Lint: NOT VERIFIED (dependencies unavailable).
- Live owner/member/client QA and Supabase RLS: NOT VERIFIED.
- Completion timestamp, per-work-order due date, and PO assignee data missing from inspected PO schema: team leaderboard, on-time rate and overdue-work-order count cannot honestly be implemented from current columns.

## PowerShell (from actual project root)
```
$project = 'C:\PATH\TO\EXISTING\ADROUTE'
$zip = "$env:USERPROFILE\Downloads\AdRoute_source_patch.zip"
Set-Location $project
git status
git switch -c backup-before-client-folder-redesign
Expand-Archive -LiteralPath $zip -DestinationPath $project -Force
npm ci
npm run typecheck
npm run lint
npm run build
npm run dev
```
Do not commit/push/deploy if any check fails. Verify live role access and work-order drawer first.
