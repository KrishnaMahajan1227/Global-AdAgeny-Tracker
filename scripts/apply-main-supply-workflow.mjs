/**
 * AdRoute Main — minimal-diff supply-only integration.
 * Apply on existing main (no pull/reset/force push). Validates exact source blobs first.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const project = path.resolve(process.argv[2] || process.cwd());
const testMode = process.argv.includes('--test-only');
const patchRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = [
  'src/components/AdminLayout.tsx',
  'src/App.tsx',
  'src/pages/PurchaseOrdersPage.tsx',
  'src/pages/SupplyOrdersPage.tsx',
];
const expected = {
  'src/components/AdminLayout.tsx': 'e52a7722978ca6186953d842611e3f49cc3fe672',
  'src/App.tsx': '994435cfad2b67b4e69691485195d40b87b0cd28',
  'src/pages/PurchaseOrdersPage.tsx': '3431406ddd701959028c8ea5be8f24031dbf7c67',
  'src/pages/SupplyOrdersPage.tsx': '0a37687759c9d64460877425cabff1466bdccc15',
};
function blobHash(contents) {
  const bytes = Buffer.from(contents);
  return crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}
function exactly(input, needle, replacement, file) {
  const count = input.split(needle).length - 1;
  if (count !== 1) throw new Error(`Could not safely locate unique anchor in ${file}: found ${count} matches for ${needle.slice(0, 100)}`);
  return input.replace(needle, replacement);
}
async function main() {
  if (!testMode) {
    const { execFileSync } = await import('node:child_process');
    const branch = execFileSync('git', ['branch', '--show-current'], { cwd: project, encoding: 'utf8' }).trim();
    if (branch !== 'main') throw new Error(`Current branch must be main, found ${branch}`);
    if (execFileSync('git', ['status', '--porcelain'], { cwd: project, encoding: 'utf8' }).trim()) {
      throw new Error('Working tree must be clean. Commit current work before applying this patch.');
    }
  }
  const original = Object.fromEntries(files.map(f => [f, fs.readFileSync(path.join(project, f), 'utf8')]));
  if (!testMode) for (const file of files) {
    const sha = blobHash(original[file]);
    if (sha !== expected[file]) throw new Error(`Source mismatch: ${file}. Current ${sha}; expected main ${expected[file]}. Nothing changed. Merge this patch with your latest code instead.`);
  }
  const changed = { ...original };
  let s = changed['src/components/AdminLayout.tsx'];
  s = exactly(s, "  Map as MapIcon, ClipboardCheck, ClipboardList, Truck, Route as RouteIcon, User,", "  Map as MapIcon, ClipboardCheck, ClipboardList, Route as RouteIcon, User,", 'AdminLayout');
  s = exactly(s, "    { to: '/supply-orders', label: 'Supply Orders', icon: Truck, show: isAdmin || isAccounts },\n", '', 'AdminLayout');
  changed['src/components/AdminLayout.tsx'] = s;

  s = changed['src/App.tsx'];
  s = exactly(s, "import SupplyOrdersPage from '@/pages/SupplyOrdersPage';\n", '', 'App');
  s = exactly(s, `<ProtectedRoute allowedRoles={FINANCIAL_ROLES}><SupplyOrdersPage /></ProtectedRoute>`, `<ProtectedRoute allowedRoles={FINANCIAL_ROLES}><Navigate to="/purchase-orders?type=supply_only&workflow=supply" replace /></ProtectedRoute>`, 'App');
  changed['src/App.tsx'] = s;

  s = changed['src/pages/PurchaseOrdersPage.tsx'];
  s = exactly(s, "import { useSearchParams, Link } from 'react-router-dom';", "import { useSearchParams, Link } from 'react-router-dom';\nimport SupplyOrdersPage from '@/pages/SupplyOrdersPage';", 'PurchaseOrders');
  s = exactly(s, "export default function PurchaseOrdersPage() {", `/** Supply Only execution is a mode of the canonical Work Orders route, not a new sidebar page. */
export default function PurchaseOrdersPage() {
  const [routeParams] = useSearchParams();
  if (routeParams.get('workflow') === 'supply') {
    return <SupplyOrdersPage
      embedded
      workOrderId={routeParams.get('po') || ''}
      initialTab={routeParams.get('step') === 'dispatch' ? 'dispatch' : 'entries'}
    />;
  }
  return <WorkOrdersList />;
}

