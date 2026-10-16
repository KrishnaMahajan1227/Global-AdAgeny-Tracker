// Safe contextual patch. Validates originals and all anchors before changing anything.
const fs=require('fs'),path=require('path'),cp=require('child_process'),crypto=require('crypto');
const old=require('./previous-po-dashboard.cjs');
const root=path.resolve(process.argv[2]||'.');
const src=(p)=>fs.readFileSync(path.join(root,p),'utf8');
const hash=s=>{const b=Buffer.from(s);return crypto.createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex')};
const known={
  'src/pages/PurchaseOrdersPage.tsx':'71c48eb2d6e2e0bc826c5500efd1fd417d19b62d',
  'src/pages/DashboardPage.tsx':'7cd365a7488c702473ea1722af5d631082165cde',
  'src/pages/ShopsPages.tsx':'578992b6f0812a787186d47e124ba7088bd5127b',
  'src/pages/AgencyHierarchyPage.tsx':'d6e81dc3dab54c6740d739743f0410e7a1d384ef',
  'src/pages/WorkProgressPage.tsx':'38e3188f6999d2268abb009b1d645891e1f1fb43'
};
if(!fs.existsSync(path.join(root,'package.json')))throw Error('Open in project root');
const git=args=>cp.execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
if(git(['branch','--show-current'])!=='main')throw Error('Work on main branch only');
if(git(['status','--porcelain']))throw Error('Commit or stash existing changes first. No files modified.');
const originals=Object.fromEntries(Object.keys(known).map(p=>[p,src(p)]));
for(const [p,s] of Object.entries(originals))if(hash(s)!==known[p])throw Error(`${p} has a newer/different source version. Do not overwrite; merge manually.`);
if(fs.existsSync(path.join(root,'src/lib/workCompletion.ts')))throw Error('workCompletion helper already exists. Avoid duplicate/overwrite.');
function once(s,a,b,what){const count=s.split(a).length-1;if(count!==1)throw Error(`${what}: expected 1 matching anchor, found ${count}`);return s.replace(a,b)}
function pPO(s){
  s=old.patchPO(s);
  // Operational stage counts are from actual shop statuses; measured scope remains a separate calculation.
  const contextText = '<p className="mt-1 text-[11px] text-slate-500">The quantity/area chart below uses recorded PO work items. Missing measurements must be reconciled, not estimated from shop counts.</p>';
  s=once(s, contextText, contextText + `
            <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-600" aria-label="Shop stages for this Work Order">
              {Object.entries(physicalCompletion.stages).filter(([, count]) => count > 0).map(([name, count]) => (
                <div key={name} className="inline-flex items-center gap-1"><dt className="capitalize">{name.replace(/_/g, ' ')}</dt><dd className="font-semibold tabular-nums text-slate-800">{count}</dd></div>
              ))}
            </dl>`, 'physical stage summary');
  s=once(s, '<h3 className="text-sm font-semibold text-slate-900">Overall completion</h3>', '<h3 className="text-sm font-semibold text-slate-900">Measured PO scope</h3>', 'separate measured scope label');
  s=once(s,'            const { completionPct, lineCount } = getPoMetrics(po, utilization || []);',
    '            const { completionPct, lineCount } = getPoMetrics(po, utilization || []);\n            const physical = shopCompletionByPo.get(po.id);','mobile PO completion lookup');
  const mStart=s.indexOf('              {completionPct == null\n');
  const mEnd=s.indexOf('              </button>',mStart);
  if(mStart<0||mEnd<0)throw Error('mobile progress JSX not found');
  s=s.slice(0,mStart)+`              {physical?.total ? <div className="mt-2 space-y-1"><div className="flex items-center gap-2"><ProgressBar pct={physical.percentage} className="flex-1"/><span className="w-10 text-right text-xs font-semibold">{physical.percentage}%</span></div><p className="text-[11px] text-slate-500">{physical.completed}/{physical.total} shops finished{completionPct == null ? ' · measurements pending' : \` · \${Math.round(completionPct)}% measured\`}</p></div> : <p className="mt-2 text-xs text-slate-500">No linked shop progress yet</p>}\n`+s.slice(mEnd);
  const start=s.indexOf('function WorkOrderDetailDrawer('),end=s.indexOf('// Phase 6 — PO Utilization table:',start);
  if(start<0||end<0)throw Error('Work Order detail component changed');
  let component=s.slice(start,end);
  // The existing detail contents stay the same: only presentation container changes.
  const open=component.match(/<Drawer open=\{!!po\}[^\n]*width="xl">/);
  if(!open)throw Error('Work Order drawer opening not found');
  component=once(component,open[0],`<Modal open={!!po} onClose={onClose} title={po.name || po.po_number} size="xl">\n      <p className="mb-3 text-xs text-slate-500">{po.po_number} · {po.clients?.name || 'Client'}</p>`,'center modal');
  component=once(component,'    </Drawer>','    </Modal>','center modal close');
  // Mobile list also uses the same final shop data rather than stale quantity rollup.
  // Keep every existing edit, line-item, shops, deletion and accept/reject action untouched.
  s=s.slice(0,start)+component+s.slice(end);
  return s;
}
function pDash(s){
  s=old.patchDashboard(s);
  s=once(s,"import { useAuth } from '@/lib/auth';","import { useAuth } from '@/lib/auth';\nimport { useRealtimeInvalidate } from '@/lib/useRealtimeInvalidate';",'dashboard realtime import');
  s=once(s,"  const orgId = profile?.organization_id;","  const orgId = profile?.organization_id;\n  useRealtimeInvalidate(['shops','purchase_orders','work_items','installation_jobs'],orgId,[['agency-operations-dashboard',orgId]]);",'dashboard realtime hook');
  s=once(s,"    enabled: !!orgId,\n    queryFn: async () => {","    enabled: !!orgId,\n    refetchInterval: 20000,\n    queryFn: async () => {",'dashboard polling');
  s=once(s,"import { isShopFinished } from '@/lib/workCompletion';","import { groupShopCompletion, orderOperationalDone, ordersOperationalPercent, isShopFinished } from '@/lib/workCompletion';",'dashboard shared helper');
  s=once(s,'    const orders = data.orders.filter(o => !excluded(o));',"    const orders = data.orders.filter(o => !excluded(o));\n    const byOrder = groupShopCompletion(orders, data.shops);\n    const flowByOrder = new Map(orders.map(o => [o.id, (o as Order & { fulfillment_type?: string | null }).fulfillment_type]));\n    const finishedSites = data.shops.filter(s => isShopFinished(flowByOrder.get(s.purchase_order_id || ''), s.status)).length;",'dashboard shop group');
  const a=s.indexOf('    const orderFinished = (order: Order): boolean => {');
  const b=s.indexOf('    const activeClients = ',a);
  if(a<0||b<0)throw Error('dashboard orderFinished body missing');
  s=s.slice(0,a)+"    const orderFinished = (order: Order): boolean => orderOperationalDone(order, byOrder.get(order.id));\n"+s.slice(b);
  s=once(s,'percent: own.length ? Math.round(done * 100 / own.length) : 0, open: own.length - done','percent: ordersOperationalPercent(own, byOrder), open: own.length - done','partial delivery by client');
  s=once(s,'<span className="tabular-nums text-slate-500">{c.done}/{c.total}</span>','<span className="tabular-nums text-slate-600">{c.percent}% <span className="text-slate-400">· {c.done}/{c.total} orders complete</span></span>','dashboard client progress label');
  s=once(s,'const stageOf = (status: string):', 'const stageOf = (status: string, flow?: string | null):','dashboard stage type');
  s=once(s,"  if (status === 'installed' || status === 'billed') return 'installed';", "  if (status === 'billed' && flow === 'supply_only') return 'dispatch';\n  if (status === 'installed' || status === 'billed') return 'installed';",'billed supply status');
  s=once(s,'    data.shops.forEach(s => { stages[stageOf(s.status)] += 1; });', "    data.shops.forEach(s => { stages[stageOf(s.status, flowByOrder.get(s.purchase_order_id || ''))] += 1; });",'flow-based dashboard stage');
  s=once(s,'recent, sites: data.shops.length, done: orders.filter(orderFinished).length','recent, sites: data.shops.length, finishedSites, done: orders.filter(orderFinished).length','dashboard finished-site metric');
  s=once(s,"{ label: 'Installed sites', value: snapshot.stages.installed, extra: `\${snapshot.sites ? Math.round(snapshot.stages.installed / snapshot.sites * 100) : 0}% of sites`, url: '/installation-review', icon: PackageCheck },","{ label: 'Finished sites', value: snapshot.finishedSites, extra: `\${snapshot.sites ? Math.round(snapshot.finishedSites / snapshot.sites * 100) : 0}% of sites`, url: '/purchase-orders', icon: PackageCheck },",'cross-type finished site KPI');
  return s;
}
function pClients(s){
 s=once(s,"import { isDone, percent, type Order } from '@/lib/agencyProgress';","import { isDone, percent, type Order } from '@/lib/agencyProgress';\nimport { groupShopCompletion, orderOperationalDone, ordersOperationalPercent, isShopFinished } from '@/lib/workCompletion';",'clients imports');
 s=once(s,"useRealtimeInvalidate(['clients', 'purchase_orders'], orgId, [['clients', orgId], ['client-progress', orgId]]);","useRealtimeInvalidate(['clients', 'purchase_orders', 'shops'], orgId, [['clients', orgId], ['client-progress', orgId]]);",'client realtime');
 s=once(s,"      const orders: Order[] = [];","      const orders: (Order & { fulfillment_type?: string | null })[] = [];",'orders type');
 s=once(s,".select('id,client_id,project_id,campaign_id,name,po_number,status,assignment_status,created_at')",".select('id,client_id,project_id,campaign_id,name,po_number,status,assignment_status,fulfillment_type,created_at')",'client orders query');
 s=once(s,`      return orders;
    },
  });
  const progressByClient`, `      const shops: { purchase_order_id: string | null; status: string | null }[] = [];
      for (let from=0;;from+=500) {
        const {data,error}=await supabase.from('shops').select('purchase_order_id,status')
          .eq('organization_id',orgId).in('client_id',pageClientIds)
          .order('id',{ascending:true}).range(from,from+499);
        if(error)throw error;
        shops.push(...(data||[]));
        if(!data||data.length<500)break;
      }
      return {orders,shops};
    }, refetchInterval: 20000,
  });
  const progressByClient`, 'client pagination');
 const a=s.indexOf('  const progressByClient = useMemo('),b=s.indexOf('  useEffect(() => { setClientPage(1);',a);
 if(a<0||b<0)throw Error('client progress derivation changed');
 s=s.slice(0,a)+`  const progressByClient = useMemo(() => {
    const result=new Map<string,{done:number;total:number;pct:number}>();
    if(!clientProgress)return result;
    const progress=groupShopCompletion(clientProgress.orders,clientProgress.shops);
    for(const client of clientsPage?.rows||[]){
      const orders=clientProgress.orders.filter(o=>o.client_id===client.id);
      result.set(client.id,{total:orders.length,done:orders.filter(o=>orderOperationalDone(o,progress.get(o.id))).length,pct:ordersOperationalPercent(orders,progress)});
    }
    return result;
  },[clientProgress,clientsPage]);

`+s.slice(b);
 s=once(s,'const ordersFor = (id: string) => progressByClient.get(id) || { total: 0, done: 0 };','const ordersFor = (id: string) => progressByClient.get(id) || { total: 0, done: 0, pct: 0 };','clients default');
 s=once(s,'>Orders closed</th>','>Delivery progress</th>','client column label');
 s=once(s,'const {done,total}=ordersFor(client.id);const ready =','const {done,total,pct}=ordersFor(client.id);const ready =','client desktop result');
 s=once(s,'<ProgressBar pct={ready && total ? percent(done, total) : 0}/>','<ProgressBar pct={ready ? pct : 0}/>','client progress bar');
 s=once(s,"{ready ? `${done}/${total}` : '—'}","{ready ? `${pct}% · ${done}/${total} orders completed` : '—'}",'client percent label');
 s=once(s,'const {done,total}=ordersFor(client.id);const ready=!progressLoading','const {done,total,pct}=ordersFor(client.id);const ready=!progressLoading','mobile progress');
 s=once(s,'{ready ? `${total} work orders · ${done} closed →` : \'Loading orders…\'}','{ready ? `${total} work orders · ${pct}% delivery · ${done} completed →` : \'Loading orders…\'}','mobile progress label');
 return s;
}
function pHierarchy(s){
 s=once(s,"import { completion, dateLabel, isDone, orderState, type Order } from '@/lib/agencyProgress';","import { completion, dateLabel, isDone, orderState, type Order } from '@/lib/agencyProgress';\nimport { groupShopCompletion, orderOperationalDone, orderOperationalPercent, ordersOperationalPercent, type ShopProgressRow } from '@/lib/workCompletion';",'hierarchy import');
 s=once(s,"import { useAuth } from '@/lib/auth';","import { useAuth } from '@/lib/auth';\nimport { useRealtimeInvalidate } from '@/lib/useRealtimeInvalidate';",'hierarchy realtime import');
 s=once(s,"  const orgId = profile?.organization_id;","  const orgId = profile?.organization_id;\n  useRealtimeInvalidate(['shops','purchase_orders'], orgId, [['agency-hierarchy',kind,id,orgId]]);",'hierarchy realtime');
 s=once(s,".select('id,client_id,project_id,campaign_id,name,po_number,status,assignment_status,created_at').eq('organization_id', orgId)",".select('id,client_id,project_id,campaign_id,name,po_number,status,assignment_status,fulfillment_type,created_at').eq('organization_id', orgId)",'hierarchy order query');
 s=once(s,'    return { clients: (clients.data || [])',`    const shops: ShopProgressRow[] = [];
    for(let from=0;;from+=500){
      const {data: batch,error} = await supabase.from('shops').select('purchase_order_id,status')
        .eq('organization_id',orgId).order('id').range(from,from+499);
      if(error)throw error;
      shops.push(...(batch||[]));
      if(!batch || batch.length < 500)break;
    }
    return { shops, clients: (clients.data || [])`,'hierarchy shop query');
 s=once(s,'  const targetOrders = data.orders.filter(o => kind === \'client\' ? o.client_id === id : kind === \'project\' ? o.project_id === id : o.campaign_id === id);', `  const targetOrders = data.orders.filter(o => kind === 'client' ? o.client_id === id : kind === 'project' ? o.project_id === id : o.campaign_id === id);
  const progress = groupShopCompletion(data.orders, data.shops);
  const deliveryPct = ordersOperationalPercent(targetOrders, progress);
  const doneOrders = targetOrders.filter(o => orderOperationalDone(o,progress.get(o.id))).length;`,'hierarchy progress derivation');
 s=s.replaceAll('completion(targetOrders)','deliveryPct').replaceAll('targetOrders.filter(isDone).length','doneOrders');
 s=once(s,'<OrderList orders={targetOrders} emptyLink=', '<OrderList orders={targetOrders} progress={progress} emptyLink=','hierarchy order list call');
 s=once(s,'function OrderList({orders,emptyLink}:{orders:Order[];emptyLink:string}) {', 'function OrderList({orders,progress,emptyLink}:{orders:Order[];progress:ReturnType<typeof groupShopCompletion>;emptyLink:string}) {','hierarchy order list signature');
 s=once(s,'<ProgressBar pct={isDone(o)?100:0}/><span className="text-xs">{isDone(o)?100:0}%</span>','<ProgressBar pct={orderOperationalPercent(o,progress.get(o.id))}/><span className="text-xs">{orderOperationalPercent(o,progress.get(o.id))}% · {progress.get(o.id)?.completed||0}/{progress.get(o.id)?.total||0} shops done</span>','hierarchy order bar');
 return s;
}
function pProgress(s){
 s=once(s,"import { useRealtimeInvalidate } from '@/lib/useRealtimeInvalidate';","import { useRealtimeInvalidate } from '@/lib/useRealtimeInvalidate';\nimport { isShopFinished } from '@/lib/workCompletion';",'work progress import');
 s=once(s,'const [shops, items, assigns] = await Promise.all([','const [shops, items, assigns, orders] = await Promise.all([','work progress query');
 s=once(s,".select('id,name,city,status,client_id,clients(name)')",".select('id,name,city,status,client_id,purchase_order_id,clients(name)')",'work progress shops PO');
 s=once(s,"        fetchAll<any>((a, b) => supabase.from('shop_assignments').select('shop_id,user_id,role,status,profiles(full_name)').eq('organization_id', orgId!).order('assigned_at').range(a, b)),","        fetchAll<any>((a, b) => supabase.from('shop_assignments').select('shop_id,user_id,role,status,profiles(full_name)').eq('organization_id', orgId!).order('assigned_at').range(a, b)),\n        fetchAll<any>((a, b) => supabase.from('purchase_orders').select('id,fulfillment_type').eq('organization_id', orgId!).order('id').range(a, b)),",'work progress orders fetch');
 s=once(s,'      return { shops, items, assigns };','      return { shops, items, assigns, orders };','work progress data');
 s=once(s,'    const rows = data.shops.map((s) => {','    const flowByOrder = new Map(data.orders.map(o=>[o.id,o.fulfillment_type]));\n    const rows = data.shops.map((s) => {','work progress map');
 s=once(s,'      const stage = stageOf(s.status);','      const stage = isShopFinished(flowByOrder.get(s.purchase_order_id || ""),s.status) ? \'done\' : stageOf(s.status);','work progress final stage');
 s=once(s,'<p className="text-xs text-slate-500">Complete (installed)</p>','<p className="text-xs text-slate-500">Final-stage shops</p>','work progress KPI');
 return s;
}
const current={
 'src/pages/PurchaseOrdersPage.tsx': pPO(originals['src/pages/PurchaseOrdersPage.tsx']),
 'src/pages/DashboardPage.tsx': pDash(originals['src/pages/DashboardPage.tsx']),
 'src/pages/ShopsPages.tsx': pClients(originals['src/pages/ShopsPages.tsx']),
 'src/pages/AgencyHierarchyPage.tsx': pHierarchy(originals['src/pages/AgencyHierarchyPage.tsx']),
 'src/pages/WorkProgressPage.tsx': pProgress(originals['src/pages/WorkProgressPage.tsx']),
 'src/lib/workCompletion.ts': fs.readFileSync(path.join(__dirname,'../src/lib/workCompletion.ts'),'utf8')
};
if(process.argv.includes('--verify')){console.log('PASS: Source SHA and all 5 contextual patch anchors validated. No changes made.');process.exit(0)}
const backup=path.join(root,'.git',`adroute-progress-backup-${new Date().toISOString().replace(/[:.]/g,'-')}`);
fs.mkdirSync(backup,{recursive:true});
for(const [p,s] of Object.entries(originals)){const dest=path.join(backup,p);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,s)}
try{for(const [p,s] of Object.entries(current)){const dest=path.join(root,p);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,s)}}
catch(e){for(const [p,s] of Object.entries(originals))fs.writeFileSync(path.join(root,p),s);try{fs.unlinkSync(path.join(root,'src/lib/workCompletion.ts'))}catch{}throw e}
console.log('Updated 5 canonical pages + 1 helper. Backup: '+backup);
// Confirm the change is really present before reporting success.
const finalChecks = [
  ['src/pages/PurchaseOrdersPage.tsx','shopCompletionByPo'],
  ['src/pages/PurchaseOrdersPage.tsx','<Modal open={!!po}'],
  ['src/pages/DashboardPage.tsx','ordersOperationalPercent(own, byOrder)'],
  ['src/pages/ShopsPages.tsx','const progress=groupShopCompletion'],
  ['src/pages/AgencyHierarchyPage.tsx','orderOperationalPercent(o,progress.get(o.id))'],
  ['src/pages/WorkProgressPage.tsx','isShopFinished(flowByOrder.get(s.purchase_order_id || ""),s.status)'],
];
for(const [p,token] of finalChecks) if(!src(p).includes(token))throw Error('Verification failure: '+p+' missing '+token);
console.log('APPLIED AND VERIFIED: 5 agency screens + shared completion helper.');
console.log('IMPORTANT: local source updated; changes are NOT live until build, git commit, push and deployment.');

