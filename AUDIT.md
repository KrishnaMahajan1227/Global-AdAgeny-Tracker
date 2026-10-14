# AUDIT — uploaded src.zip (2026-10-14)

## Scope and source limitations
Source archive contains 101 files under `src/`; also inspected existing project package scripts and prior code context. The archive DOES NOT contain the database migrations or package.json. Permission policies therefore cannot be audited or certified from this input alone. Three user screenshots show deployed pages, not proof of backend policies. No live browser session was available.

## A. Actual route map
Public routes: `/`, `/how-it-works`, `/for-agencies`, `/for-clients`, `/login` (LandingPage, PublicInfoPage, LoginPage).
Super admin: `/superadmin` (SuperAdminPage; `super_admin` only).
Field workers: `/mobile` (MobileRouter; `surveyor`/`installer` only).
Client organization portal: `/client` and `/client/campaigns`, `/client/campaigns/:campaignId`, `/client/campaigns/:campaignId/po/:poId`, `/client/shops`, `/client/agencies`, `/client/reports`, `/client/account` (ClientPortalPage with `pages/client/*`; `client_admin`/`client_viewer`). These are DIFFERENT from agency staff screens and must remain.
Agency administration: `/dashboard` (DashboardPage), `/clients` (ClientsPage in ShopsPages.tsx; detail via `?detail=id` and AgencyHierarchyPage), `/purchase-orders` (PurchaseOrdersPage; drawer `?order=id`), `/supply-orders` (SupplyOrdersPage), `/shops`/`/shops/:shopId` (ShopsPage/ShopDetailPage), `/survey-review` (SurveyReviewPage), `/design` (DesignerPage), `/production` (ProductionPage), `/installation-review` (InstallationReviewPage), `/field-map` (FieldMapPage), `/route-planning` (RoutePlanningPage), `/reports` (ReportsPage), `/billing` (BillingPage), `/owner` (OwnerConsolePage), `/account` (AccountSettingsPage).
Aliases: `/clients/:id` goes to the canonical client detail; `/campaigns`, `/projects` and `/progress` redirect to canonical routes. Historical `/campaigns/{project|client}/:id` redirects to Clients but does not reconstruct exact client ownership for all bookmarks. Role checks are in `App.tsx`; link visibility also in `AdminLayout.tsx`.

### Sidebar (original order)
- Dashboard → `/dashboard`
- Clients → `/clients`
- Work Orders → `/purchase-orders`
- Supply Orders → `/supply-orders`
- Survey Review → `/survey-review`
- Design Queue → `/design`
- Production → `/production`
- Installation Review → `/installation-review`
- Live Field Map → `/field-map`
- Route Planning → `/route-planning`
- Reports → `/reports`
- Billing → `/billing`
- Owner Console → `/owner`
- My Account → `/account`

## B. Data model
`clients` (id, organization_id, name, is_active) ← `projects` (client_id, start_date, end_date, status) ← `purchase_orders` (client_id, project_id nullable, campaign_id nullable, po_number, name, status, assignment_status, created_at). `campaigns` is a SEPARATE client-org-owned table linked through purchase_orders.campaign_id; it is NOT synonymous with projects. `po_line_items`, shop deployments, utilization and invoice/payment tables support operations and financial detail. `profiles` and role-restricted auth comprise staff. The PO schema does not expose a canonical PO due date, assignee, priority or completion timestamp. Role values include agency_owner, admin, client_manager, accounts, designer, printing, surveyor, installer, demo, client_admin, client_viewer, super_admin.

## C. Shared component map
`components/ui.tsx` includes existing ProgressBar, StatusBadge, Card, Input, Select, Modal, Drawer, FilterButton, FilterDrawer, Pagination, and other UI primitives. They are used by Clients/Campaigns, PurchaseOrders and agency hierarchy. Domain-specific components include charts, review panels, shop WorkItemsPanel, field map canvases, capture and photo components. Components found with exported declarations:

