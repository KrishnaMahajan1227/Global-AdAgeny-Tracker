/** Targeted, idempotent patch for the current main branch ShopsPages source.
 * No existing query/component/CRUD handler is replaced or reformatted.
 */
import fs from 'node:fs';
import os from 'node:os';
import pathLib from 'node:path';
const path = 'src/pages/ShopsPages.tsx';
if (!fs.existsSync(path)) throw new Error(`Open this from the project root: missing ${path}`);
const original = fs.readFileSync(path, 'utf8');
if (original.includes('shop-type-filter-canonical-v1')) {
  console.log('Shop filters are already installed; no changes needed.');
  process.exit(0);
}
function replaceOnce(source, from, to, label) {
  const occurrences = source.split(from).length - 1;
  if (occurrences !== 1) throw new Error(`${label}: incompatible source (${occurrences} matching anchors). No files were written.`);
  return source.replace(from, to);
}
const shopStart = original.indexOf('export function ShopsPage()');
if (shopStart < 0) throw new Error('ShopsPage not found.');
let prefix = original.slice(0, shopStart);
if (!prefix.includes("import { fetchAllPages } from '@/lib/paginatedQuery';")) {
  prefix = "import { fetchAllPages } from '@/lib/paginatedQuery';\n" + prefix;
}
let s = original.slice(shopStart);
const anchor = "  const poFilter = searchParams.get('po') || '';";
s = replaceOnce(s, anchor, `${anchor}
  // shop-type-filter-canonical-v1: filter URL persists across refresh and links
  const clientDirectoryFilter = searchParams.get('client') || '';
  const fulfillmentTypeFilter = searchParams.get('type') || '';`, 'filter URL');
