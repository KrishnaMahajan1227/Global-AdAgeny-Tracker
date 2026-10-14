import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
import { Card, ProgressBar } from '@/components/ui';
import { completion, dateLabel, isDone, orderState, type Order } from '@/lib/agencyProgress';
import type { Project, Campaign, Client } from '@/lib/types';

const breadcrumb = (nodes: { label: string; to?: string }[]) => <nav aria-label="Breadcrumb" className="text-sm text-slate-600 mb-5 flex flex-wrap gap-2"><Link to="/dashboard" className="text-blue-700">Dashboard</Link>{nodes.map((n, i) => <span key={i}>/ {n.to ? <Link to={n.to} className="text-blue-700">{n.label}</Link> : n.label}</span>)}</nav>;
export default function AgencyHierarchyPage({ kind, selectedId }: { kind: 'client' | 'project' | 'campaign'; selectedId?: string }) {
  const { id: routeId } = useParams();
  const id = selectedId || routeId;
  const { profile } = useAuth();
  const orgId = profile?.organization_id;
  const query = useQuery({ queryKey: ['agency-hierarchy', kind, id, orgId], enabled: !!id && !!orgId, queryFn: async () => {
    if (!orgId) throw new Error('Missing organization');
    const [clients, projects, campaigns, orders] = await Promise.all([
      supabase.from('clients').select('id,name,is_active').eq('organization_id', orgId),
      supabase.from('projects').select('id,name,client_id,start_date,end_date,status,created_at').eq('organization_id', orgId),
      supabase.from('campaigns').select('id,name,start_date,end_date,status,created_at'),
      supabase.from('purchase_orders').select('id,client_id,project_id,campaign_id,name,po_number,status,assignment_status,created_at').eq('organization_id', orgId),
    ]);
    for (const r of [clients,projects,campaigns,orders]) if (r.error) throw r.error;
    return { clients: (clients.data || []) as Pick<Client,'id'|'name'|'is_active'>[], projects: (projects.data || []) as Pick<Project,'id'|'name'|'client_id'|'start_date'|'end_date'|'status'|'created_at'>[], campaigns: (campaigns.data || []) as Pick<Campaign,'id'|'name'|'start_date'|'end_date'|'status'|'created_at'>[], orders: (orders.data || []) as Order[] };
  }});
  if (query.isLoading) return <p role="status">Loading progress…</p>;
  if (query.isError) return <p role="alert" className="text-red-700">Couldn't load this page. <button onClick={() => query.refetch()} className="underline">Retry</button></p>;
  const data = query.data;
  if (!data) return null;
  const client = data.clients.find(c => c.id === id);
  const project = data.projects.find(p => p.id === id);
  const campaign = data.campaigns.find(c => c.id === id);
  const record = kind === 'client' ? client : kind === 'project' ? project : campaign;
  if (!record) return <p role="alert">Not found or you don't have access to this record.</p>;
  const targetOrders = data.orders.filter(o => kind === 'client' ? o.client_id === id : kind === 'project' ? o.project_id === id : o.campaign_id === id);
  const parentClient = kind === 'project' ? data.clients.find(c => c.id === project?.client_id) : undefined;
  const due = kind === 'project' ? project?.end_date : kind === 'campaign' ? campaign?.end_date : null;
  const start = kind === 'project' ? project?.start_date : kind === 'campaign' ? campaign?.start_date : null;
  const days = due ? Math.ceil((new Date(`${due}T23:59:59`).getTime() - Date.now()) / 86400000) : null;
  return <div className="max-w-6xl mx-auto space-y-5">
    {breadcrumb(kind === 'client' ? [{label:record.name}] : kind === 'project' ? [{label:parentClient?.name || 'Clients',to:parentClient ? `/clients/${parentClient.id}` : '/clients'},{label:record.name}] : [{label:record.name}])}
    <div><h1 className="text-2xl font-bold text-slate-900">{record.name}</h1><p className="text-slate-500">{kind === 'client' ? 'Work order delivery and progress' : 'Campaign work order progress'}</p></div>
    <Card><div className="flex justify-between items-center mb-3"><strong>Overall completion</strong><strong>{completion(targetOrders)}%</strong></div><ProgressBar pct={completion(targetOrders)} /><p className="text-sm text-slate-600 mt-3">{targetOrders.filter(isDone).length} of {targetOrders.length} work orders completed</p>
    {kind !== 'client' && <p className="text-sm mt-2 text-slate-600">{dateLabel(start)} → {dateLabel(due)} · {days == null ? 'No deadline set' : days >= 0 ? `${days} days left` : `${Math.abs(days)} days past deadline`}</p>}</Card>
    {kind === 'client' && <section className="rounded-xl border border-slate-200 bg-white overflow-hidden"><div className="px-4 py-3 border-b border-slate-100 flex justify-between items-center"><h2 className="text-sm font-semibold text-slate-900">Work orders</h2><span className="text-xs text-slate-500">{targetOrders.length} total · {targetOrders.filter(isDone).length} completed</span></div><OrderList orders={targetOrders} emptyLink="/purchase-orders"/></section>}
    {kind !== 'client' && <section><h2 className="text-lg font-semibold mb-3">Work orders</h2><p className="text-sm text-slate-600 mb-3">Pending: {targetOrders.filter(o => orderState(o) === 'Pending').length} · In Progress: {targetOrders.filter(o => orderState(o) === 'In Progress').length} · Review: {targetOrders.filter(o => orderState(o) === 'Review').length} · Done: {targetOrders.filter(isDone).length}</p><OrderList orders={targetOrders} emptyLink={`/purchase-orders?${kind === 'project' ? 'project' : 'campaign'}=${id}`}/></section>}
  </div>;
}

// The same compact order list serves campaign expansions and bookmarked campaign details.
function OrderList({orders,emptyLink}:{orders:Order[];emptyLink:string}) {
  if(!orders.length)return <p className="text-sm text-slate-600">No work orders yet. <Link className="font-semibold text-blue-700 underline" to={emptyLink}>Add work order</Link></p>;
  return <div className="overflow-x-auto"><table className="w-full min-w-[420px] text-sm text-left"><thead className="bg-slate-50 text-slate-600"><tr><th scope="col" className="p-3">Work order</th><th scope="col" className="p-3">Status</th><th scope="col" className="p-3">Progress</th></tr></thead><tbody>{orders.map(o=><tr key={o.id} className="border-t"><td className="p-3"><Link className="text-blue-700 font-semibold underline" to={`/purchase-orders?order=${o.id}`}>{o.name||o.po_number}</Link></td><td className="p-3">{orderState(o)}</td><td className="p-3 min-w-28"><ProgressBar pct={isDone(o)?100:0}/><span className="text-xs">{isDone(o)?100:0}%</span></td></tr>)}</tbody></table></div>;
}
