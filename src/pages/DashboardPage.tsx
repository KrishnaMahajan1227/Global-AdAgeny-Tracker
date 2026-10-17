import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  AlertCircle, ArrowRight, CalendarClock, CheckCircle2, ChevronDown,
  ClipboardList, Factory, IndianRupee, MapPin, PackageCheck, Palette,
  RefreshCw, Search, ShieldCheck, Store, Users,
} from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
import { ProgressBar } from '@/components/ui';
import type { Order } from '@/lib/agencyProgress';
import { deliveryByOrder, deliveryForOrder, deliveryForOrders, deliveryPipeline, type DeliveryShop } from '@/lib/agencyDelivery';
import { useRealtimeInvalidate } from '@/lib/useRealtimeInvalidate';
import { useAgencyFinancials, financeForOrder, financeForOrders } from '@/lib/agencyFinance';
import { formatRupees, fulfillmentTypeLabel } from '@/lib/poUtilization';
import { describeOrderNextStep, ownerStageLabels, type OwnerStageFilter } from '@/lib/ownerOperations';
import type { Client } from '@/lib/types';

// The dashboard is intentionally scoped to operational metadata. Financial
// queries and values are only available when the agency owner opens the panel.
type ShopRow = DeliveryShop & { id: string; client_id: string; purchase_order_id: string | null; status: string };
type ClientRow = Pick<Client, 'id' | 'name' | 'is_active'>;
const fmt = (value: number) => value.toLocaleString('en-IN');
const excluded = (order: Order) => order.status === 'cancelled' || order.assignment_status === 'rejected';
const poUrl = (id: string) => `/purchase-orders?order=${encodeURIComponent(id)}`;
const shopUrl = (id: string, stage?: string) => `/shops?po=${encodeURIComponent(id)}${stage ? `&stage=${encodeURIComponent(stage)}` : ''}`;
const allStageUrl = (stage: OwnerStageFilter) => `/purchase-orders?stage=${encodeURIComponent(stage)}`;
const pipelineStages = [
  {key:'pending', icon:MapPin}, {key:'survey', icon:ClipboardList},
  {key:'design', icon:Palette}, {key:'production', icon:Factory},
  {key:'dispatch', icon:PackageCheck}, {key:'installation', icon:Store},
  {key:'review', icon:ShieldCheck}, {key:'complete', icon:CheckCircle2},
] as const;
const quickLinks = [
  {label:'Survey review', url:'/survey-review'},
  {label:'Design queue', url:'/design'},
  {label:'Production queue', url:'/production'},
  {label:'Installation review', url:'/installation-review'},
  {label:'Shop directory', url:'/shops'},
  {label:'Reports', url:'/reports'},
];

