import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AlertCircle, ArrowRight, ClipboardList, Factory, MapPin, PackageCheck, Palette, Search, Users } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
import { ProgressBar } from '@/components/ui';
import { completion, isDone, type Order } from '@/lib/agencyProgress';
import type { Client } from '@/lib/types';

type ShopRow = { id: string; client_id: string; purchase_order_id: string | null; status: string };
type ClientRow = Pick<Client, 'id' | 'name' | 'is_active'>;
const fmt = (value: number) => value.toLocaleString('en-IN');
const excluded = (o: Order) => o.status === 'cancelled' || o.assignment_status === 'rejected';
const stageOf = (status: string): 'survey' | 'design' | 'production' | 'dispatch' | 'installed' | 'other' => {
  const s = status.toLowerCase();
  if (s.includes('install') || s === 'completed') return 'installed';
  if (s.includes('dispatch') || s.includes('transit') || s.includes('delivered')) return 'dispatch';
  if (s.includes('production') || s.includes('fabricat') || s.includes('print')) return 'production';
  if (s.includes('design') || s.includes('artwork')) return 'design';
  if (s.includes('survey') || s.includes('pending') || s.includes('assigned')) return 'survey';
  return 'other';
};
const tiles = [
  { key: 'survey', label: 'Field & survey', subtitle: 'Sites awaiting next stage', url: '/survey-review', icon: MapPin },
  { key: 'design', label: 'Design', subtitle: 'Design-stage sites', url: '/design', icon: Palette },
  { key: 'production', label: 'Production', subtitle: 'Production-stage sites', url: '/production', icon: Factory },
  { key: 'dispatch', label: 'Dispatch', subtitle: 'Dispatched sites', url: '/supply-orders', icon: PackageCheck },
  { key: 'installed', label: 'Installed', subtitle: 'Installed sites', url: '/installation-review', icon: ClipboardList },
] as const;