const functionAnchor = "  function setPoFilter(id: string) {";
s = replaceOnce(s, functionAnchor, `  function setDirectoryFilter(key: 'client' | 'type', value: string) {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value); else next.delete(key);
    // Do not retain an unrelated PO after switching client/type.
    if (key === 'client' || key === 'type') next.delete('po');
    setSearchParams(next, { replace: true });
  }

  function clearDirectoryFilters() {
    const next = new URLSearchParams(searchParams);
    next.delete('client'); next.delete('type'); next.delete('po');
    setSearchParams(next, { replace: true });
  }

${functionAnchor}`, 'filter setter');
const resetAnchor = '}, [poFilter, statusFilter, debouncedCityFilter, debouncedDistrictFilter, debouncedStateFilter, zoneFilter, campaignFilter, debouncedSearch, pageSize]);';
s = replaceOnce(s, resetAnchor, '}, [poFilter, clientDirectoryFilter, fulfillmentTypeFilter, statusFilter, debouncedCityFilter, debouncedDistrictFilter, debouncedStateFilter, zoneFilter, campaignFilter, debouncedSearch, pageSize]);', 'pagination reset');
const originalPoQuery = "  // ---- ADD SHOP (Already In Progress)";
s = replaceOnce(s, originalPoQuery, `  const { data: directoryWorkOrders = [] } = useQuery({
    queryKey: ['shop-directory-workorders', orgId],
    queryFn: async () => fetchAllPages<{ id: string; name: string | null; po_number: string; client_id: string; fulfillment_type: string; status: string }>(
      (from, to) => supabase.from('purchase_orders')
        .select('id,name,po_number,client_id,fulfillment_type,status')
        .eq('organization_id', orgId).order('created_at', { ascending: false }).range(from, to),
    ),
    enabled: !!orgId,
  });
  const { data: directoryClients = [] } = useQuery({
    queryKey: ['shop-directory-clients', orgId],
    queryFn: async () => fetchAllPages<{ id: string; name: string }>(
      (from, to) => supabase.from('clients').select('id,name').eq('organization_id', orgId).order('name').range(from, to),
    ),
    enabled: !!orgId,
  });
  const filteredDirectoryOrders = directoryWorkOrders.filter(po =>
    (!clientDirectoryFilter || po.client_id === clientDirectoryFilter) &&
    (!fulfillmentTypeFilter || po.fulfillment_type === fulfillmentTypeFilter)
  );

${originalPoQuery}`, 'workorder options');
s = replaceOnce(s, 'const poEmbed = campaignFilter ? \'purchase_orders!inner(po_number, campaign_id)\' : \'purchase_orders(po_number)\';', "const poEmbed = (campaignFilter || fulfillmentTypeFilter) ? 'purchase_orders!inner(name,po_number,campaign_id,fulfillment_type)' : 'purchase_orders(name,po_number,fulfillment_type)';", 'PO join');
s = replaceOnce(s, "if (poFilter) query = query.eq('purchase_order_id', poFilter);", "if (poFilter) query = query.eq('purchase_order_id', poFilter);\n      if (clientDirectoryFilter) query = query.eq('client_id', clientDirectoryFilter);\n      if (fulfillmentTypeFilter) query = query.eq('purchase_orders.fulfillment_type', fulfillmentTypeFilter);", 'main query');
s = replaceOnce(s, "if (poFilter) fallback = fallback.eq('purchase_order_id', poFilter);", "if (poFilter) fallback = fallback.eq('purchase_order_id', poFilter);\n        if (clientDirectoryFilter) fallback = fallback.eq('client_id', clientDirectoryFilter);\n        if (fulfillmentTypeFilter) fallback = fallback.eq('purchase_orders.fulfillment_type', fulfillmentTypeFilter);", 'fallback query');
s = replaceOnce(s, 'const shopsQueryKey = [\'shops\', orgId, { poFilter, statusFilter,', 'const shopsQueryKey = [\'shops\', orgId, { poFilter, clientDirectoryFilter, fulfillmentTypeFilter, statusFilter,', 'query key');
s = replaceOnce(s, 'const activeFilterCount = [statusFilter, cityFilter, districtFilter, stateFilter, zoneFilter, campaignFilter, poFilter].filter(Boolean).length;', 'const activeFilterCount = [statusFilter, cityFilter, districtFilter, stateFilter, zoneFilter, campaignFilter, poFilter, clientDirectoryFilter, fulfillmentTypeFilter].filter(Boolean).length;', 'filter count');
const toolbar = '        <FilterButton activeCount={activeFilterCount} onClick={() => setFilterDrawerOpen(true)} />';
s = replaceOnce(s, toolbar, `        <label className="sr-only" htmlFor="shops-client-filter">Filter shops by client</label>
        <select id="shops-client-filter" value={clientDirectoryFilter} onChange={e => setDirectoryFilter('client', e.target.value)} className="max-w-[190px] rounded-lg border border-slate-300 bg-white px-2 py-2 text-xs">
          <option value="">All clients</option>
          {directoryClients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <label className="sr-only" htmlFor="shops-po-filter">Filter shops by Work Order</label>
        <select id="shops-po-filter" value={poFilter} onChange={e => setPoFilter(e.target.value)} className="max-w-[250px] rounded-lg border border-slate-300 bg-white px-2 py-2 text-xs">
          <option value="">All Work Orders</option>
          {poFilter && !directoryWorkOrders.some(po => po.id === poFilter) && <option value={poFilter}>Selected order</option>}
          {filteredDirectoryOrders.map(po => <option key={po.id} value={po.id}>{po.name || po.po_number}{po.name ? ' (' + po.po_number + ')'  : ''}</option>)}
        </select>
        <label className="sr-only" htmlFor="shops-type-filter">Filter shops by Work Order type</label>
        <select id="shops-type-filter" value={fulfillmentTypeFilter} onChange={e => setDirectoryFilter('type', e.target.value)} className="max-w-[180px] rounded-lg border border-slate-300 bg-white px-2 py-2 text-xs">
          <option value="">All types</option>
          <option value="supply_only">Supply Only</option>
          <option value="survey_install">Survey + Installation</option>
          <option value="direct_install">Direct Installation</option>
        </select>
${toolbar}`, 'compact toolbar');
// Remove duplicate Work Order control in advanced drawer. The header filter is canonical.
const oldBlock = `        <FilterSection label="Work Order">
          <select
            value={poFilter}
            onChange={(e) => setPoFilter(e.target.value)}
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">All Work Orders</option>
            {poFilter && poFilterInfo && !(purchaseOrders || []).some((po) => po.id === poFilter) && (
              <option value={poFilterInfo.id}>{poFilterInfo.po_number} (cancelled)</option>
            )}
            {(purchaseOrders || []).map((po) => <option key={po.id} value={po.id}>{po.po_number}</option>)}
          </select>
        </FilterSection>`;
s=replaceOnce(s,oldBlock,'','duplicate drawer filter');
const poCell = `<span className="block truncate" title={shop.purchase_orders?.po_number || ''}>{shop.purchase_orders?.po_number || 'Not linked'}</span>`;
if (s.includes(poCell)) {
  s=replaceOnce(s,poCell,`<span className="block truncate font-medium" title={shop.purchase_orders?.name || shop.purchase_orders?.po_number || ''}>{shop.purchase_orders?.name || shop.purchase_orders?.po_number || 'Not linked'}</span>
                      {shop.purchase_orders?.name && <span className="block truncate text-[11px] text-slate-500">{shop.purchase_orders.po_number}</span>}`, 'show PO name');
}

s=replaceOnce(s, "setCampaignFilter(''); setPoFilter(''); }}", "setCampaignFilter(''); setPoFilter(''); clearDirectoryFilters(); }}", 'clear filters');
// The original source is saved before any write, never modify a user's data.
if (process.argv.includes('--check')) {
  console.log('Shop filter patch anchors verified; no files were changed.');
  process.exit(0);
}
const backup = pathLib.join(os.tmpdir(), `AdRoute_ShopsPages_${Date.now()}.tsx.bak`);
fs.copyFileSync(path, backup);
fs.writeFileSync(path, prefix + s);
console.log('ShopsPage filters patched. Backup:', backup);
