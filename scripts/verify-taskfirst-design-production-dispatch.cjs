/** Source contract checks for the task-first Design / Production / Dispatch optimization.
 * Run after npm ci: node scripts/verify-taskfirst-design-production-dispatch.cjs
 * These checks are not a substitute for authenticated Supabase E2E tests.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const d = read('src/pages/DesignerPage.tsx');
const p = read('src/pages/ProductionPage.tsx');
const s = read('src/pages/SupplyOrdersPage.tsx');
let checks = 0;
function ok(title, condition) { assert.ok(condition, title); checks++; console.log(`PASS ${title}`); }
function matches(src, expression) { return expression.test(src); }

ok('Design opens task-first for both owner and Designer', d.includes('const [browsingList, setBrowsingList] = useState(true)'));
ok('Production opens actual task list rather than owner Overview', p.includes("useState<'overview' | 'production' | 'vehicle_load'>('production')"));
ok('Design uses review queue by default and linked PO is not hidden', d.includes("(linkedPoId ? 'all' : 'in_review')"));
ok('Both studios keep the streamlined Client → Work Order → Zone hierarchy', [d,p].every(src => src.includes('clientFolders') && src.includes('poFolders') && src.includes('zoneFolders')) && !p.includes("level === 'campaign'"));
ok('Task and folder modes have accessible semantics', [d,p].every(src => src.includes('aria-pressed=') && src.includes('Action Queue') && src.includes('Browse Folders')));
ok('Deep-linked Work Order remains scoped', [d,p].every(src => src.includes('validWorkOrderId(routeParams.get(\'po\'))') && src.includes('setPoFilter(linkedPoId)')));
ok('Default queue does not require full org-wide tree download', [d,p].every(src => src.includes('enabled: !!orgId && !browsingList && !debouncedSearch') && src.includes('fetchWorkflowFolderPages(async (from, to)')));
ok('List remains server-paginated and has controlled search', [d,p].every(src => src.includes("count: 'exact'") && (src.includes('.range(page * pageSize, page * pageSize + pageSize - 1)') || src.includes('.range(pageNumber * size, pageNumber * size + size - 1)')) && src.includes('debouncedSearch')));
ok('Design search can locate Work Orders directly', d.includes('po_number.ilike.%${term}%') && d.includes('po_name.ilike.%${term}%'));
ok('Clickable KPI shortcuts jump to relevant Design queues', d.includes("setActiveTab('in_review')") && d.includes("setActiveTab('approved')") && d.includes('aria-label={`Show ${label} tasks`}'));
ok('Agency-supplied artwork still bypasses unnecessary Designer assignment', s.includes("form.artwork_source === 'agency' ? effectiveDesignerId : null"));
ok('Single Designer preselected but multiple people require explicit choice', s.includes('designers?.length === 1 ? designers[0].id') && s.includes('Choose the assigned designer'));
ok('Supply entry is still associated to the original PO and line', s.includes('po_line_item_id: selectedLineItem.id') && s.includes('purchase_order_id: selectedPO.id'));
ok('One-click zone dispatch opens the existing confirmation modal, never auto-dispatches', s.includes('Prepare dispatch (') && s.includes('setCreateOpen(true)') && s.includes("supabase.rpc('phase4_create_supply_dispatch'"));
ok('Dispatch still limits server batch to 200', s.includes('const MAX_DISPATCH_DESTINATIONS = 200') && s.includes('shops.slice(0, MAX_DISPATCH_DESTINATIONS)'));
ok('Large zone list renders at most 12 initially then increments in 50s', s.includes('shops.slice(0, visibleZoneCounts[zoneName] ?? 12)') && s.includes("(prev[zoneName] ?? 12) + 50"));
ok('Route receipt cards are compact and expand per route', s.includes('expandedRouteIds.has(route.id)') && s.includes('aria-controls={`dispatch-route-${route.id}`}'));
ok('Pending receipt routes rank first without changing delivery status', s.includes('Number(pendingCount(b) > 0)') && s.includes('Number(pendingCount(a) > 0)'));
ok('Only Owner/Admin confirm actual delivery, through the existing atomic RPC', s.includes("profile?.role === 'agency_owner' || profile?.role === 'admin'") && s.includes("supabase.rpc('phase4_confirm_supply_receipt'"));
ok('Delivery receipt realtime listener updates the shared app state', s.includes("'supply_delivery_receipts'") && s.includes('useRealtimeInvalidate'));
ok('Single production status change uses compare-and-swap against stale row state', p.includes(".eq('status', editOrder.status).select('id')") && p.includes('changed in another session'));
ok('Bulk status change avoids stale-write overwrites with retryable failures', p.includes(".eq('status', row.status).select('id')") && p.includes('status changed elsewhere'));
ok('Company approval, production and delivery RPC gates remain unchanged', d.includes('CompanyApprovalHandoff') && d.includes("supabase.rpc('phase3_send_to_production'") && p.includes("supabase.rpc('phase3_complete_production'") && s.includes("supabase.rpc('phase4_confirm_supply_receipt'"));
ok('Batch helper still retains per-item failures for retry', [d,p].every(src=>src.includes('result.failed.map(f => f.item)')));
for (const file of ['src/pages/DesignerPage.tsx','src/pages/ProductionPage.tsx','src/pages/SupplyOrdersPage.tsx']) {
  const compiled = ts.transpileModule(read(file), { fileName:file, compilerOptions:{ module:ts.ModuleKind.CommonJS, target:ts.ScriptTarget.ES2022, jsx:ts.JsxEmit.ReactJSX }, reportDiagnostics:true });
  assert.equal((compiled.diagnostics || []).filter(diag=>diag.category===ts.DiagnosticCategory.Error).length,0,`${file} TS/TSX diagnostics`);
  checks++;
  console.log('PASS TSX:',file);
}
console.log(`ALL ${checks} TASK-FIRST WORKFLOW CHECKS PASSED`);
