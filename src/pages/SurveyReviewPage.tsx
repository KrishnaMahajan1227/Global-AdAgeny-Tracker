import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNowStrict } from 'date-fns';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { Modal, Card, StatusBadge, EmptyState, Textarea } from '@/components/ui';
import { useRealtimeInvalidate } from '@/lib/useRealtimeInvalidate';
import { SurveyReviewGallery } from '@/components/SurveyReviewGallery';



import { CheckCircle2, FileText, ChevronRight, ChevronLeft, ChevronsLeft, ChevronsRight, SlidersHorizontal, Clock, Eye } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import { validWorkOrderId } from '@/lib/operationalNavigation';

import { reviewApply, refreshReviewViews } from '@/lib/reviewApi';
import { CompanyApprovalHandoff } from '@/components/CompanyApprovalHandoff';

// Debounce a fast-changing value (typing in the search box) so we don't
// fire a network request on every keystroke — same pattern Installation
// Review already uses, so both review queues feel identical to use.
function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

const TABS = [
  { key: 'pending', label: 'Pending Review' },
  { key: 'approved', label: 'Approved' },
  { key: 'declined', label: 'Rejected / Correction' },
] as const;
type TabKey = (typeof TABS)[number]['key'];

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100];

const SORT_OPTIONS: Record<string, string> = {
  submitted_asc: 'Oldest submitted first',
  submitted_desc: 'Newest submitted first',
  shop_asc: 'Shop name (A–Z)',
};

// A pending survey waiting longer than this is flagged, purely as a
// priority cue — never blocks anything, just helps a reviewer clear the
// oldest ones first instead of always working newest-first by habit.
const AGING_THRESHOLD_HOURS = 48;

// Each shop approval uses the existing atomic RPC. A bulk loop stops on failure.
async function approveSurvey(survey: any, designerId: string) {
  if (!designerId) throw new Error('Choose a designer before approving.');
  const result = await reviewApply({ stage: 'survey', shopId: survey.shop_id, refId: survey.id, decision: 'approved', designerId });
  if (!result.finalized) throw new Error(`${survey.shops?.name || 'Survey'}: ${result.redo} correction(s) and ${result.pending} pending item(s) still require review.`);
}

