import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
import { Card, ProgressBar } from '@/components/ui';
import { completion, dateLabel, isDone, isOverdue, percent, type Order } from '@/lib/agencyProgress';
import type { Project, Client, Campaign } from '@/lib/types';

const fmt = (n:number) => n.toLocaleString('en-IN');
const startOfPeriod = (period:string, from:string|null) => {
  const d = new Date();d.setHours(0,0,0,0);
  if(period==='week') d.setDate(d.getDate()-((d.getDay()+6)%7));
  if(period==='month') d.setDate(1);
  if(period==='30days') d.setDate(d.getDate()-29);
  if(period==='custom' && from && !Number.isNaN(Date.parse(from))) return new Date(`${from}T00:00:00`);
  return d;
};
export default function DashboardPage() {
  const {profile}=useAuth();const orgId=profile?.organization_id;
  const [params,setParams]=useSearchParams();
  const range=['week','month','30days','custom'].includes(params.get('range')||'')?params.get('range')!:'month';
  const setFilter=(key:string,value:string)=>{setParams(p=>{const next=new URLSearchParams(p);next.set(key,value);return next;},{replace:true});};
  const {data,isLoading,isError,refetch}=useQuery({queryKey:['agency-owner-overview',orgId],enabled:!!orgId,queryFn:async()=>{
    if(!orgId)throw new Error('Organization unavailable');
    // Every large table is fetched in pages; Supabase/PostgREST defaults to a 1000-row limit.
    async function all(table:'clients'|'projects'|'campaigns'|'purchase_orders',columns:string,scoped:boolean) {
      const rows:Record<string,unknown>[]=[];
      for(let start=0;;start+=500){
        let q=supabase.from(table).select(columns).order('id').range(start,start+499);
        if(scoped) q=q.eq('organization_id',orgId!);
        const {data:batch,error}=await q;if(error)throw error;
        rows.push(...(batch||[]) as Record<string,unknown>[]);
        if(!batch||batch.length<500)break;
      }
      return rows;
    }
    const [clients,projects,campaigns,orders]=await Promise.all([
      all('clients','id,name,is_active',true),
      all('projects','id,name,client_id,status,start_date,end_date,created_at',true),
      all('campaigns','id,name,status,start_date,end_date,created_at',false),
      all('purchase_orders','id,client_id,project_id,campaign_id,name,po_number,status,assignment_status,created_at',true),
    ]);
    return {clients:clients as unknown as Pick<Client,'id'|'name'|'is_active'>[],projects:projects as unknown as Pick<Project,'id'|'name'|'client_id'|'status'|'start_date'|'end_date'|'created_at'>[],campaigns:campaigns as unknown as Pick<Campaign,'id'|'name'|'status'|'start_date'|'end_date'|'created_at'>[],orders:orders as unknown as Order[]};
  }});
  const start=startOfPeriod(range,params.get('from'));
  const to=params.get('to');const end=range==='custom'&&to&&!Number.isNaN(Date.parse(to))?new Date(`${to}T23:59:59`):new Date();
  if(isLoading)return <p role="status" className="p-8 text-slate-600">Loading agency overview…</p>;
  if(isError)return <Card className="p-6"><p role="alert" className="text-red-700">Could not load your agency overview. <button className="underline" onClick={()=>refetch()}>Retry</button></p></Card>;
  if(!data)return null;
  const activeProjects=data.projects.filter(p=>p.status==='active');
  const scopedCampaigns=data.campaigns.filter(c=>data.orders.some(o=>o.campaign_id===c.id));
  const activeCampaigns=activeProjects.length+scopedCampaigns.filter(c=>c.status==='active').length;
  const openOrders=data.orders.filter(o=>!isDone(o)&&o.status!=='cancelled'&&o.assignment_status!=='rejected');
  const doneOrders=data.orders.filter(isDone);
  const awaitingAcceptance=openOrders.filter(o=>o.assignment_status==='pending_acceptance');
  const clientOrders=new Map<string,Order[]>();
  for(const order of data.orders){if(!order.client_id)continue;const rows=clientOrders.get(order.client_id)||[];rows.push(order);clientOrders.set(order.client_id,rows);}
  const clients=data.clients.map(c=>{
    const orders=clientOrders.get(c.id)||[];
    const ownProjects=activeProjects.filter(p=>p.client_id===c.id);
    const clientCampaigns=scopedCampaigns.filter(camp=>camp.status==='active'&&orders.some(o=>o.campaign_id===camp.id));
    const deadlines=[...ownProjects,...clientCampaigns].map(p=>p.end_date).filter((d):d is string=>!!d).sort();
    const due=deadlines[0]||null;
    const late=isOverdue(due,orders.length>0&&orders.every(isDone));
    return {id:c.id,name:c.name,active:c.is_active,orders,due,late,activeCampaigns:ownProjects.length+clientCampaigns.length};
  });
  const delayedClients=clients.filter(c=>c.late);
  const stalled=activeProjects.filter(p=>!data.orders.some(o=>o.project_id===p.id));
  const upcoming=clients.filter(c=>c.due&&!c.late&&c.orders.some(o=>!isDone(o))).sort((a,b)=>(a.due||'').localeCompare(b.due||''));
  const startDate= start;
  const endDate=end;
  const periodOrders=data.orders.filter(o=>{const date=new Date(o.created_at);return date>=startDate&&date<=endDate;});
  const periodComplete=periodOrders.filter(isDone).length;
  const clientHealth=clients.filter(c=>c.active).sort((a,b)=>Number(b.late)-Number(a.late)||completion(a.orders)-completion(b.orders)).slice(0,6);
  const customDateValid=range!=='custom'||!!params.get('from')&&!!params.get('to')&&startDate<=endDate;
  return <main className="mx-auto max-w-[1480px] space-y-6 pb-10">
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div><p className="text-xs uppercase tracking-[0.16em] font-semibold text-blue-700">Agency operations</p><h1 className="text-3xl font-bold tracking-tight text-slate-900 mt-1">Dashboard</h1><p className="text-sm text-slate-500 mt-1">Delivery health and priorities across your agency</p></div>
      <div className="flex flex-wrap gap-2"><Link to="/campaigns" className="rounded-lg border bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50">Campaigns</Link><Link to="/purchase-orders" className="rounded-lg bg-blue-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-800">View work orders →</Link></div>
    </header>
    <section aria-label="Key agency metrics" className="grid grid-cols-2 xl:grid-cols-5 gap-3">
      {[
        {label:'Active clients',value:data.clients.filter(c=>c.is_active).length,caption:'Currently served',href:'/clients'},
        {label:'Live campaigns',value:activeCampaigns,caption:'Currently running',href:'/campaigns'},
        {label:'Open work orders',value:openOrders.length,caption:'Awaiting completion',href:'/purchase-orders'},
        {label:'Awaiting acceptance',value:awaitingAcceptance.length,caption:'New client requests',href:'/purchase-orders'},
        {label:'Delivery completion',value:`${completion(data.orders)}%`,caption:`${doneOrders.length} of ${data.orders.length} orders`,href:'/purchase-orders'},
      ].map(item=><Link key={item.label} to={item.href} className="block rounded-xl border border-slate-200 bg-white p-4 sm:p-5 shadow-sm transition hover:border-blue-300 hover:shadow-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-600"><span className="text-xs sm:text-sm font-medium text-slate-600">{item.label}</span><div className="text-2xl sm:text-3xl font-bold text-slate-900 mt-3 tabular-nums">{typeof item.value==='number'?fmt(item.value):item.value}</div><p className="text-xs text-slate-500 mt-2">{item.caption}</p></Link>)}
    </section>
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1.6fr)_minmax(280px,1fr)]">
      <section className="rounded-xl bg-white border border-slate-200 shadow-sm overflow-hidden" aria-label="Priority action queue">
        <div className="p-5 border-b border-slate-100"><h2 className="font-bold text-lg text-slate-900">Requires attention</h2><p className="text-sm text-slate-500">Work needing a decision or intervention</p></div>
        <div className="divide-y divide-slate-100">
          {[
            {label:'New work orders awaiting acceptance',number:awaitingAcceptance.length,detail:'Open the work order inbox',link:'/purchase-orders',tone:'amber'},
            {label:'Clients with passed campaign deadlines',number:delayedClients.length,detail:'Review affected clients',link:'/clients',tone:'red'},
            {label:'Active campaigns without work orders',number:stalled.length,detail:'Check campaign setup',link:'/campaigns',tone:'amber'},
          ].map(item=><Link key={item.label} to={item.link} className="flex gap-3 items-center justify-between px-5 py-4 hover:bg-slate-50"><div className="min-w-0"><p className="font-medium text-slate-800 text-sm">{item.label}</p><p className="text-xs text-slate-500 mt-1">{item.detail}</p></div><div className="flex items-center gap-3"><span className={`text-xl font-bold tabular-nums ${item.number?item.tone==='red'?'text-red-700':'text-amber-700':'text-emerald-700'}`}>{fmt(item.number)}</span><span aria-hidden className="text-slate-400">→</span></div></Link>)}
        </div>
      </section>
      <section className="rounded-xl bg-white border border-slate-200 shadow-sm p-5" aria-label="Delivery snapshot">
        <h2 className="text-lg font-bold text-slate-900">Delivery snapshot</h2><p className="text-sm text-slate-500 mt-1">Live work order status distribution</p>
        <div className="mt-5 h-3 flex overflow-hidden rounded-full bg-slate-100" role="img" aria-label={`${doneOrders.length} completed, ${openOrders.length} open, ${data.orders.length} total orders`}>
          {data.orders.length>0&&<><div className="bg-emerald-600" style={{width:`${percent(doneOrders.length,data.orders.length)}%`}}/><div className="bg-blue-500" style={{width:`${percent(openOrders.length,data.orders.length)}%`}}/></>}
        </div>
        <div className="mt-5 grid grid-cols-2 gap-4 text-sm"><div><p className="text-slate-500">Completed</p><p className="font-bold text-emerald-700 text-2xl tabular-nums">{fmt(doneOrders.length)}</p></div><div><p className="text-slate-500">Still open</p><p className="font-bold text-blue-700 text-2xl tabular-nums">{fmt(openOrders.length)}</p></div></div>
        {data.orders.length===0&&<p className="text-sm text-slate-500 mt-5">No work orders recorded yet.</p>}
        <Link to="/purchase-orders" className="inline-flex mt-5 text-sm font-semibold text-blue-700 hover:underline">Open work orders →</Link>
      </section>
    </div>
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1.6fr)_minmax(280px,1fr)]">
      <section className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
        <div className="p-5 border-b border-slate-100 flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-lg font-bold text-slate-900">Client delivery health</h2><p className="text-sm text-slate-500">Six clients needing the closest attention</p></div><Link to="/clients" className="text-sm font-semibold text-blue-700 hover:underline">All clients →</Link></div>
        <div className="overflow-x-auto"><table className="w-full text-sm min-w-[500px]"><thead className="text-left bg-slate-50 text-slate-500"><tr><th scope="col" className="p-3 pl-5">Client</th><th scope="col" className="p-3">Campaigns</th><th scope="col" className="p-3">Delivered</th><th scope="col" className="p-3">Progress</th><th scope="col" className="p-3">Deadline</th></tr></thead><tbody className="divide-y divide-slate-100">{clientHealth.map(c=><tr key={c.id} className="hover:bg-slate-50"><td className="p-3 pl-5"><Link to={`/clients?detail=${encodeURIComponent(c.id)}`} className="font-semibold text-blue-700 hover:underline">{c.name}</Link>{c.late&&<span className="block text-xs font-medium text-red-700">Delayed</span>}</td><td className="p-3 tabular-nums">{c.activeCampaigns}</td><td className="p-3 tabular-nums">{c.orders.filter(isDone).length}/{c.orders.length}</td><td className="p-3 min-w-[120px]"><ProgressBar pct={completion(c.orders)}/><span className="text-xs text-slate-600">{completion(c.orders)}%</span></td><td className="p-3 whitespace-nowrap">{dateLabel(c.due)}</td></tr>)}</tbody></table></div>
        {!clientHealth.length&&<p className="p-6 text-sm text-slate-500">No active clients yet. Add one from Clients.</p>}
      </section>
      <section className="rounded-xl border border-slate-200 bg-white shadow-sm p-5"><h2 className="text-lg font-bold text-slate-900">Upcoming deadlines</h2><p className="text-sm text-slate-500 mt-1">Next campaign deadlines with open work</p><div className="mt-4 divide-y divide-slate-100">{upcoming.slice(0,5).map(c=><Link key={c.id} to={`/clients?detail=${encodeURIComponent(c.id)}`} className="flex items-center justify-between gap-3 py-3 hover:text-blue-700"><span className="text-sm font-medium truncate">{c.name}</span><span className="text-xs text-slate-600 whitespace-nowrap">{dateLabel(c.due)}</span></Link>)}{!upcoming.length&&<p className="py-4 text-sm text-slate-500">No upcoming deadlines recorded.</p>}</div></section>
    </div>
    <section className="rounded-xl border border-slate-200 bg-white shadow-sm p-5">
      <div className="flex flex-wrap items-start justify-between gap-4"><div><h2 className="text-lg font-bold text-slate-900">Delivery trends</h2><p className="text-sm text-slate-500">Completed work orders among orders created in the selected period</p></div><div className="flex flex-wrap gap-2 text-sm"><label className="font-medium text-slate-600">Period<select value={range} onChange={e=>setFilter('range',e.target.value)} className="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2"><option value="week">This week</option><option value="month">This month</option><option value="30days">Last 30 days</option><option value="custom">Custom</option></select></label></div></div>
      {range==='custom'&&<div className="flex flex-wrap gap-3 mt-3 text-sm"><label>From<input type="date" aria-label="Start date" className="ml-2 border rounded-lg p-2" value={params.get('from')||''} onChange={e=>setFilter('from',e.target.value)}/></label><label>To<input type="date" aria-label="End date" className="ml-2 border rounded-lg p-2" value={params.get('to')||''} onChange={e=>setFilter('to',e.target.value)}/></label></div>}
      {customDateValid?<div className="mt-5 grid grid-cols-2 sm:grid-cols-3 gap-4"><div><p className="text-sm text-slate-500">Orders created</p><p className="font-bold text-2xl text-slate-900 tabular-nums">{fmt(periodOrders.length)}</p></div><div><p className="text-sm text-slate-500">Now completed</p><p className="font-bold text-2xl text-slate-900 tabular-nums">{fmt(periodComplete)}</p></div><div><p className="text-sm text-slate-500">Completion</p><p className="font-bold text-2xl text-slate-900 tabular-nums">{percent(periodComplete,periodOrders.length)}%</p></div></div>:<p role="alert" className="text-red-700 text-sm mt-4">Select a valid start and end date.</p>}
      <p className="text-xs text-slate-500 mt-4">Based on the current status of orders created in this period, not their historical completion date.</p>
    </section>
  </main>;
}
