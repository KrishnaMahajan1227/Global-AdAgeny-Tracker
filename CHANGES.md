# Files the installer will modify (all existing screens reused)

- `src/pages/PurchaseOrdersPage.tsx`: final-stage shop percent in list/mobile/modal and centered modal in place of Work Order drawer.
- `src/pages/DashboardPage.tsx`: stage-aware live operational shop progress and partial client delivery.
- `src/pages/ShopsPages.tsx`: Client directory partial completion derived from shop statuses.
- `src/pages/AgencyHierarchyPage.tsx`: client/campaign work-order delivery derived from linked shops.
- `src/pages/WorkProgressPage.tsx`: stage-aware final status for dispatched supply-only vs installed installation work.
- `src/lib/workCompletion.ts` (**added**): canonical calculation helper.

No other file modified. No deletion. No DB migration. No dependencies. No updated source TSX is included directly in ZIP to avoid overwriting other changes: the installer generates it from the exact verified main files.
