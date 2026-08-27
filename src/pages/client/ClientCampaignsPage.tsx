import { useEffect, useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { useClientRealtimeInvalidate } from '@/lib/useClientRealtimeInvalidate';
import {
  Card, EmptyState, PageHeader, Modal, Input, Textarea, Select, ConfirmDialog,
  ProgressBar, FilterButton, FilterDrawer, FilterSection, Pagination,
} from '@/components/ui';
import { logAudit } from '@/lib/helpers';
import type { Campaign, PurchaseOrder, ClientPOLineItemProgress } from '@/lib/types';
import {
  buildClientCampaignRows, CLIENT_PO_WORK_STATUS_LABELS, CLIENT_PO_WORK_STATUS_COLORS,
  type ClientCampaignRow,
} from '@/lib/clientPortal';
import {
  Plus, Megaphone, ArrowUpRight, ArrowRight, ShoppingCart, Store, Loader2, Pencil, Trash2,
  Search, ChevronDown, Building2, Calendar, Layers, CheckCircle2, PlayCircle, Ban,
} from 'lucide-react';

type PoRow = PurchaseOrder & { agency_org: { name: string } | null };
type ShopRow = { id: string; status: string; purchase_order_id: string | null; zone: string | null };

const STATUS_OPTIONS = [
  { value: 'active', label: 'Active' },
  { value: 'completed', label: 'Completed' },
  { value: 'cancelled', label: 'Cancelled' },
];
const SORT_OPTIONS = [
  { value: 'created_desc', label: 'Newest first' },
  { value: 'created_asc', label: 'Oldest first' },
  { value: 'name_asc', label: 'Name (A–Z)' },
  { value: 'progress_desc', label: 'Progress (Highest first)' },
  { value: 'progress_asc', label: 'Progress (Lowest first)' },
  { value: 'sites_desc', label: 'Sites (Most first)' },
  { value: 'work_orders_desc', label: 'Work Orders (Most first)' },
];
const PAGE_SIZE_OPTIONS = [10, 20, 50, 100];
const emptyForm = { name: '', description: '', start_date: '', end_date: '', status: 'active' as Campaign['status'] };

type CampaignRow = {
  campaign: Campaign;
  poRows: ClientCampaignRow[];
  poCount: number;
  siteTotal: number;
  pct: number | null;
  agencyNames: string[];
  agencyIds: string[];
  zones: string[];
};

// Campaigns — the top of the client's flow, exactly as asked: decide what
// campaign to run FIRST, then open it to add the PO(s) under it (each PO
// deciding which agency it goes to) — see ClientCampaignDetailPage.tsx.
// A campaign is purely a client-owned grouping; it's never visible to,
// or editable by, any agency.
//
// Redesigned as a dense, filterable list (rather than a card grid) so a
// client managing 1000+ campaigns can actually scan and locate one —
// every campaign row can be expanded in place to see its Work Orders
// (agency, sites, progress, status) without leaving the list, or opened
// fully via "Open Campaign" for the complete detail view.
export default function ClientCampaignsPage() {
  const { profile } = useAuth();
  const orgId = profile?.organization_id;
  const queryClient = useQueryClient();

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [agencyFilter, setAgencyFilter] = useState('');
  const [zoneFilter, setZoneFilter] = useState('');
  const [sortBy, setSortBy] = useState('created_desc');
  const [filterDrawerOpen, setFilterDrawerOpen] = useState(false);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(20);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [modalOpen, setModalOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Campaign | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Campaign | null>(null);
  const [form, setForm] = useState(emptyForm);

  const { data: campaigns, isLoading } = useQuery({
    queryKey: ['client-campaigns', orgId],
    queryFn: async () => {
      const { data, error } = await supabase.from('campaigns').select('*').eq('client_org_id', orgId).order('created_at', { ascending: false });
      if (error) throw error;
      return data as Campaign[];
    },
    enabled: !!orgId,
    refetchInterval: 30000,
  });

  const { data: pos } = useQuery({
    queryKey: ['client-campaigns-pos-rollup', orgId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('purchase_orders')
        .select('*, agency_org:organizations!purchase_orders_assigned_agency_id_fkey(name)')
        .eq('client_org_id', orgId);
      if (error) throw error;
      return data as PoRow[];
    },
    enabled: !!orgId,
    refetchInterval: 30000,
  });

  const { data: shops } = useQuery({
    queryKey: ['client-campaigns-shops-rollup', orgId],
    queryFn: async () => {
      const { data, error } = await supabase.from('shops').select('id, status, purchase_order_id, zone');
      if (error) throw error;
      return data as ShopRow[];
    },
    enabled: !!orgId,
    refetchInterval: 30000,
  });

  const { data: progress } = useQuery({
    queryKey: ['client-campaigns-progress-rollup', orgId],
    queryFn: async () => {
      const { data, error } = await supabase.from('v_client_po_line_item_progress').select('*').eq('client_org_id', orgId);
      if (error) throw error;
      return data as ClientPOLineItemProgress[];
    },
    enabled: !!orgId,
    refetchInterval: 30000,
  });

  useClientRealtimeInvalidate(orgId, [
    ['client-campaigns-pos-rollup', orgId],
    ['client-campaigns-shops-rollup', orgId],
    ['client-campaigns-progress-rollup', orgId],
  ]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const payload = {
        name: form.name.trim(),
        description: form.description.trim() || null,
        start_date: form.start_date || null,
        end_date: form.end_date || null,
        status: form.status,
      };
      if (editTarget) {
        const { error } = await supabase.from('campaigns').update(payload).eq('id', editTarget.id);
        if (error) throw error;
        await logAudit('campaigns', editTarget.id, 'update', null, null, null, `Edited campaign "${payload.name}"`);
      } else {
        const { data, error } = await supabase.from('campaigns').insert({ ...payload, client_org_id: orgId, created_by: profile?.id }).select().single();
        if (error) throw error;
        await logAudit('campaigns', data.id, 'insert', null, null, null, `Created campaign "${payload.name}"`);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['client-campaigns', orgId] });
      closeModal();
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (campaign: Campaign) => {
      const { error } = await supabase.from('campaigns').delete().eq('id', campaign.id);
      if (error) throw error;
      await logAudit('campaigns', campaign.id, 'delete', null, null, null, `Deleted campaign "${campaign.name}"`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['client-campaigns', orgId] });
      setDeleteTarget(null);
    },
  });

  function openCreate() {
    setEditTarget(null);
    setForm(emptyForm);
    setModalOpen(true);
  }
  function openEdit(c: Campaign) {
    setEditTarget(c);
    setForm({ name: c.name, description: c.description || '', start_date: c.start_date || '', end_date: c.end_date || '', status: c.status });
    setModalOpen(true);
  }
  function closeModal() {
    setModalOpen(false);
    setEditTarget(null);
    setForm(emptyForm);
  }
  function toggleExpand(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const poRowsByCampaign = useMemo(() => {
    const map = new Map<string, PoRow[]>();
    for (const po of pos || []) {
      if (!po.campaign_id) continue;
      const arr = map.get(po.campaign_id) || [];
      arr.push(po);
      map.set(po.campaign_id, arr);
    }
    return map;
  }, [pos]);

  const rows: CampaignRow[] = useMemo(() => {
    return (campaigns || []).map((c) => {
      const wos = poRowsByCampaign.get(c.id) || [];
      const poIds = new Set(wos.map((p) => p.id));
      const poRows = buildClientCampaignRows(wos, shops || [], progress || []);

      const siteTotal = poRows.reduce((s, r) => s + r.sites_total, 0);
      let weightedSum = 0, weightBase = 0;
      for (const r of poRows) {
        if (r.completion_pct == null) continue;
        const weight = r.sites_total > 0 ? r.sites_total : 1;
        weightedSum += r.completion_pct * weight;
        weightBase += weight;
      }
      const pct = weightBase > 0 ? weightedSum / weightBase : null;

      const zones = new Set<string>();
      for (const s of shops || []) {
        if (s.purchase_order_id && poIds.has(s.purchase_order_id) && s.zone) zones.add(s.zone);
      }

      const agencyIds = Array.from(new Set(wos.filter((p) => p.assigned_agency_id).map((p) => p.assigned_agency_id as string)));
      const agencyNames = Array.from(new Set(poRows.map((r) => r.agency_name))).filter((n) => n && n !== 'Unassigned');

      return { campaign: c, poRows, poCount: wos.length, siteTotal, pct, agencyNames, agencyIds, zones: Array.from(zones) };
    });
  }, [campaigns, poRowsByCampaign, shops, progress]);

  const agencyOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const po of pos || []) {
      if (po.assigned_agency_id) map.set(po.assigned_agency_id, po.agency_org?.name || 'Agency');
    }
    return Array.from(map.entries()).sort((a, b) => a[1].localeCompare(b[1]));
  }, [pos]);

  const zoneOptions = useMemo(
    () => Array.from(new Set((shops || []).map((s) => s.zone).filter((z): z is string => !!z))).sort(),
    [shops]
  );

  const filteredRows = rows.filter(({ campaign: c, agencyIds, zones }) => {
    if (search) {
      const haystack = [c.name, c.description || ''].join(' ').toLowerCase();
      if (!haystack.includes(search.toLowerCase())) return false;
    }
    if (statusFilter && c.status !== statusFilter) return false;
    if (agencyFilter && !agencyIds.includes(agencyFilter)) return false;
    if (zoneFilter && !zones.includes(zoneFilter)) return false;
    return true;
  });

  const sortedRows = [...filteredRows].sort((a, b) => {
    switch (sortBy) {
      case 'created_asc':
        return new Date(a.campaign.created_at).getTime() - new Date(b.campaign.created_at).getTime();
      case 'name_asc':
        return a.campaign.name.localeCompare(b.campaign.name);
      case 'progress_desc':
        return (b.pct ?? -1) - (a.pct ?? -1);
      case 'progress_asc':
        return (a.pct ?? 101) - (b.pct ?? 101);
      case 'sites_desc':
        return b.siteTotal - a.siteTotal;
      case 'work_orders_desc':
        return b.poCount - a.poCount;
      case 'created_desc':
      default:
        return new Date(b.campaign.created_at).getTime() - new Date(a.campaign.created_at).getTime();
    }
  });

  useEffect(() => {
    setPage(0);
  }, [search, statusFilter, agencyFilter, zoneFilter, sortBy]);

  const totalPages = Math.max(1, Math.ceil(sortedRows.length / pageSize));
  const safePage = Math.min(page, totalPages - 1);
  const pagedRows = sortedRows.slice(safePage * pageSize, safePage * pageSize + pageSize);

  const activeFilterCount = [search, statusFilter, agencyFilter, zoneFilter].filter(Boolean).length;

  const kpi = useMemo(() => {
    const total = rows.length;
    const active = rows.filter((r) => r.campaign.status === 'active').length;
    const workOrders = rows.reduce((s, r) => s + r.poCount, 0);
    const sites = rows.reduce((s, r) => s + r.siteTotal, 0);
    return { total, active, workOrders, sites };
  }, [rows]);

  return (
    <div>
      <PageHeader
        title="Campaigns"
        subtitle="Decide what campaign to run, then add the Work Order(s) under it and pick which agency each one goes to"
        action={
          <button onClick={openCreate} className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2.5 rounded-lg font-medium text-sm shadow-sm shadow-blue-600/20 transition">
            <Plus className="w-4 h-4" /> New Campaign
          </button>
        }
      />

      {/* KPI strip — a fast, at-a-glance summary before scanning 1000+ rows */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
        <KpiCard icon={<Megaphone className="w-4.5 h-4.5" />} iconClass="bg-violet-50 text-violet-600" label="Total Campaigns" value={kpi.total.toLocaleString('en-IN')} />
        <KpiCard icon={<PlayCircle className="w-4.5 h-4.5" />} iconClass="bg-blue-50 text-blue-600" label="Active" value={kpi.active.toLocaleString('en-IN')} />
        <KpiCard icon={<ShoppingCart className="w-4.5 h-4.5" />} iconClass="bg-amber-50 text-amber-600" label="Work Orders" value={kpi.workOrders.toLocaleString('en-IN')} />
        <KpiCard icon={<Store className="w-4.5 h-4.5" />} iconClass="bg-emerald-50 text-emerald-600" label="Total Sites" value={kpi.sites.toLocaleString('en-IN')} />
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-5">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search campaigns by name or description..."
            className="w-full pl-9 pr-3 py-2.5 border border-slate-300 rounded-lg text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <select value={sortBy} onChange={(e) => setSortBy(e.target.value)} className="px-3 py-2.5 border border-slate-300 rounded-lg text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500">
          {SORT_OPTIONS.map((o) => <option key={o.value} value={o.value}>Sort: {o.label}</option>)}
        </select>
        <FilterButton activeCount={activeFilterCount} onClick={() => setFilterDrawerOpen(true)} />
        {activeFilterCount > 0 && (
          <span className="text-xs text-slate-400">{filteredRows.length.toLocaleString('en-IN')} of {rows.length.toLocaleString('en-IN')} shown</span>
        )}
      </div>

      <FilterDrawer
        open={filterDrawerOpen}
        onClose={() => setFilterDrawerOpen(false)}
        onClear={() => { setSearch(''); setStatusFilter(''); setAgencyFilter(''); setZoneFilter(''); }}
        activeCount={activeFilterCount}
        resultCount={filteredRows.length}
        resultLabel="campaigns"
      >
        <FilterSection label="Status">
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500">
            <option value="">All Statuses</option>
            {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </FilterSection>
        {agencyOptions.length > 0 && (
          <FilterSection label="Agency">
            <select value={agencyFilter} onChange={(e) => setAgencyFilter(e.target.value)} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500">
              <option value="">All Agencies ({agencyOptions.length})</option>
              {agencyOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </select>
          </FilterSection>
        )}
        {zoneOptions.length > 0 && (
          <FilterSection label="Zone">
            <select value={zoneFilter} onChange={(e) => setZoneFilter(e.target.value)} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500">
              <option value="">All Zones ({zoneOptions.length})</option>
              {zoneOptions.map((z) => <option key={z} value={z}>{z}</option>)}
            </select>
          </FilterSection>
        )}
      </FilterDrawer>

      {/* Column legend — only worth showing once there's something to scan */}
      {!isLoading && sortedRows.length > 0 && (
        <div className="hidden lg:flex items-center gap-6 px-5 mb-2 text-[11px] font-medium text-slate-400 uppercase tracking-wide">
          <span className="flex-1 min-w-0">Campaign</span>
          <span className="w-24 text-center">Work Orders</span>
          <span className="w-20 text-center">Sites</span>
          <span className="w-40">Progress</span>
          <span className="w-44">Agencies</span>
          <span className="w-16" />
        </div>
      )}

      <div className="space-y-3">
        {isLoading && (
          <>
            {[...Array(4)].map((_, i) => (
              <div key={i} className="h-24 rounded-xl border border-slate-200 bg-slate-50 animate-pulse" />
            ))}
          </>
        )}

        {!isLoading && pagedRows.map(({ campaign: c, poRows, poCount, siteTotal, pct, agencyNames }) => {
          const isOpen = expanded.has(c.id);
          return (
            <Card key={c.id} className="overflow-hidden hover:border-blue-300 hover:shadow-md transition">
              <div className="p-4 lg:p-5">
                <div className="flex flex-wrap lg:flex-nowrap items-center gap-4 lg:gap-6">
                  {/* Campaign identity */}
                  <button
                    onClick={() => toggleExpand(c.id)}
                    className="flex items-start gap-3 flex-1 min-w-0 text-left group"
                  >
                    <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-violet-50 to-violet-100 flex items-center justify-center shrink-0 mt-0.5">
                      <Megaphone className="w-5 h-5 text-violet-600" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold text-slate-900 group-hover:text-blue-700 transition truncate">{c.name}</span>
                        <CampaignStatusBadge status={c.status} />
                      </div>
                      {c.description && <p className="text-xs text-slate-500 mt-0.5 line-clamp-1 max-w-md">{c.description}</p>}
                      {(c.start_date || c.end_date) && (
                        <p className="text-xs text-slate-400 mt-1 flex items-center gap-1">
                          <Calendar className="w-3 h-3" />
                          {c.start_date ? new Date(c.start_date).toLocaleDateString('en-IN') : '—'} → {c.end_date ? new Date(c.end_date).toLocaleDateString('en-IN') : '—'}
                        </p>
                      )}
                    </div>
                  </button>

                  {/* Metrics */}
                  <div className="flex items-center justify-center w-24 shrink-0">
                    <div className="flex items-center gap-1.5 text-sm text-slate-700 font-medium">
                      <ShoppingCart className="w-3.5 h-3.5 text-slate-400" /> {poCount}
                    </div>
                  </div>
                  <div className="flex items-center justify-center w-20 shrink-0">
                    <div className="flex items-center gap-1.5 text-sm text-slate-700 font-medium">
                      <Store className="w-3.5 h-3.5 text-slate-400" /> {siteTotal}
                    </div>
                  </div>
                  <div className="w-full lg:w-40 shrink-0">
                    <div className="flex items-center justify-between text-xs text-slate-400 mb-1">
                      <span className="lg:hidden">Progress</span><span>{pct != null ? `${Math.round(pct)}%` : '—'}</span>
                    </div>
                    <ProgressBar pct={pct} />
                  </div>
                  <div className="w-full lg:w-44 shrink-0">
                    {agencyNames.length > 0 ? (
                      <div className="flex flex-wrap gap-1">
                        {agencyNames.slice(0, 2).map((name) => (
                          <span key={name} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 text-[11px] font-medium max-w-[110px] truncate">
                            <Building2 className="w-3 h-3 shrink-0" /> <span className="truncate">{name}</span>
                          </span>
                        ))}
                        {agencyNames.length > 2 && (
                          <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 text-[11px] font-medium">
                            +{agencyNames.length - 2} more
                          </span>
                        )}
                      </div>
                    ) : (
                      <span className="text-xs text-slate-300">—</span>
                    )}
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-1 shrink-0 ml-auto lg:ml-0">
                    <button onClick={() => openEdit(c)} title="Edit campaign" className="p-1.5 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-md transition"><Pencil className="w-3.5 h-3.5" /></button>
                    <button onClick={() => setDeleteTarget(c)} title="Delete campaign" className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-md transition"><Trash2 className="w-3.5 h-3.5" /></button>
                    <button
                      onClick={() => toggleExpand(c.id)}
                      title={isOpen ? 'Hide Work Orders' : 'Show Work Orders'}
                      className="p-1.5 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-md transition"
                    >
                      <ChevronDown className={`w-4 h-4 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
                    </button>
                  </div>
                </div>

                <div className="flex items-center justify-between mt-3 pt-3 border-t border-slate-100">
                  <button onClick={() => toggleExpand(c.id)} className="text-xs text-slate-500 hover:text-slate-800 font-medium flex items-center gap-1">
                    <Layers className="w-3.5 h-3.5" /> {isOpen ? 'Hide' : 'View'} {poCount} Work Order{poCount === 1 ? '' : 's'}
                  </button>
                  <Link to={`/client/campaigns/${c.id}`} className="text-xs text-blue-600 hover:text-blue-700 font-semibold flex items-center gap-1">
                    Open Campaign <ArrowUpRight className="w-3.5 h-3.5" />
                  </Link>
                </div>
              </div>

              {/* Work Orders dropdown */}
              {isOpen && (
                <div className="border-t border-slate-100 bg-slate-50/70 px-4 lg:px-5 py-3">
                  {poRows.length === 0 ? (
                    <p className="text-xs text-slate-400 py-2 text-center">No Work Orders added under this campaign yet.</p>
                  ) : (
                    <div className="space-y-2">
                      {poRows.map((r) => (
                        <Link
                          key={r.po_id}
                          to={`/client/campaigns/${c.id}/po/${r.po_id}`}
                          className="flex flex-wrap items-center gap-x-5 gap-y-2 bg-white border border-slate-200 hover:border-blue-300 rounded-lg px-3.5 py-2.5 transition"
                        >
                          <div className="min-w-[130px]">
                            {r.name && <p className="text-sm font-semibold text-slate-800">{r.name}</p>}
                            <p className={r.name ? 'text-[11px] text-slate-400' : 'text-sm font-semibold text-slate-800'}>{r.po_number}</p>
                            <p className="text-[11px] text-slate-400">{new Date(r.po_date).toLocaleDateString('en-IN')}</p>
                          </div>
                          <div className="min-w-[130px] flex items-center gap-1.5 text-xs text-slate-600">
                            <Building2 className="w-3.5 h-3.5 text-slate-400 shrink-0" /> <span className="truncate">{r.agency_name}</span>
                          </div>
                          <div className="min-w-[70px] flex items-center gap-1.5 text-xs text-slate-600">
                            <Store className="w-3.5 h-3.5 text-slate-400" /> {r.sites_total}
                          </div>
                          <div className="min-w-[130px] flex-1 max-w-[180px]">
                            <div className="flex items-center justify-between text-[11px] text-slate-400 mb-0.5">
                              <span>Work Done</span><span>{r.completion_pct != null ? `${Math.round(r.completion_pct)}%` : '—'}</span>
                            </div>
                            <ProgressBar pct={r.completion_pct} />
                          </div>
                          <span className={`px-2 py-0.5 rounded-full text-[11px] font-medium ${CLIENT_PO_WORK_STATUS_COLORS[r.work_status]}`}>
                            {CLIENT_PO_WORK_STATUS_LABELS[r.work_status]}
                          </span>
                          <ArrowRight className="w-3.5 h-3.5 text-slate-300 ml-auto" />
                        </Link>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </Card>
          );
        })}

        {!isLoading && sortedRows.length === 0 && (
          <Card>
            <EmptyState
              icon={<Megaphone className="w-12 h-12" />}
              title={campaigns && campaigns.length > 0 ? 'No campaigns match these filters' : 'No campaigns yet'}
              subtitle={campaigns && campaigns.length > 0 ? 'Try clearing a filter' : 'Create your first campaign, then add Work Orders under it'}
            />
          </Card>
        )}
      </div>

      {!isLoading && sortedRows.length > 0 && (
        <Card className="mt-3">
          <Pagination
            page={safePage}
            pageSize={pageSize}
            totalItems={sortedRows.length}
            onPageChange={setPage}
            onPageSizeChange={(n) => { setPageSize(n); setPage(0); }}
            pageSizeOptions={PAGE_SIZE_OPTIONS}
            itemLabel="campaigns"
          />
        </Card>
      )}

      <Modal open={modalOpen} onClose={closeModal} title={editTarget ? 'Edit Campaign' : 'New Campaign'} size="md">
        <div className="space-y-4">
          <Input label="Campaign Name" value={form.name} onChange={(v) => setForm({ ...form, name: v })} placeholder="e.g. Diwali 2026 Signage Drive" required />
          <Textarea label="Description" value={form.description} onChange={(v) => setForm({ ...form, description: v })} placeholder="What is this campaign for?" />
          <div className="grid grid-cols-2 gap-4">
            <Input label="Start Date" type="date" value={form.start_date} onChange={(v) => setForm({ ...form, start_date: v })} />
            <Input label="End Date" type="date" value={form.end_date} onChange={(v) => setForm({ ...form, end_date: v })} />
          </div>
          {editTarget && (
            <Select label="Status" value={form.status} onChange={(v) => setForm({ ...form, status: v as Campaign['status'] })} options={STATUS_OPTIONS} />
          )}

          {saveMutation.isError && <p className="text-sm text-red-600">{(saveMutation.error as Error).message}</p>}

          <button
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending || !form.name.trim()}
            className="w-full flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-700 text-white font-medium py-2.5 rounded-lg transition disabled:opacity-50"
          >
            {saveMutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
            {saveMutation.isPending ? 'Saving...' : editTarget ? 'Save Changes' : 'Create Campaign'}
          </button>
        </div>
      </Modal>

      <ConfirmDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => deleteTarget && deleteMutation.mutate(deleteTarget)}
        title="Delete this campaign?"
        message={`This deletes "${deleteTarget?.name}". Any Work Orders already added under it stay exactly as they are — they just won't be grouped under a campaign anymore.`}
        confirmLabel={deleteMutation.isPending ? 'Deleting...' : 'Delete'}
        danger
      />
    </div>
  );
}

function KpiCard({ icon, iconClass, label, value }: { icon: React.ReactNode; iconClass: string; label: string; value: string }) {
  return (
    <Card className="p-4 flex items-center gap-3">
      <div className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 ${iconClass}`}>{icon}</div>
      <div className="min-w-0">
        <p className="text-xl font-bold text-slate-900 leading-tight">{value}</p>
        <p className="text-xs text-slate-500 truncate">{label}</p>
      </div>
    </Card>
  );
}

function CampaignStatusBadge({ status }: { status: Campaign['status'] }) {
  const map: Record<Campaign['status'], { label: string; className: string; icon: React.ReactNode }> = {
    active: { label: 'Active', className: 'bg-blue-100 text-blue-700', icon: <PlayCircle className="w-3 h-3" /> },
    completed: { label: 'Completed', className: 'bg-emerald-100 text-emerald-700', icon: <CheckCircle2 className="w-3 h-3" /> },
    cancelled: { label: 'Cancelled', className: 'bg-slate-200 text-slate-600', icon: <Ban className="w-3 h-3" /> },
  };
  const { label, className, icon } = map[status] || map.active;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold shrink-0 ${className}`}>
      {icon} {label}
    </span>
  );
}
