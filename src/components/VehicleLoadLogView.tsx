import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { fetchVehicleLoadLog, groupVehicleLoadLog, VehicleLoadTripGroup } from '@/lib/vehicleLoadLog';
import { logAudit } from '@/lib/helpers';
import { Card, EmptyState, StatusBadge } from '@/components/ui';
import { Truck, Search, ListChecks, CheckCircle2, AlertTriangle, Users, PackagePlus, ChevronDown, Store } from 'lucide-react';

type DateFilter = 'today' | '7d' | '30d' | 'all';

// How many trip cards render at once. At org scale (thousands of shops ->
// thousands of trips over a window) mounting every card up front is what
// turns this screen into "kichadi" — slow paint, endless scroll, totals lost
// somewhere in the middle. We show totals first (below) and only mount a
// page of cards, growing on demand.
const PAGE_SIZE = 25;

// Reused by ProductionPage (Production's own "who loaded what" check) and
// OwnerConsolePage (Owner/Admin's full-org log) — one implementation so the
// numbers Owner sees and the numbers Production sees can never drift apart.
export function VehicleLoadLogView({ canManage }: { canManage: boolean }) {
  const { profile } = useAuth();
  const orgId = profile?.organization_id;
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [dateFilter, setDateFilter] = useState<DateFilter>('30d');
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  const { data: rows, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['vehicle-load-log', orgId],
    queryFn: () => fetchVehicleLoadLog(orgId as string),
    enabled: !!orgId,
  });

  const groups = useMemo(() => groupVehicleLoadLog(rows || []), [rows]);

  const filtered = useMemo(() => {
    let list = groups;
    if (dateFilter !== 'all') {
      const days = dateFilter === 'today' ? 1 : dateFilter === '7d' ? 7 : 30;
      const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
      list = list.filter((g) => new Date(g.loaded_at).getTime() >= cutoff);
    }
    const term = search.trim().toLowerCase();
    if (term) {
      list = list.filter((g) =>
        g.vehicle_number.toLowerCase().includes(term) ||
        (g.driver_name || '').toLowerCase().includes(term) ||
        (g.loaded_by_name || '').toLowerCase().includes(term) ||
        g.shops.some((s) => s.shop_name.toLowerCase().includes(term) || (s.installer_name || '').toLowerCase().includes(term))
      );
    }
    return list;
  }, [groups, search, dateFilter]);

  // Reset paging whenever the filtered set changes shape, so switching
  // search/date filter doesn't leave you scrolled deep into a stale page.
  useEffect(() => { setVisibleCount(PAGE_SIZE); }, [search, dateFilter, groups]);

  // Totals across the FULL filtered set (not just the mounted cards), so
  // Owner/Admin/Production get the "kitna total load hua" number instantly
  // without having to page through every trip card to add it up themselves.
  const totals = useMemo(() => {
    let shopCount = 0;
    let readyQty = 0;
    let loadedQty = 0;
    const vehicles = new Set<string>();
    for (const g of filtered) {
      shopCount += g.shops.length;
      readyQty += g.total_ready_qty;
      loadedQty += g.total_loaded_qty;
      vehicles.add(g.vehicle_number);
    }
    return { trips: filtered.length, shopCount, readyQty, loadedQty, vehicleCount: vehicles.size };
  }, [filtered]);

  const visible = useMemo(() => filtered.slice(0, visibleCount), [filtered, visibleCount]);

  const markDeliveredMutation = useMutation({
    mutationFn: async ({ vehicleLoadId, shopName }: { vehicleLoadId: string; shopName: string }) => {
      if (!profile) return;
      const { error: updErr } = await supabase.from('vehicle_loads').update({
        status: 'delivered', delivered_at: new Date().toISOString(), delivered_by: profile.id,
      }).eq('id', vehicleLoadId);
      if (updErr) throw new Error(updErr.message);
      await logAudit('vehicle_loads', vehicleLoadId, 'update', 'status', 'loaded', 'delivered', `Vehicle load marked delivered for ${shopName}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['vehicle-load-log', orgId] });
      queryClient.invalidateQueries({ queryKey: ['vehicle-load-shops', orgId] });
    },
  });

  return (
    <div>
      {/* Totals-first: the number Owner/Admin/Production actually want
          ("kitna total load hua") up front, before any per-shop detail.
          Per-shop breakdown is opt-in via each card below. */}
      <Card className="p-3.5 mb-4">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <SummaryStat label="Trips" value={totals.trips} icon={<Truck className="w-3.5 h-3.5" />} />
          <SummaryStat label="Shops covered" value={totals.shopCount} icon={<Store className="w-3.5 h-3.5" />} />
          <SummaryStat label="Total ready qty" value={totals.readyQty} icon={<ListChecks className="w-3.5 h-3.5" />} />
          <SummaryStat label="Total loaded qty" value={totals.loadedQty} icon={<CheckCircle2 className="w-3.5 h-3.5" />} tone="text-emerald-700" />
        </div>
        <p className="text-xs text-slate-500 mt-3">
          Ek shop ho ya ek hi trip me kai shops, har loading event neeche ek card hai. Multi-shop trips
          <span className="inline-flex items-center gap-1 mx-1 text-[11px] font-semibold px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-700"><Users className="w-3 h-3" /> Multi-shop</span>
          badge ke saath dikhte hain — shop-wise detail card kholne par hi dikhega, taaki list saaf rahe.
        </p>
      </Card>

      <div className="flex flex-col sm:flex-row gap-2 mb-4">
        <div className="relative flex-1">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by vehicle number, driver, shop, installer, or loaded-by..."
            className="w-full pl-9 pr-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
          />
        </div>
        <div className="flex gap-1.5 shrink-0">
          {(['today', '7d', '30d', 'all'] as DateFilter[]).map((d) => (
            <button
              key={d}
              onClick={() => setDateFilter(d)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium border transition ${
                dateFilter === d ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
              }`}
            >
              {d === 'today' ? 'Today' : d === '7d' ? '7 days' : d === '30d' ? '30 days' : 'All'}
            </button>
          ))}
        </div>
      </div>

      {isError && (
        <div className="mb-4 flex items-start gap-2 bg-red-50 border border-red-200 text-red-700 rounded-lg px-3 py-2.5 text-sm">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <div className="min-w-0">
            <p className="font-medium">Couldn't load the vehicle load log.</p>
            <p className="text-xs text-red-600/80 break-words">{(error as Error)?.message}</p>
          </div>
          <button onClick={() => refetch()} className="ml-auto shrink-0 text-xs font-medium underline">Retry</button>
        </div>
      )}

      {isLoading ? (
        <div className="space-y-3">{Array.from({ length: 3 }).map((_, i) => <div key={i} className="h-24 bg-slate-100 rounded-xl animate-pulse" />)}</div>
      ) : filtered.length === 0 ? (
        <Card>
          <EmptyState
            icon={<ListChecks className="w-12 h-12" />}
            title={groups.length > 0 ? 'Nothing matches this filter' : 'No vehicle loads recorded yet'}
            subtitle={groups.length > 0 ? 'Try a different date range or clear your search.' : 'Once Production loads a vehicle, it will show up here.'}
          />
        </Card>
      ) : (
        <div className="space-y-3">
          {visible.map((g) => (
            <TripLogCard key={g.key} group={g} canManage={canManage} onMarkDelivered={(id, name) => markDeliveredMutation.mutate({ vehicleLoadId: id, shopName: name })} />
          ))}
          {visibleCount < filtered.length && (
            <button
              onClick={() => setVisibleCount((n) => n + PAGE_SIZE)}
              className="w-full text-sm font-medium text-blue-600 hover:text-blue-700 bg-white border border-slate-200 rounded-lg py-2.5 hover:bg-slate-50"
            >
              Load more ({filtered.length - visibleCount} more trip{filtered.length - visibleCount === 1 ? '' : 's'})
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function SummaryStat({ label, value, icon, tone }: { label: string; value: number; icon: React.ReactNode; tone?: string }) {
  return (
    <div>
      <p className="flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide text-slate-400">{icon} {label}</p>
      <p className={`text-lg font-semibold ${tone || 'text-slate-800'}`}>{value.toLocaleString('en-IN')}</p>
    </div>
  );
}

function TripLogCard({ group, canManage, onMarkDelivered }: { group: VehicleLoadTripGroup; canManage: boolean; onMarkDelivered: (vehicleLoadId: string, shopName: string) => void }) {
  // Single-shop trips are just one row anyway — no point hiding it behind a
  // click. Multi-shop trips (the ones that can balloon into a huge list)
  // start collapsed: total qty is already visible above, per-shop detail is
  // one click away instead of always-on-screen.
  const [expanded, setExpanded] = useState(!group.is_multi_shop);

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <Truck className="w-4 h-4 text-slate-400" />
        <span className="text-sm font-semibold text-slate-900">{group.vehicle_number}</span>
        {group.driver_name && <span className="text-xs text-slate-400">· Driver {group.driver_name}</span>}
        {group.is_multi_shop && (
          <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-700">
            <Users className="w-3 h-3" /> Multi-shop · {group.shops.length} shops
          </span>
        )}
        <span className="ml-auto text-xs text-slate-400">
          Loaded by <span className="font-medium text-slate-600">{group.loaded_by_name || '—'}</span> · {new Date(group.loaded_at).toLocaleString('en-IN')}
        </span>
      </div>

      <div className="flex items-center justify-between gap-2 mb-3">
        <p className="text-xs text-slate-500">
          Ready <span className="font-semibold text-slate-700">{group.total_ready_qty}</span> · Loaded <span className="font-semibold text-slate-700">{group.total_loaded_qty}</span>
          {group.total_loaded_qty < group.total_ready_qty && (
            <span className="text-amber-600 font-semibold"> · {group.total_ready_qty - group.total_loaded_qty} not yet on this vehicle</span>
          )}
        </p>
        {group.is_multi_shop && (
          <button
            onClick={() => setExpanded((v) => !v)}
            className="flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-700 shrink-0"
          >
            {expanded ? 'Hide' : 'View'} {group.shops.length} shop{group.shops.length === 1 ? '' : 's'}
            <ChevronDown className={`w-3.5 h-3.5 transition-transform ${expanded ? 'rotate-180' : ''}`} />
          </button>
        )}
      </div>

      {/* Material-wise breakdown — "kis material ka kitna load hua" — always
          visible, not gated behind the per-shop expand below. This is the
          number people actually come here to check. */}
      {group.materials.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-3">
          {group.materials.map((m) => (
            <span key={m.name} className="text-[11px] bg-slate-100 text-slate-700 px-2 py-0.5 rounded-full">
              <span className="font-medium">{m.name}</span> · Ready {m.qty_ready} → Loaded {m.qty_loaded}
            </span>
          ))}
        </div>
      )}

      {!expanded ? (
        // Collapsed: a scannable one-liner per shop — name, who it's for,
        // and its own qty — enough to confirm "haan ye 40 shops sahi hain
        // aur sahi installer ko ja rahe hain" without opening every one.
        <div className="flex flex-wrap gap-1.5">
          {group.shops.slice(0, 12).map((s) => (
            <span key={s.vehicle_load_id} className="text-[11px] bg-slate-50 border border-slate-200 text-slate-600 px-2 py-0.5 rounded-full">
              {s.shop_name} → <span className="font-medium">{s.installer_name || '—'}</span> · {s.total_loaded_qty}
            </span>
          ))}
          {group.shops.length > 12 && (
            <button onClick={() => setExpanded(true)} className="text-[11px] text-blue-600 font-medium px-2 py-0.5">
              +{group.shops.length - 12} more
            </button>
          )}
        </div>
      ) : (
      <div className="space-y-2">
        {group.shops.map((s) => (
          <div key={s.vehicle_load_id} className={`border rounded-lg p-2.5 ${s.status === 'cancelled' ? 'border-slate-200 bg-slate-50 opacity-60' : 'border-slate-200'}`}>
            <div className="flex flex-wrap items-center gap-2 mb-1">
              <span className="text-sm font-medium text-slate-800">{s.shop_name}</span>
              {s.shop_city && <span className="text-xs text-slate-400">· {s.shop_city}</span>}
              <StatusBadge status={s.status} />
              <span className="ml-auto text-xs text-slate-500">For <span className="font-medium text-slate-700">{s.installer_name || '—'}</span></span>
            </div>
            <div className="flex flex-wrap gap-1.5 mb-1">
              {s.boards.map((b) => (
                <span key={b.item_id} className="text-[11px] bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full">
                  {b.work_type_name || b.material || 'Item'} · Ready {b.qty_ready} → Loaded {b.qty_loaded}
                </span>
              ))}
            </div>
            {s.notes && <p className="text-xs text-slate-500 italic mb-1">"{s.notes}"</p>}
            {s.status === 'loaded' && canManage && (
              <button onClick={() => onMarkDelivered(s.vehicle_load_id, s.shop_name)} className="flex items-center gap-1.5 text-xs font-medium text-emerald-700 hover:text-emerald-800">
                <CheckCircle2 className="w-3.5 h-3.5" /> Mark Delivered
              </button>
            )}
            {s.status === 'delivered' && s.delivered_at && (
              <p className="flex items-center gap-1 text-xs text-emerald-600">
                <PackagePlus className="w-3.5 h-3.5" /> Delivered {new Date(s.delivered_at).toLocaleString('en-IN')}{s.delivered_by_name ? ` by ${s.delivered_by_name}` : ''}
              </p>
            )}
          </div>
        ))}
      </div>
      )}
    </Card>
  );
}
