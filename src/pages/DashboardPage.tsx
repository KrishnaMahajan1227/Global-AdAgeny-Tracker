import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
import { Card, ProgressBar } from '@/components/ui';
import { completion, dateLabel, isDone, isOverdue, percent, type Order } from '@/lib/agencyProgress';
import type { Project, Client, Campaign } from '@/lib/types';

type ClientRow = {id:string;name:string;active:boolean;activeCampaigns:number;orders:Order[];due:string|null;late:boolean};
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
  const [search,setSearch]=useState('');const [page,setPage]=useState(1);
  const view=params.get('view')==='campaign'?'campaign':'client';
  const range=['week','month','30days','custom'].includes(params.get('range')||'')?params.get('range')!:'month';
  const metric=params.get('metric')==='completed'?'completed':'completion';
  const setFilter=(key:string,value:string)=>{setPage(1);setParams(p=>{const next=new URLSearchParams(p);next.set(key,value);return next;},{replace:true});};
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
  const start=useMemo(()=>startOfPeriod(range,params.get('from')),[range,params]);
  const to=params.get('to');const end=range==='custom'&&to&&!Number.isNaN(Date.parse(to))?new Date(`${to}T23:59:59`):new Date();
  if(isLoading)return <p role="status" className="p-8 text-slate-600">Loading agency overview…</p>;
  if(isError)return <Card className="p-6"><p role="alert" className="text-red-700">Could not load your agency overview. <button className="underline" onClick={()=>refetch()}>Retry</button></p></Card>;
  if(!data)return null;
  const projects=data.projects;
  const activeProjects=projects.filter(p=>p.status==='active');
  const visibleCampaigns=data.campaigns.filter(c=>data.orders.some(o=>o.campaign_id===c.id));
  const activeCampaigns=activeProjects.length+visibleCampaigns.filter(c=>c.status==='active').length;
  const open=data.orders.filter(o=>!isDone(o)&&o.status!=='cancelled'&&o.assignment_status!=='rejected');
  const orderByClient=new Map<string,Order[]>();data.orders.forEach(o=>{if(!o.client_id)return;const arr=orderByClient.get(o.client_id)||[];arr.push(o);orderByClient.set(o.client_id,arr);});
  const clientRows:ClientRow[]=data.clients.map(c=>{
    const orders=orderByClient.get(c.id)||[];
    const ownProjects=projects.filter(p=>p.client_id===c.id);
    const linked=visibleCampaigns.filter(camp=>orders.some(o=>o.campaign_id===camp.id));
    const dates=[...ownProjects,...linked].filter(p=>p.status==='active'&&p.end_date).map(p=>p.end_date!).sort();
    const due=dates[0]||null;
    return {id:c.id,name:c.name,active:c.is_active,activeCampaigns:ownProjects.filter(p=>p.status==='active').length+linked.filter(p=>p.status==='active').length,orders,due,late:isOverdue(due,orders.length>0&&orders.every(isDone))};
  });
  const deadlineIssues=clientRows.filter(r=>r.late).length;
  const pendingReview=open.filter(o=>o.assignment_status==='pending_acceptance');
  const unstartedCampaigns=activeProjects.filter(p=>!data.orders.some(o=>o.project_id===p.id));
  const periodOrders=data.orders.filter(o=>{const d=new Date(o.created_at);return d>=start&&d<=end;});
  const groups=view==='client' ? clientRows.map(r=>({key:r.id,name:r.name,href:`/clients?detail=${r.id}`,orders:periodOrders.filter(o=>o.client_id===r.id),extra:r.activeCampaigns})) : [...projects.map(p=>({key:`p-${p.id}`,name:p.name,href:`/campaigns?detail=project:${p.id}`,orders:periodOrders.filter(o=>o.project_id===p.id),extra:0})),...visibleCampaigns.map(c=>({key:`c-${c.id}`,name:c.name,href:`/campaigns?detail=campaign:${c.id}`,orders:periodOrders.filter(o=>o.campaign_id===c.id),extra:0}))];
  const filtered=groups.filter(r=>r.name.toLowerCase().includes(search.toLowerCase())).sort((a,b)=>b.orders.filter(isDone).length-a.orders.filter(isDone).length||a.name.localeCompare(b.name));
  const pageCount=Math.max(1,Math.ceil(filtered.length/12));const currentPage=Math.min(page,pageCount);const pageRows=filtered.slice((currentPage-1)*12,currentPage*12);
  return <main className="max-w-7xl mx-auto space-y-6 pb-8">
    <header className="flex flex-wrap items-end justify-between gap-3"><div><h1 className="text-2xl font-bold tracking-tight text-slate-900">Agency overview</h1><p className="text-sm text-slate-600 mt-1">Clients, delivery and issues that need your attention</p></div><Link className="rounded-lg bg-blue-700 px-4 py-2 text-sm font-medium text-white hover:bg-blue-800" to="/clients">Manage clients →</Link></header>
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">{[
      ['Active clients',data.clients.filter(c=>c.is_active).length],['Running campaigns',activeCampaigns],['Open work orders',open.length],['Overall completion',`${completion(data.orders)}%`]
    ].map(([label,num])=><Card key={label} className="p-4 sm:p-5"><p className="text-sm text-slate-600">{label}</p><p className="text-2xl sm:text-3xl font-bold mt-2 text-slate-900">{typeof num==='number'?fmt(num):num}</p></Card>)}</div>
    <section aria-label="Attention required" className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-4 sm:px-5"><div className="flex flex-wrap items-center gap-x-7 gap-y-2"><strong className="text-amber-950">Needs attention</strong><span className="text-sm text-amber-950"><b>{fmt(deadlineIssues)}</b> clients past campaign deadline</span><span className="text-sm text-amber-950"><b>{fmt(pendingReview.length)}</b> work orders awaiting acceptance</span><span className="text-sm text-amber-950"><b>{fmt(unstartedCampaigns.length)}</b> active campaigns without orders</span><Link className="text-sm font-semibold text-blue-800 underline ml-auto" to="/purchase-orders">Review work orders</Link></div></section>
    <section><div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4 mb-4"><div><h2 className="text-lg font-bold text-slate-900">Delivery progress</h2><p className="text-sm text-slate-500">Search, filter and open a client or campaign directly. Results are paginated.</p></div><div className="flex flex-wrap gap-2 text-sm">
      <label>Group by<select aria-label="Group by" className="block mt-1 border border-slate-300 rounded-lg bg-white px-3 py-2" value={view} onChange={e=>setFilter('view',e.target.value)}><option value="client">Clients</option><option value="campaign">Campaigns</option></select></label>
      <label>Period<select aria-label="Period" className="block mt-1 border border-slate-300 rounded-lg bg-white px-3 py-2" value={range} onChange={e=>setFilter('range',e.target.value)}><option value="week">This week</option><option value="month">This month</option><option value="30days">Last 30 days</option><option value="custom">Custom</option></select></label>
      <label>Metric<select aria-label="Metric" className="block mt-1 border border-slate-300 rounded-lg bg-white px-3 py-2" value={metric} onChange={e=>setFilter('metric',e.target.value)}><option value="completion">Completion %</option><option value="completed">Orders completed</option></select></label>
    </div></div>
    {range==='custom'&&<div className="flex flex-wrap gap-3 mb-3 text-sm"><label>From <input type="date" className="ml-2 border rounded-lg px-2 py-1" value={params.get('from')||''} onChange={e=>setFilter('from',e.target.value)}/></label><label>To <input type="date" className="ml-2 border rounded-lg px-2 py-1" value={to||''} onChange={e=>setFilter('to',e.target.value)}/></label></div>}
    <Card className="overflow-hidden"><div className="p-4 border-b"><input aria-label="Search progress" value={search} onChange={e=>{setSearch(e.target.value);setPage(1);}} placeholder={`Search ${view==='client'?'clients':'campaigns'}…`} className="border border-slate-300 rounded-lg px-3 py-2 text-sm w-full sm:w-80"/></div><div className="overflow-x-auto"><table className="w-full min-w-[620px] text-sm"><thead className="bg-slate-50 text-slate-600 text-left"><tr><th className="p-3">{view==='client'?'Client':'Campaign'}</th>{view==='client'&&<th className="p-3">Active campaigns</th>}<th className="p-3">Orders done / total</th><th className="p-3">Progress</th>{view==='client'&&<><th className="p-3">Health</th><th className="p-3">Next deadline</th></>}</tr></thead><tbody>{pageRows.map(r=>{const original=clientRows.find(c=>c.id===r.key);const done=r.orders.filter(isDone).length;return <tr key={r.key} className="border-t border-slate-100 hover:bg-slate-50"><td className="p-3"><Link className="font-semibold text-blue-700 hover:underline" to={r.href}>{r.name}</Link></td>{view==='client'&&<td className="p-3">{r.extra}</td>}<td className="p-3">{done}/{r.orders.length}</td><td className="p-3 min-w-40"><div className="flex items-center gap-3"><div className="w-28"><ProgressBar pct={completion(r.orders)}/></div><span>{metric==='completed'?fmt(done):`${percent(done,r.orders.length)}%`}</span></div></td>{view==='client'&&<><td className="p-3"><span className={original?.late?'text-red-700 font-medium':original?.orders.length&&!original.orders.every(isDone)?'text-blue-700':'text-emerald-700'}>{original?.late?'Delayed':original?.orders.length&&!original.orders.every(isDone)?'In progress':'On track'}</span></td><td className="p-3">{dateLabel(original?.due)}</td></>}</tr>;})}</tbody></table></div>{!pageRows.length&&<p className="p-6 text-slate-500">No records match these filters.</p>}{pageCount>1&&<div className="p-3 border-t flex justify-end items-center gap-3 text-sm"><button disabled={currentPage===1} className="text-blue-700 disabled:opacity-40" onClick={()=>setPage(n=>n-1)}>Previous</button><span>{currentPage} / {pageCount}</span><button disabled={currentPage===pageCount} className="text-blue-700 disabled:opacity-40" onClick={()=>setPage(n=>n+1)}>Next</button></div>}</Card>
    <p className="mt-2 text-xs text-slate-500">Completion uses recorded work-order status. Period filters use order creation dates because historical completion timestamps are unavailable. Individual work-order overdue counts and team rankings are not shown without reliable source data.</p></section>
  </main>;
}
