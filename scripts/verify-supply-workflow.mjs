import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(process.argv[2] || process.cwd());
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const nav = read('src/components/AdminLayout.tsx');
const app = read('src/App.tsx');
const orders = read('src/pages/PurchaseOrdersPage.tsx');
const supply = read('src/pages/SupplyOrdersPage.tsx');
const checks = [
  ['No separate Supply Orders sidebar entry', !nav.includes("label: 'Supply Orders'")],
  ['Existing Work Orders sidebar entry preserved', nav.includes("label: 'Work Orders'")],
  ['Supply route retains role guard', app.includes('path="/supply-orders"') && app.includes('allowedRoles={FINANCIAL_ROLES}')],
  ['Old Supply URL redirects to existing Work Orders', app.includes('to="/purchase-orders?type=supply_only&workflow=supply"')],
  ['Supply workflow uses existing source component', orders.includes("import SupplyOrdersPage from '@/pages/SupplyOrdersPage'")],
  ['Work Orders default listing preserved', orders.includes('function WorkOrdersList()')],
  ['Work Orders supports all three fulfillment types', orders.includes('FULFILLMENT_OPTIONS') && orders.includes('Filter by fulfillment type')],
  ['Selected Work Order filters are URL-aware', orders.includes("searchParams.get('type')") && orders.includes('changeFulfillmentFilter')],
  ['Per-PO supply action available', orders.includes('Manage supply →') && orders.includes('workflow=supply&po=')],
  ['Inline supply can select an exact PO', supply.includes('workOrderId') && supply.includes('visibleSupplyPOs')],
  ['Supply workflow retains Design + Dispatch tabs', supply.includes("openTab('entries')") && supply.includes("openTab('dispatch')")],
  ['Supply workflow steps persist in URL', supply.includes("next.set('step', 'dispatch')")],
  ['Supply queries org-scoped', supply.includes(".eq('organization_id', orgId)")],
  ['Supply only fetch and dispatch retained', supply.includes(".eq('fulfillment_type', 'supply_only')") && supply.includes(".from('routes').insert")],
  ['Paginated Supply data fetch', supply.includes('fetchAllPages<')],
];
let bad = 0;
for(const [title, ok] of checks){ console.log(`${ok ? 'PASS' : 'FAIL'}  ${title}`); if(!ok)bad++; }
console.log(`${checks.length-bad}/${checks.length} static regression checks passed`);
if (bad) process.exitCode=1;