export default function SurveyReviewPage() {
  const [routeParams, setRouteParams] = useSearchParams();
  const linkedPoId = validWorkOrderId(routeParams.get('po'));
  const { profile } = useAuth();
  const orgId = profile?.organization_id;
  const queryClient = useQueryClient();

  const [tab, setTab] = useState<TabKey>('pending');
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search.trim(), 350);
  const [surveyorFilter, setSurveyorFilter] = useState('');
  const [clientFilter, setClientFilter] = useState('');
  const [workOrderFilter, setWorkOrderFilter] = useState(linkedPoId);
  useEffect(() => { setWorkOrderFilter(linkedPoId); }, [linkedPoId]);
  const [cityFilter, setCityFilter] = useState('');
  const [stateFilter, setStateFilter] = useState('');
  const [moreFilters, setMoreFilters] = useState(false);
  const [bulkPreviewId, setBulkPreviewId] = useState<string | null>(null);
  const [rejectConfirmation, setRejectConfirmation] = useState(false);
  const [sortBy, setSortBy] = useState<'submitted_asc' | 'submitted_desc' | 'shop_asc'>('submitted_asc');
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(PAGE_SIZE_OPTIONS[0]);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // The survey currently open in the review drawer. Opening it never
  // implies a decision — Admin/Owner sees every detail first, and only
  // picks approve/reject/correction inside the drawer once they've
  // actually looked.
  const [selectedSurvey, setSelectedSurvey] = useState<any | null>(null);
  const [note, setNote] = useState('');
  // Section 8 — adjustment note per work item, keyed by work_item.id, only
  // filled in when Admin/Owner chooses to explain a variance (never
  // required — exceeding budget is allowed, just never silent).

  const [bulkModalOpen, setBulkModalOpen] = useState(false);
  const [bulkDesignerId, setBulkDesignerId] = useState('');

  useEffect(() => { setPage(0); }, [tab, debouncedSearch, surveyorFilter, clientFilter, workOrderFilter, cityFilter, stateFilter, sortBy, pageSize]);
  useEffect(() => { setSelectedIds(new Set()); }, [tab, debouncedSearch, surveyorFilter, clientFilter, workOrderFilter, cityFilter, stateFilter, sortBy, page, pageSize]);

  const isPendingSurvey = selectedSurvey?.status === 'submitted';

  const closeDrawer = () => {
    setSelectedSurvey(null);
    setNote('');
    setRejectConfirmation(false);
  };

  const openReview = (survey: any) => {
    setSelectedSurvey(survey);
    setNote('');
  };

  // Who to hand the design task to on approval — fetched once at page
  // level (not per-drawer-open) so the exact same list backs both the
  // single-review drawer's picker and the bulk-approve modal's picker.
  const { data: designers } = useQuery({
    queryKey: ['org-designers', orgId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, full_name')
        .eq('organization_id', orgId)
        .eq('role', 'designer')
        .eq('is_active', true)
        .order('full_name');
      if (error) throw new Error(`Could not load designers: ${error.message}`);
      return data as { id: string; full_name: string }[];
    },
    enabled: !!orgId,
  });

  const { data: availableFilters } = useQuery({
    queryKey: ['survey-review-options', orgId],
    queryFn: async () => {
      const shops: { client_id: string; city: string | null; state: string | null; clients: any }[] = [];
      for (let offset = 0; ; offset += 1000) {
        const { data, error } = await supabase.from('shops').select('client_id,city,state,clients(name)').eq('organization_id', orgId).range(offset, offset + 999);
        if (error) throw error;
        shops.push(...((data || []) as typeof shops));
        if (!data || data.length < 1000) break;
      }
      const purchaseOrders: { id: string; name: string | null; po_number: string; client_id: string }[] = [];
      for (let offset = 0; ; offset += 1000) {
        const { data, error } = await supabase.from('purchase_orders').select('id,name,po_number,client_id').eq('organization_id', orgId).range(offset, offset + 999);
        if (error) throw error;
        purchaseOrders.push(...((data || []) as typeof purchaseOrders));
        if (!data || data.length < 1000) break;
      }
      const clients = new Map<string, string>();
      for (const shop of shops) if (shop.client_id) clients.set(shop.client_id, (shop.clients as any)?.name || 'Unnamed client');
      return {
        clients: [...clients].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
        orders: purchaseOrders.sort((a, b) => (a.name || a.po_number).localeCompare(b.name || b.po_number)),
        cities: [...new Set(shops.map(s => s.city).filter((v): v is string => !!v))].sort(),
        states: [...new Set(shops.map(s => s.state).filter((v): v is string => !!v))].sort(),
      };
    }, enabled: !!orgId, staleTime: 300000,
  });

  const { data: surveyors } = useQuery({
    queryKey: ['survey-review-surveyors', orgId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('profiles').select('id, full_name')
        .eq('organization_id', orgId).eq('role', 'surveyor').eq('is_active', true)
        .order('full_name');
      if (error) throw new Error(error.message);
      return data as { id: string; full_name: string }[];
    },
    enabled: !!orgId,
  });

  const statusesForTab = (t: TabKey) => (t === 'pending' ? ['submitted'] : t === 'approved' ? ['approved'] : ['rejected', 'correction_requested']);

  // One cheap count per tab so the tab bar always shows accurate totals,
  // independent of whatever filters/page are currently active.
  const countsQueryKey = ['survey-review-counts', orgId];
  const { data: statusCounts } = useQuery({
    queryKey: countsQueryKey,
    queryFn: async () => {
      const counts: Record<TabKey, number> = { pending: 0, approved: 0, declined: 0 };
      await Promise.all(TABS.map(async ({ key }) => {
        const { count } = await supabase.from('surveys').select('id', { count: 'exact', head: true })
          .eq('organization_id', orgId).in('status', statusesForTab(key));
        counts[key] = count || 0;
      }));
      return counts;
    },
    enabled: !!orgId,
  });

  // The list itself — server-filtered, server-sorted, server-paginated,
  // exactly like Installation Review, so this stays fast and correct
  // whether an org has 20 surveys or 20,000.
  const surveysQueryKey = ['surveys-review', orgId, { tab, q: debouncedSearch, surveyorFilter, clientFilter, workOrderFilter, cityFilter, stateFilter, sortBy, page, pageSize }];
  const { data: surveysPage, isFetching: surveysLoading, error: surveysError } = useQuery({
    queryKey: surveysQueryKey,
    queryFn: async () => {
      let query = supabase
        .from('surveys')
        // `surveys` has TWO foreign keys into `profiles` (surveyor_id AND
        // reviewed_by) — naming the FK column (`profiles:surveyor_id`)
        // resolves the otherwise-ambiguous embed.
        .select('*, shops!inner(name, city, state, client_id, status, purchase_order_id, clients(name), purchase_orders(name,po_number)), profiles:surveyor_id(full_name)', { count: 'exact' })
        .eq('organization_id', orgId)
        .in('status', statusesForTab(tab));
      // A shop already past survey (design/production/installation/done) can never sit in Pending Survey Review.
      if (tab === 'pending') query = query.not('shops.status', 'in', '(design_pending,designing,design_ready,in_review,design_approved,production_pending,in_production,production_ready,production_hold,production_done,dispatched,installation_pending,installing,installation_review,installed,billed,cancelled)');

      if (surveyorFilter) query = query.eq('surveyor_id', surveyorFilter);
      if (clientFilter) query = query.eq('shops.client_id', clientFilter);
      if (workOrderFilter) query = query.eq('shops.purchase_order_id', workOrderFilter);
      if (cityFilter) query = query.eq('shops.city', cityFilter);
      if (stateFilter) query = query.eq('shops.state', stateFilter);
      if (debouncedSearch) {
        const term = debouncedSearch.replace(/[%,()]/g, '');
        query = query.or(`name.ilike.%${term}%,city.ilike.%${term}%`, { referencedTable: 'shops' });
      }

      if (sortBy === 'shop_asc') {
        query = query.order('name', { referencedTable: 'shops', ascending: true });
      } else {
        const dateField = tab === 'pending' ? 'submitted_at' : 'reviewed_at';
        query = query.order(dateField, { ascending: sortBy === 'submitted_asc', nullsFirst: false });
      }

      const from = page * pageSize;
      const to = from + pageSize - 1;
      const { data, error, count } = await query.range(from, to);
      if (error) throw new Error(`Could not load surveys: ${error.message}`);
      return { rows: data || [], total: count || 0 };
    },
    enabled: !!orgId,
    placeholderData: (prev) => prev,
  });

  const rows = surveysPage?.rows || [];
  const total = surveysPage?.total || 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const rangeStart = total === 0 ? 0 : page * pageSize + 1;
  const rangeEnd = Math.min(total, page * pageSize + pageSize);
  const hasActiveFilters = !!(search || surveyorFilter || clientFilter || workOrderFilter || cityFilter || stateFilter);

  // A survey submitted from a surveyor's phone should appear here live,
  // without the Admin/Owner needing to already have this tab closed and
  // reopened.
  useRealtimeInvalidate(['surveys'], orgId, [surveysQueryKey, countsQueryKey, ['dashboard-stats', orgId]]);

  function invalidateAll() {
    void refreshReviewViews(queryClient);
    queryClient.invalidateQueries({ queryKey: ['surveys-review'] });
    queryClient.invalidateQueries({ queryKey: countsQueryKey });
    queryClient.invalidateQueries({ queryKey: ['design-task-list'] });
    queryClient.invalidateQueries({ queryKey: ['design-task-stats'] });
    queryClient.invalidateQueries({ queryKey: ['shops'] });
    // The sidebar's "Survey Review" badge count lives in its own query
    // (AdminLayout's `nav-pending-counts`), separate from this page's own
    // list — invalidate it here too so both always agree the moment an
    // action completes instead of the badge lagging behind.
    queryClient.invalidateQueries({ queryKey: ['nav-pending-counts', orgId] });
  }

  const rejectMutation = useMutation({
    mutationFn: async () => {
      if (!selectedSurvey || !note.trim()) throw new Error('Enter the reason for final rejection.');
      const { error } = await supabase.rpc('reject_survey_shop_final', { p_survey_id: selectedSurvey.id, p_reason: note.trim() });
      if (error) throw error;
    },
    onSuccess: () => { invalidateAll(); closeDrawer(); },
  });

  // One active designer is a deterministic default; multiple designers require an explicit selection.
  const effectiveBulkDesignerId = bulkDesignerId || (designers?.length === 1 ? designers[0].id : '');

  const bulkMutation = useMutation({
    mutationFn: async () => {
      const targets = rows.filter(r => selectedIds.has(r.id));
      if (!targets.length) throw new Error('Select at least one survey.');
      if (!effectiveBulkDesignerId) throw new Error('Choose a designer before approving selected surveys.');
      const completed: string[] = [];
      for (const survey of targets) {
        try {
          await approveSurvey(survey, effectiveBulkDesignerId);
          completed.push(survey.id);
        } catch (error) {
          setSelectedIds(prev => new Set([...prev].filter(id => !completed.includes(id))));
          throw error;
        }
      }
    },
    onSuccess: () => { invalidateAll(); setBulkModalOpen(false); setSelectedIds(new Set()); setBulkDesignerId(''); setBulkPreviewId(null); },
    onError: () => { invalidateAll(); },
  });

  function toggleSelected(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function openBulk() {
    setBulkDesignerId('');
    setBulkPreviewId(null);
    setBulkModalOpen(true);
  }

  const selectedSurveys = rows.filter((r) => selectedIds.has(r.id));

  // Confirm is locked until a decision is actually made, and — for
  // reject/correction — until there's a note, since "declined, no reason
  // given" leaves the surveyor with nothing to act on.
  const canConfirmBulk = !!effectiveBulkDesignerId && selectedSurveys.length > 0;

  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-2"><h1 className="text-lg font-semibold text-slate-900">Survey Review</h1><span className="text-xs text-slate-500">{statusCounts?.pending ?? '…'} pending</span></div>

      {linkedPoId && <div role="status" className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-900"><span>Survey review filtered to the selected Work Order</span><button type="button" className="font-semibold text-blue-700 underline" onClick={() => setRouteParams(previous => { const next = new URLSearchParams(previous); next.delete('po'); return next; }, { replace: true })}>Show all surveys</button></div>}
      {/* Status tabs */}
      <div className="flex items-center gap-1.5 mb-4 border-b border-slate-200">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-3.5 py-2 text-sm font-medium border-b-2 -mb-px transition ${
              tab === t.key ? 'border-blue-600 text-blue-700' : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            {t.label}
            <span className={`ml-1.5 inline-flex items-center justify-center min-w-[1.25rem] px-1 rounded-full text-[11px] ${
              tab === t.key ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-500'
            }`}>
              {statusCounts?.[t.key] ?? '—'}
            </span>
          </button>
        ))}
      </div>

      {tab === 'pending' && selectedIds.size > 0 && (
        <div className="mb-2 flex flex-wrap items-center gap-3 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2">
          <p className="mr-auto text-xs font-semibold text-blue-900">{selectedIds.size} selected on this page</p>
          <button type="button" onClick={() => setSelectedIds(new Set())} className="text-xs text-blue-800 hover:underline">Clear</button>
          <button type="button" onClick={openBulk} className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white"><CheckCircle2 className="h-3.5 w-3.5" /> Review & approve selected</button>
        </div>
      )}

      {/* Filters — same set works across all three tabs, so lookups stay
          fast even months later when there's a long history to sort through. */}
      <Card className="mb-3 px-3 py-2.5">
        <div className="flex flex-wrap items-end gap-2">
          <label className="min-w-[170px] flex-[2_1_220px] text-[11px] font-medium text-slate-600">Search shop or city
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search surveys…" className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm focus-visible:ring-2 focus-visible:ring-blue-500" />
          </label>
          <label className="min-w-[130px] flex-1 text-[11px] font-medium text-slate-600">Client
            <select value={clientFilter} onChange={e => { setClientFilter(e.target.value); setWorkOrderFilter(''); }} className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm"><option value="">All clients</option>{availableFilters?.clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
          </label>
          <label className="min-w-[145px] flex-1 text-[11px] font-medium text-slate-600">Work Order
            <select value={workOrderFilter} onChange={e => setWorkOrderFilter(e.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm"><option value="">All work orders</option>{availableFilters?.orders.filter(o => !clientFilter || o.client_id === clientFilter).map(o => <option key={o.id} value={o.id}>{o.name || o.po_number}</option>)}</select>
          </label>
          <button type="button" onClick={() => setMoreFilters(p => !p)} aria-expanded={moreFilters} className="mb-0.5 inline-flex items-center gap-1 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"><SlidersHorizontal className="h-3.5 w-3.5" />More filters{(cityFilter || stateFilter || surveyorFilter) ? ' •' : ''}</button>
          {hasActiveFilters && <button type="button" onClick={() => { setSearch(''); setClientFilter(''); setWorkOrderFilter(''); setCityFilter(''); setStateFilter(''); setSurveyorFilter(''); if (linkedPoId) setRouteParams(previous => { const next = new URLSearchParams(previous); next.delete('po'); return next; }, { replace: true }); }} className="mb-0.5 px-2 py-1.5 text-xs text-blue-700">Clear</button>}
        </div>
        {moreFilters && <div className="mt-2 grid grid-cols-2 gap-2 border-t border-slate-100 pt-2 sm:grid-cols-4">
          <label className="text-[11px] text-slate-600">City<select value={cityFilter} onChange={e => setCityFilter(e.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs"><option value="">All cities</option>{availableFilters?.cities.map(c => <option key={c} value={c}>{c}</option>)}</select></label>
          <label className="text-[11px] text-slate-600">State<select value={stateFilter} onChange={e => setStateFilter(e.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs"><option value="">All states</option>{availableFilters?.states.map(c => <option key={c} value={c}>{c}</option>)}</select></label>
          <label className="text-[11px] text-slate-600">Surveyor<select value={surveyorFilter} onChange={e => setSurveyorFilter(e.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs"><option value="">All surveyors</option>{(surveyors || []).map(s => <option key={s.id} value={s.id}>{s.full_name}</option>)}</select></label>
          <label className="text-[11px] text-slate-600">Sort<select value={sortBy} onChange={e => setSortBy(e.target.value as typeof sortBy)} className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs">{Object.entries(SORT_OPTIONS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        </div>}
        <p className="mt-2 text-[11px] text-slate-500">{total ? `${rangeStart}–${rangeEnd} of ${total.toLocaleString('en-IN')} surveys` : 'No matching surveys'}{surveysLoading ? ' · Updating…' : ''}</p>
      </Card>

      {surveysError && (
        <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-3 mb-4" role="alert">
          {(surveysError as Error).message}
        </p>
      )}

      {/* LISTING — a proper table, not cards: stays usable when an org has
          thousands of shops cycling through survey review, not just the
          first handful. */}
      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-500 text-xs uppercase tracking-wide border-b border-slate-200">
              <tr>
                {tab === 'pending' && <th className="w-10 px-3 py-2.5 text-left"><input aria-label="Select all surveys on this page" type="checkbox" className="h-4 w-4 accent-blue-600" checked={rows.length > 0 && rows.every(r => selectedIds.has(r.id))} onChange={e => setSelectedIds(e.target.checked ? new Set(rows.map(r => r.id)) : new Set())} /></th>}
                <th className="text-left px-3 py-2.5 font-medium">Shop</th>
                <th className="text-left px-3 py-2.5 font-medium">Client / City</th>
                <th className="text-left px-3 py-2.5 font-medium">Surveyor</th>
                <th className="text-left px-3 py-2.5 font-medium">{tab === 'pending' ? 'Submitted' : 'Reviewed'}</th>
                <th className="text-left px-3 py-2.5 font-medium">Status</th>
                {tab !== 'pending' && <th className="text-left px-3 py-2.5 font-medium">Note</th>}
                <th className="text-right px-3 py-2.5 font-medium">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((s) => {
                const dateStr = tab === 'pending' ? s.submitted_at : s.reviewed_at;
                const waitingHours = tab === 'pending' && s.submitted_at ? (Date.now() - new Date(s.submitted_at).getTime()) / 36e5 : 0;
                const isAging = tab === 'pending' && waitingHours > AGING_THRESHOLD_HOURS;
                return (
                  <tr
                    key={s.id}
                    className={`hover:bg-slate-50 transition ${selectedIds.has(s.id) ? 'bg-blue-50/60' : ''}`}

                  >
                    {tab === 'pending' && <td className="px-3 py-2.5 align-top"><input type="checkbox" aria-label={`Select ${s.shops?.name || 'survey'}`} checked={selectedIds.has(s.id)} onChange={() => toggleSelected(s.id)} className="h-4 w-4 accent-blue-600" /></td>}
                    <td className="px-3 py-3 align-top max-w-[220px]">
                      <p className="font-medium text-slate-900 truncate">{s.shops?.name}</p>
                      <Link to={`/shops/${s.shop_id}`} onClick={(e) => e.stopPropagation()} className="text-[11px] text-blue-600 hover:underline">
                        View shop
                      </Link>
                    </td>
                    <td className="px-3 py-3 align-top text-slate-500 whitespace-nowrap"><span className="block">{s.shops?.clients?.name || '—'} · {s.shops?.city || '—'}{s.shops?.state ? `, ${s.shops.state}` : ''}</span>{s.shops?.purchase_orders && <span className="block text-[11px] text-slate-400">{s.shops.purchase_orders.name || s.shops.purchase_orders.po_number}</span>}</td>
                    <td className="px-3 py-3 align-top text-slate-700 whitespace-nowrap">{s.profiles?.full_name || 'Unknown'}</td>
                    <td className="px-3 py-3 align-top text-slate-600 whitespace-nowrap">
                      {dateStr ? (
                        <div className="flex items-center gap-1.5">
                          <span>{new Date(dateStr).toLocaleString('en-IN', tab === 'pending' ? undefined : { dateStyle: 'medium' })}</span>
                          {isAging && (
                            <span title={`Waiting ${formatDistanceToNowStrict(new Date(dateStr))} for review`} className="inline-flex items-center gap-0.5 text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-1 py-0.5">
                              <Clock className="w-2.5 h-2.5" /> {formatDistanceToNowStrict(new Date(dateStr))}
                            </span>
                          )}
                        </div>
                      ) : '—'}
                    </td>
                    <td className="px-3 py-3 align-top"><StatusBadge status={s.status} /></td>
                    {tab !== 'pending' && (
                      <td className="px-3 py-3 align-top text-slate-500 max-w-[220px] truncate" title={s.review_note || ''}>{s.review_note || '—'}</td>
                    )}
                    <td className="px-3 py-3 align-top">
                      <div className="flex items-center justify-end gap-1.5" onClick={(e) => e.stopPropagation()}>
                        <button
                          onClick={() => openReview(s)}
                          className={`flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium border ${
                            tab === 'pending'
                              ? 'bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100'
                              : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'
                          }`}
                        >
                          {tab === 'pending' ? <><ChevronRight className="w-3.5 h-3.5" /> Review</> : <><Eye className="w-3.5 h-3.5" /> View</>}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {rows.length === 0 && !surveysLoading && (
          <EmptyState
            icon={<FileText className="w-12 h-12" />}
            title={tab === 'pending' ? 'No surveys pending review' : hasActiveFilters ? 'No surveys match these filters' : 'Nothing here yet'}
          />
        )}

        {total > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-t border-slate-100 bg-slate-50/60">
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <span>Rows per page</span>
              <select
                value={pageSize}
                onChange={(e) => setPageSize(Number(e.target.value))}
                className="px-2 py-1 border border-slate-300 rounded-md text-xs bg-white outline-none focus:ring-2 focus:ring-blue-500"
              >
                {PAGE_SIZE_OPTIONS.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
              <span className="ml-2 hidden sm:inline">{rangeStart}–{rangeEnd} of {total.toLocaleString('en-IN')}</span>
            </div>
            <div className="flex items-center gap-1">
              <button onClick={() => setPage(0)} disabled={page === 0} title="First page" className="p-1.5 rounded-md text-slate-500 hover:bg-white hover:text-blue-600 disabled:opacity-30 border border-transparent hover:border-slate-200">
                <ChevronsLeft className="w-4 h-4" />
              </button>
              <button onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0} title="Previous page" className="p-1.5 rounded-md text-slate-500 hover:bg-white hover:text-blue-600 disabled:opacity-30 border border-transparent hover:border-slate-200">
                <ChevronLeft className="w-4 h-4" />
              </button>
              <span className="text-xs text-slate-600 font-medium px-2 whitespace-nowrap">Page {page + 1} of {totalPages}</span>
              <button onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1} title="Next page" className="p-1.5 rounded-md text-slate-500 hover:bg-white hover:text-blue-600 disabled:opacity-30 border border-transparent hover:border-slate-200">
                <ChevronRight className="w-4 h-4" />
              </button>
              <button onClick={() => setPage(totalPages - 1)} disabled={page >= totalPages - 1} title="Last page" className="p-1.5 rounded-md text-slate-500 hover:bg-white hover:text-blue-600 disabled:opacity-30 border border-transparent hover:border-slate-200">
                <ChevronsRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}
      </Card>

      <Modal open={!!selectedSurvey} onClose={closeDrawer} size="xl" title={selectedSurvey?.shops?.name || 'Survey review'}>
        {selectedSurvey && <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-600">
            <StatusBadge status={selectedSurvey.status} />
            <span>{selectedSurvey.shops?.clients?.name || 'Unknown client'}</span>
            {selectedSurvey.shops?.purchase_orders && <span>· {selectedSurvey.shops.purchase_orders.name || selectedSurvey.shops.purchase_orders.po_number}</span>}
            <span>· {selectedSurvey.profiles?.full_name || 'Surveyor'}</span>
            {selectedSurvey.submitted_at && <span>· {new Date(selectedSurvey.submitted_at).toLocaleString('en-IN')}</span>}
          </div>
          {selectedSurvey.notes && <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">{selectedSurvey.notes}</p>}
          <CompanyApprovalHandoff stage="survey" refId={selectedSurvey.id} shopId={selectedSurvey.shop_id} />
          <SurveyReviewGallery surveyId={selectedSurvey.id} shopId={selectedSurvey.shop_id} readOnly={!isPendingSurvey} onDone={() => { invalidateAll(); closeDrawer(); }} />
          {isPendingSurvey ? <details className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
            <summary className="cursor-pointer font-medium">Final rejection (entire survey)</summary>
            <div className="mt-2 space-y-2">
              <p>Only use when the entire survey must be permanently rejected. For rework, select individual photos or measurements and use Redo.</p>
              <Textarea label="Reason for final rejection" value={note} onChange={setNote} placeholder="Reason required" rows={2} />
              <button type="button" onClick={() => setRejectConfirmation(true)} disabled={!note.trim() || rejectMutation.isPending} className="rounded-lg border border-red-200 bg-white px-3 py-1.5 text-xs font-semibold text-red-700 disabled:opacity-40">Reject entire survey…</button>
              {rejectConfirmation && <div role="alertdialog" aria-label="Confirm final rejection" className="flex flex-wrap items-center gap-2 rounded-lg border border-red-300 bg-white p-2 text-xs"><span className="mr-auto text-red-900">Final rejection cannot be handled as item redo. Confirm?</span><button type="button" onClick={() => setRejectConfirmation(false)} className="rounded px-2 py-1 text-slate-700">Cancel</button><button type="button" disabled={rejectMutation.isPending} onClick={() => rejectMutation.mutate()} className="rounded bg-red-700 px-2 py-1 text-white disabled:opacity-40">Confirm rejection</button></div>}
              {rejectMutation.isError && <p role="alert" className="text-red-700">{(rejectMutation.error as Error).message}</p>}
            </div>
          </details> : selectedSurvey.review_note && <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">Review note: {selectedSurvey.review_note}</p>}
        </div>}
      </Modal>

      <Modal open={bulkModalOpen} onClose={() => { if (!bulkMutation.isPending) { setBulkModalOpen(false); setBulkPreviewId(null); } }} title={`Review ${selectedSurveys.length} selected shops`} size="xl">
        <div className="space-y-3">
          <p className="text-xs text-slate-600">Check each shop's marked evidence before batch approval. Corrections must be assigned to exact items inside a single shop.</p>
          <div className="max-h-[40vh] space-y-2 overflow-y-auto pr-1">
            {selectedSurveys.map(s => <div key={s.id} className="rounded-lg border border-slate-200">
              <button type="button" onClick={() => setBulkPreviewId(bulkPreviewId === s.id ? null : s.id)} className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs"><span><strong className="font-semibold text-slate-800">{s.shops?.name}</strong><span className="ml-2 text-slate-500">{s.shops?.clients?.name} · {s.profiles?.full_name}</span></span><span className="shrink-0 text-blue-700">{bulkPreviewId === s.id ? 'Close evidence' : 'Review evidence'}</span></button>
              {bulkPreviewId === s.id && <div className="border-t border-slate-200 p-3"><SurveyReviewGallery surveyId={s.id} shopId={s.shop_id} readOnly /></div>}
            </div>)}
          </div>
          <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
            <label className="min-w-0 flex-1 text-xs text-slate-700">Assign designer to selected shops
              <select value={effectiveBulkDesignerId} onChange={e => setBulkDesignerId(e.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs"><option value="">Select designer</option>{(designers || []).map(d => <option key={d.id} value={d.id}>{d.full_name}</option>)}</select>
            </label>
            <button type="button" disabled={!canConfirmBulk || bulkMutation.isPending} onClick={() => bulkMutation.mutate()} className="rounded-lg bg-emerald-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-40">{bulkMutation.isPending ? 'Approving…' : `Approve ${selectedSurveys.length} shops`}</button>
          </div>
          {bulkMutation.isError && <p role="alert" className="text-xs text-red-700">{(bulkMutation.error as Error).message}. Successfully approved shops were removed from selection; retry only remaining shops.</p>}
        </div>
      </Modal>

    </div>
  );
}

// Full measurement breakdown for every work item on the survey, shown
// unconditionally in the review drawer — previously the only thing an
// Admin/Owner could see about what was actually measured was the PO
// budget panel below, which only renders line items tied to a purchase
// order. A shop with no PO (or items not linked to one) showed no
// measurements at all, so approval was effectively a decision made from
// photos alone.
