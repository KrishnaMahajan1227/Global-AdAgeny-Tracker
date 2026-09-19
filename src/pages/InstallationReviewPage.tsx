import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { Card, EmptyState, PageHeader, Modal, Textarea } from '@/components/ui';
import { MarkedPhotoGrid } from '@/components/MarkedPhotoGrid';
import { logAudit, createNotification } from '@/lib/helpers';
import { useRealtimeInvalidate } from '@/lib/useRealtimeInvalidate';
import type { InstallationProof, SurveyPhoto, BoardMarking, WorkItem } from '@/lib/types';
import {
  CheckCircle2, XCircle, Wrench, AlertTriangle, Truck, Search, CheckSquare, Square,
  SlidersHorizontal, X, Eye, Loader2, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Images,
  Palette, Camera,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { ItemLevelReviewPanel } from '@/components/ItemLevelReviewPanel';

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

const PAGE_SIZE_OPTIONS = [20, 50, 100];

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

  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const [reviewModal, setReviewModal] = useState<any | null>(null);
  const [action, setAction] = useState<'approve' | 'reject'>('approve');
  const [note, setNote] = useState('');
  const [reopenForRedo, setReopenForRedo] = useState(false);
  const [correctionTargets, setCorrectionTargets] = useState<Record<string, { issue_type: 'work_item' | 'installation_photo'; work_item_id?: string; installation_proof_id?: string; note: string }>>({});

  const [bulkModalOpen, setBulkModalOpen] = useState(false);
  const [bulkAction, setBulkAction] = useState<'approve' | 'reject'>('approve');
  const [bulkNote, setBulkNote] = useState('');

  // Full-size photo preview — shared by row thumbnails, the review modal's
  // installation proofs, and the material-check photo, so any photo
  // anywhere on this page opens the same way.
  const [lightbox, setLightbox] = useState<string | null>(null);

  // Any filter/tab change invalidates page + selection — stale selections
  // pointing at rows that may no longer be in the result set are worse
  // than an empty one.
  useEffect(() => { setPage(0); }, [tab, debouncedSearch, installerFilter, flagFilter, sortBy, pageSize]);
  useEffect(() => { setSelectMode(false); setSelectedIds(new Set()); }, [tab, debouncedSearch, installerFilter, flagFilter, sortBy, page, pageSize]);

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
  const jobsQueryKey = ['installation-review', orgId, { tab, q: debouncedSearch, installerFilter, flagFilter, sortBy, page, pageSize }];
  const { data: jobsPage, isFetching: jobsLoading } = useQuery({
    queryKey: jobsQueryKey,
    queryFn: async () => {
      let query = supabase
        .from('installation_jobs')
        .select(
          '*, shops!inner(name, city, clients(name)), profiles:installer_id(id, full_name), confirmed_by_profile:material_check_confirmed_by(full_name), installation_proofs(id, photo_url, storage_path, photo_type, angle, duplicate_flag, work_item_id)',
          { count: 'exact' }
        )
        .eq('organization_id', orgId)
        .eq('review_status', tab);

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
  const hasActiveFilters = !!(search || installerFilter || flagFilter);

  useRealtimeInvalidate(['installation_jobs'], orgId, [jobsQueryKey, countsQueryKey, ['dashboard-stats', orgId]]);

  function invalidateAll() {
    queryClient.invalidateQueries({ queryKey: ['installation-review'] });
    queryClient.invalidateQueries({ queryKey: countsQueryKey });
    queryClient.invalidateQueries({ queryKey: ['shops'] });
    queryClient.invalidateQueries({ queryKey: ['dashboard-stats', orgId] });
    queryClient.invalidateQueries({ queryKey: ['nav-pending-counts', orgId] });
  }

  async function applyDecision(job: any, decision: 'approve' | 'reject', decisionNote: string) {
    const newReviewStatus = decision === 'approve' ? 'approved' : 'rejected';

    const { error: jobError } = await supabase.from('installation_jobs').update({
      review_status: newReviewStatus,
      reviewed_at: new Date().toISOString(),
      reviewed_by: profile!.id,
      review_note: decisionNote || null,
    }).eq('id', job.id).select('id');
    if (jobError) throw new Error(`${job.shops?.name}: ${jobError.message}`);

    if (decision === 'approve') {
      // Do not let a whole shop bypass the item-by-item review. Every
      // approved Work Item and every installation proof must have its own
      // explicit APPROVED decision; any REDO keeps final approval blocked.
      const [{ data: reviewItems }, { data: reviewProofs }, { data: itemDecisions, error: decisionError }] = await Promise.all([
        supabase.from('work_items').select('id').eq('shop_id', job.shop_id),
        supabase.from('installation_proofs').select('id').eq('installation_job_id', job.id),
        supabase.from('field_review_decisions').select('entity_type,entity_id,decision').eq('stage','installation').eq('installation_job_id',job.id),
      ]);
      if (decisionError) throw new Error(`Item-level review migration is required before final approval: ${decisionError.message}`);
      const approved = new Set((itemDecisions || []).filter((d:any)=>d.decision==='approved').map((d:any)=>`${d.entity_type}:${d.entity_id}`));
      const required = [...(reviewItems||[]).map((r:any)=>`work_item:${r.id}`), ...(reviewProofs||[]).map((r:any)=>`installation_photo:${r.id}`)];
      const pending = required.filter(k=>!approved.has(k));
      if (pending.length) throw new Error(`Review every Work Item/photo first. ${pending.length} item(s) are still unapproved or marked for redo.`);
      await supabase.from('field_corrections').update({ status: 'resolved', resolved_at: new Date().toISOString() }).eq('installation_job_id', job.id).in('status', ['open','resubmitted']);
      // The write that finally makes the shop billable — gated in the
      // database to only be reachable from here, by Owner/Admin/Demo.
      const { error: shopError } = await supabase.from('shops').update({ status: 'installed' }).eq('id', job.shop_id).select('id');
      if (shopError) throw new Error(`${job.shops?.name}: ${shopError.message}`);
    } else {
      // Granular redo: return ONLY the failed measurement/photo to the same installer.
      // Good evidence remains approved/preserved and is not re-uploaded.
      const selectedCorrections = Object.values(correctionTargets);
      if (!selectedCorrections.length) throw new Error('Select at least one exact Work Item or installation photo that needs correction.');
      await supabase.from('field_corrections').update({ status: 'cancelled' }).eq('installation_job_id', job.id).eq('status', 'open');
      const correctionRows = selectedCorrections.map((c) => ({
        organization_id: job.organization_id, shop_id: job.shop_id, stage: 'installation', installation_job_id: job.id,
        work_item_id: c.work_item_id || null, installation_proof_id: c.installation_proof_id || null,
        assigned_to: job.installer_id, requested_by: profile!.id, issue_type: c.issue_type, note: c.note || decisionNote || null, status: 'open',
      }));
      const { error: correctionError } = await supabase.from('field_corrections').insert(correctionRows);
      if (correctionError) throw new Error(`Could not create correction tasks: ${correctionError.message}`);

      // Delete ONLY proofs explicitly marked bad (or proofs belonging to a Work Item
      // marked for redo). Everything else stays as valid evidence.
      const rejectedProofs = (job.installation_proofs || []) as { id: string; storage_path?: string | null; work_item_id?: string | null }[];
      const badProofIds = new Set(selectedCorrections.flatMap(c => c.installation_proof_id ? [c.installation_proof_id] : []));
      const badWorkItemIds = new Set(selectedCorrections.flatMap(c => c.issue_type === 'work_item' && c.work_item_id ? [c.work_item_id] : []));
      const proofsToRemove = rejectedProofs.filter(p => badProofIds.has(p.id) || (!!p.work_item_id && badWorkItemIds.has(p.work_item_id)));
      const rejectedPaths = proofsToRemove.map((p) => p.storage_path).filter(Boolean) as string[];
      if (rejectedPaths.length) {
        const { error: storageError } = await supabase.storage.from('installation-proof').remove(rejectedPaths);
        if (storageError) console.error('[InstallationReview] rejected proof storage cleanup:', storageError.message);
      }
      const removeIds = proofsToRemove.map(p => p.id);
      const { error: proofDeleteError } = removeIds.length ? await supabase.from('installation_proofs').delete().in('id', removeIds) : { error: null };
      if (proofDeleteError) throw new Error(`${job.shops?.name}: could not clear rejected photos: ${proofDeleteError.message}`);

      // Redo: send the shop back to the installer's own list, and reset
      // the assignment so "Start Install" is enabled again.
      const { error: shopError } = await supabase.from('shops').update({ status: 'installation_pending' }).eq('id', job.shop_id).select('id');
      if (shopError) throw new Error(`${job.shops?.name}: ${shopError.message}`);
      await supabase.from('shop_assignments').update({ status: 'assigned', completed_at: null })
        .eq('shop_id', job.shop_id).eq('user_id', job.installer_id).eq('role', 'installer').select('id');
    }

    await logAudit('installation_jobs', job.id, decision, 'review_status', job.review_status, newReviewStatus, `Installation ${decision === 'approve' ? 'approved' : 'sent back for redo'} for ${job.shops?.name}`);
    await createNotification(
      job.installer_id,
      decision === 'approve' ? 'Installation Approved' : 'Installation Needs Redo',
      decision === 'approve'
        ? `Your installation for ${job.shops?.name} was approved.`
        : `Your installation for ${job.shops?.name} needs redo. ${decisionNote || ''}`,
      'info',
      '/mobile'
    );
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

  const bulkMutation = useMutation({
    mutationFn: async () => {
      const targets = rows.filter((r) => selectedIds.has(r.id));
      if (targets.length === 0) throw new Error('Select at least one installation first.');
      for (const job of targets) {
        await applyDecision(job, bulkAction, bulkNote);
      }
    },
    onSuccess: () => {
      invalidateAll();
      setBulkModalOpen(false);
      setSelectMode(false);
      setSelectedIds(new Set());
      setBulkNote('');
    },
  });

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

  function openBulk(act: 'approve' | 'reject') {
    setBulkAction(act);
    setBulkNote('');
    setBulkModalOpen(true);
  }

  const selectedJobs = rows.filter((r) => selectedIds.has(r.id));

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

      {tab === 'pending' && (
        <div className="flex items-center justify-end mb-3">
          <button
            onClick={() => { setSelectMode((v) => !v); setSelectedIds(new Set()); }}
            className={`flex items-center gap-2 px-3.5 py-2 rounded-lg font-medium text-sm transition border ${
              selectMode ? 'bg-blue-50 text-blue-700 border-blue-200' : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'
            }`}
          >
            {selectMode ? <CheckSquare className="w-4 h-4" /> : <Square className="w-4 h-4" />} Select Multiple
          </button>
        </div>
      )}

      {selectMode && (
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4 bg-blue-50 border border-blue-200 rounded-lg px-4 py-2.5">
          <p className="text-sm text-blue-800 font-medium">
            {selectedIds.size} selected
            {total > pageSize && <span className="font-normal text-blue-600"> (this page only)</span>}
          </p>
          <div className="flex items-center gap-2">
            <button onClick={() => setSelectedIds(new Set(rows.map((r) => r.id)))} className="text-xs font-medium text-blue-700 hover:underline">
              Select all on this page
            </button>
            <button
              onClick={() => openBulk('reject')}
              disabled={selectedIds.size === 0}
              className="flex items-center gap-1.5 bg-white text-red-600 border border-red-200 hover:bg-red-50 px-3 py-1.5 rounded-lg text-xs font-medium disabled:opacity-50"
            >
              <XCircle className="w-3.5 h-3.5" /> Bulk Reject / Redo
            </button>
            <button
              onClick={() => openBulk('approve')}
              disabled={selectedIds.size === 0}
              className="flex items-center gap-1.5 bg-green-600 hover:bg-green-700 text-white px-3 py-1.5 rounded-lg text-xs font-medium disabled:opacity-50"
            >
              <CheckCircle2 className="w-3.5 h-3.5" /> Bulk Approve
            </button>
          </div>
        </div>
      )}

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
            <button onClick={() => { setSearch(''); setInstallerFilter(''); setFlagFilter(''); }} className="text-xs text-slate-500 hover:text-slate-700 flex items-center gap-1 font-medium">
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
                              alt=""
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
          {reviewModal && <MaterialLoadedSummary job={reviewModal} onOpenPhoto={setLightbox} />}

          {/* Design reference (what was approved) next to the installer's
              own proof (what actually went up) — side by side so a
              mismatch jumps out without leaving this modal. */}
          {reviewModal && (
            <div>
              <p className="text-xs font-medium text-slate-700 flex items-center gap-1.5 mb-2"><Palette className="w-3.5 h-3.5" /> Work Item Evidence — Survey → Measurement → Design → Installation</p>
              <WorkItemEvidenceReview shopId={reviewModal.shop_id} jobId={reviewModal.id} onOpenPhoto={setLightbox} />
              <ItemLevelReviewPanel stage="installation" shopId={reviewModal.shop_id} jobId={reviewModal.id} assignedTo={reviewModal.installer_id} readOnly={reviewModal.review_status !== 'pending'} />
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
            <>
              {action === 'reject' && reviewModal && <InstallationCorrectionPicker job={reviewModal} value={correctionTargets} onChange={setCorrectionTargets} />}
              <Textarea label="Review Note (sent to installer)" value={note} onChange={setNote} rows={3} placeholder={action === 'approve' ? 'Optional note...' : 'Overall note (optional when each selected issue has its own note)...'} />
              {reviewMutation.isError && (
                <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-2">{(reviewMutation.error as Error).message}</p>
              )}
              <button
                onClick={() => reviewMutation.mutate()}
                disabled={reviewMutation.isPending}
                className={`w-full text-white font-medium py-2.5 rounded-lg disabled:opacity-50 ${action === 'approve' ? 'bg-green-600 hover:bg-green-700' : 'bg-red-600 hover:bg-red-700'}`}
              >
                {reviewMutation.isPending ? 'Processing...' : `Confirm ${action === 'approve' ? 'Approval' : 'Redo Request'}`}
              </button>
            </>
          )}
        </div>
      </Modal>

      {/* Bulk review — the actual "10,000 shops" flow: pick several rows,
          look at their proof photos together, then finalize in one shot. */}
      <Modal
        open={bulkModalOpen}
        onClose={() => setBulkModalOpen(false)}
        title={`Bulk ${bulkAction === 'approve' ? 'Approve' : 'Reject / Redo'} — ${selectedJobs.length} installation${selectedJobs.length === 1 ? '' : 's'}`}
        size="lg"
      >
        <div className="space-y-4">
          <div className="max-h-72 overflow-y-auto border border-slate-200 rounded-lg divide-y divide-slate-100">
            {selectedJobs.map((j) => {
              const photos: any[] = j.installation_proofs || [];
              return (
                <div key={j.id} className="flex items-center gap-3 px-3 py-2">
                  <div className="flex -space-x-2 shrink-0">
                    {photos.length === 0 ? (
                      <div className="w-9 h-9 rounded-md bg-slate-100 flex items-center justify-center"><Images className="w-4 h-4 text-slate-300" /></div>
                    ) : (
                      photos.slice(0, 3).map((p) => (
                        <img
                          key={p.id}
                          src={p.photo_url}
                          alt=""
                          onClick={() => setLightbox(p.photo_url)}
                          className="w-9 h-9 rounded-md object-cover border-2 border-white shadow-sm cursor-zoom-in hover:scale-105 transition"
                        />
                      ))
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-slate-900 truncate">{j.shops?.name}</p>
                    <p className="text-xs text-slate-500 truncate">{j.profiles?.full_name} · {j.shops?.city}</p>
                  </div>
                  {(j.gps_distance_flag || photos.some((p) => p.duplicate_flag)) && (
                    <span title="Has a flag — worth a closer look" className="shrink-0">
                      <AlertTriangle className="w-4 h-4 text-amber-500" />
                    </span>
                  )}
                </div>
              );
            })}
          </div>
          <Textarea
            label="Review Note (sent to each installer)"
            value={bulkNote}
            onChange={setBulkNote}
            rows={3}
            placeholder={bulkAction === 'approve' ? 'Optional note...' : 'Please explain what needs to be redone...'}
          />
          {bulkMutation.isError && (
            <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-2">{(bulkMutation.error as Error).message}</p>
          )}
          <button
            onClick={() => bulkMutation.mutate()}
            disabled={bulkMutation.isPending}
            className={`w-full text-white font-medium py-2.5 rounded-lg disabled:opacity-50 ${bulkAction === 'approve' ? 'bg-green-600 hover:bg-green-700' : 'bg-red-600 hover:bg-red-700'}`}
          >
            {bulkMutation.isPending ? 'Processing...' : `Confirm ${bulkAction === 'approve' ? 'Approval' : 'Redo Request'} for ${selectedJobs.length}`}
          </button>
        </div>
      </Modal>

      {lightbox && (
        <div onClick={() => setLightbox(null)} className="fixed inset-0 z-[100] bg-black/80 flex items-center justify-center p-4 cursor-zoom-out">
          <img src={lightbox} alt="Full size" className="max-w-full max-h-full rounded-lg" />
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
function WorkItemEvidenceReview({ shopId, jobId, onOpenPhoto }: { shopId: string; jobId: string; onOpenPhoto: (url: string) => void }) {
  const { data: workItems } = useQuery({
    queryKey: ['review-evidence-work-items', shopId],
    queryFn: async () => {
      const { data, error } = await supabase.from('work_items').select('*').eq('shop_id', shopId).order('created_at');
      if (error) throw new Error(error.message);
      return (data || []) as WorkItem[];
    }, enabled: !!shopId,
  });
  const { data: surveyPhotos } = useQuery({
    queryKey: ['review-evidence-survey-photos', shopId],
    queryFn: async () => {
      const { data, error } = await supabase.from('survey_photos').select('*').eq('shop_id', shopId).order('created_at');
      if (error) throw new Error(error.message);
      return (data || []) as SurveyPhoto[];
    }, enabled: !!shopId,
  });
  const { data: markings } = useQuery({
    queryKey: ['review-evidence-markings', shopId, surveyPhotos?.length],
    queryFn: async () => {
      const ids = (surveyPhotos || []).map(p => p.id); if (!ids.length) return [] as BoardMarking[];
      const { data, error } = await supabase.from('board_markings').select('*').in('survey_photo_id', ids);
      if (error) throw new Error(error.message); return (data || []) as BoardMarking[];
    }, enabled: !!surveyPhotos,
  });
  const { data: photoLinks } = useQuery({
    queryKey: ['review-evidence-photo-links', shopId, surveyPhotos?.length],
    queryFn: async () => {
      const ids = (surveyPhotos || []).map(p => p.id); if (!ids.length) return [] as any[];
      const { data, error } = await supabase.from('survey_photo_items').select('survey_photo_id, work_item_id').in('survey_photo_id', ids);
      if (error && /survey_photo_items|schema cache|could not find the table/i.test(error.message || '')) return [];
      if (error) throw new Error(error.message); return data || [];
    }, enabled: !!surveyPhotos,
  });
  const { data: designTasks } = useQuery({
    queryKey: ['review-evidence-designs', shopId],
    queryFn: async () => {
      const { data, error } = await supabase.from('design_tasks').select('id, design_versions(*, design_version_items(work_item_id))').eq('shop_id', shopId);
      if (error) throw new Error(error.message); return data || [];
    }, enabled: !!shopId,
  });
  const { data: proofs } = useQuery({
    queryKey: ['review-evidence-proofs', jobId],
    queryFn: async () => {
      const { data, error } = await supabase.from('installation_proofs').select('*').eq('installation_job_id', jobId).order('captured_at');
      if (error) throw new Error(error.message); return (data || []) as any[];
    }, enabled: !!jobId,
  });
  const items = workItems || [];
  if (!items.length) return <p className="text-xs text-slate-400">No approved work items found for this shop.</p>;
  const dim = (it:any) => {
    const w=it.approved_width ?? it.survey_width, h=it.approved_height ?? it.survey_height, u=it.approved_unit ?? it.survey_unit ?? 'ft';
    const q=it.approved_quantity ?? it.survey_quantity ?? 1, a=it.approved_area ?? it.survey_area;
    return `${w ?? '—'} × ${h ?? '—'} ${u} · Qty ${q}${a != null ? ` · ${Number(a).toFixed(2)} sq.ft` : ''}`;
  };
  const Photo = ({url,label}:{url?:string|null;label:string}) => url ? (
    <button onClick={()=>onOpenPhoto(url)} className="group relative overflow-hidden rounded-xl border border-slate-200 bg-slate-50 text-left">
      <img src={url} alt={label} className="w-full aspect-[4/3] object-contain bg-slate-100" />
      <span className="absolute left-2 bottom-2 rounded-md bg-slate-950/75 px-2 py-1 text-[10px] font-medium text-white">{label}</span>
    </button>
  ) : <div className="aspect-[4/3] rounded-xl border border-dashed border-slate-200 bg-slate-50 flex items-center justify-center text-[11px] text-slate-400">No {label.toLowerCase()}</div>;
  return <div className="space-y-3">
    {items.map((item:any, index:number)=>{
      const linkedSurvey=(surveyPhotos||[]).filter(p => (photoLinks||[]).some((x:any)=>x.work_item_id===item.id && x.survey_photo_id===p.id) || (markings||[]).some(m=>m.work_item_id===item.id && m.survey_photo_id===p.id));
      const designs=(designTasks||[]).flatMap((t:any)=>t.design_versions||[]).filter((v:any)=>(v.design_version_items||[]).some((x:any)=>x.work_item_id===item.id)).sort((a:any,b:any)=>(b.version_number||0)-(a.version_number||0));
      const itemProofs=(proofs||[]).filter((p:any)=>p.work_item_id===item.id);
      return <div key={item.id} className="rounded-2xl border border-slate-200 bg-white overflow-hidden shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3 px-4 py-3 bg-slate-50 border-b border-slate-200">
          <div><p className="text-[10px] font-bold tracking-[.16em] text-slate-400 uppercase">Work Item {index+1}</p><h4 className="text-sm font-semibold text-slate-900 mt-0.5">{item.work_type_name || 'Work item'}</h4><p className="text-xs text-slate-500 mt-1">{dim(item)}</p></div>
          <span className={`rounded-full px-2.5 py-1 text-[10px] font-semibold ${itemProofs.length?'bg-emerald-50 text-emerald-700 border border-emerald-200':'bg-amber-50 text-amber-700 border border-amber-200'}`}>{itemProofs.length} installation photo{itemProofs.length===1?'':'s'}</span>
        </div>
        <div className="p-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div><p className="text-[10px] font-bold uppercase tracking-wider text-blue-600 mb-1.5">1 · Survey / Measurement</p><Photo url={linkedSurvey[0]?.photo_url} label="Survey" />{linkedSurvey.length>1&&<p className="text-[10px] text-slate-400 mt-1">+{linkedSurvey.length-1} more survey photo(s)</p>}</div>
            <div><p className="text-[10px] font-bold uppercase tracking-wider text-violet-600 mb-1.5">2 · Approved Design</p><Photo url={designs[0]?.file_url} label={designs[0] ? `Design v${designs[0].version_number}` : 'Design'} /></div>
            <div><p className="text-[10px] font-bold uppercase tracking-wider text-emerald-600 mb-1.5">3 · Installed Proof</p>{itemProofs.length?<div className="grid grid-cols-2 gap-2">{itemProofs.map((p:any)=><Photo key={p.id} url={p.photo_url} label={p.angle || 'Installed'} />)}</div>:<Photo label="Installation proof" />}</div>
          </div>
        </div>
      </div>;
    })}
    {(proofs||[]).some((p:any)=>!p.work_item_id) && <div className="rounded-xl border border-amber-200 bg-amber-50 p-3"><p className="text-xs font-semibold text-amber-800">Legacy/unmapped installation photos</p><p className="text-[11px] text-amber-700 mt-0.5">These proofs predate Work Item mapping. They are shown separately and are not silently assigned to a measurement.</p><div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-2">{(proofs||[]).filter((p:any)=>!p.work_item_id).map((p:any)=><Photo key={p.id} url={p.photo_url} label="Unmapped proof" />)}</div></div>}
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
