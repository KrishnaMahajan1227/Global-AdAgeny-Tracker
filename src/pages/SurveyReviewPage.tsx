import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNowStrict } from 'date-fns';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { Drawer, Modal, Card, StatusBadge, EmptyState, PageHeader, Textarea, Select } from '@/components/ui';
import { logAudit, createNotification } from '@/lib/helpers';
import { useRealtimeInvalidate } from '@/lib/useRealtimeInvalidate';
import { MarkedPhotoGrid } from '@/components/MarkedPhotoGrid';
import { formatDim } from '@/lib/units';
import type { SurveyPhoto, BoardMarking, WorkItem, POLineItemWorkContext } from '@/lib/types';
import { computePOVariance } from '@/lib/poVariance';
import {
  CheckCircle2, XCircle, AlertCircle, AlertTriangle, FileText, ChevronRight, ChevronLeft, ChevronsLeft, ChevronsRight,
  MapPin, StickyNote, Search, SlidersHorizontal, CheckSquare, Square, X, Loader2, Clock, Eye,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { ItemLevelReviewPanel } from '@/components/ItemLevelReviewPanel';
import { reviewApply, refreshReviewViews, type ReviewEntity } from '@/lib/reviewApi';

type ReviewAction = 'approve' | 'reject' | 'correction';

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

/**
 * The single place that actually performs a review decision — approve,
 * reject, or request correction — for exactly one survey. Both the
 * single-survey drawer and the bulk-review modal call this same function,
 * so a bulk approval can never diverge from what a one-at-a-time approval
 * does: same status writes, same work-item copy-to-approved, same design
 * task creation, same notifications. Throws on the first failure so the
 * caller's loop can report exactly which survey failed and why, instead
 * of a bulk action silently leaving some surveys half-updated.
 */
async function applySurveyDecision(params: {
  survey: any;
  decision: ReviewAction;
  note: string;
  reviewerId: string;
  designerId?: string;
  varianceNotes?: Record<string, string>;
  correctionTargets?: Record<string, { issue_type: 'measurement' | 'survey_photo'; work_item_id?: string; survey_photo_id?: string; note: string }>;
}) {
  const { survey, decision, note, designerId, varianceNotes, correctionTargets } = params;
  const name = survey.shops?.name || 'Survey';
  // Every decision is ONE atomic server call (migration 0090) — nothing is ever half-applied.
  if (decision === 'approve') {
    if (!designerId) throw new Error(`${name}: pick a designer before approving.`);
    const res = await reviewApply({ stage: 'survey', shopId: survey.shop_id, refId: survey.id, decision: 'approved', note, designerId, variance: varianceNotes });
    if (!res.finalized) {
      throw new Error(res.redo > 0
        ? `${name}: ${res.redo} item(s) are still marked for redo — they must be corrected first.`
        : `${name}: could not finalize the approval (${res.pending} item(s) pending).`);
    }
    return;
  }
  if (decision === 'reject') {
    await reviewApply({ stage: 'survey', shopId: survey.shop_id, refId: survey.id, decision: 'redo', note });
    return;
  }
  const selected = Object.values(correctionTargets || {});
  if (!selected.length) throw new Error('Select at least one exact measurement or survey photo that needs correction.');
  const entities: ReviewEntity[] = selected.map((c) => c.issue_type === 'survey_photo'
    ? { type: 'survey_photo', id: c.survey_photo_id! } : { type: 'measurement', id: c.work_item_id! });
  await reviewApply({ stage: 'survey', shopId: survey.shop_id, refId: survey.id, entities, decision: 'redo', note: note || selected.map((c) => c.note).filter(Boolean).join(' | ') });
}

export default function SurveyReviewPage() {
  const { profile } = useAuth();
  const orgId = profile?.organization_id;
  const queryClient = useQueryClient();

  const [tab, setTab] = useState<TabKey>('pending');
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search.trim(), 350);
  const [surveyorFilter, setSurveyorFilter] = useState('');
  const [sortBy, setSortBy] = useState<'submitted_asc' | 'submitted_desc' | 'shop_asc'>('submitted_asc');
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(PAGE_SIZE_OPTIONS[0]);

  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // The survey currently open in the review drawer. Opening it never
  // implies a decision — Admin/Owner sees every detail first, and only
  // picks approve/reject/correction inside the drawer once they've
  // actually looked.
  const [selectedSurvey, setSelectedSurvey] = useState<any | null>(null);
  const [action, setAction] = useState<ReviewAction | null>(null);
  const [note, setNote] = useState('');
  const [designerId, setDesignerId] = useState('');
  // Section 8 — adjustment note per work item, keyed by work_item.id, only
  // filled in when Admin/Owner chooses to explain a variance (never
  // required — exceeding budget is allowed, just never silent).
  const [varianceNotes, setVarianceNotes] = useState<Record<string, string>>({});
  const [correctionTargets, setCorrectionTargets] = useState<Record<string, { issue_type: 'measurement' | 'survey_photo'; work_item_id?: string; survey_photo_id?: string; note: string }>>({});

  const [bulkModalOpen, setBulkModalOpen] = useState(false);
  const [bulkAction, setBulkAction] = useState<ReviewAction>('approve');
  const [bulkNote, setBulkNote] = useState('');
  const [bulkDesignerId, setBulkDesignerId] = useState('');

  useEffect(() => { setPage(0); }, [tab, debouncedSearch, surveyorFilter, sortBy, pageSize]);
  useEffect(() => { setSelectMode(false); setSelectedIds(new Set()); }, [tab, debouncedSearch, surveyorFilter, sortBy, page, pageSize]);

  const isPendingSurvey = selectedSurvey?.status === 'submitted';

  const closeDrawer = () => {
    setSelectedSurvey(null);
    setAction(null);
    setNote('');
    setDesignerId('');
    setVarianceNotes({});
    setCorrectionTargets({});
  };

  const openReview = (survey: any) => {
    setSelectedSurvey(survey);
    setAction(null);
    setNote('');
    setDesignerId('');
    setVarianceNotes({});
    setCorrectionTargets({});
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
  const surveysQueryKey = ['surveys-review', orgId, { tab, q: debouncedSearch, surveyorFilter, sortBy, page, pageSize }];
  const { data: surveysPage, isFetching: surveysLoading, error: surveysError } = useQuery({
    queryKey: surveysQueryKey,
    queryFn: async () => {
      let query = supabase
        .from('surveys')
        // `surveys` has TWO foreign keys into `profiles` (surveyor_id AND
        // reviewed_by) — naming the FK column (`profiles:surveyor_id`)
        // resolves the otherwise-ambiguous embed.
        .select('*, shops!inner(name, city, status, purchase_order_id, clients(name)), profiles:surveyor_id(full_name)', { count: 'exact' })
        .eq('organization_id', orgId)
        .in('status', statusesForTab(tab));
      // A shop already past survey (design/production/installation/done) can never sit in Pending Survey Review.
      if (tab === 'pending') query = query.not('shops.status', 'in', '(design_pending,designing,design_ready,in_review,design_approved,production_pending,in_production,production_ready,production_hold,production_done,dispatched,installation_pending,installing,installation_review,installed,billed,cancelled)');

      if (surveyorFilter) query = query.eq('surveyor_id', surveyorFilter);
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
  const hasActiveFilters = !!(search || surveyorFilter);

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

  const reviewMutation = useMutation({
    mutationFn: async () => {
      if (!selectedSurvey || !action) return;
      await applySurveyDecision({ survey: selectedSurvey, decision: action, note, reviewerId: profile!.id, designerId, varianceNotes, correctionTargets });
    },
    onSuccess: () => { invalidateAll(); closeDrawer(); },
  });

  const bulkMutation = useMutation({
    mutationFn: async () => {
      const targets = rows.filter((r) => selectedIds.has(r.id));
      if (targets.length === 0) throw new Error('Select at least one survey first.');
      if (bulkAction === 'approve' && !bulkDesignerId) throw new Error('Pick a designer to assign these to before approving.');
      for (const survey of targets) {
        // eslint-disable-next-line no-await-in-loop
        await applySurveyDecision({ survey, decision: bulkAction, note: bulkNote, reviewerId: profile!.id, designerId: bulkDesignerId });
      }
    },
    onSuccess: () => {
      invalidateAll();
      setBulkModalOpen(false);
      setSelectMode(false);
      setSelectedIds(new Set());
      setBulkNote('');
      setBulkDesignerId('');
    },
  });

  function toggleSelected(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function openBulk(act: ReviewAction) {
    setBulkAction(act);
    setBulkNote('');
    setBulkDesignerId('');
    setBulkModalOpen(true);
  }

  const selectedSurveys = rows.filter((r) => selectedIds.has(r.id));

  // Confirm is locked until a decision is actually made, and — for
  // reject/correction — until there's a note, since "declined, no reason
  // given" leaves the surveyor with nothing to act on.
  const noteRequired = action === 'reject' || action === 'correction';
  const canConfirm = !!action && (action !== 'approve' || !!designerId) && (!noteRequired || note.trim().length > 0);

  const bulkNoteRequired = bulkAction === 'reject' || bulkAction === 'correction';
  const canConfirmBulk = (bulkAction !== 'approve' || !!bulkDesignerId) && (!bulkNoteRequired || bulkNote.trim().length > 0);

  return (
    <div>
      <PageHeader title="Survey Review" subtitle={`${statusCounts?.pending ?? '…'} pending review`} />

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
              onClick={() => openBulk('correction')}
              disabled={selectedIds.size === 0}
              className="flex items-center gap-1.5 bg-white text-amber-700 border border-amber-200 hover:bg-amber-50 px-3 py-1.5 rounded-lg text-xs font-medium disabled:opacity-50"
            >
              <AlertCircle className="w-3.5 h-3.5" /> Bulk Decline
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
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
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
            <label className="block text-xs font-medium text-slate-500 mb-1">Surveyor</label>
            <select value={surveyorFilter} onChange={(e) => setSurveyorFilter(e.target.value)} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500">
              <option value="">All Surveyors</option>
              {(surveyors || []).map((s) => <option key={s.id} value={s.id}>{s.full_name}</option>)}
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
            {total === 0 ? '0 surveys' : `Showing ${rangeStart}–${rangeEnd} of ${total.toLocaleString('en-IN')}`}
            {hasActiveFilters ? ' matching filters' : ''}
            {surveysLoading && <Loader2 className="inline w-3 h-3 ml-1.5 animate-spin align-[-1px]" />}
          </p>
          {hasActiveFilters && (
            <button onClick={() => { setSearch(''); setSurveyorFilter(''); }} className="text-xs text-slate-500 hover:text-slate-700 flex items-center gap-1 font-medium">
              <X className="w-3.5 h-3.5" /> Clear filters
            </button>
          )}
        </div>
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
                {selectMode && <th className="w-10 px-3 py-2.5"></th>}
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
                    onClick={selectMode && tab === 'pending' ? () => toggleSelected(s.id) : undefined}
                  >
                    {selectMode && (
                      <td className="px-3 py-3 align-top cursor-pointer" onClick={(e) => { e.stopPropagation(); toggleSelected(s.id); }}>
                        {tab === 'pending' ? (
                          <input
                            type="checkbox"
                            checked={selectedIds.has(s.id)}
                            onChange={() => toggleSelected(s.id)}
                            onClick={(e) => e.stopPropagation()}
                            className="w-4 h-4 accent-blue-600"
                          />
                        ) : null}
                      </td>
                    )}
                    <td className="px-3 py-3 align-top max-w-[220px]">
                      <p className="font-medium text-slate-900 truncate">{s.shops?.name}</p>
                      <Link to={`/shops/${s.shop_id}`} onClick={(e) => e.stopPropagation()} className="text-[11px] text-blue-600 hover:underline">
                        View shop
                      </Link>
                    </td>
                    <td className="px-3 py-3 align-top text-slate-500 whitespace-nowrap">{s.shops?.clients?.name || '—'} · {s.shops?.city}</td>
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

      {/* Single-survey review — full photos/measurements/PO-budget context
          before any decision is made. Also doubles as the read-only
          detail view for already-reviewed surveys. */}
      <Drawer
        open={!!selectedSurvey}
        onClose={closeDrawer}
        width="lg"
        title={selectedSurvey?.shops?.name || 'Survey'}
        subtitle={selectedSurvey ? `${selectedSurvey.shops?.clients?.name || 'No client'} · ${selectedSurvey.shops?.city || ''}` : undefined}
      >
        {selectedSurvey && (
          <div className="space-y-6">
            {/* ── 1. Survey details, always visible first, before any decision is made ── */}
            <div className="flex items-center gap-2 flex-wrap">
              <StatusBadge status={selectedSurvey.status} />
              <span className="text-xs text-slate-400">·</span>
              <span className="text-xs text-slate-500">
                Surveyed by <span className="font-medium text-slate-700">{selectedSurvey.profiles?.full_name || 'Unknown'}</span>
              </span>
              {selectedSurvey.submitted_at && (
                <>
                  <span className="text-xs text-slate-400">·</span>
                  <span className="text-xs text-slate-500">Submitted {new Date(selectedSurvey.submitted_at).toLocaleString('en-IN')}</span>
                </>
              )}
            </div>

            {selectedSurvey.gps_lat != null && selectedSurvey.gps_lng != null && (
              <p className="flex items-center gap-1.5 text-xs text-slate-500">
                <MapPin className="w-3.5 h-3.5 shrink-0" />
                Location captured at {selectedSurvey.gps_lat.toFixed(5)}, {selectedSurvey.gps_lng.toFixed(5)}
                {selectedSurvey.gps_accuracy != null && ` (±${Math.round(selectedSurvey.gps_accuracy)}m)`}
              </p>
            )}

            {selectedSurvey.notes && (
              <div className="flex gap-2 text-sm bg-slate-50 border border-slate-200 rounded-lg p-3">
                <StickyNote className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" />
                <p className="text-slate-700">{selectedSurvey.notes}</p>
              </div>
            )}

            <ReviewMarkedPhotos surveyId={selectedSurvey.id} />

            <SurveyMeasurementsTable surveyId={selectedSurvey.id} />

            <ItemLevelReviewPanel stage="survey" shopId={selectedSurvey.shop_id} surveyId={selectedSurvey.id} variance={varianceNotes} onDone={() => { invalidateAll(); closeDrawer(); }} assignedTo={selectedSurvey.surveyor_id} readOnly={!isPendingSurvey} />

            <POBudgetReviewPanel
              surveyId={selectedSurvey.id}
              shopId={selectedSurvey.shop_id}
              purchaseOrderId={selectedSurvey.shops?.purchase_order_id || null}
              varianceNotes={varianceNotes}
              onNoteChange={(itemId, val) => setVarianceNotes((prev) => ({ ...prev, [itemId]: val }))}
              readOnly={action !== 'approve'}
            />

            {/* ── 2. Decision, only after everything above has actually been seen ── */}
            {isPendingSurvey ? (
              <div className="sticky bottom-0 -mx-5 px-5 pb-5 pt-4 bg-white border-t border-slate-200 space-y-4">
                <div>
                  <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-2">Decision</p>
                  <div className="grid grid-cols-3 gap-2" role="group" aria-label="Review decision">
                    <button
                      type="button"
                      aria-pressed={action === 'approve'}
                      onClick={() => setAction('approve')}
                      className={`flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium border transition ${
                        action === 'approve' ? 'bg-green-600 text-white border-green-600' : 'bg-green-50 text-green-700 border-green-200 hover:bg-green-100'
                      }`}
                    >
                      <CheckCircle2 className="w-4 h-4" /> Approve
                    </button>
                    <button
                      type="button"
                      aria-pressed={action === 'correction'}
                      onClick={() => setAction('correction')}
                      className={`flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium border transition ${
                        action === 'correction' ? 'bg-amber-600 text-white border-amber-600' : 'bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-100'
                      }`}
                    >
                      <AlertCircle className="w-4 h-4" /> Correction
                    </button>
                    <button
                      type="button"
                      aria-pressed={action === 'reject'}
                      onClick={() => setAction('reject')}
                      className={`flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium border transition ${
                        action === 'reject' ? 'bg-red-600 text-white border-red-600' : 'bg-red-50 text-red-700 border-red-200 hover:bg-red-100'
                      }`}
                    >
                      <XCircle className="w-4 h-4" /> Reject
                    </button>
                  </div>
                </div>

                {action === 'approve' && (
                  <>
                    <Select
                      label="Assign Designer"
                      value={designerId}
                      onChange={setDesignerId}
                      options={[
                        { value: '', label: 'Select a designer...' },
                        ...(designers || []).map((d) => ({ value: d.id, label: d.full_name })),
                      ]}
                      required
                    />
                    {designers && designers.length === 0 && (
                      <p className="text-xs text-amber-600">
                        No active designers found in your organization. Add one from Owner Console → Users first.
                      </p>
                    )}
                  </>
                )}

                {action && (
                  <Textarea
                    label={`Review Note (sent to surveyor)${noteRequired ? ' — required' : ''}`}
                    value={note}
                    onChange={setNote}
                    rows={3}
                    placeholder={action === 'approve' ? 'Optional note...' : 'Explain what needs to be corrected so the surveyor can fix it...'}
                  />
                )}

                {reviewMutation.isError && (
                  <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-2" role="alert">
                    {(reviewMutation.error as Error).message}
                  </p>
                )}

                <button
                  onClick={() => reviewMutation.mutate()}
                  disabled={!canConfirm || reviewMutation.isPending}
                  className={`w-full text-white font-medium py-2.5 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed ${
                    action === 'approve' ? 'bg-green-600 hover:bg-green-700' : action === 'reject' ? 'bg-red-600 hover:bg-red-700' : 'bg-amber-600 hover:bg-amber-700'
                  }`}
                >
                  {reviewMutation.isPending
                    ? 'Processing...'
                    : action
                      ? `Confirm ${action === 'approve' ? 'Approval' : action === 'reject' ? 'Rejection' : 'Correction Request'}`
                      : 'Choose a decision above'}
                </button>
              </div>
            ) : (
              <div className="border-t border-slate-200 pt-4 space-y-2">
                <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">Past Decision</p>
                <div className="flex items-center gap-2">
                  <StatusBadge status={selectedSurvey.status} />
                  {selectedSurvey.reviewed_at && (
                    <span className="text-xs text-slate-500">on {new Date(selectedSurvey.reviewed_at).toLocaleString('en-IN')}</span>
                  )}
                </div>
                {selectedSurvey.review_note && (
                  <p className="text-sm text-slate-600 bg-slate-50 border border-slate-200 rounded-lg p-3">{selectedSurvey.review_note}</p>
                )}
              </div>
            )}
          </div>
        )}
      </Drawer>

      {/* Bulk review — pick several pending surveys, confirm the list at a
          glance, then finalize in one shot. Approving in bulk still needs
          exactly one designer picked (assigned to every survey in the
          batch) — nothing about a real approval decision is skipped, this
          only saves the repeated clicking, not the judgment call. */}
      <Modal
        open={bulkModalOpen}
        onClose={() => setBulkModalOpen(false)}
        title={`Bulk ${bulkAction === 'approve' ? 'Approve' : bulkAction === 'correction' ? 'Request Correction' : 'Reject'} — ${selectedSurveys.length} survey${selectedSurveys.length === 1 ? '' : 's'}`}
        size="lg"
      >
        <div className="space-y-4">
          <div className="max-h-64 overflow-y-auto border border-slate-200 rounded-lg divide-y divide-slate-100">
            {selectedSurveys.map((s) => (
              <div key={s.id} className="flex items-center justify-between px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-slate-900 truncate">{s.shops?.name}</p>
                  <p className="text-xs text-slate-500 truncate">{s.profiles?.full_name || 'Unknown'} · {s.shops?.city}</p>
                </div>
                <StatusBadge status={s.status} />
              </div>
            ))}
          </div>

          {(bulkAction === 'correction' || bulkAction === 'reject') && (
            <div className="flex items-center gap-2 text-xs">
              <span className="text-slate-500">Decline as:</span>
              <button
                onClick={() => setBulkAction('correction')}
                className={`px-2.5 py-1 rounded-full font-medium border ${bulkAction === 'correction' ? 'bg-amber-600 text-white border-amber-600' : 'bg-amber-50 text-amber-700 border-amber-200'}`}
              >
                Request Correction
              </button>
              <button
                onClick={() => setBulkAction('reject')}
                className={`px-2.5 py-1 rounded-full font-medium border ${bulkAction === 'reject' ? 'bg-red-600 text-white border-red-600' : 'bg-red-50 text-red-700 border-red-200'}`}
              >
                Reject
              </button>
              <span className="text-slate-400">
                {bulkAction === 'correction' ? '— surveyor can fix and resubmit the same shop' : '— sends it back to be resurveyed from scratch'}
              </span>
            </div>
          )}

          {bulkAction === 'approve' && (
            <>
              <Select
                label="Assign Designer (applied to all selected)"
                value={bulkDesignerId}
                onChange={setBulkDesignerId}
                options={[
                  { value: '', label: 'Select a designer...' },
                  ...(designers || []).map((d) => ({ value: d.id, label: d.full_name })),
                ]}
                required
              />
              <p className="text-xs text-slate-400">
                Each survey's measurements are still copied through individually — this only picks the one designer everyone in this batch gets handed to. Reassign any single one later from Design Studio if needed.
              </p>
            </>
          )}

          <Textarea
            label={`Review Note (sent to each surveyor)${bulkNoteRequired ? ' — required' : ''}`}
            value={bulkNote}
            onChange={setBulkNote}
            rows={3}
            placeholder={bulkAction === 'approve' ? 'Optional note...' : 'Explain what needs to be corrected/fixed so each surveyor can act on it...'}
          />

          {bulkMutation.isError && (
            <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-2" role="alert">{(bulkMutation.error as Error).message}</p>
          )}

          <button
            onClick={() => bulkMutation.mutate()}
            disabled={!canConfirmBulk || bulkMutation.isPending || selectedSurveys.length === 0}
            className={`w-full text-white font-medium py-2.5 rounded-lg disabled:opacity-50 ${
              bulkAction === 'approve' ? 'bg-green-600 hover:bg-green-700' : bulkAction === 'reject' ? 'bg-red-600 hover:bg-red-700' : 'bg-amber-600 hover:bg-amber-700'
            }`}
          >
            {bulkMutation.isPending
              ? 'Processing...'
              : `Confirm ${bulkAction === 'approve' ? 'Approval' : bulkAction === 'reject' ? 'Rejection' : 'Correction Request'} for ${selectedSurveys.length}`}
          </button>
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
function SurveyMeasurementsTable({ surveyId }: { surveyId: string }) {
  const { data: items, isLoading } = useQuery({
    queryKey: ['review-survey-measurements', surveyId],
    queryFn: async () => {
      const { data, error } = await supabase.from('work_items').select('*').eq('survey_id', surveyId).order('work_type_name');
      if (error) throw new Error(`Could not load measurements: ${error.message}`);
      return data as WorkItem[];
    },
    enabled: !!surveyId,
  });

  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">
        Measurements{items && items.length > 0 ? ` (${items.length})` : ''}
      </p>
      {isLoading ? (
        <p className="text-xs text-slate-400">Loading measurements…</p>
      ) : !items || items.length === 0 ? (
        <p className="text-xs text-slate-400">No measurements recorded for this survey.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-200">
          <table className="min-w-full text-xs">
            <thead className="bg-slate-50">
              <tr>
                <th scope="col" className="text-left font-medium text-slate-500 px-3 py-2">Work Type</th>
                <th scope="col" className="text-left font-medium text-slate-500 px-3 py-2">Material</th>
                <th scope="col" className="text-right font-medium text-slate-500 px-3 py-2">Size</th>
                <th scope="col" className="text-right font-medium text-slate-500 px-3 py-2">Qty</th>
                <th scope="col" className="text-right font-medium text-slate-500 px-3 py-2">Area</th>
                <th scope="col" className="text-left font-medium text-slate-500 px-3 py-2">Notes</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {items.map((item) => (
                <tr key={item.id}>
                  <td className="px-3 py-2 font-medium text-slate-800 whitespace-nowrap">{item.work_type_name || '—'}</td>
                  <td className="px-3 py-2 text-slate-600 whitespace-nowrap">{item.material || '—'}</td>
                  <td className="px-3 py-2 text-slate-600 text-right whitespace-nowrap">
                    {item.survey_width != null && item.survey_height != null
                      ? `${formatDim(item.survey_width)} × ${formatDim(item.survey_height)} ${item.survey_unit || ''}`
                      : '—'}
                  </td>
                  <td className="px-3 py-2 text-slate-600 text-right whitespace-nowrap">{item.survey_quantity ?? '—'}</td>
                  <td className="px-3 py-2 text-slate-600 text-right whitespace-nowrap">
                    {item.survey_area != null ? `${Math.round(item.survey_area)} sqft` : '—'}
                  </td>
                  <td className="px-3 py-2 text-slate-500 max-w-[180px] truncate" title={item.survey_notes || ''}>
                    {item.survey_notes || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// Section 8 — read-only live comparison of each surveyed work item against
// its PO line item's budget, shown at the review gate exactly like it's
// shown to the surveyor while measuring (SurveyorPage.tsx). Never a hard
// block: if the running total exceeds budget, Admin/Owner can optionally
// type an adjustment note explaining the variance, saved onto the work
// item only when the survey is actually approved (see applySurveyDecision).
function POBudgetReviewPanel({
  surveyId, shopId, purchaseOrderId, varianceNotes, onNoteChange, readOnly,
}: {
  surveyId: string;
  shopId: string;
  purchaseOrderId: string | null;
  varianceNotes: Record<string, string>;
  onNoteChange: (itemId: string, val: string) => void;
  readOnly: boolean;
}) {
  const { data: items } = useQuery({
    queryKey: ['review-po-work-items', surveyId],
    queryFn: async () => {
      const { data, error } = await supabase.from('work_items').select('*').eq('survey_id', surveyId);
      if (error) throw error;
      return data as WorkItem[];
    },
    enabled: !!surveyId,
  });

  const { data: lineItems } = useQuery({
    queryKey: ['review-po-line-items', purchaseOrderId],
    queryFn: async () => {
      const { data, error } = await supabase.from('v_po_line_item_work_context').select('*').eq('purchase_order_id', purchaseOrderId);
      if (error) throw error;
      return data as POLineItemWorkContext[];
    },
    enabled: !!purchaseOrderId,
  });

  const lineItemIds = (lineItems || []).map((li) => li.id);
  const { data: elsewhereSums } = useQuery({
    queryKey: ['review-po-elsewhere', shopId, lineItemIds.join(',')],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('work_items')
        .select('po_line_item_id, survey_area, survey_quantity')
        .in('po_line_item_id', lineItemIds)
        .neq('shop_id', shopId);
      if (error) throw error;
      const sums: Record<string, { area: number; qty: number }> = {};
      for (const row of data || []) {
        if (!row.po_line_item_id) continue;
        const cur = sums[row.po_line_item_id] || { area: 0, qty: 0 };
        cur.area += row.survey_area || 0;
        cur.qty += row.survey_quantity || 0;
        sums[row.po_line_item_id] = cur;
      }
      return sums;
    },
    enabled: lineItemIds.length > 0,
  });

  const linked = (items || []).filter((it) => it.po_line_item_id);
  if (!purchaseOrderId || linked.length === 0) return null;

  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">PO Budget Check</p>
      {linked.map((item) => {
        const lineItem = (lineItems || []).find((li) => li.id === item.po_line_item_id);
        if (!lineItem) return null;
        const areaBased = lineItem.uom === 'sqft';
        const elsewhere = elsewhereSums?.[lineItem.id];
        const surveyedElsewhere = areaBased ? (elsewhere?.area || 0) : (elsewhere?.qty || 0);
        const thisMeasurement = areaBased ? (item.survey_area || 0) : (item.survey_quantity || 0);
        const fig = computePOVariance(lineItem, surveyedElsewhere, thisMeasurement);
        const unitLabel = areaBased ? 'sqft' : lineItem.uom;
        return (
          <div key={item.id} className={`rounded-lg p-3 text-xs space-y-1 border ${fig.exceeds ? 'bg-amber-50 border-amber-300' : 'bg-slate-50 border-slate-200'}`}>
            <p className="font-medium text-slate-700">
              {item.work_type_name} — {lineItem.name ? `${lineItem.name} (${lineItem.po_number})` : `PO ${lineItem.po_number}`} budget: {fig.budgeted != null ? `${fig.budgeted} ${unitLabel}` : 'not set'}
            </p>
            <p className="text-slate-500">Already surveyed elsewhere: {fig.surveyedElsewhere.toFixed(2)} {unitLabel} · This shop: {fig.thisMeasurement.toFixed(2)} {unitLabel}</p>
            <p className={fig.exceeds ? 'text-amber-700 font-semibold' : 'text-slate-700 font-medium'}>
              Running total: {fig.runningTotal.toFixed(2)}{fig.budgeted != null ? ` / ${fig.budgeted} ${unitLabel} (${fig.pct?.toFixed(0)}%)` : ` ${unitLabel}`}
            </p>
            {fig.exceeds && (
              <>
                <p className="text-amber-700 flex items-center gap-1">
                  <AlertTriangle className="w-3.5 h-3.5" /> Exceeds PO budget by {fig.exceedsBy.toFixed(2)} {unitLabel}
                </p>
                {!readOnly && (
                  <input
                    type="text"
                    value={varianceNotes[item.id] || ''}
                    onChange={(e) => onNoteChange(item.id, e.target.value)}
                    placeholder="Optional adjustment note explaining the variance..."
                    className="w-full mt-1 text-xs border border-amber-300 rounded px-2 py-1.5 bg-white"
                  />
                )}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

// Shows the marked board photos for a submitted survey. Fetches only the
// data; MarkedPhotoGrid owns all the rendering (each photo renders as its
// own independent, timeout-isolated promise and updates the instant it's
// ready), so the reviewer sees exactly the same reliable marked photos
// the agency and client sides already do.
function ReviewMarkedPhotos({ surveyId }: { surveyId: string }) {
  const { data: photos } = useQuery({
    queryKey: ['review-survey-photos', surveyId],
    queryFn: async () => {
      const { data } = await supabase.from('survey_photos').select('*').eq('survey_id', surveyId).order('created_at');
      return data as SurveyPhoto[];
    },
    enabled: !!surveyId,
  });

  const { data: markings } = useQuery({
    queryKey: ['review-board-markings', surveyId, photos],
    queryFn: async () => {
      const photoIds = (photos || []).map((p) => p.id);
      if (photoIds.length === 0) return [] as BoardMarking[];
      const { data } = await supabase.from('board_markings').select('*').in('survey_photo_id', photoIds);
      return data as BoardMarking[];
    },
    enabled: !!photos,
  });

  // Needed so each marked board's caption (work type + dimensions) can be
  // burned onto the photo itself, matching what the surveyor saw while
  // marking it, instead of the reviewer having to cross-reference a
  // separate work-items list against an unlabeled photo.
  const { data: workItems } = useQuery({
    queryKey: ['review-work-items', surveyId],
    queryFn: async () => {
      const { data } = await supabase.from('work_items').select('*').eq('survey_id', surveyId);
      return data as WorkItem[];
    },
    enabled: !!surveyId,
  });

  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">
        Survey Photos{photos && photos.length > 0 ? ` (${photos.length})` : ''}
      </p>
      <MarkedPhotoGrid photos={photos || []} markings={markings || []} workItems={workItems || []} />
    </div>
  );
}


function SurveyCorrectionPicker({ survey, value, onChange }: { survey:any; value:Record<string,any>; onChange:(v:Record<string,any>)=>void }) {
  const { data: items } = useQuery({ queryKey:['survey-correction-items',survey.id], queryFn:async()=>{const {data}=await supabase.from('work_items').select('id,work_type_name,survey_width,survey_height,survey_unit,survey_quantity,survey_area').eq('survey_id',survey.id).order('created_at');return data||[];}});
  const { data: photos } = useQuery({ queryKey:['survey-correction-photos',survey.id], queryFn:async()=>{const {data}=await supabase.from('survey_photos').select('id,photo_url,caption').eq('survey_id',survey.id).order('created_at');return data||[];}});
  const toggle=(k:string,row:any)=>{const n={...value};if(n[k])delete n[k];else n[k]={...row,note:''};onChange(n)}; const note=(k:string,v:string)=>onChange({...value,[k]:{...value[k],note:v}});
  return <div className="rounded-xl border border-amber-200 bg-amber-50/50 p-3 space-y-3"><div><p className="text-sm font-semibold text-slate-900">Select only the incorrect survey evidence</p><p className="text-xs text-slate-500">Only these measurements/photos are returned to the same assigned surveyor.</p></div>
    <div className="space-y-2">{(items||[]).map((it:any)=>{const k=`m:${it.id}`,c=!!value[k];return <div key={it.id} className="rounded-lg border bg-white p-2.5"><label className="flex gap-2 cursor-pointer"><input type="checkbox" checked={c} onChange={()=>toggle(k,{issue_type:'measurement',work_item_id:it.id})}/><span className="text-xs"><b>{it.work_type_name||'Measurement'}</b> · {it.survey_width??'—'} × {it.survey_height??'—'} {it.survey_unit||''} · Qty {it.survey_quantity??1} · {it.survey_area??'—'} sq.ft</span></label>{c&&<input value={value[k]?.note||''} onChange={e=>note(k,e.target.value)} placeholder="Exact measurement correction" className="mt-2 w-full rounded border px-2 py-1.5 text-xs"/>}</div>})}</div>
    <div><p className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1">Photos</p><div className="grid grid-cols-3 gap-2">{(photos||[]).map((ph:any)=>{const k=`p:${ph.id}`,c=!!value[k];return <div key={ph.id}><button type="button" onClick={()=>toggle(k,{issue_type:'survey_photo',survey_photo_id:ph.id})} className={`w-full rounded-lg border-2 overflow-hidden ${c?'border-red-500 ring-2 ring-red-100':'border-slate-200'}`}><img src={ph.photo_url} className="w-full aspect-[4/3] object-contain bg-slate-100"/><span className={`block text-[10px] py-1 ${c?'bg-red-50 text-red-700':'bg-white text-slate-500'}`}>{c?'Marked for correction':'Survey photo'}</span></button>{c&&<input value={value[k]?.note||''} onChange={e=>note(k,e.target.value)} placeholder="Photo issue" className="mt-1 w-full rounded border px-2 py-1 text-[10px]"/>}</div>})}</div></div>
  </div>;
}
