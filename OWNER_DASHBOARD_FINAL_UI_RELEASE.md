# Darshan Ad Agency — Professional Owner Dashboard & Sidebar UX

Release: 2026-10-17

## Dashboard changes
- Removed the oversized dashboard title/intro panel.
- Replaced uneven, stacked two-column layout that left a large blank region with consistently flowing full-width sections.
- Four compact clickable operational KPIs: open Work Orders, owner-action queue, delivered sites, and site completion.
- Priority follow-up rows show client, PO, job, action, and linked-site delivery evidence.
- Work Orders by client is a dense responsive, searchable tracker with work-stage links, current status, fulfillment type, order age, and direct actions.
- Quick access actions link to survey review, design, production, installation review, and field map.
- Site pipeline is one compact full-width strip showing only active nonzero stages, without large empty cells. Links show orders with sites at each stage.
- Client delivery rows show linked sites, completed and open orders, and direct client/PO navigation.
- Values involving money remain behind the explicit owner-only Financial view. Work mode is default and no money fetch is made while in that mode.
- No inferred delivery deadline is presented as a confirmed delay/overdue status; 30+ day figure is an age indicator only.

## Sidebar
- Sidebar now uses a true fixed viewport-height flex column, rather than a fixed navigation max-height.
- Navigation takes only available space and scrolls when genuinely needed. Visible native scrollbar is hidden while scroll remains available to wheel, touch, and keyboard users.
- Account footer and sign-out remain visible independently of nav scroll.
- Improved collapsed and mobile navigation affordances; mobile Escape closes and background scroll is locked while open.

## Work Order stage detail navigation
- Passed downstream-inferred milestones now open the complete related sites list, instead of incorrectly filtering to a no-longer-current historical stage and returning empty results.
- Current-stage drill downs remain stage-specific.

## Modified application files
- src/pages/DashboardPage.tsx
- src/components/AdminLayout.tsx
- src/index.css
- src/pages/PurchaseOrdersPage.tsx

## Verification
- 61 TSX files parsed, JSX symbol/import check passed.
- 8 new compact dashboard/sidebar checks passed.
- 15 existing Work Order and dashboard stage-routing checks passed.
- 23 owner billing-readiness regressions passed.
- 14 PO progress calculation regressions passed.
- 12 completed-work checks plus four syntax parses passed after bringing historical test expectation in line with downstream-installed supply-only completion.
- Existing agency progress regressions passed.
- Full Vite application build and live Supabase/browser testing were not possible in this isolated environment (offline npm cache missing dependencies). These are required before production sign-off.

## Deployment
- Use your existing private .env. No .env, secrets, or node_modules are packaged.
- Run npm ci, npm run typecheck, npm run build, then check dashboard/sidebar interactions on desktop and mobile and verify each Work Order route with live data.
