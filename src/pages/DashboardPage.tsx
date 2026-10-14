import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
import { Card, ProgressBar } from '@/components/ui';
import { completion, dateLabel, isDone, isOverdue, percent, type Order } from '@/lib/agencyProgress';
import type { Project, Client, Campaign } from '@/lib/types';

const periods = ['week', 'month', '30days', 'custom'];
const views = ['client','campaign','team'];
const metrics = ['completion','completed','ontime'];
const dateKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;

export default function DashboardPage() {
  const { profile } = useAuth();
  const orgId = profile?.organization_id;
  const [params, setParams] = useSearchParams();
  const view = views.includes(params.get('view') || '') ? params.get('view')! : 'client';
  const period = periods.includes(params.get('range') || '') ? params.get('range')! : 'month';
  const metric = metrics.includes(params.get('metric') || '') ? params.get('metric')! : 'completion';
  const setFilter = (key:string, value:string) => setParams(p => { const next = new URLSearchParams(p); next.set(key,value); return next; }, {replace:true});
  const {data, isLoading, isError, refetch} = useQuery({queryKey:['agency-progress-dashboard',orgId],enabled:!!orgId,queryFn:async()=>{
    if (!orgId) throw new Error('Organization missing');
    const [clients, projects, campaigns, orders] = await Promise.all([
      supabase.from('clients').select('id,name,is_active').eq('organization_id',orgId),
      supabase.from('projects').select('id,name,client_id,status,start_date,end_date,created_at').eq('organization_id',orgId),
      supabase.from('campaigns').select('id,name,status,start_date,end_date,created_at'),
      supabase.from('purchase_orders').select('id,client_id,project_id,campaign_id,name,po_number,status,assignment_status,created_at').eq('organization_id',orgId),
    ]);
    for (const r of [clients,projects,campaigns,orders]) if(r.error) throw r.error;
    return {clients: (clients.data||[]) as Pick<Client,'id'|'name'|'is_active'>[],projects:(projects.data||[]) as Pick<Project,'id'|'name'|'client_id'|'status'|'start_date'|'end_date'|'created_at'>[],campaigns:(campaigns.data||[]) as Pick<Campaign,'id'|'name'|'status'|'start_date'|'end_date'|'created_at'>[],orders:(orders.data||[]) as Order[]};
  }});
  const now = new Date();
  const start = useMemo(()=> { const d = new Date(); d.setHours(0,0,0,0); if(period==='week') d.setDate(d.getDate()-((d.getDay()+6)%7)); else if(period==='month') d.setDate(1); else if(period==='30days') d.setDate(d.getDate()-29); else if(params.get('from')) return new Date(`${params.get('from')}T00:00:00`); return d; },[period,params]);
  const end = period==='custom' && params.get('to') ? new Date(`${params.get('to')}T23:59:59`) : now;
  if(isLoading) return <p role="status" className="p-8">Loading agency performance…</p>;
  if(isError) return <div role="alert" className="p-6 text-red-700">Unable to load agency progress. <button className="underline" onClick={()=>refetch()}>Retry</button></div>;
  if(!data) return null;
  const scoped = data.orders.filter(o=>{const d=new Date(o.created_at);return d>=start && d<=end;});
  const campaigns = [...data.projects.map(p=>({...p,kind:'project' as const})),...data.campaigns.map(c=>({...c,client_id:undefined,kind:'client' as const}))];
  const relevant = (c:typeof campaigns[number])=>data.orders.filter(o=>c.kind==='project'?o.project_id===c.id:o.campaign_id===c.id);
  const clientRows = data.clients.map(c=>{const orders=data.orders.filter(o=>o.client_id===c.id);const active=data.projects.filter(p=>p.client_id===c.id&&p.status==='active').length + data.campaigns.filter(p=>p.status==='active'&&data.orders.some(o=>o.client_id===c.id&&o.campaign_id===p.id)).length;const due = data.projects.filter(p=>p.client_id===c.id&&p.end_date&&p.status==='active').map(p=>p.end_date!).sort()[0];const delayed = !!due && isOverdue(due,orders.length>0&&orders.every(isDone));return {client:c,orders,active,due,status:delayed?'Delayed':orders.length&&!orders.every(isDone)&&due&&new Date(due).getTime()-Date.now()<7*86400000?'At Risk':'On Track'};});
  const list = view==='client' ? data.clients.map(c=>({id:c.id,name:c.name,orders:scoped.filter(o=>o.client_id===c.id),to:`/clients/${c.id}`})) : view==='campaign' ? campaigns.map(c=>({id:`${c.kind}-${c.id}`,name:c.name,orders:scoped.filter(o=>c.kind==='project'?o.project_id===c.id:o.campaign_id===c.id),to:`/campaigns/${c.kind}/${c.id}`})) : [];
  const activeCampaigns = campaigns.filter(c=>c.status==='active');
  const runningOrders = data.orders.filter(o=>!isDone(o)&&o.status!=='cancelled'&&o.assignment_status!=='rejected');
  return <main className="max-w-7xl mx-auto space-y-7">
    <div><h1 className="text-2xl font-bold text-slate-900">Agency dashboard</h1><p className="text-sm text-slate-600 mt-1">Live progress across clients, campaigns and work orders</p></div>
    <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">{[
      ['Active clients',data.clients.filter(c=>c.is_active).length],['Active campaigns',activeCampaigns.length],['Open work orders',runningOrders.length],['Overdue work orders','—'],['Average completion',`${completion(data.orders)}%`]
    ].map(([label,num])=><Card key={label} className="p-4"><p className="text-xs text-slate-500">{label}</p><p className="text-2xl font-bold mt-2">{num}</p>{label==='Overdue work orders'&&<p className="text-xs text-slate-500">No per-order due dates recorded</p>}</Card>)}</div>
    <section><h2 className="text-lg font-semibold mb-3">Client-wise progress</h2><Card className="overflow-x-auto"><table className="min-w-[700px] w-full text-sm"><thead><tr className="text-left border-b text-slate-600"><th className="p-3">Client</th><th className="p-3">Active campaigns</th><th className="p-3">Done / total</th><th className="p-3">Progress</th><th className="p-3">Status</th><th className="p-3">Next deadline</th></tr></thead><tbody>{clientRows.map(r=><tr key={r.client.id} className="border-b hover:bg-slate-50"><td className="p-3"><Link to={`/clients/${r.client.id}`} className="font-semibold text-blue-700">{r.client.name}</Link></td><td className="p-3">{r.active}</td><td className="p-3">{r.orders.filter(isDone).length} / {r.orders.length}</td><td className="p-3 w-44"><ProgressBar pct={completion(r.orders)}/><span>{completion(r.orders)}%</span></td><td className="p-3">{r.status}</td><td className="p-3">{dateLabel(r.due)}</td></tr>)}</tbody></table>{!clientRows.length&&<p className="p-5">No clients yet. <Link className="text-blue-700" to="/clients">Add a client</Link></p>}</Card></section>
    <section><h2 className="text-lg font-semibold mb-3">Campaign progress</h2><div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-3">{activeCampaigns.map(c=><Link key={`${c.kind}-${c.id}`} to={`/campaigns/${c.kind}/${c.id}`} className="rounded-xl border bg-white p-4 hover:border-blue-400"><strong>{c.name}</strong><div className="mt-3"><ProgressBar pct={completion(relevant(c))}/></div><p className="text-xs mt-2 text-slate-600">{relevant(c).filter(isDone).length}/{relevant(c).length} work orders · {completion(relevant(c))}%</p></Link>)}{!activeCampaigns.length&&<p className="text-sm text-slate-600">No active campaigns.</p>}</div></section>
    <section><h2 className="text-lg font-semibold mb-3">Progression filters</h2><Card><div className="flex flex-wrap gap-3 mb-4"><label className="text-sm">View by <select aria-label="View by" className="block mt-1 border rounded p-2" value={view} onChange={e=>setFilter('view',e.target.value)}><option value="client">Client</option><option value="campaign">Campaign</option><option value="team">Team Member</option></select></label><label className="text-sm">Time range <select aria-label="Time range" className="block mt-1 border rounded p-2" value={period} onChange={e=>setFilter('range',e.target.value)}><option value="week">This week</option><option value="month">This month</option><option value="30days">Last 30 days</option><option value="custom">Custom</option></select></label><label className="text-sm">Metric <select aria-label="Metric" className="block mt-1 border rounded p-2" value={metric} onChange={e=>setFilter('metric',e.target.value)}><option value="completion">Completion %</option><option value="completed">Work orders completed</option><option value="ontime">On-time rate</option></select></label>{period==='custom'&&<><label className="text-sm">From <input aria-label="From date" type="date" className="block mt-1 border rounded p-2" value={params.get('from')||dateKey(start)} onChange={e=>setFilter('from',e.target.value)}/></label><label className="text-sm">To <input aria-label="To date" type="date" className="block mt-1 border rounded p-2" value={params.get('to')||dateKey(now)} onChange={e=>setFilter('to',e.target.value)}/></label></>}</div>{view==='team'||metric==='ontime' ? <p className="text-sm text-slate-600">{view==='team'?'Team-member assignment data is not stored on these work orders.':'On-time completion cannot be computed without work-order due and completion dates.'} No scores have been estimated.</p>:<div className="space-y-4">{list.map(row=><div key={row.id}><div className="flex items-center justify-between text-sm mb-2"><Link to={row.to} className="text-blue-700 font-medium">{row.name}</Link><span>{metric==='completed'?`${row.orders.filter(isDone).length} completed`:`${percent(row.orders.filter(isDone).length,row.orders.length)}%`}</span></div><ProgressBar pct={completion(row.orders)}/></div>)}{!list.length&&<p className="text-sm text-slate-600">Nothing to display for this view.</p>}</div>}</Card></section>
    <div className="grid md:grid-cols-2 gap-4"><section><h2 className="text-lg font-semibold mb-3">Team performance</h2><Card><p className="text-sm text-slate-600">Leaderboard unavailable: purchase orders do not have a reliable assignee or task completion timestamp. Scores and Top Performer are hidden until those records exist.</p></Card></section><section><h2 className="text-lg font-semibold mb-3">Needs attention</h2><Card><p className="text-sm mb-2">{data.orders.filter(o=>o.assignment_status==='pending_acceptance').length} work orders awaiting review</p><p className="text-sm mb-2">{activeCampaigns.filter(c=>relevant(c).length===0).length} active campaigns without work orders</p><p className="text-sm text-slate-600">Per-order overdue and unassigned counts are unavailable without their source fields.</p><Link className="text-blue-700 text-sm inline-block mt-3" to="/purchase-orders">Review work orders →</Link></Card></section></div>
  </main>;
}
