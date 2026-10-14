import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
import { ProgressBar } from '@/components/ui';
import { completion, isDone, type Order } from '@/lib/agencyProgress';
import type { Client } from '@/lib/types';

const fmt = (value: number) => value.toLocaleString('en-IN');
const isOpen = (order: Order) => !isDone(order) && order.status !== 'cancelled' && order.assignment_status !== 'rejected';

export default function DashboardPage() {
  const { profile } = useAuth();
  const orgId = profile?.organization_id;
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<'attention' | 'name' | 'completion'>('attention');
  const [page, setPage] = useState(0);
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['agency-dashboard-delivery', orgId], enabled: !!orgId,
    queryFn: async () => {
      if (!orgId) throw new Error('Missing organization');
      async function fetchAll(table: 'clients' | 'purchase_orders', columns: string) {
        const output: Record<string, unknown>[] = [];
        for (let offset = 0; ; offset += 500) {
          const { data: batch, error } = await supabase.from(table).select(columns).eq('organization_id', orgId!).order('id').range(offset, offset + 499);
          if (error) throw error;
          output.push(...(batch || []) as Record<string, unknown>[]);
          if (!batch || batch.length < 500) break;
        }
        return output;
      }
      const [clients, orders] = await Promise.all([
        fetchAll('clients', 'id,name,is_active'),
        fetchAll('purchase_orders', 'id,client_id,project_id,campaign_id,name,po_number,status,assignment_status,created_at'),
      ]);
      return { clients: clients as unknown as Pick<Client, 'id' | 'name' | 'is_active'>[], orders: orders as unknown as Order[] };
    },
  });
  const summary = useMemo(() => {
    if (!data) return null;
    const orders = data.orders.filter(o => o.status !== 'cancelled' && o.assignment_status !== 'rejected');
    const activeClients = data.clients.filter(c => c.is_active);
    const rows = activeClients.map(client => {
      const own = orders.filter(o => o.client_id === client.id);
      const done = own.filter(isDone).length;
      const pending = own.filter(o => o.assignment_status === 'pending_acceptance').length;
      const open = own.filter(isOpen).length;
      return { ...client, done, pending, open, total: own.length, pct: completion(own) };
    });
    const awaiting = orders.filter(o => o.assignment_status === 'pending_acceptance');
    const needsAction = rows.filter(r => r.pending > 0 || (r.total > 0 && r.pct < 25));
    return { orders, rows, awaiting, needsAction, activeClients, open: orders.filter(isOpen).length, done: orders.filter(isDone).length };
  }, [data]);
  if (isLoading) return <p role="status" className="p-5 text-sm text-slate-600">Loading agency dashboard…</p>;
  if (isError || !summary) return <div role="alert" className="rounded-lg bg-white border p-5 text-sm text-red-700">Dashboard could not be loaded. <button onClick={() => refetch()} className="underline">Retry</button></div>;
  const kpis = [
    { label: 'Active clients', value: summary.activeClients.length, href: '/clients', sub: 'Currently active' },
    { label: 'Open work orders', value: summary.open, href: '/purchase-orders', sub: 'Awaiting completion' },
    { label: 'Completed orders', value: summary.done, href: '/purchase-orders', sub: 'All-time' },
    { label: 'Pending acceptance', value: summary.awaiting.length, href: '/purchase-orders', sub: 'Review required' },
    { label: 'Delivery completion', value: `${completion(summary.orders)}%`, href: '/purchase-orders', sub: `${fmt(summary.done)} of ${fmt(summary.orders.length)} orders` },
  ];
  const filtered = summary.rows.filter(r => r.name.toLowerCase().includes(search.trim().toLowerCase())).sort((a,b) => sort === 'name' ? a.name.localeCompare(b.name) : sort === 'completion' ? b.pct-a.pct : b.pending-a.pending || a.pct-b.pct);
  const lastPage = Math.max(0, Math.ceil(filtered.length / 12) - 1);
  const safePage = Math.min(page, lastPage);
  return <main className="mx-auto max-w-[1500px] space-y-4 pb-8 text-slate-800">
    <section aria-label="Agency delivery indicators" className="grid grid-cols-2 gap-3 lg:grid-cols-5">
      {kpis.map(k => <Link key={k.label} to={k.href} className="rounded-lg border border-slate-200 bg-white px-4 py-3 transition-colors hover:border-blue-300 focus-visible:outline-2 focus-visible:outline-blue-600"><div className="text-xs font-medium text-slate-500">{k.label}</div><div className="mt-1 text-[23px] font-semibold tabular-nums tracking-tight text-slate-900">{typeof k.value === 'number' ? fmt(k.value) : k.value}</div><div className="mt-1 text-[11px] text-slate-500">{k.sub}</div></Link>)}
    </section>
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px] items-start">
      <section className="min-w-0 rounded-lg border border-slate-200 bg-white">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-4 py-3"><div><h2 className="text-sm font-semibold text-slate-900">Client delivery</h2><p className="text-xs text-slate-500">Progress across current work orders · {summary.rows.length} active clients</p></div><div className="flex flex-wrap gap-2"><label className="sr-only" htmlFor="dashboard-client-search">Search clients</label><input id="dashboard-client-search" value={search} onChange={e=>{setSearch(e.target.value);setPage(0);}} placeholder="Find client" className="w-36 sm:w-44 rounded-md border border-slate-200 px-2.5 py-1.5 text-xs focus-visible:outline-blue-600"/><label className="sr-only" htmlFor="dashboard-sort">Sort clients</label><select id="dashboard-sort" value={sort} onChange={e=>{setSort(e.target.value as typeof sort);setPage(0);}} className="rounded-md border border-slate-200 bg-white px-2 py-1.5 text-xs"><option value="attention">Needs attention</option><option value="name">Client name</option><option value="completion">Highest completion</option></select></div></div>
        <div className="overflow-x-auto"><table className="w-full min-w-[580px] text-xs"><thead className="bg-slate-50 text-left text-slate-500"><tr><th className="px-4 py-2.5 font-medium">Client</th><th className="px-3 py-2.5 font-medium">Delivery progress</th><th className="px-3 py-2.5 font-medium">Work orders</th><th className="px-3 py-2.5 font-medium">Pending review</th><th className="px-3 py-2.5 font-medium"><span className="sr-only">Open</span></th></tr></thead><tbody className="divide-y divide-slate-100">{filtered.slice(safePage*12,(safePage+1)*12).map(r=><tr key={r.id} className="hover:bg-slate-50"><td className="px-4 py-3 font-medium text-slate-800"><Link to={`/clients?detail=${encodeURIComponent(r.id)}`} className="hover:text-blue-700 hover:underline">{r.name}</Link></td><td className="px-3 py-3"><div className="flex items-center gap-2"><div className="w-24 sm:w-36"><ProgressBar pct={r.pct}/></div><span className="tabular-nums text-slate-600">{r.pct}%</span></div></td><td className="px-3 py-3 tabular-nums">{r.done}/{r.total} done</td><td className="px-3 py-3"><span className={r.pending ? 'font-medium text-amber-700' : 'text-slate-400'}>{r.pending || '—'}</span></td><td className="px-3 py-3 text-right"><Link to={`/clients?detail=${encodeURIComponent(r.id)}`} className="text-blue-700 hover:underline">Open →</Link></td></tr>)}</tbody></table>{!filtered.length&&<p className="p-6 text-center text-sm text-slate-500">{search ? 'No clients match your search.' : 'No active clients yet.'}</p>}</div>
        {filtered.length > 12 && <div className="flex items-center justify-between border-t px-4 py-2.5 text-xs text-slate-600"><span>{safePage*12+1}–{Math.min((safePage+1)*12,filtered.length)} of {filtered.length}</span><div className="flex gap-2"><button className="rounded border px-2 py-1 disabled:opacity-40" disabled={safePage===0} onClick={()=>setPage(safePage-1)}>Previous</button><button className="rounded border px-2 py-1" onClick={()=>setPage(safePage+1)} style={{visibility:safePage===lastPage?'hidden':'visible'}}>Next</button></div></div>}
      </section>
      <aside className="space-y-4">
        <section className="rounded-lg border border-slate-200 bg-white"><div className="border-b border-slate-100 px-4 py-3"><h2 className="text-sm font-semibold text-slate-900">Action required</h2><p className="text-xs text-slate-500">Items waiting on your team</p></div><div className="divide-y divide-slate-100">{summary.awaiting.slice(0,6).map(o=><Link key={o.id} to={`/purchase-orders?order=${encodeURIComponent(o.id)}`} className="block px-4 py-3 hover:bg-slate-50"><p className="truncate text-xs font-medium text-slate-800">{o.name?.trim() || o.po_number || 'Untitled work order'}</p><p className="mt-1 text-[11px] text-amber-700">Pending acceptance · Open order →</p></Link>)}{!summary.awaiting.length&&<p className="px-4 py-5 text-xs text-slate-500">No work orders pending acceptance.</p>}</div>{summary.awaiting.length>6&&<Link to="/purchase-orders" className="block border-t px-4 py-2.5 text-xs font-medium text-blue-700">View all work orders →</Link>}</section>
        <section className="rounded-lg border border-slate-200 bg-white"><div className="border-b border-slate-100 px-4 py-3"><h2 className="text-sm font-semibold text-slate-900">Clients to monitor</h2><p className="text-xs text-slate-500">Pending review or low completion</p></div><div className="divide-y divide-slate-100">{summary.needsAction.slice(0,6).map(r=><Link key={r.id} to={`/clients?detail=${encodeURIComponent(r.id)}`} className="flex justify-between gap-2 px-4 py-3 text-xs hover:bg-slate-50"><span className="truncate font-medium">{r.name}</span><span className="shrink-0 tabular-nums text-amber-700">{r.pending ? `${r.pending} review` : `${r.pct}% done`} →</span></Link>)}{!summary.needsAction.length&&<p className="px-4 py-5 text-xs text-slate-500">No clients currently flagged by these checks.</p>}</div></section>
      </aside>
    </div>
    <p className="text-[11px] text-slate-500">Progress uses recorded work-order completion states. Order-level overdue and on-time rates are not shown because this database has no reliable work-order due/completion timestamps.</p>
  </main>;
}