- components/AdminLayout.tsx: AdminLayout
- components/BoardMarkerCanvas.tsx: BoardMarkerCanvas
- components/BurndownChart.tsx: BurndownChart
- components/CameraCapture.tsx: CameraCapture
- components/DesignMarkingPreview.tsx: DesignMarkingPreview
- components/DonutChart.tsx: DonutChart
- components/FieldNavigation.tsx: FieldNavigation
- components/InstallationPhotoGrid.tsx: InstallationPhotoGrid
- components/ItemLevelReviewPanel.tsx: ItemLevelReviewPanel
- components/LineItemProgressChart.tsx: LineItemProgressChart
- components/MarkedPhotoGrid.tsx: MarkedPhotoGrid
- components/NotificationBell.tsx: NotificationBell
- components/ShopForm.tsx: emptyShopFormValues, ShopForm
- components/SurveyCorrectionFixer.tsx: SurveyCorrectionFixer
- components/VehicleLoadLogView.tsx: VehicleLoadLogView
- components/VoiceMicButton.tsx: VoiceMicButton, VoiceSizeButton
- components/shop/EvidenceViewer.tsx: isImageUrl, MarkOverlay, EvidenceThumb, FileTile, EvidenceViewer
- components/shop/WorkItemsPanel.tsx: WorkItemsPanel
- components/ui.tsx: Modal, Drawer, FilterButton, FilterDrawer, FilterSection, Pagination, ConfirmDialog, StatusBadge, Card, ProgressBar, Input, Combobox, Select, Textarea, EmptyState, PageHeader

## D. Duplicate/overlap report
- Standalone `/campaigns` CampaignsPage in ShopsPages.tsx duplicates campaign browsing in client hierarchy. Canonical: Clients client folder. Sidebar entry removed and public agency route redirected. Legacy CampaignsPage implementation remains in source, unreachable by routing (retaining old CRUD handlers but not inventing an alternative editing screen).
- AgencyHierarchyPage originally showed a flat client work-order table AS WELL AS campaign cards. Canonical client folder now uses expandable campaigns with inline work-order list, so flat duplication is removed.
- WorkOrders PurchaseOrdersPage has a canonical full list and established detail drawer, with line-item utilization: preserve it. The client folder uses a compact linked summary, not a second editor.
- `WorkProgressPage` is legacy and `/progress` already redirects. Not referenced by the active App route map.
- The old dashboard duplicated client list, delivery snapshot and action summaries. Canonical redesigned one dashboard KPI strip, one progress table, leaderboard unavailability state, and one attention list.
- Work-order completion by closed/assignment-completed is centralized in `lib/agencyProgress.ts`, but PO physical-utilization percentage in PurchaseOrdersPage is a different metric; do not conflate these two.

## E. Click path
Dashboard → Client detail (1) → an already-expanded campaign work order link (2) → existing WorkOrders drawer. Where clients have multiple campaigns and the desired one is collapsed, expanding it requires another click (3 total). A strict 2-click guarantee for ALL work orders is therefore NOT achieved; do not claim otherwise.

## F. Exact change plan and implemented files
- `src/App.tsx`: disable standalone Campaigns route, point aliases to Clients, retain role route guards.
- `src/components/AdminLayout.tsx`: remove Campaigns sidebar entry, preserve ordering.
- `src/pages/DashboardPage.tsx`: replace duplicative owner screen with filter bar, 5 KPIs, one progress table and attention panel; show unsupported metrics as unavailable.
- `src/pages/AgencyHierarchyPage.tsx`: display client campaigns as inline accordions and keep work-order links to existing drawer; suppress duplicate flat list.
- `AUDIT.md`, `CHANGES.md`: audit and installation/verification details.

## Authorization findings
Route guards block unauthorized agency navigation via typed URLs and prevent rendering agency pages to client/field roles. Supabase RLS is the essential backend boundary. Migrations were NOT provided in the user archive, so RLS restrictions on campaigns/purchase_orders cannot be verified here. Do not treat these front-end changes as a backend security certification.
