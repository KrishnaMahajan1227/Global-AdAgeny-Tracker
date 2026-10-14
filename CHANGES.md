# Agency dashboard correction

- `src/pages/DashboardPage.tsx`: replaced repeated zero-percent/attention widgets with real agency operational snapshot: live orders, retail sites, shop-status delivery pipeline, pending acceptance, client delivery, and direct links to existing screens.
- No migrations, data writes, route changes, or dependencies.
- Preserves existing client, work-order, supply, survey, design, production and installation pages.
- Stage counts represent *current shop statuses*, not exact pending task counts; unknown statuses shown separately, never silently counted as complete.
- Due dates and on-time scores are intentionally omitted because purchase-order records do not provide reliable timestamps.

## Validation
- Source reviewed against uploaded project and existing typed entities.
- Build/lint/typecheck require installed dependencies; not certified as passing in this sandbox.
- Apply on a clean Git branch, run checks, test with Supabase, then deploy.
