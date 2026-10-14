import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
import { Card, ProgressBar } from '@/components/ui';
import { completion, dateLabel, isDone, isOverdue, type Order } from '@/lib/agencyProgress';
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
  const view=['client','campaign','member'].includes(params.get('view')||'')?params.get('view')!:'client';
  const metric=['completion','completed','ontime'].includes(params.get('metric')||'')?params.get('metric')!:'completion';
  const start=startOfPeriod(range,params.get('from'));
  const end=range==='custom'&&params.get('to')&&!Number.isNaN(Date.parse(params.get('to')!))?new Date(`${params.get('to')}T23:59:59`):new Date();
  const validRange=range!=='custom'||!!(params.get('from')&&params.get('to')&&start<=end);
  if(isLoading)return <p role="status" className="p-8 text-slate-600">Loading dashboard…</p>;
  if(isError)return <Card className="p-6"><p role="alert" className="text-red-700">Could not load dashboard. <button className="underline" onClick={()=>refetch()}>Retry</button></p></Card>;
  if(!data)return null;
  const orders=data.orders.filter(o=>o.status!=='cancelled'&&o.assignment_status!=='rejected');
  const scoped=orders.filter(o=>{const d=new Date(o.created_at);return d>=start&&d<=end;});
  const activeProjects=data.projects.filter(p=>p.status==='active');
  const clientCampaigns=data.campaigns.filter(c=>c.status==='active'&&orders.some(o=>o.campaign_id===c.id));
  const group=(rows:Order[])=>({all:rows,done:rows.filter(isDone).length,pct:completion(rows)});
  const rows=view==='client'?data.clients.filter(c=>c.is_active).map(c=>{
    const own=scoped.filter(o=>o.client_id===c.id);
    const campaigns=[...activeProjects.filter(p=>p.client_id===c.id),...clientCampaigns.filter(p=>orders.some(o=>o.client_id===c.id&&o.campaign_id===p.id))];
    const due=campaigns.map(p=>p.end_date).filter((d):d is string=>!!d).sort()[0]||null;
    return {id:c.id,label:c.name,to:`/clients?detail=${encodeURIComponent(c.id)}`,due,...group(own)};
  }):view==='campaign'?[...activeProjects.map(p=>({id:`project:${p.id}`,label:p.name,client:p.client_id,due:p.end_date,...group(scoped.filter(o=>o.project_id===p.id))})),...clientCampaigns.map(c=>({id:`campaign:${c.id}`,label:c.name,client:orders.find(o=>o.campaign_id===c.id)?.client_id||null,due:c.end_date,...group(scoped.filter(o=>o.campaign_id===c.id))}))].map(c=>({...c,to:c.client?`/clients?detail=${encodeURIComponent(c.client)}&campaign=${encodeURIComponent(c.id)}`:'/clients'})):[];
  const overdueCampaigns=[...activeProjects,...clientCampaigns].filter(c=>{const linked=orders.filter(o=>'client_id' in c?o.project_id===c.id:o.campaign_id===c.id);return isOverdue(c.end_date,linked.length>0&&linked.every(isDone));});
  const ungrouped=orders.filter(o=>!o.project_id&&!o.campaign_id);
  const scoreLabel=(r:{all:Order[];pct:number;due:string|null})=>isOverdue(r.due,r.all.length>0&&r.all.every(isDone))?'Delayed':r.pct<50&&r.all.length>0?'At Risk':'On Track';
  const displayRows=rows.slice().sort((a,b)=>a.pct-b.pct||a.label.localeCompare(b.label));
  const [pageRaw]=[Number(params.get('page')||0)];const page=Number.isFinite(pageRaw)?Math.max(0,Math.min(Math.floor(pageRaw),Math.max(0,Math.ceil(displayRows.length/20)-1))):0;
  return <main className="mx-auto max-w-[1480px] space-y-4 pb-10">
    <section aria-label="Dashboard filters" className="rounded-xl border border-slate-200 bg-white px-4 py-3 flex flex-wrap items-end gap-3">
      <label className="text-xs font-semibold text-slate-600">View by<select aria-label="View by" value={view} onChange={e=>{setFilter('view',e.target.value);setFilter('page','0');}} className="block mt-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"><option value="client">Client</option><option value="campaign">Campaign</option><option value="member">Team Member</option></select></label>
      <label className="text-xs font-semibold text-slate-600">Time range<select aria-label="Time range" value={range} onChange={e=>setFilter('range',e.target.value)} className="block mt-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"><option value="week">This week</option><option value="month">This month</option><option value="30days">Last 30 days</option><option value="custom">Custom</option></select></label>
      <label className="text-xs font-semibold text-slate-600">Metric<select aria-label="Metric" value={metric} onChange={e=>setFilter('metric',e.target.value)} className="block mt-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"><option value="completion">Completion %</option><option value="completed">Work orders completed</option><option value="ontime">On-time rate</option></select></label>
      {range==='custom'&&<><label className="text-xs text-slate-600">From<input aria-label="Start date" type="date" value={params.get('from')||''} onChange={e=>setFilter('from',e.target.value)} className="block mt-1 rounded-lg border p-2 text-sm"/></label><label className="text-xs text-slate-600">To<input aria-label="End date" type="date" value={params.get('to')||''} onChange={e=>setFilter('to',e.target.value)} className="block mt-1 rounded-lg border p-2 text-sm"/></label></>}
      <span className="ml-auto text-xs text-slate-500">Created in selected period; current completion state</span>
    </section>
    <section aria-label="Agency KPIs" className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3">{[
      ['Active Clients',data.clients.filter(c=>c.is_active).length,'/clients'],
      ['Active Campaigns',activeProjects.length+clientCampaigns.length,'/clients'],
      ['Open Work Orders',orders.filter(o=>!isDone(o)).length,'/purchase-orders'],
      ['Overdue Work Orders','—','/purchase-orders'],
      ['Avg Completion',`${completion(orders)}%`,'/purchase-orders'],
    ].map(([label,value,to])=><Link key={String(label)} to={String(to)} className="rounded-xl border border-slate-200 bg-white px-4 py-4 hover:border-blue-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-600"><p className="text-xs font-semibold text-slate-500">{label}</p><p className="mt-2 text-2xl font-bold tabular-nums text-slate-900">{typeof value==='number'?fmt(value):value}</p>{label==='Overdue Work Orders'&&<p className="mt-1 text-xs text-slate-500">Due dates unavailable</p>}</Link>)}</section>
    <section className="rounded-xl border border-slate-200 bg-white overflow-hidden"><div className="flex items-center justify-between gap-3 px-4 py-3 border-b"><h2 className="text-base font-semibold text-slate-900">{view==='client'?'Client progress':view==='campaign'?'Campaign progress':'Team progress'}</h2><span className="text-xs text-slate-500">{rows.length} records</span></div>
      {!validRange?<p role="alert" className="p-5 text-red-700">Enter a valid date range.</p>:view==='member'?<p className="p-5 text-sm text-slate-600">Team-member assignments are not recorded on work orders. Member-level progress is unavailable.</p>:metric==='ontime'?<p className="p-5 text-sm text-slate-600">On-time completion cannot be calculated without work-order due dates and completion timestamps.</p>:!rows.length?<p className="p-5 text-sm text-slate-600">No records available for this view.</p>:<><div className="overflow-x-auto"><table className="w-full min-w-[660px] text-sm"><thead className="bg-slate-50 text-left text-slate-600"><tr><th className="p-3">{view==='client'?'Client':'Campaign'}</th><th className="p-3">Progress</th><th className="p-3">Done / Total</th><th className="p-3">On time</th><th className="p-3">Status</th><th className="p-3">Next deadline</th></tr></thead><tbody className="divide-y divide-slate-100">{displayRows.slice(page*20,(page+1)*20).map(r=><tr key={r.id} className="hover:bg-slate-50"><td className="p-3"><Link to={r.to} className="font-semibold text-blue-700 hover:underline">{r.label}</Link></td><td className="p-3 w-40"><ProgressBar pct={r.pct}/><span className="text-xs">{metric==='completed'?`${r.done} completed`:`${r.pct}%`}</span></td><td className="p-3 tabular-nums">{r.done} / {r.all.length}</td><td className="p-3 text-slate-500">—</td><td className="p-3"><span className={`text-xs font-semibold ${scoreLabel(r)==='Delayed'?'text-red-700':scoreLabel(r)==='At Risk'?'text-amber-700':'text-emerald-700'}`}>{scoreLabel(r)}</span></td><td className="p-3 whitespace-nowrap">{dateLabel(r.due)}</td></tr>)}</tbody></table></div><div className="flex justify-between items-center p-3 border-t text-sm text-slate-600"><span>{page*20+1}–{Math.min((page+1)*20,rows.length)} of {rows.length}</span><div className="flex gap-2"><button disabled={page===0} onClick={()=>setFilter('page',String(page-1))} className="border rounded px-3 py-1 disabled:opacity-40">Previous</button><button disabled={(page+1)*20>=rows.length} onClick={()=>setFilter('page',String(page+1))} className="border rounded px-3 py-1 disabled:opacity-40">Next</button></div></div></>}
    </section>
    <section className="rounded-xl border border-slate-200 bg-white p-4"><h2 className="text-base font-semibold">Team leaderboard</h2><p className="mt-2 text-sm text-slate-600">Not available: work orders have no team-member assignment or completion timestamps. No scores or rankings are fabricated.</p>{/* Score formula once data exists: (on-time completed / due completed) * 70 + min(completed / 20, 1) * 30. Do not rank without source dates. */}</section>
    <section className="rounded-xl border border-slate-200 bg-white overflow-hidden"><h2 className="p-4 border-b text-base font-semibold">Needs Attention</h2><div className="divide-y divide-slate-100 text-sm">{overdueCampaigns.slice(0,10).map(c=><Link key={c.id} to="/clients" className="flex justify-between gap-3 p-3 hover:bg-slate-50"><span className="font-medium">Campaign deadline passed: {c.name}</span><span className="text-red-700">{dateLabel(c.end_date)} →</span></Link>)}{ungrouped.slice(0,10).map(o=><Link key={o.id} to={`/purchase-orders?order=${o.id}`} className="flex justify-between p-3 hover:bg-slate-50"><span>Work order without campaign: {o.name||o.po_number}</span><span className="text-blue-700">Open →</span></Link>)}{!overdueCampaigns.length&&!ungrouped.length&&<p className="p-4 text-slate-600">No campaign deadline alerts or ungrouped work orders.</p>}<p className="p-3 text-xs text-slate-500">Order-level overdue, inactivity and unassigned-member alerts require fields not present in the current data model.</p></div></section>
  </main>;
}
