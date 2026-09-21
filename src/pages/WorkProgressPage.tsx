import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { Card, PageHeader } from '@/components/ui';
import { useRealtimeInvalidate } from '@/lib/useRealtimeInvalidate';

type Stage = 'not_started' | 'survey' | 'design' | 'production' | 'installation' | 'install_review' | 'done' | 'cancelled';
const STAGES: { key: Stage; label: string; tone: string }[] = [
  { key: 'not_started', label: 'Survey baaki', tone: 'bg-slate-100 text-slate-700' },
  { key: 'survey', label: 'Survey / Survey review', tone: 'bg-sky-100 text-sky-800' },
  { key: 'design', label: 'Design', tone: 'bg-violet-100 text-violet-800' },
  { key: 'production', label: 'Production', tone: 'bg-orange-100 text-orange-800' },
  { key: 'installation', label: 'Installation baaki', tone: 'bg-amber-100 text-amber-800' },
  { key: 'install_review', label: 'Installation review', tone: 'bg-blue-100 text-blue-800' },
  { key: 'done', label: 'Complete', tone: 'bg-emerald-100 text-emerald-800' },
];
function stageOf(status: string): Stage {
  if (['pending', 'assigned'].includes(status)) return 'not_started';
  if (['survey_started', 'surveyed', 'approval_pending', 'approved'].includes(status)) return 'survey';
  if (['design_pending', 'designing', 'design_ready', 'in_review', 'design_approved'].includes(status)) return 'design';
  if (['production_pending', 'in_production', 'production_ready', 'production_hold', 'production_done'].includes(status)) return 'production';
  if (['dispatched', 'installation_pending', 'installing'].includes(status)) return 'installation';
  if (status === 'installation_review') return 'install_review';
  if (['installed', 'billed'].includes(status)) return 'done';
  return 'cancelled';
}
const num = (v: any) => (v == null ? 0 : Number(v) || 0);
const fmt = (v: number) => (Math.round(v * 100) / 100).toLocaleString('en-IN');

async function fetchAll<T>(build: (from: number, to: number) => any): Promise<T[]> {
  const out: T[] = []; const size = 1000;
  for (let from = 0; ; from += size) {
    const { data, error } = await build(from, from + size - 1);
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < size) break;
  }
  return out;
}