/** Read-only operational snapshot; no writes or schema changes. */
export default function DashboardPage() {
  const { profile } = useAuth();
  const orgId = profile?.organization_id;
  const [search, setSearch] = useState('');
  const [showAll, setShowAll] = useState(false);
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['agency-operations-dashboard', orgId],
    enabled: !!orgId,
    queryFn: async () => {
      if (!orgId) throw new Error('Missing organization');
      async function load(table: 'clients' | 'purchase_orders' | 'shops', columns: string) {
        const results: Record<string, unknown>[] = [];
        for (let from = 0; ; from += 500) {
          const { data: batch, error } = await supabase.from(table).select(columns).eq('organization_id', orgId!).order('id').range(from, from + 499);
          if (error) throw error;
          results.push(...((batch || []) as Record<string, unknown>[]));
          if (!batch || batch.length < 500) break;
        }
        return results;
      }
      const [clients, orders, shops] = await Promise.all([
        load('clients', 'id,name,is_active'),
        load('purchase_orders', 'id,client_id,project_id,campaign_id,name,po_number,status,assignment_status,created_at'),
        load('shops', 'id,client_id,purchase_order_id,status'),
      ]);
      return { clients: clients as unknown as ClientRow[], orders: orders as unknown as Order[], shops: shops as unknown as ShopRow[] };
    },
  });
  const snapshot = useMemo(() => {
    if (!data) return null;
    const orders = data.orders.filter(o => !excluded(o));
    const activeClients = data.clients.filter(c => c.is_active);
    const clientRows = activeClients.map(c => {
      const own = orders.filter(o => o.client_id === c.id);
      const siteCount = data.shops.filter(s => s.client_id === c.id).length;
      const done = own.filter(isDone).length;
      return { ...c, done, total: own.length, sites: siteCount, percent: completion(own), open: own.length - done };
    });
    const stages = { survey: 0, design: 0, production: 0, dispatch: 0, installed: 0, other: 0 };
    data.shops.forEach(s => { stages[stageOf(s.status)] += 1; });
    const openOrders = orders.filter(o => !isDone(o));
    const pending = openOrders.filter(o => o.assignment_status === 'pending_acceptance');
    const recent = [...openOrders].sort((a, b) => (b.created_at || '').localeCompare(a.created_at || '')).slice(0, 7);
    return { activeClients, orders, clientRows, stages, openOrders, pending, recent, sites: data.shops.length, done: orders.filter(isDone).length };
  }, [data]);
  if (isLoading) return <div role="status" className="rounded-xl border bg-white p-6 text-sm text-slate-600">Loading agency operations…</div>;
  if (isError || !snapshot) return <div role="alert" className="rounded-xl border border-red-200 bg-white p-6 text-sm text-red-700">Agency data couldn't be loaded. <button type="button" className="font-semibold underline" onClick={() => refetch()}>Retry</button></div>;
  const metrics = [
    { label: 'Active clients', value: snapshot.activeClients.length, extra: 'Client accounts', url: '/clients', icon: Users },
    { label: 'Live work orders', value: snapshot.openOrders.length, extra: `${fmt(snapshot.orders.length)} total orders`, url: '/purchase-orders', icon: ClipboardList },
    { label: 'Retail sites', value: snapshot.sites, extra: 'Sites in delivery network', url: '/field-map', icon: MapPin },
    { label: 'Installed sites', value: snapshot.stages.installed, extra: `${snapshot.sites ? Math.round(snapshot.stages.installed / snapshot.sites * 100) : 0}% of sites`, url: '/installation-review', icon: PackageCheck },
    { label: 'Orders completed', value: snapshot.done, extra: `${completion(snapshot.orders)}% of orders`, url: '/purchase-orders', icon: ClipboardList },
  ];
  const rows = snapshot.clientRows.filter(c => c.name.toLowerCase().includes(search.trim().toLowerCase()))
    .sort((a, b) => b.open - a.open || a.name.localeCompare(b.name));
  const visible = showAll ? rows : rows.slice(0, 6);
  return <main className="mx-auto max-w-[1600px] space-y-5 pb-9 text-slate-800">
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 pb-3">
      <div className="flex items-center gap-2 text-xs text-slate-500"><span className="h-2 w-2 rounded-full bg-emerald-500"/> Agency operations <span className="text-slate-300">/</span> Live delivery snapshot</div>
      <button type="button" onClick={() => refetch()} className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-blue-600">Refresh data</button>
    </div>
    <section aria-label="Agency metrics" className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
      {metrics.map(m => <Link key={m.label} to={m.url} className="group rounded-xl border border-slate-200 bg-white px-4 py-3.5 hover:border-blue-300 focus-visible:outline-2 focus-visible:outline-blue-600">
        <div className="flex items-center justify-between gap-2"><span className="text-xs font-medium text-slate-500">{m.label}</span><m.icon size={16} className="text-slate-400 group-hover:text-blue-600"/></div>
        <p className="mt-2 text-2xl font-semibold leading-none tracking-tight tabular-nums text-slate-900">{fmt(m.value)}</p>
        <p className="mt-2 text-[11px] text-slate-500">{m.extra}</p>
      </Link>)}
    </section>
    <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(290px,1fr)]">
      <section className="rounded-xl border border-slate-200 bg-white">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3.5"><div><h2 className="text-sm font-semibold">Delivery pipeline</h2><p className="mt-0.5 text-xs text-slate-500">Actual site status, from field work through installation</p></div><Link to="/field-map" className="inline-flex items-center gap-1 text-xs font-medium text-blue-700 hover:underline">Field map <ArrowRight size={13}/></Link></div>
        <div className="grid grid-cols-2 gap-2 p-3 sm:grid-cols-5">{tiles.map(t => { const Icon = t.icon; const value = snapshot.stages[t.key]; return <Link to={t.url} key={t.key} className="rounded-lg border border-slate-100 bg-slate-50/70 px-3 py-3 hover:border-blue-300"><Icon size={17} className="mb-3 text-slate-500"/><div className="text-xl font-semibold tabular-nums">{fmt(value)}</div><div className="mt-1 text-xs font-medium">{t.label}</div><div className="mt-1 text-[10px] text-slate-500">{snapshot.sites ? Math.round(value / snapshot.sites * 100) : 0}% of sites</div></Link>; })}</div>
        {snapshot.stages.other > 0 && <p className="border-t px-4 py-2 text-xs text-amber-700">{fmt(snapshot.stages.other)} sites have other status values. Review details in Field Map.</p>}
        {!snapshot.sites && <p className="border-t px-4 py-4 text-xs text-slate-500">No field sites recorded yet. Pipeline will populate from existing shops.</p>}
      </section>
      <section className="rounded-xl border border-slate-200 bg-white">
        <div className="flex items-center justify-between border-b px-4 py-3.5"><div><h2 className="text-sm font-semibold">Requires attention</h2><p className="mt-0.5 text-xs text-slate-500">Work awaiting an owner decision</p></div>{snapshot.pending.length > 0 && <span className="rounded-full bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-700">{snapshot.pending.length} pending</span>}</div>
        <div className="divide-y divide-slate-100">{snapshot.pending.slice(0, 5).map(o => <Link to={`/purchase-orders?order=${encodeURIComponent(o.id)}`} key={o.id} className="flex items-center gap-3 px-4 py-3 hover:bg-slate-50"><AlertCircle size={16} className="shrink-0 text-amber-600"/><span className="min-w-0 flex-1 truncate text-xs font-medium">{o.name || o.po_number || 'Work order'}</span><span className="text-[11px] text-amber-700">Acceptance <ArrowRight size={12} className="inline"/></span></Link>)}{!snapshot.pending.length && <div className="px-4 py-8 text-center text-xs text-slate-500">No work orders pending acceptance.</div>}</div>
        {snapshot.pending.length > 5 && <Link to="/purchase-orders" className="block border-t px-4 py-3 text-xs font-medium text-blue-700">View remaining pending orders →</Link>}
      </section>
    </div>
    <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(290px,1fr)]">
      <section className="min-w-0 rounded-xl border border-slate-200 bg-white">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3.5"><div><h2 className="text-sm font-semibold">Client delivery</h2><p className="mt-0.5 text-xs text-slate-500">Open work orders and delivery completion by client</p></div><div className="relative"><Search size={14} className="absolute left-2.5 top-2.5 text-slate-400"/><label htmlFor="agency-client-search" className="sr-only">Search clients</label><input id="agency-client-search" value={search} onChange={e => {setSearch(e.target.value); setShowAll(false);}} placeholder="Find client" className="w-44 rounded-md border border-slate-200 py-2 pl-8 pr-2 text-xs focus-visible:outline-blue-600"/></div></div>
        <div className="overflow-x-auto"><table className="w-full min-w-[540px] text-xs"><thead className="bg-slate-50 text-left text-slate-500"><tr><th className="px-4 py-2.5 font-medium">Client</th><th className="px-3 py-2.5 font-medium">Open orders</th><th className="px-3 py-2.5 font-medium">Sites</th><th className="px-3 py-2.5 font-medium">Order completion</th><th className="px-3 py-2.5 font-medium"/></tr></thead><tbody className="divide-y divide-slate-100">{visible.map(c => <tr key={c.id} className="hover:bg-slate-50"><td className="px-4 py-3 font-medium">{c.name}</td><td className="px-3 py-3 tabular-nums">{fmt(c.open)}</td><td className="px-3 py-3 tabular-nums">{fmt(c.sites)}</td><td className="px-3 py-3"><div className="flex items-center gap-2"><div className="w-20"><ProgressBar pct={c.percent}/></div><span className="tabular-nums text-slate-500">{c.done}/{c.total}</span></div></td><td className="px-3 py-3 text-right"><Link to={`/clients?detail=${encodeURIComponent(c.id)}`} className="font-medium text-blue-700 hover:underline">Open →</Link></td></tr>)}</tbody></table>{!rows.length && <p className="p-6 text-center text-xs text-slate-500">{search ? 'No matching client.' : 'No active clients yet.'}</p>}</div>
        <div className="flex items-center justify-between border-t px-4 py-3 text-xs text-slate-500"><span>{visible.length} of {rows.length} clients</span>{rows.length > 6 && <button className="font-medium text-blue-700 hover:underline" onClick={() => setShowAll(v => !v)}>{showAll ? 'Show fewer' : 'View all clients'}</button>}{rows.length <= 6 && <Link to="/clients" className="font-medium text-blue-700 hover:underline">Manage clients →</Link>}</div>
      </section>
      <section className="rounded-xl border border-slate-200 bg-white"><div className="flex items-center justify-between border-b px-4 py-3.5"><div><h2 className="text-sm font-semibold">Open work orders</h2><p className="mt-0.5 text-xs text-slate-500">Most recently created active orders</p></div><Link to="/purchase-orders" className="text-xs font-medium text-blue-700 hover:underline">View all →</Link></div><div className="divide-y divide-slate-100">{snapshot.recent.map(o => <Link to={`/purchase-orders?order=${encodeURIComponent(o.id)}`} key={o.id} className="flex items-center justify-between gap-2 px-4 py-3 hover:bg-slate-50"><div className="min-w-0"><p className="truncate text-xs font-medium">{o.name || o.po_number || 'Work order'}</p><p className="mt-1 text-[11px] text-slate-500">{snapshot.activeClients.find(c => c.id === o.client_id)?.name || 'Client not available'}</p></div><ArrowRight size={14} className="shrink-0 text-slate-400"/></Link>)}{!snapshot.recent.length && <p className="p-7 text-center text-xs text-slate-500">No open work orders.</p>}</div></section>
    </div>
  </main>;
}
