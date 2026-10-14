# CHANGES — agency dashboard / Campaigns UI removal

- `src/pages/DashboardPage.tsx`: Replace large filter/leaderboard display with compact operational KPIs, searchable client delivery table, action queue, and client monitoring. No monetary panels.
- `src/pages/AgencyHierarchyPage.tsx`: Existing client detail now shows direct work-order list; campaign grouping UI removed. Historical campaign detail component retained in source for compatibility, not exposed in navigation.
- `src/App.tsx`: Old agency campaign detail URLs redirect to Clients; client bookmarked detail URLs still resolve. Client portal campaign routes remain unchanged for existing client users.

Deleted files: none. Dependencies: none. Database migrations/SQL: **none**. No tables, foreign keys, campaigns, projects, or work orders are deleted or modified.

## Safety and testing
This patch changes only frontend display/navigation. It cannot migrate or destroy Supabase records. Never delete campaign/project tables or cascade their foreign keys. Always backup code and database before deployment. Build and authenticated browser/RLS tests must be completed on your machine before production deployment.

Unchanged: Work Orders canonical list/drawer; Clients CRUD; client portal; billing and all operational pages.
