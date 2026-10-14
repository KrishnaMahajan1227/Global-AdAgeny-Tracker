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
  const relatedProjects = kind === 'client' ? data.projects.filter(p => p.client_id === id) : [];
  const parentClient = kind === 'project' ? data.clients.find(c => c.id === project?.client_id) : undefined;
  const relatedCampaigns = kind === 'client' ? data.campaigns.filter(c => data.orders.some(o => o.client_id === id && o.campaign_id === c.id)) : [];
  const due = kind === 'project' ? project?.end_date : kind === 'campaign' ? campaign?.end_date : null;
  const start = kind === 'project' ? project?.start_date : kind === 'campaign' ? campaign?.start_date : null;
  const days = due ? Math.ceil((new Date(`${due}T23:59:59`).getTime() - Date.now()) / 86400000) : null;
  return <div className="max-w-6xl mx-auto space-y-5">
    {breadcrumb(kind === 'client' ? [{label:record.name}] : kind === 'project' ? [{label:parentClient?.name || 'Clients',to:parentClient ? `/clients/${parentClient.id}` : '/clients'},{label:record.name}] : [{label:record.name}])}
    <div><h1 className="text-2xl font-bold text-slate-900">{record.name}</h1><p className="text-slate-500">{kind === 'client' ? 'Client campaigns and work orders' : 'Campaign work order progress'}</p></div>
    <Card><div className="flex justify-between items-center mb-3"><strong>Overall completion</strong><strong>{completion(targetOrders)}%</strong></div><ProgressBar pct={completion(targetOrders)} /><p className="text-sm text-slate-600 mt-3">{targetOrders.filter(isDone).length} of {targetOrders.length} work orders completed</p>
    {kind !== 'client' && <p className="text-sm mt-2 text-slate-600">{dateLabel(start)} → {dateLabel(due)} · {days == null ? 'No deadline set' : days >= 0 ? `${days} days left` : `${Math.abs(days)} days past deadline`}</p>}</Card>
    {kind === 'client' && <section><h2 className="text-lg font-semibold mb-3">Campaigns</h2><div className="grid gap-3 sm:grid-cols-2">{relatedProjects.map(p => <Link key={p.id} to={`/campaigns?detail=project:${p.id}`} className="rounded-xl border bg-white p-4 hover:border-blue-400"><strong>{p.name}</strong><p className="text-sm text-slate-600">{completion(targetOrders.filter(o => o.project_id === p.id))}% complete</p></Link>)}{relatedCampaigns.map(c => <Link key={c.id} to={`/campaigns?detail=campaign:${c.id}`} className="rounded-xl border bg-white p-4 hover:border-blue-400"><strong>{c.name}</strong><p className="text-sm text-slate-600">{completion(targetOrders.filter(o => o.campaign_id === c.id))}% complete</p></Link>)}{relatedProjects.length + relatedCampaigns.length === 0 && <p>No campaigns yet.</p>}</div></section>}
    <section><h2 className="text-lg font-semibold mb-3">Work orders</h2><p className="text-sm text-slate-600 mb-3">Pending: {targetOrders.filter(o => orderState(o) === 'Pending').length} · In Progress: {targetOrders.filter(o => orderState(o) === 'In Progress').length} · Review: {targetOrders.filter(o => orderState(o) === 'Review').length} · Done: {targetOrders.filter(isDone).length}</p>
    <Card className="overflow-x-auto">{targetOrders.length ? <table className="w-full text-sm text-left"><thead><tr className="border-b text-slate-600"><th className="p-3">Title</th><th className="p-3">Status</th><th className="p-3">Progress</th></tr></thead><tbody>{targetOrders.map(o => <tr key={o.id} className="border-b"><td className="p-3 font-medium"><Link className="text-blue-700 underline" to={`/purchase-orders?order=${o.id}`}>{o.name || o.po_number}</Link></td><td className="p-3">{orderState(o)}</td><td className="p-3"><ProgressBar pct={isDone(o) ? 100 : 0}/><span>{isDone(o) ? 100 : 0}%</span></td></tr>)}</tbody></table> : <p className="p-5 text-slate-600">No work orders yet. <Link className="text-blue-700 underline" to={`/purchase-orders?${kind === 'project' ? 'project' : kind === 'campaign' ? 'campaign' : 'client'}=${id}`}>Add work order</Link></p>}</Card></section>
  </div>;
}