function WorkOrdersList() {`, 'PurchaseOrders');
  s = exactly(s, "  const [fulfillmentFilter, setFulfillmentFilter] = useState('');", `  const urlType = searchParams.get('type') || '';
  const [fulfillmentFilter, setFulfillmentFilter] = useState(() => new URLSearchParams(window.location.search).get('type') || '');
  useEffect(() => { setFulfillmentFilter(urlType); }, [urlType]);
  const changeFulfillmentFilter = (type: string) => {
    if (type && !FULFILLMENT_OPTIONS.some(option => option.value === type)) return;
    setFulfillmentFilter(type);
    setSearchParams(current => {
      const next = new URLSearchParams(current);
      if (type) next.set('type', type); else next.delete('type');
      next.delete('order');
      return next;
    }, { replace: true });
  };`, 'PurchaseOrders');
  s = exactly(s, `<p className={po.name ? 'text-xs text-slate-400 mt-0.5' : 'font-semibold text-slate-900'}>{po.po_number}</p>`, `<p className={po.name ? 'text-xs text-slate-400 mt-0.5' : 'font-semibold text-slate-900'}>{po.po_number}<span className="ml-2 text-[11px] font-medium text-blue-700">{fulfillmentTypeLabel(po.fulfillment_type)}</span></p>`, 'PurchaseOrders');
  s = exactly(s, `{po.po_number} · {po.clients?.name || 'Client not set'}`, `{po.po_number} · {po.clients?.name || 'Client not set'} · {fulfillmentTypeLabel(po.fulfillment_type)}`, 'PurchaseOrders');
  s = exactly(s, `        <select aria-label="Sort work orders" value={sortBy}`, `        <select aria-label="Filter by fulfillment type" value={fulfillmentFilter} onChange={(e) => changeFulfillmentFilter(e.target.value)} className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-600">
          <option value="">All fulfillment types</option>
          {FULFILLMENT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        {fulfillmentFilter === 'supply_only' && <Link to="/purchase-orders?type=supply_only&workflow=supply" className="inline-flex items-center rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm font-medium text-blue-700 hover:bg-blue-100">Supply execution →</Link>}
        <select aria-label="Sort work orders" value={sortBy}`, 'PurchaseOrders');
  s = exactly(s, `onClear={() => { setStatusFilter(''); changeClientFilter(''); setFulfillmentFilter(''); setCampaignFilterValue(''); setZoneFilter(''); }}`, `onClear={() => { setStatusFilter(''); changeClientFilter(''); changeFulfillmentFilter(''); setCampaignFilterValue(''); setZoneFilter(''); }}`, 'PurchaseOrders');
  s = exactly(s, `<select value={fulfillmentFilter} onChange={(e) => setFulfillmentFilter(e.target.value)}`, `<select value={fulfillmentFilter} onChange={(e) => changeFulfillmentFilter(e.target.value)}`, 'PurchaseOrders');
  s = exactly(s, `                      <ChevronRight className="w-4 h-4 text-slate-300 group-hover:text-blue-500 transition-colors" />`, `                      {po.fulfillment_type === 'supply_only' ? (
                        <Link to={\`/purchase-orders?type=supply_only&workflow=supply&po=\${encodeURIComponent(po.id)}\`} onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()} className="whitespace-nowrap text-xs font-medium text-blue-700 hover:underline" aria-label={\`Manage supply for \${po.name || po.po_number}\`}>Manage supply →</Link>
                      ) : <ChevronRight className="w-4 h-4 text-slate-300 group-hover:text-blue-500 transition-colors" />}`, 'PurchaseOrders');
  s = exactly(s, `          <Link to={\`/shops?po=\${po.id}\`} className="flex items-center gap-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 px-3.5 py-2 rounded-lg text-sm font-medium transition">`, `          {po.fulfillment_type === 'supply_only' && (
            <Link to={\`/purchase-orders?type=supply_only&workflow=supply&po=\${encodeURIComponent(po.id)}\`} className="inline-flex items-center rounded-lg bg-blue-600 px-3.5 py-2 text-sm font-medium text-white hover:bg-blue-700">Manage supply →</Link>
          )}
          <Link to={\`/shops?po=\${po.id}\`} className="flex items-center gap-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 px-3.5 py-2 rounded-lg text-sm font-medium transition">`, 'PurchaseOrders');
  changed['src/pages/PurchaseOrdersPage.tsx'] = s;

  // Standalone supply screen is the same existing component, embedded by PurchaseOrdersPage.
  changed['src/pages/SupplyOrdersPage.tsx'] = fs.readFileSync(path.join(patchRoot, 'src/pages/SupplyOrdersPage.tsx'), 'utf8');

  // All anchors checked and files prepared before writing anything.
  const backups = path.join(project, '.git', 'adroute-supply-backup-' + Date.now());
  fs.mkdirSync(backups, { recursive: true });
  for (const file of files) {
    const dst = path.join(backups, file);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(project, file), dst);
  }
  for (const [file, contents] of Object.entries(changed)) fs.writeFileSync(path.join(project, file), contents, 'utf8');
  console.log('Updated 4 existing files. Backups: ' + backups);
  console.log('Run typecheck, lint, build and browser review before pushing to main.');
}
main().catch(e => { console.error('APPLY ABORTED:', e.message); process.exitCode = 1; });
