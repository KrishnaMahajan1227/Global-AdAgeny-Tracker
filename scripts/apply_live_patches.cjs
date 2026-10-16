/* No dependencies. Contextual, exact-anchor changes only; run after APPLY_MAIN.ps1 preflight. */
const fs = require('fs');
const path = require('path');
const project = path.resolve(process.argv[2] || '.');
const load = p => fs.readFileSync(path.join(project,p),'utf8');
const save = (p,s) => fs.writeFileSync(path.join(project,p),s,'utf8');
function replaceOnce(s,a,b,label) {
  const n=s.split(a).length-1;
  if(n!==1) throw new Error(`${label}: expected exactly one anchor, found ${n}`);
  return s.replace(a,b);
}
function patchPO(s){
  const imp="import { getShopCompletion } from '@/lib/workCompletion';\n";
  if(!s.includes(imp)) s=imp+s;
  s=replaceOnce(s,'const result: { purchase_order_id: string; zone_id: string | null }[] = [];','const result: { purchase_order_id: string; zone_id: string | null; status: string | null }[] = [];','PO shop projection');
  s=replaceOnce(s,".select('purchase_order_id, zone_id')",".select('purchase_order_id, zone_id, status')",'PO status field');
  const m=`  // Which zone(s) each Work Order's shops actually fall in`;
  const insert=`  // Operational completion is measured by actual final-stage shops, not missing
  // historical work item quantities. Financial quantities stay independent.
  const shopCompletionByPo = useMemo(() => {
    const byOrder = new Map<string, { status: string | null }[]>();
    for (const shop of poShopLinks || []) {
      const rows = byOrder.get(shop.purchase_order_id) || [];
      rows.push({ status: shop.status });
      byOrder.set(shop.purchase_order_id, rows);
    }
    const values = new Map<string, ReturnType<typeof getShopCompletion>>();
    for (const order of pos || []) values.set(order.id, getShopCompletion(byOrder.get(order.id) || [], order.fulfillment_type));
    return values;
  }, [poShopLinks, pos]);

`;
  s=replaceOnce(s,m,insert+m,'PO summary insertion');
  const counted='const shopCount = shopCountByPo.get(po.id) || 0;';
  s=replaceOnce(s,counted,counted+'\n                const physical = shopCompletionByPo.get(po.id);','PO row completion');
  const before=`                      {completionPct != null ? (
                        <div className="flex items-center gap-2">
                          <ProgressBar pct={completionPct} className="flex-1" />
                          <span className="text-xs text-slate-500 w-8 text-right shrink-0">{\`\${Math.round(completionPct)}%\`}</span>
                        </div>
                      ) : <span className="text-slate-500 text-xs" title="Set planned quantities on every line item to calculate work completion">Scope needed</span>}`;
  const after=`                      {physical && physical.total > 0 ? (
                        <div className="space-y-1" title={\`\${physical.completed} / \${physical.total} shops at their final stage; quantity-based completion is separate\`}>
                          <div className="flex items-center gap-2"><ProgressBar pct={physical.percentage} className="flex-1" /><span className="shrink-0 text-xs font-semibold text-slate-700">{physical.percentage}%</span></div>
                          <span className="text-[10px] text-slate-500">{physical.completed}/{physical.total} shops done{completionPct != null ? \` · \${Math.round(completionPct)}% measured work\` : ' · measurements pending'}</span>
                        </div>
                      ) : (completionPct != null ? <div className="flex items-center gap-2"><ProgressBar pct={completionPct} className="flex-1" /><span className="text-xs text-slate-500">{Math.round(completionPct)}%</span></div> : <span className="text-xs text-slate-500">No linked shops</span>)}`;
  s=replaceOnce(s,before,after,'PO row UI');
  const detail='          shopCount={shopCountByPo.get(detailPo.id) || 0}';
  s=replaceOnce(s,detail,detail+'\n          physicalCompletion={shopCompletionByPo.get(detailPo.id)}','PO drawer prop');
  s=replaceOnce(s,'  po, utilization, shopCount, canDelete, canHardDelete,','  po, utilization, shopCount, physicalCompletion, canDelete, canHardDelete,','PO drawer definition');
  s=replaceOnce(s,'  shopCount: number;','  shopCount: number;\n  physicalCompletion?: ReturnType<typeof getShopCompletion>;','PO drawer type');
  s=replaceOnce(s,`        <PoCompletionDonut\n`, `        {physicalCompletion && physicalCompletion.total > 0 && (
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
            <p className="text-xs font-medium text-slate-800">Final-stage shops: {physicalCompletion.completed}/{physicalCompletion.total} ({physicalCompletion.percentage}%)</p>
            <p className="mt-1 text-[11px] text-slate-500">The quantity/area chart below uses recorded PO work items. Missing measurements must be reconciled, not estimated from shop counts.</p>
          </div>
        )}
        <PoCompletionDonut\n`, 'PO drawer completion banner');
  return s;
}
function patchDashboard(s){
  s=replaceOnce(s,"import { completion, isDone, type Order } from '@/lib/agencyProgress';","import { completion, isDone, type Order } from '@/lib/agencyProgress';\nimport { isShopFinished } from '@/lib/workCompletion';",'dashboard completion import');
  const start=s.indexOf('const stageOf = (status: string)');
  const end=s.indexOf('const tiles = [',start);
  if(start<0||end<0) throw new Error('Dashboard stage matcher not found');
  s=s.slice(0,start)+`const stageOf = (status: string): 'survey' | 'design' | 'production' | 'dispatch' | 'installed' | 'other' => {
  // Avoid treating "installation_pending" / "installation_review" as installed.
  if (status === 'installed' || status === 'billed') return 'installed';
  if (['dispatched', 'installation_pending', 'installing', 'installation_review'].includes(status)) return 'dispatch';
  if (status.startsWith('production_') || status === 'in_production') return 'production';
  if (status.startsWith('design_') || status === 'designing' || status === 'in_review') return 'design';
  if (['pending', 'assigned', 'survey_started', 'surveyed', 'approval_pending', 'approved'].includes(status)) return 'survey';
  return 'other';
};
`+s.slice(end);
  s=replaceOnce(s,"load('purchase_orders', 'id,client_id,project_id,campaign_id,name,po_number,status,assignment_status,created_at')","load('purchase_orders', 'id,client_id,project_id,campaign_id,name,po_number,status,assignment_status,fulfillment_type,created_at')",'Dashboard PO type');
  const anchor='    const orders = data.orders.filter(o => !excluded(o));';
  const extra=`
    const orderFinished = (order: Order): boolean => {
      const linkedShops = data.shops.filter(shop => shop.purchase_order_id === order.id);
      if (!linkedShops.length) return isDone(order);
      const type = (order as Order & { fulfillment_type?: string | null }).fulfillment_type;
      return linkedShops.every(shop => isShopFinished(type, shop.status));
    };`;
  s=replaceOnce(s,anchor,anchor+extra,'Dashboard order completion');
  s=replaceOnce(s,'const done = own.filter(isDone).length;','const done = own.filter(orderFinished).length;','Client completed orders');
  s=replaceOnce(s,'percent: completion(own), open: own.length - done','percent: own.length ? Math.round(done * 100 / own.length) : 0, open: own.length - done','Client percent');
  s=replaceOnce(s,'const openOrders = orders.filter(o => !isDone(o));','const openOrders = orders.filter(o => !orderFinished(o));','Open orders');
  s=replaceOnce(s,'done: orders.filter(isDone).length','done: orders.filter(orderFinished).length','Total done');
  s=replaceOnce(s,'extra: `${completion(snapshot.orders)}% of orders`','extra: `${snapshot.orders.length ? Math.round(snapshot.done * 100 / snapshot.orders.length) : 0}% operationally complete`','Metric progress');
  s=replaceOnce(s,"url: '/supply-orders'","url: '/purchase-orders?type=supply_only'",'Supply link');
  return s;
}
module.exports={patchPO,patchDashboard};
if(require.main===module){
const paths=[['src/pages/PurchaseOrdersPage.tsx',patchPO],['src/pages/DashboardPage.tsx',patchDashboard]];
// Compute every updated file in memory before writing anything.
const staged=paths.map(([p,fn])=>[p,fn(load(p))]);
for(const [p,updated] of staged) save(p,updated);
console.log('Updated Work Orders and Dashboard in place; other source files untouched.');
}
