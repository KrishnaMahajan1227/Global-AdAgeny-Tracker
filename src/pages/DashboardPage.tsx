import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  AlertCircle, ArrowRight, CheckCircle2, ChevronDown,
  ClipboardList, Factory, IndianRupee, MapPin, Palette,
  RefreshCw, Search, ShieldCheck, Store, Truck, EyeOff,
  ArrowUpRight,
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
import { orderNextActionPath } from '@/lib/operationalNavigation';
import type { Client } from '@/lib/types';

// Show only operational data by default. PO amounts and reconciled invoices
// are fetched only after an agency owner explicitly selects private finance.
type ShopRow = DeliveryShop & { id: string; client_id: string; purchase_order_id: string | null; status: string };
type ClientRow = Pick<Client, 'id' | 'name' | 'is_active'>;
type OrderView = 'all' | 'attention' | 'completed';
const fmt = (value: number) => value.toLocaleString('en-IN');
const excluded = (order: Order) => order.status === 'cancelled' || order.assignment_status === 'rejected';
const poUrl = (id: string) => `/purchase-orders?order=${encodeURIComponent(id)}`;
const shopUrl = (id: string, stage?: string) => `/shops?po=${encodeURIComponent(id)}${stage ? `&stage=${encodeURIComponent(stage)}` : ''}`;
const stageUrl = (stage: OwnerStageFilter) => `/purchase-orders?stage=${encodeURIComponent(stage)}`;
const pipelineStages = [
  { key: 'pending', icon: MapPin }, { key: 'survey', icon: ClipboardList },
  { key: 'design', icon: Palette }, { key: 'production', icon: Factory },
  { key: 'dispatch', icon: Truck }, { key: 'installation', icon: Store },
  { key: 'review', icon: ShieldCheck }, { key: 'complete', icon: CheckCircle2 },
] as const;
export default function DashboardPage() {
  const { profile } = useAuth();
  const orgId = profile?.organization_id;
  const isOwner = profile?.role === 'agency_owner';
  const [privateFinance, setPrivateFinance] = useState(false);
  const financialView = Boolean(isOwner && privateFinance);
  const [orderSearch, setOrderSearch] = useState('');
  const [clientSearch, setClientSearch] = useState('');
  const [orderView, setOrderView] = useState<OrderView>('all');
  const [showAllOrders, setShowAllOrders] = useState(false);
  const [showAllClients, setShowAllClients] = useState(false);
  const { data: invoiceTotals, isError: financeError, isFetching: financeFetching } = useAgencyFinancials(orgId, financialView);

  useRealtimeInvalidate(['shops', 'purchase_orders', 'po_line_items', 'work_items', 'installation_jobs', 'surveys', 'design_tasks', 'production_orders', 'invoices', 'invoice_items'], orgId,
    [['agency-operations-dashboard', orgId]]);

  const { data, isLoading, isError, refetch, isFetching } = useQuery({
    queryKey: ['agency-operations-dashboard', orgId, financialView],
    enabled: !!orgId,
    staleTime: 10000,
    queryFn: async () => {
      if (!orgId) throw new Error('Organization is unavailable');
      async function load(table: 'clients' | 'purchase_orders' | 'shops', columns: string) {
        const result: Record<string, unknown>[] = [];
        for (let from = 0; ; from += 500) {
          const { data: batch, error } = await supabase.from(table).select(columns)
            .eq('organization_id', orgId!).order('id').range(from, from + 499);
          if (error) throw error;
          result.push(...((batch || []) as Record<string, unknown>[]));
          if (!batch || batch.length < 500) break;
        }
        return result;
      }
      const [clients, orders, shops] = await Promise.all([
        load('clients', 'id,name,is_active'),
        load('purchase_orders', `id,client_id,project_id,campaign_id,name,po_number,status,assignment_status,fulfillment_type,delivery_receipt_required,created_at${financialView ? ',total_amount' : ''},po_line_items(requires_survey,requires_design,requires_production,requires_installation)`),
        load('shops', 'id,client_id,purchase_order_id,status'),
      ]);
      return { clients: clients as unknown as ClientRow[], orders: orders as unknown as Order[], shops: shops as unknown as ShopRow[] };
    },
  });

  const snapshot = useMemo(() => {
    if (!data) return null;
    const orders = data.orders.filter(order => !excluded(order));
    const clients = data.clients.filter(client => client.is_active);
    const clientNames = new Map(data.clients.map(client => [client.id, client.name]));
    const byOrder = deliveryByOrder(orders, data.shops);
    const portfolio = deliveryForOrders(orders, byOrder);
    const orderIds = new Set(orders.map(order => order.id));
    const linkedShops = data.shops.filter(shop => shop.purchase_order_id && orderIds.has(shop.purchase_order_id));
    const stages = deliveryPipeline(linkedShops, orders);
    const details = orders.map(order => {
      const delivery = deliveryForOrder(order, byOrder);
      const awaitingAcceptance = order.assignment_status === 'pending_acceptance';
      const next = describeOrderNextStep(delivery.stages || {pending:0,survey:0,design:0,production:0,dispatch:0,installation:0,review:0,complete:0,excluded:0}, awaitingAcceptance, order.fulfillment_type, order.delivery_receipt_required === true);
      const createdMs = order.created_at ? new Date(order.created_at).getTime() : NaN;
      const ageDays = Number.isFinite(createdMs) ? Math.max(0, Math.floor((Date.now() - createdMs) / 86400000)) : null;
      const needsAttention = !delivery.delivered && (awaitingAcceptance || !delivery.total || next.kind === 'attention');
      const priority = awaitingAcceptance ? 0 : !delivery.total ? 1 : delivery.stages?.review ? 2 : delivery.stages?.survey ? 3
        : delivery.stages?.pending ? 4 : ageDays != null && ageDays >= 30 ? 5 : 6;
      return { order, delivery, next, ageDays, clientName: clientNames.get(order.client_id) || 'Client', needsAttention, priority };
    });
    const ordered = [...details].sort((a,b) => Number(a.delivery.delivered) - Number(b.delivery.delivered)
      || a.priority - b.priority || (b.ageDays || 0) - (a.ageDays || 0));
    const open = ordered.filter(item => !item.delivery.delivered);
    const needsOwner = open.filter(item => item.needsAttention);
    const unlinked = open.filter(item => !item.delivery.total);
    const clientRows = clients.map(client => {
      const own = orders.filter(order => order.client_id === client.id);
      const progress = deliveryForOrders(own, byOrder);
      const work = ordered.filter(item => item.order.client_id === client.id);
      return { ...client, ...progress, work, attention: work.filter(item => item.needsAttention).length };
    }).sort((a,b) => b.attention - a.attention || b.open - a.open || a.name.localeCompare(b.name));
    return { clients, orders, details, ordered, open, needsOwner, clientRows, portfolio, stages, unlinked,
      aged: open.filter(item => item.ageDays != null && item.ageDays >= 30).length,
      unfinishedSites: Math.max(0, portfolio.sites - portfolio.deliveredSites) };
  }, [data]);

  if (isLoading) return <main role="status" className="rounded-2xl border bg-white p-6 text-sm text-slate-600">Loading agency operations…</main>;
  if (isError || !snapshot) return <main role="alert" className="rounded-2xl border border-red-200 bg-white p-6 text-sm text-red-700">Unable to load agency operations. <button type="button" className="font-semibold underline" onClick={() => void refetch()}>Retry</button></main>;

  const normalizedOrderSearch = orderSearch.trim().toLowerCase();
  const relevantOrders = snapshot.ordered.filter(item => (orderView === 'all' || (orderView === 'attention' ? item.needsAttention : item.delivery.delivered))
    && (!normalizedOrderSearch || [item.clientName, item.order.name, item.order.po_number, fulfillmentTypeLabel(item.order.fulfillment_type || 'survey_install')]
      .some(value => String(value || '').toLowerCase().includes(normalizedOrderSearch))));
  const workShown = showAllOrders ? relevantOrders : relevantOrders.slice(0, 10);
  const clientsFiltered = snapshot.clientRows.filter(client => client.name.toLowerCase().includes(clientSearch.trim().toLowerCase()));
  const clientsShown = showAllClients ? clientsFiltered : clientsFiltered.slice(0, 4);
  const needsOwner = snapshot.needsOwner.slice(0, 4);
  const stageItems = pipelineStages.filter(stage => snapshot.stages[stage.key] > 0);
  const actionLinks = [
    { label: 'Survey reviews', to: '/survey-review', icon: ClipboardList },
    { label: 'Design queue', to: '/design', icon: Palette },
    { label: 'Production', to: '/production', icon: Factory },
    { label: 'Install reviews', to: '/installation-review', icon: ShieldCheck },
    { label: 'Field map', to: '/field-map', icon: MapPin },
  ];
  const kpis = [
    { label: 'Open work orders', value: fmt(snapshot.open.length), subtitle: `${fmt(snapshot.clients.length)} active clients`, icon: ClipboardList, href: '/purchase-orders', tone: 'text-slate-900' },
    { label: 'Needs attention', value: fmt(snapshot.needsOwner.length), subtitle: snapshot.aged ? `${fmt(snapshot.aged)} open over 30 days` : 'Owner follow-up queue', icon: AlertCircle, href: '#owner-attention', tone: snapshot.needsOwner.length ? 'text-amber-700' : 'text-slate-900' },
    { label: 'Sites delivered', value: `${fmt(snapshot.portfolio.deliveredSites)} / ${fmt(snapshot.portfolio.sites)}`, subtitle: 'At final required stage', icon: CheckCircle2, href: '/shops?stage=complete', tone: 'text-emerald-700' },
    { label: 'Site completion', value: snapshot.portfolio.sites ? `${snapshot.portfolio.percentage}%` : '—', subtitle: snapshot.portfolio.sites ? `${fmt(snapshot.unfinishedSites)} active sites remaining` : 'Site scope not linked', icon: Store, href: '/shops', tone: 'text-blue-700' },
  ];

  return <main className="mx-auto max-w-[1660px] space-y-3 pb-6 text-slate-800">
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 pb-3">
      <p className="text-xs font-medium text-slate-500">Agency operations <span className="mx-1 text-slate-300">/</span> Live delivery overview</p>
      <div className="flex flex-wrap items-center gap-2">
        {isOwner && <div role="group" aria-label="Choose dashboard view" className="inline-flex items-center rounded-lg border border-slate-200 bg-slate-100 p-0.5">
          <button type="button" aria-pressed={!financialView} onClick={() => setPrivateFinance(false)} className={`min-h-9 rounded-md px-3 text-xs font-semibold focus-visible:outline-2 focus-visible:outline-blue-600 ${!financialView ? 'bg-white text-blue-700 shadow-sm' : 'text-slate-600 hover:bg-white/70'}`}>Work</button>
          <button type="button" aria-pressed={financialView} onClick={() => setPrivateFinance(true)} className={`min-h-9 rounded-md px-3 text-xs font-semibold focus-visible:outline-2 focus-visible:outline-blue-600 ${financialView ? 'bg-white text-blue-700 shadow-sm' : 'text-slate-600 hover:bg-white/70'}`}>Financial · private</button>
        </div>}
        <button type="button" title="Refresh live operations" aria-label="Refresh live operations" onClick={() => { void refetch(); }} className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-600 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-blue-600"><RefreshCw size={14} className={isFetching ? 'animate-spin' : ''}/> Refresh</button>
        <Link to="/purchase-orders" className="inline-flex min-h-9 items-center gap-1.5 rounded-lg bg-blue-600 px-3 text-xs font-semibold text-white hover:bg-blue-700 focus-visible:outline-2 focus-visible:outline-blue-600">Work Orders <ArrowRight size={14}/></Link>
      </div>
    </div>

    {!financialView ? <>
      <section aria-label="Key delivery indicators" className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        {kpis.map(kpi => {
          const Icon = kpi.icon;
          return <Link key={kpi.label} to={kpi.href} onClick={kpi.href.startsWith('#') ? (event) => {event.preventDefault();document.getElementById('owner-attention')?.scrollIntoView({behavior:'smooth',block:'start'});} : undefined} className="group flex min-w-0 items-start gap-3 rounded-xl border border-slate-200 bg-white px-3.5 py-3.5 transition-colors hover:border-blue-300 hover:bg-blue-50/40 focus-visible:outline-2 focus-visible:outline-blue-600">
            <span className="shrink-0 rounded-lg bg-slate-100 p-2 text-slate-500 group-hover:bg-blue-100 group-hover:text-blue-700"><Icon size={16}/></span>
            <span className="min-w-0 flex-1"><span className="block text-xs font-medium text-slate-500">{kpi.label}</span><strong className={`mt-0.5 block text-xl font-semibold tabular-nums tracking-tight sm:text-2xl ${kpi.tone}`}>{kpi.value}</strong><span className="mt-0.5 block text-[11px] text-slate-500">{kpi.subtitle}</span></span>
            <ArrowUpRight className="shrink-0 text-slate-300 group-hover:text-blue-600" size={13}/>
          </Link>;
        })}
      </section>

      <section id="owner-attention" aria-label="Action required" className="scroll-mt-20 overflow-hidden rounded-xl border border-slate-200 bg-white">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-2.5">
          <div className="flex min-w-0 items-center gap-2"><h2 className="text-sm font-semibold text-slate-900">Attention required</h2><span className={`rounded-md px-2 py-0.5 text-[11px] font-semibold ${snapshot.needsOwner.length ? 'bg-amber-50 text-amber-800' : 'bg-emerald-50 text-emerald-800'}`}>{snapshot.needsOwner.length}</span></div>
          <div className="flex flex-wrap items-center gap-3 text-[11px] text-slate-500">{snapshot.unlinked.length > 0 && <span>{snapshot.unlinked.length} unlinked order(s)</span>}{snapshot.aged > 0 && <span>{snapshot.aged} open 30+ days — not an overdue label</span>}{snapshot.needsOwner.length > needsOwner.length && <button type="button" onClick={() => {setOrderView('attention'); setShowAllOrders(true); document.getElementById('owner-work-orders')?.scrollIntoView({behavior:'smooth',block:'start'});}} className="font-semibold text-blue-700 hover:underline">View all →</button>}</div>
        </div>
        {needsOwner.length ? <div className="divide-y divide-slate-100">{needsOwner.map(item => <div key={item.order.id} className="grid gap-2 px-4 py-2.5 sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_auto] sm:items-center">
          <div className="min-w-0"><p className="truncate text-[11px] text-slate-500">{item.clientName} · {item.order.po_number}</p><Link to={poUrl(item.order.id)} className="block truncate text-sm font-semibold text-slate-900 hover:text-blue-700">{item.order.name || item.order.po_number}</Link></div>
          <div className="min-w-0"><p className="truncate text-xs font-medium text-amber-800">{!item.delivery.total && item.order.assignment_status !== 'pending_acceptance' ? 'Verify linked site scope' : item.next.label}</p><p className="text-[11px] text-slate-500">{item.delivery.total ? `${fmt(item.delivery.completed)} of ${fmt(item.delivery.total)} delivered` : 'Site scope unlinked'}</p></div>
          <Link to={orderNextActionPath(item.order, item.next, item.delivery.total > 0)} className="inline-flex min-h-9 items-center justify-center gap-1 rounded-lg bg-blue-600 px-3 text-xs font-semibold text-white hover:bg-blue-700">Take action <ArrowRight size={13}/></Link>
        </div>)}</div> : <p className="flex items-center gap-2 px-4 py-4 text-xs text-slate-600"><CheckCircle2 size={16} className="text-emerald-600"/> No immediate owner-action exceptions in recorded shop stages.</p>}
      </section>

      <section id="owner-work-orders" aria-label="Client and work orders" className="scroll-mt-20 overflow-hidden rounded-xl border border-slate-200 bg-white">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-2.5"><h2 className="text-sm font-semibold text-slate-900">Work Orders by client</h2><Link to="/purchase-orders" className="inline-flex items-center gap-1 text-xs font-semibold text-blue-700 hover:underline">All Work Orders <ArrowRight size={13}/></Link></div>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 bg-slate-50/70 px-3 py-2">
          <div role="group" aria-label="Work order filter" className="inline-flex flex-wrap gap-0.5 rounded-lg border border-slate-200 bg-white p-0.5">{([['all','All orders'],['attention','Needs action'],['completed','Completed']] as [OrderView,string][]).map(([key,label]) => <button key={key} type="button" aria-pressed={orderView===key} onClick={() => {setOrderView(key);setShowAllOrders(false);}} className={`min-h-8 rounded-md px-3 text-xs font-semibold focus-visible:outline-2 focus-visible:outline-blue-600 ${orderView===key ? 'bg-blue-600 text-white' : 'text-slate-600 hover:bg-slate-100'}`}>{label}</button>)}</div>
          <div className="relative w-full sm:w-72"><Search size={15} className="pointer-events-none absolute left-3 top-2.5 text-slate-400"/><label htmlFor="owner-order-search" className="sr-only">Search by client name, work order or PO number</label><input id="owner-order-search" type="search" value={orderSearch} onChange={event=>{setOrderSearch(event.target.value);setShowAllOrders(false);}} placeholder="Search client, order or PO" className="min-h-9 w-full rounded-lg border border-slate-200 bg-white py-1.5 pl-9 pr-3 text-xs focus-visible:outline-2 focus-visible:outline-blue-600"/></div>
        </div>
        <div className="hidden grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)_minmax(0,1.1fr)_auto] gap-3 bg-slate-50/50 px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500 lg:grid"><span>Client / work order</span><span>Site delivery</span><span>Current stage / next step</span><span className="text-right">Action</span></div>
        <div className="divide-y divide-slate-100">{workShown.map(item=>{
          const stages = pipelineStages.filter(stage=>stage.key!=='complete' && (item.delivery.stages?.[stage.key]||0)>0);
          const directAction = orderNextActionPath(item.order, item.next, item.delivery.total > 0);
          return <article key={item.order.id} className="grid gap-2 px-4 py-3 hover:bg-slate-50/70 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)_minmax(0,1.1fr)_auto] lg:items-center lg:gap-3">
            <div className="min-w-0"><p className="truncate text-[11px] text-slate-500">{item.clientName} · PO {item.order.po_number}</p><Link to={poUrl(item.order.id)} className="block truncate text-sm font-semibold text-slate-900 hover:text-blue-700">{item.order.name||item.order.po_number}</Link><p className="truncate text-[11px] text-slate-500">{fulfillmentTypeLabel(item.order.fulfillment_type||'survey_install')}{item.ageDays!=null?` · ${fmt(item.ageDays)}d since created`:''}</p></div>
            <div className="min-w-0"><div className="mb-1 flex justify-between gap-2 text-xs"><span className="text-slate-500">Sites</span><span className="font-semibold tabular-nums text-slate-700">{item.delivery.total?`${fmt(item.delivery.completed)} / ${fmt(item.delivery.total)}`:'Not linked'}</span></div><ProgressBar pct={item.delivery.percentage}/><p className="mt-1 text-[11px] text-slate-500">{item.delivery.total?`${item.delivery.percentage}% final-stage delivery`:'Verify scope before progress'}</p></div>
            <div className="min-w-0"><p className={`truncate text-xs font-semibold ${item.delivery.delivered?'text-emerald-700':item.needsAttention?'text-amber-800':'text-slate-700'}`}>{item.delivery.delivered?'Delivery complete':!item.delivery.total && item.order.assignment_status!=='pending_acceptance'?'Scope check needed':item.next.label}</p><div className="mt-1 flex flex-wrap gap-1">{stages.slice(0,3).map(stage=><Link key={stage.key} to={shopUrl(item.order.id,stage.key)} className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-600 hover:bg-blue-100 hover:text-blue-700">{item.delivery.stages?.[stage.key]||0} {ownerStageLabels[stage.key]}</Link>)}{item.delivery.delivered&&<span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] text-emerald-800">All sites final</span>}</div></div>
            <div className="flex flex-wrap gap-1.5 lg:justify-end"><Link to={poUrl(item.order.id)} className="inline-flex min-h-9 items-center rounded-lg border border-slate-200 px-3 text-xs font-semibold text-slate-600 hover:bg-slate-100">Details</Link>{!item.delivery.delivered&&<Link to={directAction} className="inline-flex min-h-9 items-center gap-1 rounded-lg border border-blue-200 bg-blue-50 px-3 text-xs font-semibold text-blue-700 hover:bg-blue-100">Next <ArrowRight size={13}/></Link>}</div>
          </article>;
        })}{!relevantOrders.length&&<div className="px-4 py-6 text-center text-sm text-slate-500">No Work Orders match. <button type="button" onClick={()=>{setOrderSearch('');setOrderView('all');}} className="font-semibold text-blue-700 underline">Clear filters</button></div>}</div>
        {relevantOrders.length>10&&<button type="button" onClick={()=>setShowAllOrders(v=>!v)} className="w-full border-t px-4 py-2.5 text-xs font-semibold text-blue-700 hover:bg-slate-50">{showAllOrders?'Show fewer':`Show all ${fmt(relevantOrders.length)} orders`} <ChevronDown size={13} className={`ml-1 inline ${showAllOrders?'rotate-180':''}`}/></button>}
      </section>

      <section aria-label="Operational quick actions" className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2.5">
        <span className="mr-1 text-xs font-semibold text-slate-700">Quick access</span>{actionLinks.map(action=>{const Icon=action.icon;return <Link key={action.to} to={action.to} className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-3 text-xs font-medium text-slate-700 hover:border-blue-200 hover:bg-blue-50 hover:text-blue-700"><Icon size={14}/>{action.label}</Link>;})}
      </section>

      <section aria-label="Current site stages" className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-4 py-2.5"><div className="flex flex-wrap items-baseline gap-2"><h2 className="text-sm font-semibold text-slate-900">Site pipeline</h2><span className="text-xs text-slate-500">Sites in their current stage · each counted once</span></div><Link to="/shops" className="shrink-0 text-xs font-semibold text-blue-700">All sites →</Link></div>
        <div className="flex flex-wrap gap-px bg-slate-200">{stageItems.map(stage=>{const Icon=stage.icon;return <Link key={stage.key} to={stageUrl(stage.key)} className="group flex min-w-[135px] flex-1 items-center gap-2 bg-white px-3 py-3 hover:bg-blue-50"><Icon size={15} className="shrink-0 text-slate-400 group-hover:text-blue-600"/><div className="min-w-0"><strong className="block text-lg font-semibold tabular-nums leading-5 text-slate-900">{fmt(snapshot.stages[stage.key])}</strong><span className="block truncate text-[11px] text-slate-500">{ownerStageLabels[stage.key]}</span></div></Link>;})}{!stageItems.length&&<p className="w-full bg-white p-4 text-sm text-slate-500">No linked active site stages available. <Link to="/shops" className="text-blue-700 underline">Review shops</Link></p>}</div>
      </section>

      <section aria-label="Client delivery summary" className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-2.5"><h2 className="text-sm font-semibold text-slate-900">Client delivery</h2><div className="relative w-full sm:w-52"><Search className="pointer-events-none absolute left-2.5 top-2.5 text-slate-400" size={14}/><label htmlFor="owner-client-search" className="sr-only">Search clients</label><input id="owner-client-search" value={clientSearch} onChange={event=>{setClientSearch(event.target.value);setShowAllClients(false);}} placeholder="Find client" className="min-h-9 w-full rounded-lg border border-slate-200 py-1.5 pl-8 pr-2 text-xs focus-visible:outline-2 focus-visible:outline-blue-600"/></div></div>
        <div className="divide-y divide-slate-100">{clientsShown.map(client=><article key={client.id} className="grid gap-2 px-4 py-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_minmax(0,1.4fr)_auto] md:items-center md:gap-4">
          <div className="min-w-0"><Link to={`/purchase-orders?client=${encodeURIComponent(client.id)}`} className="block truncate text-sm font-semibold text-slate-900 hover:text-blue-700">{client.name}</Link><p className="text-[11px] text-slate-500">{client.open} open · {client.done} completed orders{client.attention?` · ${client.attention} need action`:''}</p></div>
          <div className="min-w-0"><div className="mb-1 flex justify-between gap-2 text-xs"><span className="text-slate-500">Delivered sites</span><span className="font-semibold tabular-nums text-slate-700">{fmt(client.deliveredSites)} / {fmt(client.sites)} · {client.sites?`${client.percentage}%`:'—'}</span></div><ProgressBar pct={client.percentage}/></div>
          <div className="min-w-0 space-y-1">{client.work.slice(0,2).map(item=><Link key={item.order.id} to={poUrl(item.order.id)} className="flex min-w-0 items-center justify-between gap-1 text-[11px] text-slate-600 hover:text-blue-700"><span className="truncate">{item.order.name||item.order.po_number} · {item.delivery.delivered?'Delivered':item.next.label}</span><ArrowRight size={12} className="shrink-0"/></Link>)}</div>
          <Link to={`/purchase-orders?client=${encodeURIComponent(client.id)}`} className="inline-flex min-h-9 shrink-0 items-center text-xs font-semibold text-blue-700 hover:underline">Open client orders <ArrowRight className="ml-1" size={13}/></Link>
        </article>)}{!clientsFiltered.length&&<p className="px-4 py-5 text-sm text-slate-500">{clientSearch?'No matching clients.':'No active clients yet.'}</p>}</div>
        {clientsFiltered.length>4&&<button type="button" onClick={()=>setShowAllClients(v=>!v)} className="w-full border-t px-4 py-2.5 text-xs font-semibold text-blue-700 hover:bg-slate-50">{showAllClients?'Show fewer clients':`Show all ${clientsFiltered.length} clients`}</button>}
      </section>
    </> : isOwner && <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm" aria-label="Owner private financial progress">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b bg-slate-50 px-5 py-4"><div><p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-500"><IndianRupee size={15}/> Owner-only view</p><h2 className="mt-1 text-lg font-semibold text-slate-950">Private financial progress</h2><p className="mt-1 text-xs text-slate-500">Only shown after you select Financial. Amounts are contract and invoicing figures, not guessed from delivered sites.</p></div>
        <button type="button" onClick={() => setPrivateFinance(false)} className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-700 hover:bg-slate-100"><EyeOff size={15}/> Hide finances</button></div>
      <div className="p-4 sm:p-5">
        {financeError ? <p role="alert" className="text-sm text-red-700">Financial history unavailable. Switch views or refresh and retry.</p> : !invoiceTotals ? <p role="status" className="text-sm text-slate-500">{financeFetching ? 'Reconciling invoice history…' : 'Loading financial history…'}</p> : (() => {
          const totals = financeForOrders(snapshot.orders, invoiceTotals);
          return <>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2"><div><h3 className="text-sm font-semibold">Billing status across Work Orders</h3><p className="mt-1 text-xs text-slate-500">Value invoiced and still unbilled, ex-GST. Eligible unbilled quantities must be verified per Work Order.</p></div><Link to="/billing" className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-blue-600 px-3 text-xs font-semibold text-white hover:bg-blue-700">Billing workspace <ArrowRight size={14}/></Link></div>
            <div className="grid gap-3 sm:grid-cols-3">{[
              { label: 'Planned PO value', value: formatRupees(totals.planned) },
              { label: 'Previously invoiced', value: formatRupees(totals.invoiced) },
              { label: 'Not yet invoiced', value: formatRupees(totals.remaining) },
            ].map(card => <div key={card.label} className="rounded-xl border border-slate-200 bg-slate-50 p-4"><p className="text-xs text-slate-500">{card.label}</p><strong className="mt-2 block text-xl font-semibold tabular-nums text-slate-950">{card.value}</strong></div>)}</div>
            {totals.percentage != null && <div className="my-4"><div className="mb-1 flex justify-between text-xs"><span>Invoiced coverage</span><span>{totals.percentage}%</span></div><ProgressBar pct={totals.percentage}/></div>}
            <div className="mt-4 overflow-x-auto rounded-xl border border-slate-200"><table className="w-full min-w-[700px] text-left text-xs"><thead className="bg-slate-50 text-slate-500"><tr><th scope="col" className="px-4 py-3">Client / Work Order</th><th scope="col" className="px-3 py-3 text-right">PO value</th><th scope="col" className="px-3 py-3 text-right">Invoiced</th><th scope="col" className="px-3 py-3 text-right">Not invoiced</th><th scope="col" className="px-3 py-3">Next step</th></tr></thead><tbody className="divide-y divide-slate-100">{snapshot.details.map(({order, clientName}) => {
              const finances = financeForOrder(order, invoiceTotals);
              return <tr key={order.id} className="hover:bg-slate-50"><td className="px-4 py-3"><span className="block text-slate-500">{clientName}</span><Link to={poUrl(order.id)} className="font-semibold text-blue-700">{order.name || order.po_number}</Link></td><td className="px-3 py-3 text-right tabular-nums">{formatRupees(finances.planned)}</td><td className="px-3 py-3 text-right tabular-nums">{formatRupees(finances.invoiced)}</td><td className="px-3 py-3 text-right tabular-nums">{formatRupees(finances.remaining)}</td><td className="px-3 py-3"><Link to={poUrl(order.id)} className="font-semibold text-blue-700">Review billable items →</Link></td></tr>;
            })}</tbody></table></div>
            <p className="mt-3 text-xs text-slate-500">To see verified ready-to-invoice quantity, partial invoicing and line-item exceptions, open a Work Order → Financial.</p>
          </>;
        })()}
      </div>
    </section>}
  </main>;
}
