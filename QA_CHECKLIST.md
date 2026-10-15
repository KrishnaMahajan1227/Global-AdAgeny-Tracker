# QA / Release Checklist

1. Owner/admin: `/purchase-orders` shows type filter in main toolbar (All Work Types, Survey + Install, Supply Only, Direct Installation) and no Supply Orders sidebar link.
2. Filter Supply Only: only orders with `fulfillment_type='supply_only'` remain; refresh and browser Back preserve correct URL and selection; combined status/client filters work.
3. Desktop: order row opens original detail drawer. Supply Only row also offers direct `Manage Supply`; neither action bubbles incorrectly. Mobile: tap row for detail, or separate Manage Supply shortcut.
4. Supply workflow: Entries & Design and Dispatch tabs operate on selected Work Order. Back returns to selected Work Order. Existing create/edit/dispatch data and permissions stay intact.
5. Old `/supply-orders` URL redirects to Work Orders Supply workflow, not a blank or 404 page. Protected route rejects unauthorized users.
6. Owner/admin delete: not visibly primary; click More actions, then Delete, then existing confirmation. Cancel confirmation retains the Work Order, linked shops, invoices and photos.
7. Test account role, financial access, mobile/tablet breakpoint, keyboard focus and missing/empty Shop/PO data.
8. Verify `npm run typecheck`, `npm run lint`, `npm run build`; then review Work Order edit/delete and Supply flows on a staging Supabase database before deploying.

_Source TSX syntax parsing passed. Full build/typecheck and live Supabase/browser tests were not run successfully in this environment because installed type dependencies are incomplete._