export default function WorkProgressPage() {
  const { profile } = useAuth();
  const orgId = profile?.organization_id;
  const navigate = useNavigate();
  const [stageFilter, setStageFilter] = useState<Stage | 'all'>('all');
  const [clientFilter, setClientFilter] = useState('all');
  const [personFilter, setPersonFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<'remaining' | 'progress' | 'name'>('remaining');

  useRealtimeInvalidate(['shops', 'work_items', 'shop_assignments', 'installation_jobs', 'surveys', 'design_tasks'], orgId, [['work-progress', orgId]]);

  const { data, isLoading, error } = useQuery({
    queryKey: ['work-progress', orgId],
    enabled: !!orgId,
    refetchInterval: 20000,
    queryFn: async () => {
      const [shops, items, assigns] = await Promise.all([
        fetchAll<any>((a, b) => supabase.from('shops').select('id,name,city,status,client_id,clients(name)').eq('organization_id', orgId!).neq('status', 'cancelled').order('created_at').range(a, b)),
        fetchAll<any>((a, b) => supabase.from('work_items').select('id,shop_id,status,approved_area,survey_area,installed_area,excluded_from_calculations,execution_reason').eq('organization_id', orgId!).order('created_at').range(a, b)),
        fetchAll<any>((a, b) => supabase.from('shop_assignments').select('shop_id,user_id,role,status,profiles(full_name)').eq('organization_id', orgId!).order('assigned_at').range(a, b)),
      ]);
      return { shops, items, assigns };
    },
  });

  const view = useMemo(() => {
    if (!data) return null;
    const itemsByShop = new Map<string, any[]>(); data.items.forEach((i) => { (itemsByShop.get(i.shop_id) || itemsByShop.set(i.shop_id, []).get(i.shop_id)!).push(i); });
    const assignByShop = new Map<string, any[]>(); data.assigns.forEach((a) => { (assignByShop.get(a.shop_id) || assignByShop.set(a.shop_id, []).get(a.shop_id)!).push(a); });
    const rows = data.shops.map((s) => {
      const its = itemsByShop.get(s.id) || [];
      const active = its.filter((i) => !i.excluded_from_calculations);
      const unavailable = its.filter((i) => i.excluded_from_calculations);
      const planned = active.reduce((t, i) => t + num(i.approved_area ?? i.survey_area), 0);
      const done = active.reduce((t, i) => t + num(i.installed_area), 0);
      const installedCount = active.filter((i) => i.status === 'installed' || num(i.installed_area) > 0).length;
      const stage = stageOf(s.status);
      const people = assignByShop.get(s.id) || [];
      const who = (role: string) => people.filter((p) => p.role === role).map((p) => p.profiles?.full_name).filter(Boolean).join(', ');
      const pct = stage === 'done' ? 100 : planned > 0 ? Math.min(100, Math.round((done / planned) * 100)) : 0;
      return { s, stage, its, active, unavailable, planned, done, remaining: stage === 'done' ? 0 : Math.max(0, planned - done), installedCount, pct,
        surveyor: who('surveyor'), designer: who('designer'), installer: who('installer'), people };
    });
    return rows;
  }, [data]);

  const people = useMemo(() => {
    const m = new Map<string, { id: string; name: string; roles: Set<string> }>();
    (data?.assigns || []).forEach((a) => { if (a.profiles?.full_name) { const e = m.get(a.user_id) || { id: a.user_id, name: a.profiles.full_name, roles: new Set<string>() }; e.roles.add(a.role); m.set(a.user_id, e); } });
    return [...m.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [data]);
  const clients = useMemo(() => [...new Map((data?.shops || []).filter((s) => s.client_id).map((s) => [s.client_id, s.clients?.name || 'Client'])).entries()], [data]);

  const filtered = useMemo(() => {
    if (!view) return [];
    let r = view;
    if (stageFilter !== 'all') r = r.filter((x) => x.stage === stageFilter);
    if (clientFilter !== 'all') r = r.filter((x) => x.s.client_id === clientFilter);
    if (personFilter !== 'all') r = r.filter((x) => x.people.some((p) => p.user_id === personFilter));
    if (search.trim()) { const q = search.toLowerCase(); r = r.filter((x) => `${x.s.name} ${x.s.city || ''}`.toLowerCase().includes(q)); }
    return [...r].sort((a, b) => sort === 'name' ? a.s.name.localeCompare(b.s.name) : sort === 'progress' ? b.pct - a.pct : b.remaining - a.remaining);
  }, [view, stageFilter, clientFilter, personFilter, search, sort]);

  const totals = useMemo(() => {
    const base = view || [];
    const planned = base.reduce((t, r) => t + r.planned, 0);
    const done = base.reduce((t, r) => t + (r.stage === 'done' ? Math.max(r.done, 0) : r.done), 0);
    const complete = base.filter((r) => r.stage === 'done').length;
    const unavailableItems = base.reduce((t, r) => t + r.unavailable.length, 0);
    const unavailableArea = base.reduce((t, r) => t + r.unavailable.reduce((x, i) => x + num(i.approved_area ?? i.survey_area), 0), 0);
    return { shops: base.length, complete, planned, done, remaining: Math.max(0, planned - done), unavailableItems, unavailableArea, pct: base.length ? Math.round((complete / base.length) * 100) : 0 };
  }, [view]);

  const perPerson = useMemo(() => {
    if (!view || !data) return [];
    const byShop = new Map(view.map((r) => [r.s.id, r]));
    const m = new Map<string, { name: string; role: string; shops: number; complete: number; sqft: number; pending: number }>();
    data.assigns.forEach((a) => {
      if (!a.profiles?.full_name) return;
      const r = byShop.get(a.shop_id); if (!r) return;
      const key = `${a.user_id}:${a.role}`;
      const e = m.get(key) || { name: a.profiles.full_name, role: a.role, shops: 0, complete: 0, sqft: 0, pending: 0 };
      e.shops += 1;
      const finished = a.role === 'installer' ? r.stage === 'done' : a.status === 'completed';
      if (finished) { e.complete += 1; if (a.role === 'installer') e.sqft += r.done; } else e.pending += 1;
      m.set(key, e);
    });
    return [...m.values()].filter((p) => ['surveyor', 'installer', 'designer'].includes(p.role)).sort((a, b) => a.role.localeCompare(b.role) || b.complete - a.complete);
  }, [view, data]);

  const stageCounts = useMemo(() => { const c: Record<string, number> = {}; (view || []).forEach((r) => { c[r.stage] = (c[r.stage] || 0) + 1; }); return c; }, [view]);

  if (isLoading) return <div className="p-8 text-slate-400 text-sm">Loading progress…</div>;
  if (error) return <div className="p-8 text-red-600 text-sm">Progress load nahi hua: {(error as any).message}</div>;

  return (
    <div className="space-y-5">
      <PageHeader title="Work Progress" subtitle="Kitna kaam ho gaya, kitna baaki hai, kis shop me kya atka hai aur kaun kar raha hai — live." />

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <Card className="p-4"><p className="text-xs text-slate-500">Total shops</p><p className="text-2xl font-bold text-slate-900">{totals.shops}</p></Card>
        <Card className="p-4"><p className="text-xs text-slate-500">Complete (installed)</p><p className="text-2xl font-bold text-emerald-700">{totals.complete}</p><p className="text-[11px] text-slate-400">{totals.pct}% shops · {totals.shops - totals.complete} baaki</p></Card>
        <Card className="p-4"><p className="text-xs text-slate-500">Installed sq.ft</p><p className="text-2xl font-bold text-slate-900">{fmt(totals.done)}</p><p className="text-[11px] text-slate-400">planned {fmt(totals.planned)}</p></Card>
        <Card className="p-4"><p className="text-xs text-slate-500">Baaki sq.ft</p><p className="text-2xl font-bold text-amber-700">{fmt(totals.remaining)}</p></Card>
        <Card className="p-4"><p className="text-xs text-slate-500">Not available (count nahi)</p><p className="text-2xl font-bold text-slate-700">{totals.unavailableItems}</p><p className="text-[11px] text-slate-400">{fmt(totals.unavailableArea)} sq.ft excluded</p></Card>
      </div>

      <Card className="p-4">
        <p className="text-sm font-semibold text-slate-900 mb-3">Pipeline — shop abhi kis stage me hai</p>
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-2">
          {STAGES.map((st) => (
            <button key={st.key} onClick={() => setStageFilter(stageFilter === st.key ? 'all' : st.key)} className={`rounded-xl border p-3 text-left ${stageFilter === st.key ? 'ring-2 ring-blue-500 border-blue-300' : 'border-slate-200'} bg-white`}>
              <p className="text-2xl font-bold text-slate-900">{stageCounts[st.key] || 0}</p>
              <span className={`text-[10px] font-bold rounded-full px-2 py-0.5 ${st.tone}`}>{st.label}</span>
            </button>
          ))}
        </div>
      </Card>

      <div className="flex flex-wrap gap-2">
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Shop / city search" className="border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white" />
        <select value={clientFilter} onChange={(e) => setClientFilter(e.target.value)} className="border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white"><option value="all">Sab clients</option>{clients.map(([id, n]) => <option key={id} value={id}>{n}</option>)}</select>
        <select value={personFilter} onChange={(e) => setPersonFilter(e.target.value)} className="border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white"><option value="all">Sab log</option>{people.map((p) => <option key={p.id} value={p.id}>{p.name} ({[...p.roles].join('/')})</option>)}</select>
        <select value={sort} onChange={(e) => setSort(e.target.value as any)} className="border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white"><option value="remaining">Sort: sabse zyada baaki</option><option value="progress">Sort: progress %</option><option value="name">Sort: naam</option></select>
        {(stageFilter !== 'all' || clientFilter !== 'all' || personFilter !== 'all' || search) && <button onClick={() => { setStageFilter('all'); setClientFilter('all'); setPersonFilter('all'); setSearch(''); }} className="text-sm text-blue-700 font-medium px-2">Clear filters</button>}
      </div>

      <Card className="p-0 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs text-slate-500"><tr>
            <th className="text-left px-3 py-2.5">Shop</th><th className="text-left px-3 py-2.5">Stage</th><th className="text-left px-3 py-2.5">Works</th>
            <th className="text-left px-3 py-2.5">Sq.ft done / total</th><th className="text-left px-3 py-2.5">Progress</th><th className="text-left px-3 py-2.5">Surveyor</th><th className="text-left px-3 py-2.5">Installer</th>
          </tr></thead>
          <tbody className="divide-y">
            {filtered.map((r) => {
              const st = STAGES.find((x) => x.key === r.stage);
              return (
                <tr key={r.s.id} onClick={() => navigate(`/shops/${r.s.id}`)} className="hover:bg-slate-50 cursor-pointer">
                  <td className="px-3 py-2.5"><p className="font-medium text-slate-900">{r.s.name}</p><p className="text-[11px] text-slate-400">{r.s.clients?.name}{r.s.city ? ` · ${r.s.city}` : ''}</p></td>
                  <td className="px-3 py-2.5"><span className={`text-[10px] font-bold rounded-full px-2 py-0.5 ${st?.tone}`}>{st?.label}</span></td>
                  <td className="px-3 py-2.5 text-xs text-slate-700">{r.installedCount}/{r.active.length} installed{r.unavailable.length > 0 && <span className="block text-[11px] text-amber-700">{r.unavailable.length} not available{r.unavailable[0]?.execution_reason ? ` — ${r.unavailable[0].execution_reason}` : ''}</span>}</td>
                  <td className="px-3 py-2.5 text-xs text-slate-700">{fmt(r.done)} / {fmt(r.planned)}<span className="block text-[11px] text-slate-400">baaki {fmt(r.remaining)}</span></td>
                  <td className="px-3 py-2.5 w-36"><div className="h-2 rounded-full bg-slate-100 overflow-hidden"><div className={`h-full ${r.pct === 100 ? 'bg-emerald-500' : 'bg-blue-500'}`} style={{ width: `${r.pct}%` }} /></div><p className="text-[11px] text-slate-500 mt-0.5">{r.pct}%</p></td>
                  <td className="px-3 py-2.5 text-xs text-slate-600">{r.surveyor || '—'}</td>
                  <td className="px-3 py-2.5 text-xs text-slate-600">{r.installer || '—'}</td>
                </tr>
              );
            })}
            {filtered.length === 0 && <tr><td colSpan={7} className="px-3 py-8 text-center text-slate-400 text-sm">Koi shop nahi mila.</td></tr>}
          </tbody>
        </table>
      </Card>

      <Card className="p-0 overflow-x-auto">
        <p className="px-4 pt-4 pb-2 text-sm font-semibold text-slate-900">Kiska kitna kaam hua</p>
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs text-slate-500"><tr><th className="text-left px-3 py-2.5">Naam</th><th className="text-left px-3 py-2.5">Role</th><th className="text-left px-3 py-2.5">Assigned shops</th><th className="text-left px-3 py-2.5">Complete</th><th className="text-left px-3 py-2.5">Baaki</th><th className="text-left px-3 py-2.5">Installed sq.ft</th></tr></thead>
          <tbody className="divide-y">
            {perPerson.map((p) => <tr key={p.name + p.role}><td className="px-3 py-2 font-medium text-slate-900">{p.name}</td><td className="px-3 py-2 capitalize text-slate-600">{p.role}</td><td className="px-3 py-2">{p.shops}</td><td className="px-3 py-2 text-emerald-700 font-semibold">{p.complete}</td><td className="px-3 py-2 text-amber-700">{p.pending}</td><td className="px-3 py-2">{p.role === 'installer' ? fmt(p.sqft) : '—'}</td></tr>)}
            {perPerson.length === 0 && <tr><td colSpan={6} className="px-3 py-6 text-center text-slate-400 text-sm">Abhi koi assignment nahi.</td></tr>}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
