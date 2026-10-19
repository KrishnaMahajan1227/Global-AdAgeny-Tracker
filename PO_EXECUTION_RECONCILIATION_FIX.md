# Darshan Ad Agency — Work Order Evidence & Utilization Reconciliation

## User-facing issue
Example: PO 9011566350 (7D Standee) shows 96/144 linked sites installed, while utilization SQL view shows 0 installed pieces against a PO budget of 1,000 pieces. The two calculations use different underlying evidence: shop status vs item-level quantity grouped by `work_items.po_line_item_id`. A legacy item with a missing PO-line ID does not appear in the SQL view, even if the item itself records installed quantity.

## Source changes
- `src/lib/poExecutionReconciliation.ts` (new): reads only the selected Work Order's shops/work-items and reconciles item measurements with the matching PO line. Match order: explicit valid line ID; uniquely matching work type; uniquely matching description; single-line PO. All ambiguous or foreign line IDs are excluded and reported. It never writes historical records or fabricates quantities from shop counts.
- `src/pages/PurchaseOrdersPage.tsx`: lazy, per-PO reconciliation query; clearer current/passed stage blocks; drilled-down current site stage links; concise data-quality exceptions; measured quantities only on demand. It suppresses misleading zero-value utilization tables while records are loading or unavailable and labels missing measurements as “Not recorded”. Work/Financial privacy remains unchanged.
- `src/lib/poUtilization.ts`: survey-vs-plan variance requires a measured survey. A blank/zero survey record is no longer automatically labeled a variance.
- `scripts/verify-po-execution-reconciliation.cjs` (new): 12 regression scenarios including legacy line link recovery, installed vs unrecorded items, cancelled sites, custom and supply fulfillment, and false variance.

## Important integrity distinctions
1. **Delivery progress** counts active shop statuses at the final required fulfillment stage. Example: 96/144 = 67% for this Work Order.
2. **Item measured progress** counts actual recorded work-item quantities/area, after conservative read-only PO-line matching. `1 installed site` is NOT assumed to equal `1 PO piece`; 144 shops can have an independent 1,000-piece contract.
3. **Invoice eligibility** still uses the existing completion / invoice allocation engine, including previous invoices, rates, and UOM conversions; matching a legacy work item in the operational display does not bypass invoice validation.
4. If the original work items have no installed/approved quantity whatsoever, the application cannot reconstruct it safely. The Work Order now explicitly reports the affected sites and routes to their shop records so actual execution can be reconciled.
5. Custom types use their line-specific final required stage. Square-foot production is not labeled complete solely from produced piece count unless comparable approved area/quantity exists.

## Verification in this environment
- `node scripts/verify-po-execution-reconciliation.cjs` — 12 tests passed.
- `node scripts/verify-owner-billing-readiness.cjs` — 23 tests passed.
- `node scripts/verify-owner-dashboard-compact.cjs` — 8 tests passed.
- `node scripts/verify-owner-ux-stage-routing.cjs` — 15 tests passed.
- `node scripts/verify-runtime-jsx-symbols.cjs` — 61 TSX files parsed and symbols checked.
- Full Vite build, authenticated live Supabase reconciliation, and browser deployment tests **not verified**: complete node_modules dependencies and production connection are unavailable in this environment.

## Recommended live smoke test
Open 7D Standee in Work Orders → Work; confirm 96/144 delivery remains 67%. Expand Recorded work-item quantities: quantities should reflect measured work items wherever unambiguous evidence exists. Any remaining "delivered site(s) need measurement reconciliation" should link to the exact PO's delivered shops. Select Financial privately; compare ready-to-invoice with Billing's unbilled allocations; confirm historical invoices are not duplicated. Repeat for Supply Only, Direct Installation, Custom, and orders with multiple PO lines. Check Survey Review and Installation Review changes trigger query invalidation/refetch in the Work Order detail.

## Deployment
Preserve your local `.env`; it is intentionally not packaged. Extract the archive's `Darshan_Ad_Agency/` source, install dependencies with `npm ci`, then run `npm run typecheck` and `npm run build` in your own environment before deploying. The existing Supabase migrations in this ZIP are unchanged; this patch requires no new migrations.