export default function DashboardPage() {
  const { profile } = useAuth();
  const orgId = profile?.organization_id;
  const owner = profile?.role === 'agency_owner';
  const [showFinance, setShowFinance] = useState(false);
  const [search, setSearch] = useState('');
  const [showAllClients, setShowAllClients] = useState(false);
  const [showAllOrders, setShowAllOrders] = useState(false);
  const {data: invoiceTotals, isError: financeError, isFetching: financeFetching} = useAgencyFinancials(orgId, !!owner && showFinance);
  useRealtimeInvalidate(['shops', 'purchase_orders', 'work_items', 'installation_jobs', 'surveys', 'design_tasks', 'production_orders'], orgId,
    [['agency-operations-dashboard', orgId]]);

  const {data, isLoading, isError, refetch, isFetching} = useQuery({
    queryKey:['agency-operations-dashboard', orgId], enabled: !!orgId, staleTime:10000,
    queryFn:async () => {
      if (!orgId) throw new Error('Missing organization');
      async function load(table:'clients'|'purchase_orders'|'shops', columns:string) {
        const result:Record<string,unknown>[] = [];
        for (let from=0;;from+=500) {
          const {data:batch,error} = await supabase.from(table).select(columns).eq('organization_id',orgId!).order('id').range(from,from+499);
          if (error) throw error;
          result.push(...((batch||[]) as Record<string,unknown>[]));
          if (!batch || batch.length<500) break;
        }
        return result;
      }
      const [clients,orders,shops] = await Promise.all([
        load('clients','id,name,is_active'),
        load('purchase_orders','id,client_id,project_id,campaign_id,name,po_number,status,assignment_status,fulfillment_type,total_amount,created_at,po_line_items(requires_survey,requires_design,requires_production,requires_installation)'),
        load('shops','id,client_id,purchase_order_id,status'),
      ]);
      return {clients:clients as unknown as ClientRow[],orders:orders as unknown as Order[],shops:shops as unknown as ShopRow[]};
    },
  });
  const snapshot = useMemo(() => {
    if (!data) return null;
    const orders = data.orders.filter(order=>!excluded(order));
    const clients = data.clients.filter(client=>client.is_active);
    const clientNames = new Map(data.clients.map(client=>[client.id,client.name]));
    const byOrder = deliveryByOrder(orders,data.shops);
    const portfolio = deliveryForOrders(orders,byOrder);
    const validOrderIds = new Set(orders.map(order=>order.id));
    const linkedShops = data.shops.filter(shop=>!!shop.purchase_order_id && validOrderIds.has(shop.purchase_order_id));
    const stages = deliveryPipeline(linkedShops,orders);
    const details = orders.map(order=>{
      const delivery = deliveryForOrder(order,byOrder);
      const next = describeOrderNextStep(delivery.stages || {pending:0,survey:0,design:0,production:0,dispatch:0,installation:0,review:0,complete:0,excluded:0},order.assignment_status==='pending_acceptance');
      const ageDays = order.created_at ? Math.max(0,Math.floor((Date.now()-new Date(order.created_at).getTime())/86400000)) : null;
      return {order,delivery,next,ageDays,clientName:clientNames.get(order.client_id)||'Client'};
    });
    const open = details.filter(item=>!item.delivery.delivered);
    const ranked = [...open].sort((a,b)=>{
      const rank = (item:typeof a) => item.order.assignment_status==='pending_acceptance' ? 0
        : item.delivery.stages?.review ? 1
        : item.delivery.stages?.survey ? 2
        : item.delivery.stages?.pending ? 3 : 4;
      return rank(a)-rank(b) || (b.ageDays||0)-(a.ageDays||0);
    });
    const clientRows = clients.map(client=>{
      const own = orders.filter(order=>order.client_id===client.id);
      const progress = deliveryForOrders(own,byOrder);
      return {...client,...progress,percent:progress.percentage,work:ranked.filter(item=>item.order.client_id===client.id)};
    }).sort((a,b)=>b.open-a.open || a.name.localeCompare(b.name));
    const needsOwner = ranked.filter(item=>item.next.kind==='attention');
    return {orders,clients,portfolio,stages,details,open,ranked,needsOwner,clientRows,sites:portfolio.sites,
      aged:open.filter(item=>item.ageDays!=null && item.ageDays>=30).length};
  },[data]);

  if (isLoading) return <main role="status" className="rounded-xl border bg-white p-6 text-sm text-slate-600">Loading agency operations…</main>;
  if (isError || !snapshot) return <main role="alert" className="rounded-xl border border-red-200 bg-white p-6 text-sm text-red-700">Could not load the dashboard. <button type="button" className="font-semibold underline" onClick={()=>void refetch()}>Retry</button></main>;
  const clientRows = snapshot.clientRows.filter(client=>client.name.toLowerCase().includes(search.trim().toLowerCase()));
  const clientsShown = showAllClients ? clientRows : clientRows.slice(0,5);
  const workShown = showAllOrders ? snapshot.ranked : snapshot.ranked.slice(0,8);
  const kpis = [
    {label:'Active clients',value:snapshot.clients.length,detail:'Accounts with work',icon:Users,url:'/clients'},
    {label:'Work orders in progress',value:snapshot.open.length,detail:`${snapshot.orders.length} active / accepted`,icon:ClipboardList,url:'/purchase-orders'},
    {label:'Requires action',value:snapshot.needsOwner.length,detail:'Orders with pending field/review',icon:AlertCircle,url:'#owner-actions'},
    {label:'Delivered sites',value:snapshot.portfolio.deliveredSites,detail:`${snapshot.portfolio.percentage}% of ${fmt(snapshot.sites)} sites`,icon:PackageCheck,url:'/purchase-orders?stage=complete'},
    {label:'Open 30+ days',value:snapshot.aged,detail:'Age, not a missed deadline',icon:CalendarClock,url:'#owner-work-orders'},
  ];

  return <main className="mx-auto max-w-[1680px] space-y-5 pb-10 text-slate-800">
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-4">
      <div><div className="flex items-center gap-2 text-xs font-medium text-emerald-700"><span className="h-2 w-2 rounded-full bg-emerald-500"/> Agency owner · live operations</div>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-950">Agency command center</h1>
        <p className="mt-1 text-xs text-slate-500">Which client needs attention, which Work Order is moving, and what to open next</p>
      </div>
      <div className="flex items-center gap-2"><Link to="/purchase-orders" className="rounded-lg bg-blue-600 px-4 py-2.5 text-xs font-semibold text-white hover:bg-blue-700">All Work Orders <ArrowRight size={13} className="ml-1 inline"/></Link>
        <button type="button" disabled={isFetching} onClick={()=>void refetch()} className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-xs font-semibold hover:bg-slate-50 disabled:opacity-50"><RefreshCw size={14} className={isFetching?'animate-spin':''}/>{isFetching?'Refreshing':'Refresh'}</button>
      </div>
    </header>

    <section aria-label="Owner operational summary" className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
      {kpis.map(item=>item.url.startsWith('#')?<a key={item.label} href={item.url} className="group rounded-xl border border-slate-200 bg-white p-4 transition hover:border-blue-300 hover:shadow-sm focus-visible:outline-2 focus-visible:outline-blue-600"><div className="flex items-start justify-between gap-2"><span className="text-xs font-semibold text-slate-500">{item.label}</span><item.icon size={17} className="shrink-0 text-slate-400 group-hover:text-blue-600"/></div><p className="mt-3 text-2xl font-semibold tabular-nums tracking-tight text-slate-950">{fmt(item.value)}</p><p className="mt-1 text-[11px] text-slate-500">{item.detail}</p></a>:<Link key={item.label} to={item.url} className="group rounded-xl border border-slate-200 bg-white p-4 transition hover:border-blue-300 hover:shadow-sm focus-visible:outline-2 focus-visible:outline-blue-600">
        <div className="flex items-start justify-between gap-2"><span className="text-xs font-semibold text-slate-500">{item.label}</span><item.icon size={17} className="shrink-0 text-slate-400 group-hover:text-blue-600"/></div>
        <p className="mt-3 text-2xl font-semibold tabular-nums tracking-tight text-slate-950">{fmt(item.value)}</p><p className="mt-1 text-[11px] text-slate-500">{item.detail}</p>
      </Link>)}
    </section>

    <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.55fr)_minmax(300px,1fr)]">
      <section id="owner-actions" className="min-w-0 scroll-mt-4 rounded-xl border border-slate-200 bg-white" aria-labelledby="action-title">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 p-4"><div><h2 id="action-title" className="text-sm font-semibold text-slate-900">What needs attention</h2><p className="mt-1 text-xs text-slate-500">Client → Work Order → specific unresolved stage</p></div><span className="rounded-lg bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-800">{snapshot.needsOwner.length} orders</span></div>
        <div className="divide-y divide-slate-100">
          {snapshot.needsOwner.slice(0,6).map(item=><div key={item.order.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 hover:bg-slate-50/70">
            <div className="min-w-0 flex-1"><p className="text-[11px] text-slate-500">{item.clientName} · PO {item.order.po_number}</p><Link to={poUrl(item.order.id)} className="mt-1 block truncate text-sm font-semibold text-slate-900 hover:text-blue-700">{item.order.name||item.order.po_number}</Link><p className="mt-1 text-xs font-medium text-amber-800">{item.next.label}</p></div>
            <div className="flex shrink-0 flex-col items-end gap-2"><span className="text-xs font-medium tabular-nums text-slate-600">{item.delivery.total ? `${item.delivery.completed}/${item.delivery.total} delivered` : 'Site scope unlinked'}</span><Link to={item.order.assignment_status==='pending_acceptance'?poUrl(item.order.id):shopUrl(item.order.id,item.delivery.total?item.next.stage:undefined)} className="rounded-lg border border-blue-200 px-3 py-1.5 text-xs font-semibold text-blue-700 hover:bg-blue-50">Open action →</Link></div>
          </div>)}
          {!snapshot.needsOwner.length && <div className="p-6 text-center text-sm text-slate-600"><CheckCircle2 size={23} className="mx-auto mb-2 text-emerald-600"/> No pending owner or field-stage actions based on current statuses.</div>}
          {snapshot.needsOwner.length>6 && <Link to="/purchase-orders" className="block px-4 py-3 text-right text-xs font-semibold text-blue-700 hover:bg-slate-50">See all Work Orders →</Link>}
        </div>
      </section>
      <section className="rounded-xl border border-slate-200 bg-white" aria-label="Quick navigation">
        <div className="border-b p-4"><h2 className="text-sm font-semibold">Jump to a queue</h2><p className="mt-1 text-xs text-slate-500">Common owner actions, one click</p></div>
        <div className="grid grid-cols-2 gap-2 p-3">{quickLinks.map(action=><Link key={action.url} to={action.url} className="flex min-h-[54px] items-center justify-between gap-2 rounded-lg border border-slate-200 bg-slate-50/60 px-3 text-xs font-medium hover:border-blue-300 hover:bg-blue-50">{action.label}<ArrowRight size={14} className="shrink-0 text-blue-700"/></Link>)}</div>
        {snapshot.aged>0 && <p className="border-t p-3 text-xs text-slate-500"><CalendarClock size={14} className="mr-1 inline text-amber-600"/>{snapshot.aged} Work Orders open 30+ days. Age is not proof of delay because PO delivery deadlines are not recorded here.</p>}
      </section>
    </div>

    <section className="rounded-xl border border-slate-200 bg-white" aria-label="Delivery stage overview">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3.5"><div><h2 className="text-sm font-semibold">Where the work is right now</h2><p className="mt-1 text-xs text-slate-500">Each linked active site counted once at its current stage; select a stage to see matching orders</p></div><Link to="/shops" className="text-xs font-semibold text-blue-700">All sites →</Link></div>
      <div className="grid grid-cols-2 gap-2 p-3 sm:grid-cols-4 xl:grid-cols-8">{pipelineStages.filter(tile=>snapshot.stages[tile.key]>0).map(tile=>{const count=snapshot.stages[tile.key];const Icon=tile.icon;return <Link key={tile.key} to={allStageUrl(tile.key)} className={`rounded-lg border px-3 py-3 transition hover:border-blue-300 ${count?'border-slate-200 bg-white':'border-slate-100 bg-slate-50/60'}`}><div className="flex items-center justify-between"><Icon size={17} className="text-slate-500"/><ArrowRight size={12} className="text-slate-300"/></div><p className={`mt-2 text-xl font-semibold tabular-nums ${count?'text-slate-950':'text-slate-400'}`}>{fmt(count)}</p><p className="mt-1 text-[11px] font-medium text-slate-600">{ownerStageLabels[tile.key]}</p></Link>})}</div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t px-4 py-3 text-xs"><span className="text-slate-600"><strong>{fmt(snapshot.sites)}</strong> linked active sites · <strong>{fmt(snapshot.portfolio.deliveredSites)}</strong> delivered</span><span className="font-semibold text-blue-700">{snapshot.portfolio.percentage}% complete</span></div>
    </section>

    <section id="owner-work-orders" className="scroll-mt-4 rounded-xl border border-slate-200 bg-white" aria-label="Client Work Orders status">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3.5"><div><h2 className="text-sm font-semibold">Work Orders by client</h2><p className="mt-1 text-xs text-slate-500">Stage, delivery and next step together · no need to open each order to know what's happening</p></div><Link to="/purchase-orders" className="text-xs font-semibold text-blue-700">Open all →</Link></div>
      <div className="divide-y divide-slate-100">{workShown.map(item=><div key={item.order.id} className="grid gap-3 px-4 py-4 hover:bg-slate-50/70 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_auto] md:items-center">
        <div className="min-w-0"><p className="text-[11px] text-slate-500">{item.clientName} · {item.order.po_number}</p><Link to={poUrl(item.order.id)} className="mt-1 block truncate text-sm font-semibold text-slate-900 hover:text-blue-700">{item.order.name||item.order.po_number}</Link><span className="mt-1 block text-[11px] text-slate-500">{fulfillmentTypeLabel(item.order.fulfillment_type||'survey_install')}{item.ageDays!=null?` · ${item.ageDays} days old`:''}</span></div>
        <div><div className="mb-1 flex justify-between gap-2 text-[11px]"><span className="text-slate-500">Site delivery</span><span className="font-medium tabular-nums">{item.delivery.total?`${item.delivery.completed}/${item.delivery.total}`:'Unlinked'}</span></div><ProgressBar pct={item.delivery.percentage} /></div>
        <div><p className={`text-xs font-semibold ${item.next.kind==='attention'?'text-amber-800':item.next.kind==='done'?'text-emerald-700':'text-slate-700'}`}>{item.next.label}</p><p className="mt-1 text-[11px] text-slate-500">{item.delivery.delivered?'Final stage passed':'Latest shop stage from linked sites'}</p></div>
        <div className="flex gap-2 md:justify-end"><Link to={poUrl(item.order.id)} className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-blue-700 hover:bg-white">Details →</Link>{!item.delivery.delivered && <Link to={shopUrl(item.order.id,item.next.stage)} className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-white">Sites →</Link>}</div>
      </div>)}{!snapshot.ranked.length && <p className="p-7 text-center text-sm text-slate-600">No open Work Orders. All current orders are delivered or closed.</p>}</div>
      {snapshot.ranked.length>8 && <button type="button" onClick={()=>setShowAllOrders(v=>!v)} className="w-full border-t px-4 py-3 text-xs font-semibold text-blue-700 hover:bg-slate-50">{showAllOrders?'Show fewer':'View all open Work Orders'} ({snapshot.ranked.length})</button>}
    </section>

    <section className="rounded-xl border border-slate-200 bg-white" aria-label="Client portfolio">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3.5"><div><h2 className="text-sm font-semibold">Client portfolio</h2><p className="mt-1 text-xs text-slate-500">Weighted by actual linked sites; client names open their Work Orders</p></div><div className="relative"><Search size={14} className="absolute left-3 top-2.5 text-slate-400"/><label className="sr-only" htmlFor="dashboard-client-search">Search clients</label><input id="dashboard-client-search" value={search} onChange={e=>{setSearch(e.target.value);setShowAllClients(false)}} placeholder="Find client" className="w-44 rounded-lg border border-slate-200 py-2 pl-8 pr-2 text-xs focus-visible:outline-2 focus-visible:outline-blue-600"/></div></div>
      <div className="grid gap-3 p-3 md:grid-cols-2">{clientsShown.map(client=><div key={client.id} className="rounded-xl border border-slate-200 bg-slate-50/50 p-4"><div className="flex items-center justify-between gap-2"><Link to={`/purchase-orders?client=${encodeURIComponent(client.id)}`} className="min-w-0 truncate text-sm font-semibold text-slate-900 hover:text-blue-700">{client.name}</Link><Link to={`/purchase-orders?client=${encodeURIComponent(client.id)}`} className="shrink-0 text-xs font-semibold text-blue-700">{client.open} open →</Link></div><div className="mt-3 flex justify-between text-[11px] text-slate-600"><span>{client.deliveredSites}/{client.sites} sites delivered</span><span className="tabular-nums">{client.sites?`${client.percent}%`:'Site scope not linked'}</span></div><div className="mt-1"><ProgressBar pct={client.percent}/></div>{client.work.length>0 && <Link to={poUrl(client.work[0].order.id)} className="mt-3 flex items-center justify-between gap-2 text-xs"><span className="min-w-0 truncate text-slate-600">Next: {client.work[0].order.name||client.work[0].order.po_number} — {client.work[0].next.label}</span><ArrowRight size={13} className="shrink-0 text-blue-700"/></Link>}</div>)}{!clientRows.length && <p className="col-span-full p-6 text-center text-xs text-slate-500">{search?'No matching clients.':'No active clients.'}</p>}</div>
      {clientRows.length>5 && <button type="button" onClick={()=>setShowAllClients(v=>!v)} className="w-full border-t px-4 py-3 text-xs font-semibold text-blue-700 hover:bg-slate-50">{showAllClients?'Show fewer clients':`View all ${clientRows.length} clients`}</button>}
    </section>

    {owner && <section className="rounded-xl border border-slate-200 bg-white" aria-label="Owner private financial progress">
      <button type="button" onClick={()=>setShowFinance(v=>!v)} aria-controls="owner-private-finances" aria-expanded={showFinance} className="flex w-full items-center justify-between gap-3 p-4 text-left focus-visible:outline-2 focus-visible:outline-blue-600"><span className="flex items-center gap-3"><span className="rounded-lg bg-slate-100 p-2"><IndianRupee size={17} className="text-slate-600"/></span><span><span className="block text-sm font-semibold">Private financial progress</span><span className="mt-1 block text-xs text-slate-500">Collapsed by default · owner-controlled reveal · no amounts appear in operational view</span></span></span><ChevronDown size={18} className={`text-slate-500 transition-transform ${showFinance?'rotate-180':''}`}/></button>
      {showFinance && <div id="owner-private-finances" className="border-t px-4 py-4">
        {financeError?<p role="alert" className="text-xs text-red-700">Financial history unavailable. Please retry.</p>:!invoiceTotals?<p role="status" className="text-xs text-slate-500">{financeFetching?'Calculating reconciled invoices…':'Loading financial history…'}</p>:(()=>{
          const totals=financeForOrders(snapshot.orders,invoiceTotals);
          return <><div className="mb-3 flex items-center justify-between gap-3"><div><h3 className="text-sm font-semibold">Billing progress by Work Order</h3><p className="mt-1 text-xs text-slate-500">PO budget and previously invoiced values (ex-GST). Invoice readiness needs item-wise verification inside each Work Order.</p></div><Link to="/billing" className="shrink-0 rounded-lg bg-blue-600 px-3 py-2 text-xs font-semibold text-white">Billing →</Link></div>
            <div className="grid gap-3 sm:grid-cols-3">{[
              {label:'PO planned value',value:formatRupees(totals.planned)},
              {label:'Already invoiced',value:formatRupees(totals.invoiced)},
              {label:'Not yet invoiced',value:formatRupees(totals.remaining)},
            ].map(card=><div key={card.label} className="rounded-lg bg-slate-50 p-3"><p className="text-xs text-slate-500">{card.label}</p><strong className="mt-1 block text-lg tabular-nums text-slate-900">{card.value}</strong></div>)}</div>
            {totals.percentage!=null && <div className="my-3"><div className="mb-1 flex justify-between text-xs"><span>Invoiced coverage</span><span>{totals.percentage}%</span></div><ProgressBar pct={totals.percentage}/></div>}
            <div className="mt-3 overflow-x-auto rounded-lg border"><table className="w-full min-w-[680px] text-left text-xs"><thead className="bg-slate-50 text-slate-500"><tr><th className="px-3 py-2">Client / Work Order</th><th className="px-3 py-2 text-right">PO value</th><th className="px-3 py-2 text-right">Invoiced</th><th className="px-3 py-2 text-right">Remaining</th><th className="px-3 py-2">Next step</th></tr></thead><tbody className="divide-y">{snapshot.details.map(({order,clientName})=>{const f=financeForOrder(order,invoiceTotals);return <tr key={order.id}><td className="px-3 py-3"><p className="text-slate-500">{clientName}</p><Link to={poUrl(order.id)} className="font-semibold text-blue-700">{order.name||order.po_number}</Link></td><td className="px-3 py-3 text-right tabular-nums">{formatRupees(f.planned)}</td><td className="px-3 py-3 text-right tabular-nums">{formatRupees(f.invoiced)}</td><td className="px-3 py-3 text-right tabular-nums">{formatRupees(f.remaining)}</td><td className="px-3 py-3"><Link to={poUrl(order.id)} className="font-semibold text-blue-700">Check billable scope →</Link></td></tr>})}</tbody></table></div>
          </>;
        })()}
      </div>}
    </section>}
  </main>;
}
