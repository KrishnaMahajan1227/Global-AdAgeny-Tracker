import { useEffect, useMemo, useRef, useState } from 'react';
import { itemSizeLabel } from '@/lib/units';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { Card, EmptyState, PageHeader, Modal, Textarea } from '@/components/ui';
import { MarkedPhotoGrid } from '@/components/MarkedPhotoGrid';
import { logAudit, createNotification } from '@/lib/helpers';
import { reviewApply, refreshReviewViews, setAvailability, type ReviewEntity } from '@/lib/reviewApi';
import { CompanyApprovalHandoff } from '@/components/CompanyApprovalHandoff';
import { ReviewBatchStepper } from '@/components/ReviewBatchStepper';
import { ReviewDecisionBar } from '@/components/ReviewDecisionBar';
import { decisionCounts, decisionTargets, nextUnqueued, validateShopDecision, type ShopDecisionMap, type ShopReviewDecision } from '@/lib/reviewDecisionQueue';
import { nextUnreviewedIndex, reviewedTargets, processReviewedBatch } from '@/lib/reviewBatchSafety';
import { useRealtimeInvalidate } from '@/lib/useRealtimeInvalidate';
import type { InstallationProof, SurveyPhoto, BoardMarking, WorkItem } from '@/lib/types';
import {
  CheckCircle2, XCircle, Wrench, AlertTriangle, Truck, Search, CheckSquare, Square,
  SlidersHorizontal, X, Eye, Loader2, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Images,
  Palette, Camera,
} from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import { validWorkOrderId } from '@/lib/operationalNavigation';

// Debounce a fast-changing value (typing in the search box) so we don't
// fire a network request on every keystroke — this list is meant to hold
// up to the same 10,000+ shop scale as the main Shops list.
function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

const PAGE_SIZE_OPTIONS = [20, 50, 100, 250];

const TABS = [
  { key: 'pending', label: 'Pending Review' },
  { key: 'approved', label: 'Installed (Approved)' },
  { key: 'rejected', label: 'Marked for Redo' },
] as const;
type TabKey = (typeof TABS)[number]['key'];

const SORT_OPTIONS: Record<string, string> = {
  completed_desc: 'Newest completed first',
  completed_asc: 'Oldest completed first',
  shop_asc: 'Shop name (A–Z)',
};

