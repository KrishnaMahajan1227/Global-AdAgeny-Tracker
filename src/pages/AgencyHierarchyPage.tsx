import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
import { Card, ProgressBar } from '@/components/ui';
import { dateLabel, orderState, type Order } from '@/lib/agencyProgress';
import { deliveryByOrder, deliveryForOrder, deliveryForOrders, type DeliveryShop, type DeliverySummary } from '@/lib/agencyDelivery';
import { fetchAllPages } from '@/lib/paginatedQuery';
import { useRealtimeInvalidate } from '@/lib/useRealtimeInvalidate';
import { useAgencyFinancials, financeForOrder, financeForOrders } from '@/lib/agencyFinance';
import { formatRupees } from '@/lib/poUtilization';
import type { Project, Campaign, Client } from '@/lib/types';

const breadcrumb = (nodes: { label: string; to?: string }[]) => <nav aria-label="Breadcrumb" className="text-sm text-slate-600 mb-5 flex flex-wrap gap-2"><Link to="/dashboard" className="text-blue-700">Dashboard</Link>{nodes.map((n, i) => <span key={i}>/ {n.to ? <Link to={n.to} className="text-blue-700">{n.label}</Link> : n.label}</span>)}</nav>;
export default function AgencyHierarchyPage({ kind, selectedId }: { kind: 'client' | 'project' | 'campaign'; selectedId?: string }) {
  const { id: routeId } = useParams();
  const id = selectedId || routeId;
  const { profile } = useAuth();
  const orgId = profile?.organization_id;
  const { data: invoicesByOrder, isError: invoiceTotalsError } = useAgencyFinancials(orgId);
  useRealtimeInvalidate(['shops','purchase_orders','work_items','installation_jobs','surveys','production_orders','design_tasks'], orgId, [['agency-hierarchy']]);
  const query = useQuery({ queryKey: ['agency-hierarchy', kind, id, orgId], enabled: !!id && !!orgId, queryFn: async () => {
    if (!orgId) throw new Error('Missing organization');
    const [clients, projects, campaigns, orders, shops] = await Promise.all([
      fetchAllPages<Pick<Client,'id'|'name'|'is_active'>>((a,b) => supabase.from('clients').select('id,name,is_active').eq('organization_id', orgId).order('id').range(a,b)),
      fetchAllPages<Pick<Project,'id'|'name'|'client_id'|'start_date'|'end_date'|'status'|'created_at'>>((a,b) => supabase.from('projects').select('id,name,client_id,start_date,end_date,status,created_at').eq('organization_id', orgId).order('id').range(a,b)),
      fetchAllPages<Pick<Campaign,'id'|'name'|'start_date'|'end_date'|'status'|'created_at'>>((a,b) => supabase.from('campaigns').select('id,name,start_date,end_date,status,created_at').order('id').range(a,b)),
      fetchAllPages<Order>((a,b) => supabase.from('purchase_orders').select('id,client_id,project_id,campaign_id,name,po_number,status,assignment_status,fulfillment_type,delivery_receipt_required,total_amount,created_at,po_line_items(requires_survey,requires_design,requires_production,requires_installation)').eq('organization_id', orgId).order('id').range(a,b)),
      fetchAllPages<DeliveryShop>((a,b) => supabase.from('shops').select('id,client_id,purchase_order_id,status').eq('organization_id',orgId).order('id').range(a,b)),
    ]);
    return { clients, projects, campaigns, orders, shops };
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
  const orderMap = deliveryByOrder(data.orders, data.shops);
  const aggregate = deliveryForOrders(targetOrders, orderMap);
  const financial = financeForOrders(targetOrders, invoicesByOrder);
  const parentClient = kind === 'project' ? data.clients.find(c => c.id === project?.client_id) : undefined;
  const due = kind === 'project' ? project?.end_date : kind === 'campaign' ? campaign?.end_date : null;
  const start = kind === 'project' ? project?.start_date : kind === 'campaign' ? campaign?.start_date : null;
  const days = due ? Math.ceil((new Date(`${due}T23:59:59`).getTime() - Date.now()) / 86400000) : null;
  return <div className="max-w-6xl mx-auto space-y-5">
    {breadcrumb(kind === 'client' ? [{label:record.name}] : kind === 'project' ? [{label:parentClient?.name || 'Clients',to:parentClient ? `/clients/${parentClient.id}` : '/clients'},{label:record.name}] : [{label:record.name}])}
    <div><h1 className="text-2xl font-bold text-slate-900">{record.name}</h1><p className="text-slate-500">{kind === 'client' ? 'Work order delivery and progress' : 'Campaign work order progress'}</p></div>
    <Card><div className="flex justify-between items-center mb-3"><strong>Operational delivery</strong><strong>{aggregate.percentage}%</strong></div><ProgressBar pct={aggregate.percentage} /><p className="text-sm text-slate-600 mt-3">{aggregate.deliveredSites} of {aggregate.sites} sites delivered · {aggregate.done} of {aggregate.total} Work Orders fully delivered</p>
    {kind !== 'client' && <p className="text-sm mt-2 text-slate-600">{dateLabel(start)} → {dateLabel(due)} · {days == null ? 'No deadline set' : days >= 0 ? `${days} days left` : `${Math.abs(days)} days past deadline`}</p>}</Card>
    <section className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5" aria-label="Invoicing progress"><div className="flex items-center justify-between gap-3"><div><h2 className="text-sm font-semibold text-slate-900">Financial progress</h2><p className="mt-1 text-xs text-slate-500">Invoice items (ex-GST); not payment collection</p></div><Link to="/billing" className="text-xs font-semibold text-blue-700 hover:underline">Billing →</Link></div>
      {invoiceTotalsError || !invoicesByOrder ? <p className="mt-3 text-xs text-slate-500">{invoiceTotalsError ? 'Financial totals unavailable' : 'Loading financial totals…'}</p> : <><div className="mt-3 grid grid-cols-2 gap-3 text-xs sm:grid-cols-3"><div><p className="text-slate-500">Planned</p><b>{formatRupees(financial.planned)}</b></div><div><p className="text-slate-500">Invoiced</p><b className="text-emerald-700">{formatRupees(financial.invoiced)}</b></div><div><p className="text-slate-500">Uninvoiced</p><b>{formatRupees(financial.remaining)}</b></div></div>{financial.percentage != null && <div className="mt-3"><ProgressBar pct={financial.percentage}/><p className="mt-1 text-xs text-slate-500">{financial.percentage}% of planned PO value billed</p></div>}</>}
    </section>
    {kind === 'client' && <section className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
      <div><h2 className="text-sm font-semibold text-slate-900">Work orders</h2><p className="mt-1 text-sm text-slate-600">{aggregate.total} orders · {aggregate.done} fully delivered. Manage all orders, statuses and field progress in the existing Work Orders screen.</p></div>
      <Link className="inline-flex shrink-0 items-center justify-center rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600" to={`/purchase-orders?client=${encodeURIComponent(id || '')}`}>View client work orders →</Link>
    </section>}
    {kind !== 'client' && <section><h2 className="text-lg font-semibold mb-3">Work orders</h2><p className="text-sm text-slate-600 mb-3">Pending: {targetOrders.filter(o => !deliveryForOrder(o,orderMap).delivered && orderState(o) === 'Pending').length} · In Progress: {targetOrders.filter(o => !deliveryForOrder(o,orderMap).delivered && (orderState(o) === 'In Progress' || deliveryForOrder(o,orderMap).percentage > 0)).length} · Review: {targetOrders.filter(o => orderState(o) === 'Review').length} · Done: {aggregate.done}</p><OrderList orders={targetOrders} delivery={orderMap} invoicesByOrder={invoicesByOrder} emptyLink={`/purchase-orders?${kind === 'project' ? 'project' : 'campaign'}=${id}`}/></section>}
  </div>;
}

// The same compact order list serves campaign expansions and bookmarked campaign details.
function OrderList({orders,emptyLink,delivery,invoicesByOrder}:{orders:Order[];emptyLink:string;delivery:Map<string,DeliverySummary>;invoicesByOrder?:Map<string,number>}) {
  if(!orders.length)return <p className="text-sm text-slate-600">No work orders yet. <Link className="font-semibold text-blue-700 underline" to={emptyLink}>Add work order</Link></p>;
  return <div className="overflow-x-auto"><table className="w-full min-w-[420px] text-sm text-left"><thead className="bg-slate-50 text-slate-600"><tr><th scope="col" className="p-3">Work order</th><th scope="col" className="p-3">Status</th><th scope="col" className="p-3">Progress</th><th scope="col" className="p-3">Invoiced</th></tr></thead><tbody>{orders.map(o=><tr key={o.id} className="border-t"><td className="p-3"><Link className="text-blue-700 font-semibold underline" to={`/purchase-orders?order=${o.id}`}>{o.name||o.po_number}</Link></td><td className="p-3">{deliveryForOrder(o,delivery).delivered ? 'Delivered' : orderState(o)}</td><td className="p-3 min-w-28"><ProgressBar pct={deliveryForOrder(o,delivery).percentage}/><span className="text-xs">{deliveryForOrder(o,delivery).percentage}%</span></td><td className="p-3 text-xs tabular-nums">{invoicesByOrder ? `${formatRupees(financeForOrder(o,invoicesByOrder).invoiced)} · ${financeForOrder(o,invoicesByOrder).percentage ?? '—'}%` : '—'}</td></tr>)}</tbody></table></div>;
}