export default function InstallationReviewPage() {
  const [routeParams, setRouteParams] = useSearchParams();
  const linkedPoId = validWorkOrderId(routeParams.get('po'));
  const { profile } = useAuth();
  const orgId = profile?.organization_id;
  const queryClient = useQueryClient();

  const [tab, setTab] = useState<TabKey>('pending');
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search.trim(), 350);
  const [installerFilter, setInstallerFilter] = useState('');
  const [flagFilter, setFlagFilter] = useState<'' | 'gps' | 'material'>('');
  const [sortBy, setSortBy] = useState<'completed_desc' | 'completed_asc' | 'shop_asc'>('completed_desc');
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(PAGE_SIZE_OPTIONS[0]);

  const [selectMode, setSelectMode] = useState(true);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const [reviewModal, setReviewModal] = useState<any | null>(null);
  const [action, setAction] = useState<'approve' | 'reject'>('approve');
  const [note, setNote] = useState('');
  const [reopenForRedo, setReopenForRedo] = useState(false);
  const [correctionTargets, setCorrectionTargets] = useState<Record<string, { issue_type: 'work_item' | 'installation_photo'; work_item_id?: string; installation_proof_id?: string; note: string }>>({});

  const [bulkModalOpen, setBulkModalOpen] = useState(false);
  const [batchIndex, setBatchIndex] = useState(0);
  const batchTopRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (bulkModalOpen) batchTopRef.current?.scrollIntoView({ block: 'start', behavior: 'auto' });
  }, [batchIndex, bulkModalOpen]);
  const [inspectedIds, setInspectedIds] = useState<Set<string>>(new Set());
  const [evidenceReadyIds, setEvidenceReadyIds] = useState<Set<string>>(new Set());
  const [batchDecisions, setBatchDecisions] = useState<ShopDecisionMap>({});
  const [batchErrors, setBatchErrors] = useState<Record<string, string>>({});
  const [autoNext, setAutoNext] = useState(true);
  const [bulkNote, setBulkNote] = useState('');

  // Full-size photo preview — shared by row thumbnails, the review modal's
  // installation proofs, and the material-check photo, so any photo
  // anywhere on this page opens the same way.
  const [lightbox, setLightbox] = useState<string | null>(null);
  useEffect(() => {
    if (!lightbox) return;
    const onEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setLightbox(null); };
    window.addEventListener('keydown', onEscape);
    return () => window.removeEventListener('keydown', onEscape);
  }, [lightbox]);

  // Any filter/tab change invalidates page + selection — stale selections
  // pointing at rows that may no longer be in the result set are worse
  // than an empty one.
  useEffect(() => { setPage(0); }, [tab, debouncedSearch, installerFilter, flagFilter, linkedPoId, sortBy, pageSize]);
  useEffect(() => { setSelectMode(tab === 'pending'); setSelectedIds(new Set()); setInspectedIds(new Set()); setEvidenceReadyIds(new Set()); setBatchDecisions({}); setBatchIndex(0); }, [tab, debouncedSearch, installerFilter, flagFilter, linkedPoId, sortBy, page, pageSize]);

  const { data: installers } = useQuery({
    queryKey: ['installation-review-installers', orgId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('profiles').select('id, full_name')
        .eq('organization_id', orgId).eq('role', 'installer').eq('is_active', true)
        .order('full_name');
      if (error) throw new Error(error.message);
      return data as { id: string; full_name: string }[];
    },
    enabled: !!orgId,
    staleTime: 5 * 60 * 1000,
  });

  // One cheap count per tab so the tab bar always shows accurate totals,
  // independent of whatever filters/page are currently active.
  const countsQueryKey = ['installation-review-counts', orgId];
  const { data: statusCounts } = useQuery({
    queryKey: countsQueryKey,
    queryFn: async () => {
      const counts: Record<TabKey, number> = { pending: 0, approved: 0, rejected: 0 };
      await Promise.all(TABS.map(async ({ key }) => {
        const { count } = await supabase.from('installation_jobs').select('id', { count: 'exact', head: true })
          .eq('organization_id', orgId).eq('review_status', key);
        counts[key] = count || 0;
      }));
      return counts;
    },
    enabled: !!orgId,
  });

  // The list itself — server-filtered, server-sorted, server-paginated.
  // Nothing here ever pulls the whole table: at 10,000+ shops that would
  // make the page unusable, so every control on screen (tab, search,
  // installer, flag, sort, page) narrows the query itself.
  const jobsQueryKey = ['installation-review', orgId, { tab, q: debouncedSearch, installerFilter, flagFilter, linkedPoId, sortBy, page, pageSize }];
  const { data: jobsPage, isFetching: jobsLoading } = useQuery({
    queryKey: jobsQueryKey,
    queryFn: async () => {
      let query = supabase
        .from('installation_jobs')
        .select(
          '*, shops!inner(name, city, purchase_order_id, clients(name), purchase_orders(name,po_number)), profiles:installer_id(id, full_name), confirmed_by_profile:material_check_confirmed_by(full_name), installation_proofs(id, photo_url, storage_path, photo_type, angle, duplicate_flag, work_item_id)',
          { count: 'exact' }
        )
        .eq('organization_id', orgId)
        .eq('review_status', tab);
      // A finished shop can never sit in Pending Review.
      if (tab === 'pending') query = query.not('shops.status', 'in', '(installed,billed,cancelled)');

      if (linkedPoId) query = query.eq('shops.purchase_order_id', linkedPoId);
      if (installerFilter) query = query.eq('installer_id', installerFilter);
      if (flagFilter === 'gps') query = query.eq('gps_distance_flag', true);
      if (flagFilter === 'material') query = query.eq('material_check_confirmed', false);
      if (debouncedSearch) {
        const term = debouncedSearch.replace(/[%,()]/g, '');
        query = query.or(`name.ilike.%${term}%,city.ilike.%${term}%`, { referencedTable: 'shops' });
      }

      if (sortBy === 'shop_asc') {
        query = query.order('name', { referencedTable: 'shops', ascending: true });
      } else {
        query = query.order(tab === 'pending' ? 'completed_at' : 'reviewed_at', { ascending: sortBy === 'completed_asc', nullsFirst: false });
      }

      const from = page * pageSize;
      const to = from + pageSize - 1;
      const { data, error, count } = await query.range(from, to);
      if (error) throw new Error(error.message);
      return { rows: (data || []) as any[], total: count || 0 };
    },
    enabled: !!orgId,
    placeholderData: (prev) => prev,
  });

  const rows = jobsPage?.rows || [];
  const total = jobsPage?.total || 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const rangeStart = total === 0 ? 0 : page * pageSize + 1;
  const rangeEnd = Math.min(total, page * pageSize + pageSize);
  const hasActiveFilters = !!(search || installerFilter || flagFilter || linkedPoId);

  useRealtimeInvalidate(['installation_jobs', 'field_review_decisions'], orgId, [jobsQueryKey, countsQueryKey, ['dashboard-stats', orgId]]);

  function invalidateAll() {
    void refreshReviewViews(queryClient);
    queryClient.invalidateQueries({ queryKey: ['installation-review'] });
    queryClient.invalidateQueries({ queryKey: countsQueryKey });
    queryClient.invalidateQueries({ queryKey: ['shops'] });
    queryClient.invalidateQueries({ queryKey: ['dashboard-stats', orgId] });
    queryClient.invalidateQueries({ queryKey: ['nav-pending-counts', orgId] });
  }

  async function applyDecision(job: any, decision: 'approve' | 'reject', decisionNote: string) {
    // One atomic server call (migration 0090): decisions, corrections, shop status, notifications.
    if (decision === 'approve') {
      const res = await reviewApply({ stage: 'installation', shopId: job.shop_id, refId: job.id, decision: 'approved', note: decisionNote });
      if (!res.finalized) throw new Error(`${job.shops?.name}: ${res.redo} item(s) are marked for redo and ${res.pending} still pending — finish those first.`);
      return;
    }
    const picked = Object.values(correctionTargets);
    const entities: ReviewEntity[] | undefined = picked.length
      ? picked.map((c) => c.installation_proof_id ? { type: 'installation_photo', id: c.installation_proof_id } : { type: 'work_item', id: c.work_item_id! })
      : undefined;
    await reviewApply({ stage: 'installation', shopId: job.shop_id, refId: job.id, entities, decision: 'redo', note: decisionNote || picked.map((c) => c.note).filter(Boolean).join(' | ') });
  }

  const reviewMutation = useMutation({
    mutationFn: async () => {
      if (!reviewModal) return;
      await applyDecision(reviewModal, action, note);
    },
    onSuccess: () => {
      invalidateAll();
      setReviewModal(null);
      setNote('');
      setReopenForRedo(false);
    },
  });

  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkResult, setBulkResult] = useState('');
  const [batchProgress, setBatchProgress] = useState<{done:number;total:number}|null>(null);
  async function submitBatchDecisions() {
    if (bulkBusy) return;
    const targets = decisionTargets(rows.filter(row => selectedIds.has(row.id)), batchDecisions);
    if (!targets.length) { setBulkResult('Review evidence and queue Approve or Redo for at least one shop.'); return; }
    for (const job of targets) {
      const invalid = validateShopDecision(batchDecisions[job.id], 'installation', evidenceReadyIds.has(job.id));
      if (invalid) { setBulkResult(`${job.shops?.name || 'Shop'}: ${invalid}`); return; }
    }
    setBulkBusy(true); setBulkResult(''); setBatchProgress({ done: 0, total: targets.length });
    try {
      const result = await processReviewedBatch(targets, async job => {
        const choice = batchDecisions[job.id];
        const res = await reviewApply({ stage: 'installation', shopId: job.shop_id, refId: job.id, decision: choice.action === 'approve' ? 'approved' : 'redo', note: choice.note });
        if (choice.action === 'approve' && !res.finalized) throw new Error(`${res.pending} pending item(s), ${res.redo} redo item(s) — review individually.`);
        if (choice.action === 'redo' && !res.redo && !res.left_review) throw new Error('No items were returned for redo. Check item decisions.');
      }, (done,total) => setBatchProgress({done,total}), 3);
      const successful = new Set(result.succeeded.map(job => job.id));
      setSelectedIds(prev => new Set([...prev].filter(id => !successful.has(id))));
      setInspectedIds(prev => new Set([...prev].filter(id => !successful.has(id))));
      setEvidenceReadyIds(prev => new Set([...prev].filter(id => !successful.has(id))));
      setBatchDecisions(prev => Object.fromEntries(Object.entries(prev).filter(([id]) => !successful.has(id))));
      setBatchErrors(Object.fromEntries(result.failed.map(({item,message}) => [item.id, message])));
      setBatchIndex(0);
      setBulkResult(`${result.succeeded.length} saved (${result.succeeded.filter(job => batchDecisions[job.id]?.action === 'approve').length} approved, ${result.succeeded.filter(job => batchDecisions[job.id]?.action === 'redo').length} sent for redo). ${result.failed.length ? `${result.failed.length} failed and retained for retry.` : 'Other shops remain pending.'}`);
      invalidateAll();
      if (!result.failed.length && selectedJobs.length === successful.size) setBulkModalOpen(false);
    } catch (error) {
      setBulkResult(error instanceof Error ? error.message : 'Batch failed; retry unprocessed shops.');
    } finally {
      setBatchProgress(null); setBulkBusy(false);
    }
  }

  function queueInstallDecision(id: string, choice: ShopReviewDecision) {
    const invalid = validateShopDecision(choice, 'installation', evidenceReadyIds.has(id));
    if (invalid) { setBulkResult(invalid); return; }
    setBulkResult('');
    setBatchErrors(prev => { const copy = {...prev}; delete copy[id]; return copy; });
    const updated = { ...batchDecisions, [id]: choice };
    setBatchDecisions(updated);
    const next = nextUnqueued(selectedJobs, batchIndex, updated);
    if (next >= 0) setBatchIndex(next);
  }

  function toggleSelected(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function openReview(job: any, act: 'approve' | 'reject') {
    setReviewModal(job);
    setAction(act);
    setNote('');
    setReopenForRedo(false);
    setCorrectionTargets({});
  }

  function closeBatch() {
    if (bulkBusy) return;
    if (Object.keys(batchDecisions).length && !window.confirm('Close review? Unsubmitted shop decisions will be lost.')) return;
    setBulkModalOpen(false);
  }

  const selectedJobs = rows.filter((r) => selectedIds.has(r.id));
  const activeBatchJob = selectedJobs[Math.min(batchIndex, Math.max(0, selectedJobs.length - 1))];
  function nextSingleReview(completedId: string) {
    invalidateAll();
    if (!autoNext) { setReviewModal(null); return; }
    const index = rows.findIndex(row => row.id === completedId);
    const next = rows.slice(index + 1).find(row => row.review_status === 'pending');
    if (next) openReview(next, 'approve'); else setReviewModal(null);
  }

  return (
    <div>
      <PageHeader
        title="Installation Review"
        subtitle={`${statusCounts?.pending ?? '…'} pending approval`}
      />

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

      {tab === 'pending' && <p className="mb-2 text-xs text-slate-500">Open any shop for item-wise review, or tick shops below for a focused batch review. No extra selection mode.</p>}

      {selectMode && (
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4 bg-blue-50 border border-blue-200 rounded-lg px-4 py-2.5">
          <p className="text-sm text-blue-800 font-medium">
            {selectedIds.size ? `${selectedIds.size} selected` : `${rows.length} on this page`}
            {total > pageSize && <span className="font-normal text-blue-600"> (this page only)</span>}
          </p>
          <div className="flex items-center gap-2">
            <button onClick={() => setSelectedIds(new Set(rows.map((r) => r.id)))} className="text-xs font-medium text-blue-700 hover:underline">
              Select all on this page
            </button>
            <button
              onClick={() => { if (!selectedIds.size) setSelectedIds(new Set(rows.map(row => row.id))); setBatchIndex(0); setInspectedIds(new Set()); setEvidenceReadyIds(new Set()); setBatchDecisions({}); setBatchErrors({}); setBulkResult(''); setBatchProgress(null); setBulkModalOpen(true); }}
              disabled={!rows.length}
              className="flex items-center gap-1.5 bg-slate-900 hover:bg-slate-800 text-white px-3 py-1.5 rounded-lg text-xs font-medium disabled:opacity-50"
            >
              <Eye className="w-3.5 h-3.5" /> {selectedIds.size ? `Review ${selectedIds.size} selected` : `Review page (${rows.length})`}
            </button>
          </div>
        </div>
      )}

      {linkedPoId && <div role="status" className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-900"><span>Installation reviews filtered to the selected Work Order</span><button type="button" className="font-semibold text-blue-700 underline" onClick={() => setRouteParams(previous => { const next = new URLSearchParams(previous); next.delete('po'); return next; }, { replace: true })}>Show all installation reviews</button></div>}
      {/* Filters — same set works across all three tabs, so lookups stay
          fast even months later when there's a long history to sort through. */}
      <Card className="p-4 mb-4">
        <div className="flex items-center gap-1.5 text-xs font-medium text-slate-400 uppercase tracking-wide mb-3">
          <SlidersHorizontal className="w-3.5 h-3.5" /> Filters
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <div className="relative">
            <label className="block text-xs font-medium text-slate-500 mb-1">Search</label>
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-[34px] -translate-y-1/2" />
            <input
              placeholder="Shop name or city..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-9 pr-3 py-2 border border-slate-300 rounded-lg text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Installer</label>
            <select value={installerFilter} onChange={(e) => setInstallerFilter(e.target.value)} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500">
              <option value="">All Installers</option>
              {(installers || []).map((i) => <option key={i.id} value={i.id}>{i.full_name}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Flag</label>
            <select value={flagFilter} onChange={(e) => setFlagFilter(e.target.value as any)} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500">
              <option value="">All</option>
              <option value="gps">GPS mismatch</option>
              <option value="material">Material not confirmed</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Sort by</label>
            <select value={sortBy} onChange={(e) => setSortBy(e.target.value as any)} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500">
              {Object.entries(SORT_OPTIONS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 mt-3 pt-3 border-t border-slate-100">
          <p className="text-xs text-slate-400">
            {total === 0 ? '0 installations' : `Showing ${rangeStart}–${rangeEnd} of ${total.toLocaleString('en-IN')}`}
            {hasActiveFilters ? ' matching filters' : ''}
            {jobsLoading && <Loader2 className="inline w-3 h-3 ml-1.5 animate-spin align-[-1px]" />}
          </p>
          {hasActiveFilters && (
            <button onClick={() => { setSearch(''); setInstallerFilter(''); setFlagFilter(''); if (linkedPoId) setRouteParams(previous => { const next = new URLSearchParams(previous); next.delete('po'); return next; }, { replace: true }); }} className="text-xs text-slate-500 hover:text-slate-700 flex items-center gap-1 font-medium">
              <X className="w-3.5 h-3.5" /> Clear filters
            </button>
          )}
        </div>
      </Card>

      {/* LISTING — a proper table, not cards: needs to stay usable when
          thousands of shops are cycling through review, not just the first
          handful. */}
      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-500 text-xs uppercase tracking-wide border-b border-slate-200">
              <tr>
                {selectMode && <th className="w-10 px-3 py-2.5"></th>}
                <th className="text-left px-3 py-2.5 font-medium">Shop</th>
                <th className="text-left px-3 py-2.5 font-medium">Installer</th>
                <th className="text-left px-3 py-2.5 font-medium">{tab === 'pending' ? 'Completed' : 'Reviewed'}</th>
                <th className="text-left px-3 py-2.5 font-medium">Flags</th>
                <th className="text-left px-3 py-2.5 font-medium">Photos</th>
                <th className="text-right px-3 py-2.5 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((j) => {
                const photos: any[] = j.installation_proofs || [];
                const hasDuplicate = photos.some((p) => p.duplicate_flag);
                const dateStr = tab === 'pending'
                  ? (j.completed_at ? new Date(j.completed_at).toLocaleString('en-IN') : '—')
                  : (j.reviewed_at ? new Date(j.reviewed_at).toLocaleString('en-IN') : '—');
                return (
                  <tr
                    key={j.id}
                    className={`hover:bg-slate-50 transition ${selectedIds.has(j.id) ? 'bg-blue-50/60' : ''}`}
                    onClick={selectMode && tab === 'pending' ? () => toggleSelected(j.id) : undefined}
                  >
                    {selectMode && (
                      <td className="px-3 py-3 align-top cursor-pointer" onClick={(e) => { e.stopPropagation(); toggleSelected(j.id); }}>
                        {tab === 'pending' ? (
                          <input
                            type="checkbox"
                            checked={selectedIds.has(j.id)}
                            onChange={() => toggleSelected(j.id)}
                            onClick={(e) => e.stopPropagation()}
                            className="w-4 h-4 accent-blue-600"
                          />
                        ) : null}
                      </td>
                    )}
                    <td className="px-3 py-3 align-top max-w-[220px]">
                      <p className="font-medium text-slate-900 truncate">{j.shops?.name}</p>
                      <p className="text-xs text-slate-500 truncate">{j.shops?.clients?.name} · {j.shops?.city}</p>
                      <Link to={`/shops/${j.shop_id}`} onClick={(e) => e.stopPropagation()} className="text-[11px] text-blue-600 hover:underline">
                        View shop
                      </Link>
                    </td>
                    <td className="px-3 py-3 align-top text-slate-700">{j.profiles?.full_name || '—'}</td>
                    <td className="px-3 py-3 align-top text-slate-600 whitespace-nowrap">{dateStr}</td>
                    <td className="px-3 py-3 align-top">
                      <div className="flex flex-col gap-1">
                        {j.gps_distance_flag && (
                          <span className="inline-flex items-center gap-1 w-fit text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5">
                            <AlertTriangle className="w-3 h-3" /> GPS ~{Math.round(j.gps_distance_meters || 0)}m off
                          </span>
                        )}
                        {hasDuplicate && (
                          <span className="inline-flex items-center gap-1 w-fit text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5">
                            <AlertTriangle className="w-3 h-3" /> Duplicate photo
                          </span>
                        )}
                        {j.material_check_confirmed ? (
                          <span className="inline-flex items-center gap-1 w-fit text-[11px] text-teal-700 bg-teal-50 border border-teal-200 rounded px-1.5 py-0.5">
                            <Truck className="w-3 h-3" /> Material loaded
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 w-fit text-[11px] text-slate-500 bg-slate-50 border border-slate-200 rounded px-1.5 py-0.5">
                            <Truck className="w-3 h-3" /> Not confirmed
                          </span>
                        )}
                        {tab !== 'pending' && j.review_note && (
                          <span className="text-[11px] text-slate-500 truncate max-w-[160px]" title={j.review_note}>Note: {j.review_note}</span>
                        )}
                        {!j.gps_distance_flag && !hasDuplicate && j.material_check_confirmed && tab === 'pending' && (
                          <span className="text-[11px] text-slate-300">No issues flagged</span>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-3 align-top">
                      {photos.length === 0 ? (
                        <span className="text-xs text-slate-300">No photos</span>
                      ) : (
                        <div className="flex items-center -space-x-2">
                          {photos.slice(0, 3).map((p, idx) => (
                            <img
                              key={p.id}
                              src={p.photo_url}
                              alt="Installation evidence preview"
                              loading="lazy" decoding="async"
                              onClick={(e) => { e.stopPropagation(); setLightbox(p.photo_url); }}
                              className="w-8 h-8 rounded-md object-cover border-2 border-white shadow-sm cursor-zoom-in hover:scale-105 transition"
                              style={{ zIndex: 3 - idx }}
                            />
                          ))}
                          {photos.length > 3 && (
                            <button
                              onClick={(e) => { e.stopPropagation(); openReview(j, tab === 'pending' ? 'approve' : tab === 'approved' ? 'approve' : 'reject'); }}
                              className="w-8 h-8 rounded-md bg-slate-100 border-2 border-white flex items-center justify-center text-[10px] font-medium text-slate-500 hover:bg-slate-200"
                            >
                              +{photos.length - 3}
                            </button>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-3 align-top">
                      <div className="flex justify-end gap-1.5" onClick={(e) => e.stopPropagation()}>
                        {tab === 'pending' ? (
                          <>
                            <button onClick={() => openReview(j, 'reject')} className="flex items-center gap-1 bg-red-50 text-red-700 border border-red-200 px-2.5 py-1.5 rounded-lg text-xs font-medium hover:bg-red-100">
                              <XCircle className="w-3.5 h-3.5" /> Reject
                            </button>
                            <button onClick={() => openReview(j, 'approve')} className="flex items-center gap-1 bg-green-50 text-green-700 border border-green-200 px-2.5 py-1.5 rounded-lg text-xs font-medium hover:bg-green-100">
                              <CheckCircle2 className="w-3.5 h-3.5" /> Approve
                            </button>
                          </>
                        ) : (
                          <button onClick={() => openReview(j, tab === 'approved' ? 'approve' : 'reject')} className="flex items-center gap-1 bg-white text-slate-600 border border-slate-300 px-2.5 py-1.5 rounded-lg text-xs font-medium hover:bg-slate-50">
                            <Eye className="w-3.5 h-3.5" /> View
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {rows.length === 0 && (
          <EmptyState
            icon={<Wrench className="w-12 h-12" />}
            title={tab === 'pending' ? 'No installations pending approval' : hasActiveFilters ? 'No installations match these filters' : 'Nothing here yet'}
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

      {/* Single-job review — full photo + material context before a
          decision is made. Also doubles as the read-only detail view for
          already-reviewed jobs, with a "Flag for redo" escape hatch in
          case something's noticed after the fact. */}
      <Modal
        open={!!reviewModal}
        onClose={() => setReviewModal(null)}
        title={reviewModal?.review_status === 'pending' ? `Review Installation — ${action === 'approve' ? 'Approve' : 'Reject / Redo'}` : 'Installation Detail'}
        size="lg"
      >
        <div className="space-y-4">
          <p className="text-sm text-slate-600">Shop: <span className="font-medium text-slate-900">{reviewModal?.shops?.name}</span></p>
          {reviewModal && <div className="flex flex-wrap items-center justify-between rounded-lg border border-slate-200 px-3 py-2 text-xs"><span className="font-medium text-slate-700">Work Item measurements, design and installed proofs are reviewed together.</span><label className="flex items-center gap-2 text-blue-800"><input type="checkbox" checked={autoNext} onChange={e => setAutoNext(e.target.checked)} /> Open next after completion</label></div>}
          {reviewModal && <CompanyApprovalHandoff stage="installation" refId={reviewModal.id} shopId={reviewModal.shop_id} />}
          {reviewModal && <MaterialLoadedSummary job={reviewModal} onOpenPhoto={setLightbox} />}

          {/* Design reference (what was approved) next to the installer's
              own proof (what actually went up) — side by side so a
              mismatch jumps out without leaving this modal. */}
          {reviewModal && (
            <div>
              <p className="text-xs font-medium text-slate-700 flex items-center gap-1.5 mb-2"><Palette className="w-3.5 h-3.5" /> Work Item Evidence — Survey → Measurement → Design → Installation</p>
              <WorkItemEvidenceReview shopId={reviewModal.shop_id} jobId={reviewModal.id} assignedTo={reviewModal.installer_id} readOnly={reviewModal.review_status !== 'pending' && !reopenForRedo} key={reviewModal.id} onOpenPhoto={setLightbox} onLeftReview={() => nextSingleReview(reviewModal.id)} />
            </div>
          )}

          {reviewModal && reviewModal.review_status !== 'pending' && !reopenForRedo ? (
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5">
              <p className="text-xs text-slate-500">
                {reviewModal.review_status === 'approved' ? 'Approved' : 'Marked for redo'} by {reviewModal.profiles?.full_name || 'reviewer'} · {reviewModal.reviewed_at ? new Date(reviewModal.reviewed_at).toLocaleString('en-IN') : ''}
              </p>
              {reviewModal.review_note && <p className="text-sm text-slate-700 mt-1">{reviewModal.review_note}</p>}
              {reviewModal.review_status === 'approved' && (
                <button onClick={() => { setReopenForRedo(true); setAction('reject'); setNote(''); }} className="text-xs text-amber-700 hover:underline mt-2 font-medium">
                  Noticed an issue — flag for redo
                </button>
              )}
            </div>
          ) : (
            <div className="rounded-xl border border-blue-100 bg-blue-50/60 px-3 py-2 text-xs text-slate-600">
              Review actions are built directly into each Work Item above. Approving the last required item automatically completes the installation review; marking any selected item/photo for redo sends only that correction back to the assigned installer.
            </div>
          )}
        </div>
      </Modal>

      {/* Multi-shop review workspace: the selected shops stay separated so
          evidence can never be accidentally approved against the wrong shop. */}
      <Modal
        open={bulkModalOpen}
        onClose={closeBatch}
        title={`Review Selected Shops — ${selectedJobs.length}`}
        size="xl"
      >
        <div className="space-y-4">
          <div className="rounded-xl border border-blue-100 bg-blue-50/60 px-4 py-3 flex items-start gap-3">
            <CheckSquare className="w-5 h-5 text-blue-600 mt-0.5 shrink-0" />
            <div><p className="text-sm font-semibold text-slate-900">Multi-shop quality review</p><p className="text-xs text-slate-600 mt-0.5">Each shop has its own Survey → Measurement → Design → Installation evidence. Select evidence inside that shop and approve or mark only that selection for redo. A shop stays in Pending Review until every required item is complete and approved.</p></div>
          </div>
          <div ref={batchTopRef} />
          <ReviewBatchStepper
            items={selectedJobs.map(j => ({ id: j.id, name: j.shops?.name || 'Shop', subtitle: `${j.shops?.purchase_orders?.name || j.shops?.purchase_orders?.po_number || 'No PO'} · ${j.shops?.city || 'Location not set'} · ${j.profiles?.full_name || 'Installer'} · ${(j.installation_proofs || []).length} photos`, flagged: !!j.gps_distance_flag || (j.installation_proofs || []).some((p:any) => p.duplicate_flag) }))}
            index={batchIndex} onIndexChange={setBatchIndex} inspected={new Set(Object.keys(batchDecisions))} disabled={bulkBusy}
            decisionLabels={Object.fromEntries(Object.entries(batchDecisions).map(([id,d]) => [id,d.action === 'approve' ? 'Approve' : 'Redo']))}
          />
          {activeBatchJob && <div key={activeBatchJob.id} className="space-y-3">
            <CompanyApprovalHandoff stage="installation" refId={activeBatchJob.id} shopId={activeBatchJob.shop_id}/>
            <MaterialLoadedSummary job={activeBatchJob} onOpenPhoto={setLightbox} />
            <WorkItemEvidenceReview shopId={activeBatchJob.shop_id} jobId={activeBatchJob.id} assignedTo={activeBatchJob.installer_id} readOnly={bulkBusy} onOpenPhoto={setLightbox}
              onEvidenceReady={() => setEvidenceReadyIds(prev => prev.has(activeBatchJob.id) ? prev : new Set(prev).add(activeBatchJob.id))}
              batchMode onEvidenceChanged={() => { setInspectedIds(prev => { const next = new Set(prev); next.delete(activeBatchJob.id); return next; }); setEvidenceReadyIds(prev => { const next = new Set(prev); next.delete(activeBatchJob.id); return next; }); setBatchDecisions(prev => { const copy = { ...prev }; delete copy[activeBatchJob.id]; return copy; }); }}
              onLeftReview={() => { setSelectedIds(prev => { const next = new Set(prev); next.delete(activeBatchJob.id); return next; }); setInspectedIds(prev => { const next = new Set(prev); next.delete(activeBatchJob.id); return next; }); setBatchDecisions(prev => { const copy = { ...prev }; delete copy[activeBatchJob.id]; return copy; }); setBatchIndex(0); invalidateAll(); }}/>
          </div>}
          {activeBatchJob && <ReviewDecisionBar shopId={activeBatchJob.id} stage="installation" evidenceReady={evidenceReadyIds.has(activeBatchJob.id)} decision={batchDecisions[activeBatchJob.id]} disabled={bulkBusy}
            onDecide={choice => queueInstallDecision(activeBatchJob.id, choice)}
            onClear={() => setBatchDecisions(prev => { const copy = {...prev}; delete copy[activeBatchJob.id]; return copy; })} />}
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs font-semibold text-slate-900">Ready to submit: {decisionTargets(selectedJobs, batchDecisions).length}/{selectedJobs.length} shops</p>
              <span className="text-xs text-slate-600">{decisionCounts(selectedJobs.map(j=>j.id),batchDecisions).approve} approve · {decisionCounts(selectedJobs.map(j=>j.id),batchDecisions).redo} redo</span>
            </div>
            <button type="button" disabled={bulkBusy || decisionTargets(selectedJobs,batchDecisions).length === 0} onClick={() => void submitBatchDecisions()} className="w-full rounded-lg bg-blue-700 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-40">{bulkBusy ? `Saving ${batchProgress?.done || 0}/${batchProgress?.total || 0}…` : `Submit ${decisionTargets(selectedJobs,batchDecisions).length} decisions`}</button>
            <p className="text-[11px] text-slate-600">Only queued shops are processed. For one Work Item/photo only, use its correction controls above. Redo is not a permanent rejection.</p>
            {bulkResult && <p role="status" className="text-xs text-slate-700">{bulkResult}</p>}
            {Object.keys(batchErrors).length > 0 && <div role="alert" className="rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900"><strong>Needs retry:</strong>{Object.entries(batchErrors).map(([id,msg]) => <p key={id}>{selectedJobs.find(j=>j.id===id)?.shops?.name || 'Shop'}: {msg}</p>)}</div>}
          </div>
          <div className="flex items-center justify-between gap-3 border-t border-slate-100 pt-3">
            <p className="text-xs text-slate-500">Decisions are saved per shop and per selected evidence — never across the wrong shop.</p>
            <button disabled={bulkBusy} onClick={closeBatch} className="px-4 py-2 rounded-lg bg-slate-900 text-white text-sm font-medium hover:bg-slate-800 disabled:opacity-50">Done Reviewing</button>
          </div>
        </div>
      </Modal>

      {lightbox && (
        <div onClick={() => setLightbox(null)} role="dialog" aria-modal="true" aria-label="Full size installation evidence" className="fixed inset-0 z-[100] bg-black/80 flex items-center justify-center p-4 cursor-zoom-out">
          <button type="button" onClick={() => setLightbox(null)} className="absolute right-4 top-4 rounded-lg bg-white px-3 py-2 text-sm font-semibold text-slate-900">Close (Esc)</button>
          <img src={lightbox} alt="Full size installation evidence" onClick={event => event.stopPropagation()} className="max-w-full max-h-full rounded-lg" />
        </div>
      )}
    </div>
  );
}

// The loading-register reconciliation an Owner/Admin actually asked for:
// per board, approved qty (what survey/design signed off on) vs produced
// qty (what Production actually made, from work_items.produced_quantity)
// vs loaded qty (what the installer's Material Check step recorded as
// physically on the vehicle) — three numbers side by side, not just a
// "confirmed" flag. Falls back gracefully for jobs recorded before the
// loading register existed (material_check_items was a plain array of
// ids back then, or empty on jobs migration 0044 backfilled).
function MaterialLoadedSummary({ job, onOpenPhoto }: { job: any; onOpenPhoto: (url: string) => void }) {
  const items: any[] = Array.isArray(job.material_check_items) ? job.material_check_items : [];
  const hasQtyRecord = items.length > 0 && typeof items[0] === 'object' && items[0] !== null && 'loaded_quantity' in items[0];

  const workItemIds = hasQtyRecord ? items.map((it) => it.work_item_id).filter(Boolean) : [];
  const { data: producedByItem } = useQuery({
    queryKey: ['material-check-produced-qty', job.id, workItemIds.join(',')],
    queryFn: async () => {
      if (workItemIds.length === 0) return {} as Record<string, number | null>;
      const { data } = await supabase.from('work_items').select('id, produced_quantity').in('id', workItemIds);
      const map: Record<string, number | null> = {};
      for (const row of data || []) map[row.id] = row.produced_quantity;
      return map;
    },
    enabled: hasQtyRecord && workItemIds.length > 0,
  });

  if (!job.material_check_confirmed) {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700 flex items-center gap-1.5">
        <AlertTriangle className="w-3.5 h-3.5" /> No material/load check on record for this job.
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-slate-200 overflow-hidden">
      <div className="bg-slate-50 px-3 py-2 flex items-center justify-between">
        <p className="text-xs font-medium text-slate-700 flex items-center gap-1.5">
          <Truck className="w-3.5 h-3.5" /> Material Loaded
        </p>
        <p className="text-[11px] text-slate-400">
          {job.confirmed_by_profile?.full_name || 'Installer'} · {job.material_check_confirmed_at ? new Date(job.material_check_confirmed_at).toLocaleString('en-IN') : ''}
        </p>
      </div>

      {hasQtyRecord ? (
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-slate-100 text-slate-400">
              <th className="text-left px-3 py-1.5 font-medium">Board</th>
              <th className="text-right px-3 py-1.5 font-medium">Approved</th>
              <th className="text-right px-3 py-1.5 font-medium">Produced</th>
              <th className="text-right px-3 py-1.5 font-medium">Loaded</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it, i) => {
              const produced = producedByItem?.[it.work_item_id];
              const short = (it.loaded_quantity ?? 0) < (it.approved_quantity ?? 0);
              return (
                <tr key={i} className="border-b border-slate-50 last:border-0">
                  <td className="px-3 py-1.5 text-slate-700">{it.work_type_name || 'Item'}</td>
                  <td className="px-3 py-1.5 text-right text-slate-600">{it.approved_quantity ?? '—'}</td>
                  <td className="px-3 py-1.5 text-right text-slate-600">{produced ?? '—'}</td>
                  <td className={`px-3 py-1.5 text-right font-semibold ${short ? 'text-amber-600' : 'text-green-700'}`}>{it.loaded_quantity ?? '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <p className="text-xs text-slate-400 px-3 py-2">Confirmed, but no item-level quantities on record (this job predates the loading register).</p>
      )}

      {job.material_check_photo_url && (
        <div className="p-2 border-t border-slate-100">
          <img
            src={job.material_check_photo_url}
            alt="Loaded material"
            onClick={() => onOpenPhoto(job.material_check_photo_url)}
            className="w-20 h-20 object-cover rounded-lg border border-slate-200 cursor-zoom-in hover:opacity-90 transition"
          />
        </div>
      )}
    </div>
  );
}

// Shows before/after/installed proof photos plus GPS, so Admin/Owner can
// actually see the completed work before approving it. Click any photo to
// open it full-size.
function WorkItemEvidenceReview({ shopId, jobId, assignedTo, readOnly = false, onOpenPhoto, onLeftReview, onEvidenceReady, onEvidenceChanged, batchMode = false }: { shopId: string; jobId: string; assignedTo?: string; readOnly?: boolean; onOpenPhoto: (url: string) => void; onLeftReview?: () => void; onEvidenceReady?: () => void; onEvidenceChanged?: () => void; batchMode?: boolean }) {
  const { profile } = useAuth();
  const qc = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [reviewNote, setReviewNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [reviewError, setReviewError] = useState('');
  const { data: workItems, isSuccess: workItemsReady, isError: workItemsFailed, isFetching: workItemsFetching } = useQuery({
    queryKey: ['review-evidence-work-items', shopId],
    queryFn: async () => { const { data, error } = await supabase.from('work_items').select('*').eq('shop_id', shopId).order('created_at'); if (error) throw new Error(error.message); return (data || []) as WorkItem[]; }, enabled: !!shopId,
  });
  const { data: surveyPhotos, isSuccess: surveyPhotosReady, isError: surveyPhotosFailed, isFetching: surveyPhotosFetching } = useQuery({
    queryKey: ['review-evidence-survey-photos', shopId],
    queryFn: async () => { const { data, error } = await supabase.from('survey_photos').select('*').eq('shop_id', shopId).order('created_at'); if (error) throw new Error(error.message); return (data || []) as SurveyPhoto[]; }, enabled: !!shopId,
  });
  const { data: markings, isSuccess: markingsReady, isError: markingsFailed, isFetching: markingsFetching } = useQuery({
    queryKey: ['review-evidence-markings', shopId, surveyPhotos?.length],
    queryFn: async () => { const ids=(surveyPhotos||[]).map(p=>p.id); if(!ids.length)return [] as BoardMarking[]; const {data,error}=await supabase.from('board_markings').select('*').in('survey_photo_id',ids); if(error)throw new Error(error.message); return (data||[]) as BoardMarking[]; }, enabled: !!surveyPhotos,
  });
  const { data: photoLinks, isSuccess: photoLinksReady, isError: photoLinksFailed, isFetching: photoLinksFetching } = useQuery({
    queryKey: ['review-evidence-photo-links', shopId, surveyPhotos?.length],
    queryFn: async () => { const ids=(surveyPhotos||[]).map(p=>p.id); if(!ids.length)return [] as any[]; const {data,error}=await supabase.from('survey_photo_items').select('survey_photo_id, work_item_id').in('survey_photo_id',ids); if(error&&/survey_photo_items|schema cache|could not find the table/i.test(error.message||''))return []; if(error)throw new Error(error.message); return data||[]; }, enabled: !!surveyPhotos,
  });
  const { data: designTasks, isSuccess: designTasksReady, isError: designTasksFailed, isFetching: designTasksFetching } = useQuery({
    queryKey: ['review-evidence-designs', shopId],
    queryFn: async () => { const {data,error}=await supabase.from('design_tasks').select('id, design_versions(*, design_version_items(work_item_id))').eq('shop_id',shopId); if(error)throw new Error(error.message); return data||[]; }, enabled: !!shopId,
  });
  const { data: proofs, isSuccess: proofsReady, isError: proofsFailed, isFetching: proofsFetching } = useQuery({
    queryKey: ['review-evidence-proofs', jobId],
    queryFn: async () => { const {data,error}=await supabase.from('installation_proofs').select('*').eq('installation_job_id',jobId).order('captured_at'); if(error)throw new Error(error.message); return (data||[]) as any[]; }, enabled: !!jobId,
  });
  const { data: decisions=[], isSuccess: decisionsReady, isError: decisionsFailed, isFetching: decisionsFetching } = useQuery({
    queryKey: ['inline-install-review-decisions', jobId],
    queryFn: async () => { const {data,error}=await supabase.from('field_review_decisions').select('*').eq('stage','installation').eq('installation_job_id',jobId); if(error&&/field_review_decisions|schema cache/i.test(error.message||''))return []; if(error)throw new Error(error.message); return data||[]; }, enabled: !!jobId,
  });
  const allEvidenceReady = workItemsReady && surveyPhotosReady && markingsReady && photoLinksReady && designTasksReady && proofsReady && decisionsReady;
  const hasReviewableEvidence = (workItems?.length || 0) > 0 && (workItems || []).filter(item => !item.excluded_from_calculations).some(item => (proofs || []).some(p => p.work_item_id === item.id)) && (workItems || []).filter(item => !item.excluded_from_calculations).every(item => (proofs || []).some(p => p.work_item_id === item.id));
  const evidenceFetching = workItemsFetching || surveyPhotosFetching || markingsFetching || photoLinksFetching || designTasksFetching || proofsFetching || decisionsFetching;
  const evidenceFailed = workItemsFailed || surveyPhotosFailed || markingsFailed || photoLinksFailed || designTasksFailed || proofsFailed || decisionsFailed;
  useEffect(() => { if (allEvidenceReady && !evidenceFetching && hasReviewableEvidence) onEvidenceReady?.(); }, [allEvidenceReady, evidenceFetching, hasReviewableEvidence, onEvidenceReady]);
  const dmap = useMemo(() => new Map((decisions as any[]).map((d:any)=>[`${d.entity_type}:${d.entity_id}`,d])), [decisions]);
  const items=workItems||[];
  const pendingReviewKeys = useMemo(() => items
    .filter((item:any) => !item.excluded_from_calculations && !(decisions || []).some((d:any) => d.entity_type === 'work_item' && d.entity_id === item.id && (d.decision === 'approved' || d.decision === 'redo')))
    .map((item:any) => `work_item:${item.id}`), [workItems, decisions]);
  // One shop may have many items. Preselect the pending ones; reviewer
  // narrows selection only when sending a particular item for redo.
  useEffect(() => {
    if (!readOnly && allEvidenceReady) setSelected(new Set(pendingReviewKeys));
  }, [readOnly, jobId, allEvidenceReady, pendingReviewKeys]);
  if (evidenceFailed) return <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700">Could not load all evidence. Reopen this review or retry after reconnecting; approval is unavailable.</p>;
  if (!allEvidenceReady) return <p role="status" className="rounded-lg bg-slate-50 p-3 text-xs text-slate-600">Loading all work items, survey photos, designs and installation proofs…</p>;
  if (!items.length) return <p role="alert" className="text-xs text-amber-700">No work items found; review needs item reconciliation.</p>;
  const dim=(it:any)=>{const w=it.approved_width??it.survey_width,h=it.approved_height??it.survey_height,u=it.approved_unit??it.survey_unit??'ft',q=it.approved_quantity??it.survey_quantity??1,a=it.approved_area??it.survey_area;return `${itemSizeLabel(it)} · Qty ${q}${a!=null?` · ${Number(a).toFixed(2)} sq.ft`:''}`};
  const toggle=(key:string)=>setSelected(prev=>{const n=new Set(prev);n.has(key)?n.delete(key):n.add(key);return n});
  const Photo=({url,label,reviewKey,decision}:{url?:string|null;label:string;reviewKey?:string;decision?:any})=>url?(<div className={`relative rounded-xl border-2 overflow-hidden ${reviewKey&&selected.has(reviewKey)?'border-blue-500 ring-2 ring-blue-100':decision?.decision==='redo'?'border-amber-300':'border-slate-200'}`}><button onClick={()=>onOpenPhoto(url)} className="block w-full bg-slate-50"><img src={url} alt={label} className="w-full aspect-[4/3] object-contain bg-slate-100"/></button>{reviewKey&&!readOnly&&<button onClick={()=>setSelected(prev => prev.has(reviewKey) ? new Set([...prev].filter(key => key !== reviewKey)) : new Set([reviewKey]))} className="absolute top-2 left-2 rounded-md bg-white/95 shadow px-2 py-1 text-[10px] font-semibold flex items-center gap-1">{selected.has(reviewKey)?<CheckSquare className="w-3.5 h-3.5 text-blue-600"/>:<Square className="w-3.5 h-3.5 text-slate-500"/>} {selected.has(reviewKey) ? 'Photo selected' : 'Select photo'}</button>}{decision?.note && <p title={decision.note} className="absolute bottom-9 inset-x-2 max-h-12 overflow-auto rounded-md bg-amber-50 px-2 py-1 text-[10px] text-amber-900"><strong>Redo:</strong> {decision.note}</p>}<div className="absolute left-2 bottom-2 flex gap-1"><span className="rounded-md bg-slate-950/75 px-2 py-1 text-[10px] font-medium text-white">{label}</span>{decision&&<span className={`rounded-md px-2 py-1 text-[10px] font-bold ${decision.decision==='approved'?'bg-emerald-600 text-white':'bg-amber-500 text-white'}`}>{decision.decision==='approved'?'APPROVED':'REDO'}</span>}</div></div>):<div className="aspect-[4/3] rounded-xl border border-dashed border-slate-200 bg-slate-50 flex items-center justify-center text-[11px] text-slate-400">No {label.toLowerCase()}</div>;
  async function applyInline(decision:'approved'|'redo'){
    if(!selected.size||!profile)return; setBusy(true);setReviewError('');
    try{
      if(decision==='approved' && [...selected].some(key => { const id = key.split(':')[1]; return key.startsWith('work_item:') && !(proofs || []).some(p => p.work_item_id === id); })) throw new Error('One or more selected Work Items have no linked installation photos. Request missing proof or reconcile the legacy photos before approval.');
      if(decision==='redo' && !reviewNote.trim()) throw new Error('Redo ke liye note likhiye — installer ko batana zaroori hai kya theek karna hai.');
      const entities:ReviewEntity[]=[...selected].map(key=>{const [kind,id]=key.split(':');return {type:kind==='work_item'?'work_item':'installation_photo',id} as ReviewEntity;});
      const res=await reviewApply({stage:'installation',shopId,refId:jobId,entities,decision,note:reviewNote});
      setSelected(new Set());setReviewNote('');
      await refreshReviewViews(qc,shopId); onEvidenceChanged?.();
      if(res.finalized||res.left_review){ setReviewError(''); onLeftReview?.(); }
      else if(decision==='approved'){ setReviewError(res.redo>0?`${res.redo} item abhi Redo me hai — pehle wo theek hona chahiye ya use approve kijiye.`:res.undecided&&res.undecided>0?`${res.undecided} work item ka decision pending hai — unhe bhi approve/redo kijiye.`:'Approve ho gaya.'); }
      else { setReviewError(`Redo bhej diya. ${res.undecided||0} item ka decision pending hai, isliye shop abhi review me hai.`); }
    }catch(e:any){setReviewError(e.message||String(e));}finally{setBusy(false)}
  }
  async function toggleAvailability(item:any){
    try{
      if(item.excluded_from_calculations){ await setAvailability(item.id,false,null,null); }
      else{
        const reason=window.prompt('Yeh kaam installation ke liye available kyun nahi hai? (Renovation / site blocked / permission / removed)','Site renovation')?.trim(); if(!reason)return;
        const n=window.prompt('Optional comment','')?.trim()||null; await setAvailability(item.id,true,reason,n);
      }
      await refreshReviewViews(qc,shopId); onEvidenceChanged?.();
    }catch(e:any){setReviewError(e.message||String(e));}
  }
  const reviewableKeys=pendingReviewKeys;
  const allSelected=reviewableKeys.length>0&&reviewableKeys.every(k=>selected.has(k));
  return <div className="space-y-3">
    {!readOnly && !hasReviewableEvidence && <p role="status" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">Some work items do not have linked installation photos. Batch approval is disabled; you can still request targeted redo here.</p>}
    {!readOnly&&<div className="flex items-center justify-between gap-3 rounded-xl border border-blue-100 bg-blue-50/60 px-3 py-2"><p className="text-xs text-slate-600"><b className="text-slate-900">One shop, one review workspace.</b> Pending items are preselected. To request a targeted redo, keep only affected items checked. Photos, designs and measurements stay together.</p><button type="button" onClick={()=>setSelected(allSelected?new Set():new Set(reviewableKeys))} className="shrink-0 text-xs font-semibold text-blue-700 flex items-center gap-1">{allSelected?<CheckSquare className="w-4 h-4"/>:<Square className="w-4 h-4"/>}{allSelected?'Clear':'Select all'}</button></div>}
    {items.map((item:any,index:number)=>{
      const linkedSurvey=(surveyPhotos||[]).filter(p=>(photoLinks||[]).some((x:any)=>x.work_item_id===item.id&&x.survey_photo_id===p.id)||(markings||[]).some(m=>m.work_item_id===item.id&&m.survey_photo_id===p.id));
      const designs=(designTasks||[]).flatMap((t:any)=>t.design_versions||[]).filter((v:any)=>(v.design_version_items||[]).some((x:any)=>x.work_item_id===item.id)).sort((a:any,b:any)=>(b.version_number||0)-(a.version_number||0));
      const itemProofs=(proofs||[]).filter((p:any)=>p.work_item_id===item.id); const itemKey=`work_item:${item.id}`; const itemDecision:any=dmap.get(itemKey);
      return <div key={item.id} className={`rounded-2xl border bg-white overflow-hidden shadow-sm ${selected.has(itemKey)?'border-blue-400 ring-2 ring-blue-100':'border-slate-200'}`}>
        <div className="flex flex-wrap items-start justify-between gap-3 px-4 py-3 bg-slate-50 border-b border-slate-200"><div className="flex gap-2.5 items-start">{!readOnly&&<button onClick={()=>toggle(itemKey)} className="mt-0.5">{selected.has(itemKey)?<CheckSquare className="w-5 h-5 text-blue-600"/>:<Square className="w-5 h-5 text-slate-400"/>}</button>}<div><p className="text-[10px] font-bold tracking-[.16em] text-slate-400 uppercase">Work Item {index+1}</p><h4 className="text-sm font-semibold text-slate-900 mt-0.5">{item.work_type_name||'Work item'}</h4><p className="text-xs text-slate-500 mt-1">{dim(item)}</p></div></div><div className="flex flex-wrap items-center gap-2">{item.excluded_from_calculations&&<span className="rounded-full px-2.5 py-1 text-[10px] font-bold bg-slate-200 text-slate-700">NOT AVAILABLE · EXCLUDED</span>}{!readOnly&&<button type="button" onClick={()=>void toggleAvailability(item)} className="rounded-full border border-slate-300 px-2.5 py-1 text-[10px] font-semibold text-slate-600 hover:bg-slate-100">{item.excluded_from_calculations?'Make installable':'Mark not available'}</button>}{itemDecision&&<span className={`rounded-full px-2.5 py-1 text-[10px] font-bold ${itemDecision.decision==='approved'?'bg-emerald-100 text-emerald-700':'bg-amber-100 text-amber-700'}`}>{itemDecision.decision==='approved'?'APPROVED':'REDO'}</span>}<span className={`rounded-full px-2.5 py-1 text-[10px] font-semibold ${itemProofs.length?'bg-emerald-50 text-emerald-700 border border-emerald-200':'bg-amber-50 text-amber-700 border border-amber-200'}`}>{itemProofs.length} installation photo{itemProofs.length===1?'':'s'}</span></div></div>
        {itemDecision?.note && <p className="border-b border-amber-100 bg-amber-50 px-4 py-2 text-xs text-amber-900"><strong>{itemDecision.decision==='redo'?'Work Item redo reason:':'Review note:'}</strong> {itemDecision.note}</p>}
        {item.excluded_from_calculations&&<div className="px-4 py-2 bg-slate-100 border-b text-xs text-slate-700">Site unavailable: <b>{item.execution_reason||'reason not given'}</b>{item.execution_note?` — ${item.execution_note}`:''}. Yeh kaam installed sq.ft / qty / billing mein excluded from totals.</div>}
        <div className="p-4"><div className="grid grid-cols-1 md:grid-cols-3 gap-3"><div><p className="text-[10px] font-bold uppercase tracking-wider text-blue-600 mb-1.5">1 · Survey / Measurement</p>{linkedSurvey.length ? <div className="grid grid-cols-2 gap-2">{linkedSurvey.map((p:any) => <Photo key={p.id} url={p.photo_url} label="Survey"/>)}</div> : <Photo label="Survey"/>}</div><div><p className="text-[10px] font-bold uppercase tracking-wider text-violet-600 mb-1.5">2 · Approved Design</p><Photo url={designs[0]?.file_url} label={designs[0]?`Design v${designs[0].version_number}`:'Design'}/></div><div><p className="text-[10px] font-bold uppercase tracking-wider text-emerald-600 mb-1.5">3 · Installed Proof</p>{itemProofs.length?<div className="grid grid-cols-2 gap-2">{itemProofs.map((p:any)=><Photo key={p.id} url={p.photo_url} label={p.angle||'Installed'} reviewKey={`installation_photo:${p.id}`} decision={dmap.get(`installation_photo:${p.id}`)}/>)}</div>:<Photo label="Installation proof"/>}</div></div></div>
      </div>;
    })}
    {!readOnly&&<div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3"><div className="flex items-start gap-3"><div className="mt-0.5 rounded-full bg-blue-100 p-1.5"><CheckCircle2 className="w-4 h-4 text-blue-700"/></div><div><p className="text-xs font-semibold text-slate-900">Shop tab tak review me rahega jab tak har Work Item ka decision na ho</p><p className="text-[11px] text-slate-500 mt-0.5">Jab tak koi Work Item undecided hai, shop Pending Review me rahega. Sab approved = Installed ho jata hai. Sab decide ho jayein aur kuch redo ho = shop review se hatkar installer ke paas Redo me chala jata hai.</p></div></div></div>}
    {!readOnly&&<div className={`${batchMode ? 'relative' : 'sticky bottom-0 z-10'} rounded-2xl border border-slate-200 bg-white/95 backdrop-blur shadow-lg p-3`}><div className="mb-2 flex items-center justify-between gap-2"><div><p className="text-xs font-semibold text-slate-900">{batchMode ? 'Individual item / photo correction' : selected.size ? `${selected.size} selected` : 'Select evidence above'}</p><p className="text-[10px] text-slate-500">Action applies only to selected Work Items or proof photos in this shop. Selecting a photo clears other selections.</p></div>{selected.size>0&&<button onClick={()=>setSelected(new Set())} className="text-[11px] font-semibold text-slate-500 hover:text-slate-800">Clear selection</button>}</div><div className="flex flex-col md:flex-row gap-2"><input value={reviewNote} onChange={e=>setReviewNote(e.target.value)} placeholder="Note only if needed — especially for redo" className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-xs"/><button disabled={!selected.size||busy} onClick={()=>applyInline('approved')} className="rounded-lg bg-emerald-600 text-white px-4 py-2 text-sm font-semibold disabled:opacity-40 flex justify-center items-center gap-1"><CheckCircle2 className="w-4 h-4"/>Approve ({selected.size})</button><button disabled={!selected.size||busy} onClick={()=>applyInline('redo')} className="rounded-lg bg-amber-600 text-white px-4 py-2 text-sm font-semibold disabled:opacity-40 flex justify-center items-center gap-1"><Wrench className="w-4 h-4"/>Reject / Redo ({selected.size})</button></div>{reviewError&&<p className="text-xs text-red-600 mt-2">{reviewError}</p>}</div>}
    {(proofs||[]).some((p:any)=>!p.work_item_id)&&<div className="rounded-xl border border-amber-200 bg-amber-50 p-3"><p className="text-xs font-semibold text-amber-800">Legacy/unmapped installation photos</p><p className="text-[11px] text-amber-700 mt-0.5">These older proofs are not automatically assigned to a measurement.</p><div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-2">{(proofs||[]).filter((p:any)=>!p.work_item_id).map((p:any)=><Photo key={p.id} url={p.photo_url} label="Unmapped proof" reviewKey={`installation_photo:${p.id}`} decision={dmap.get(`installation_photo:${p.id}`)}/>)}</div></div>}
  </div>;
}

function ReviewProofPhotos({ jobId, onOpenPhoto }: { jobId: string; onOpenPhoto: (url: string) => void }) {
  const { data: photos } = useQuery({
    queryKey: ['review-installation-photos', jobId],
    queryFn: async () => {
      const { data } = await supabase.from('installation_proofs').select('*').eq('installation_job_id', jobId).order('captured_at');
      return data as InstallationProof[];
    },
    enabled: !!jobId,
  });

  if (!photos || photos.length === 0) {
    return <p className="text-xs text-slate-400">No proof photos.</p>;
  }

  return (
    <div className="grid grid-cols-3 gap-2">
      {photos.map((photo) => (
        <button key={photo.id} onClick={() => onOpenPhoto(photo.photo_url)} className="relative rounded-lg overflow-hidden border border-slate-200 cursor-zoom-in group">
          <img src={photo.photo_url} alt={photo.photo_type} className="w-full aspect-square object-cover group-hover:opacity-90 transition" />
          <span className="absolute top-1 right-1 bg-blue-600 text-white text-[9px] font-medium px-1 py-0.5 rounded capitalize">{photo.angle || photo.photo_type}</span>
          {photo.duplicate_flag && (
            <span className="absolute bottom-1 left-1 right-1 bg-amber-600 text-white text-[9px] font-semibold px-1 py-0.5 rounded text-center">
              ⚠ Possible duplicate
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

// The design reference an installer was supposed to work from — survey
// photos with their approved board markings drawn on top (same rendering
// as the shop profile page), fetched by shop rather than by job so it's
// there even for jobs that predate this review flow. Put next to the
// installer's own proof photos so a mismatch is obvious at a glance.
function DesignReferencePhotos({ shopId }: { shopId: string }) {
  const { data: surveyPhotos } = useQuery({
    queryKey: ['review-survey-photos', shopId],
    queryFn: async () => {
      const { data } = await supabase.from('survey_photos').select('*').eq('shop_id', shopId).order('created_at');
      return data as SurveyPhoto[];
    },
    enabled: !!shopId,
  });

  const { data: boardMarkings } = useQuery({
    queryKey: ['review-board-markings', shopId, surveyPhotos],
    queryFn: async () => {
      const photoIds = (surveyPhotos || []).map((p) => p.id);
      if (photoIds.length === 0) return [] as BoardMarking[];
      const { data } = await supabase.from('board_markings').select('*').in('survey_photo_id', photoIds);
      return data as BoardMarking[];
    },
    enabled: !!surveyPhotos,
  });

  const { data: workItems } = useQuery({
    queryKey: ['review-work-items', shopId],
    queryFn: async () => {
      const { data } = await supabase.from('work_items').select('*').eq('shop_id', shopId);
      return data as WorkItem[];
    },
    enabled: !!shopId,
  });

  if (!surveyPhotos || surveyPhotos.length === 0) {
    return <p className="text-xs text-slate-400">No marked design photos on record for this shop.</p>;
  }

  return <MarkedPhotoGrid photos={surveyPhotos} markings={boardMarkings || []} workItems={workItems || []} />;
}


function InstallationCorrectionPicker({ job, value, onChange }: { job:any; value:Record<string, any>; onChange:(v:Record<string, any>)=>void }) {
  const { data: items } = useQuery({ queryKey:['install-correction-items',job.shop_id], queryFn:async()=>{ const {data}=await supabase.from('work_items').select('id,work_type_name,approved_width,approved_height,approved_unit,approved_quantity').eq('shop_id',job.shop_id).order('created_at'); return data||[]; }});
  const { data: proofs } = useQuery({ queryKey:['install-correction-proofs',job.id], queryFn:async()=>{ const {data}=await supabase.from('installation_proofs').select('id,photo_url,work_item_id,angle').eq('installation_job_id',job.id).order('captured_at'); return data||[]; }});
  const toggle=(key:string,row:any)=>{ const n={...value}; if(n[key]) delete n[key]; else n[key]={...row,note:''}; onChange(n); };
  const note=(key:string,v:string)=>onChange({...value,[key]:{...value[key],note:v}});
  return <div className="rounded-xl border border-amber-200 bg-amber-50/50 p-3 space-y-3">
    <div><p className="text-sm font-semibold text-slate-900">Select only what needs correction</p><p className="text-xs text-slate-500">The same installer receives only these Work Items/photos. Correct evidence is preserved.</p></div>
    {(items||[]).map((it:any)=>{ const k=`wi:${it.id}`, checked=!!value[k], ps=(proofs||[]).filter((p:any)=>p.work_item_id===it.id); return <div key={it.id} className="rounded-lg border border-slate-200 bg-white p-3">
      <label className="flex items-start gap-2 cursor-pointer"><input type="checkbox" checked={checked} onChange={()=>toggle(k,{issue_type:'work_item',work_item_id:it.id})} className="mt-1"/><span><b className="text-sm">{it.work_type_name||'Work item'}</b><span className="block text-xs text-slate-500">{it.approved_width??'—'} × {it.approved_height??'—'} {it.approved_unit||''} · Qty {it.approved_quantity??1}</span></span></label>
      {checked&&<input value={value[k]?.note||''} onChange={e=>note(k,e.target.value)} placeholder="What exactly must be corrected?" className="mt-2 w-full rounded-lg border border-slate-300 px-2.5 py-2 text-xs"/>}
      {ps.length>0&&<div className="grid grid-cols-3 gap-2 mt-2">{ps.map((p:any)=>{const pk=`proof:${p.id}`, pc=!!value[pk]; return <div key={p.id}><button type="button" onClick={()=>toggle(pk,{issue_type:'installation_photo',work_item_id:it.id,installation_proof_id:p.id})} className={`w-full rounded-lg border-2 overflow-hidden ${pc?'border-red-500 ring-2 ring-red-100':'border-slate-200'}`}><img src={p.photo_url} className="w-full aspect-[4/3] object-contain bg-slate-100"/><span className={`block text-[10px] py-1 ${pc?'bg-red-50 text-red-700':'bg-white text-slate-500'}`}>{pc?'Marked for correction':(p.angle||'Photo')}</span></button>{pc&&<input value={value[pk]?.note||''} onChange={e=>note(pk,e.target.value)} placeholder="Photo issue" className="mt-1 w-full rounded border px-2 py-1 text-[10px]"/>}</div>})}</div>}
    </div>})}
  </div>;
}
