import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { Card, StatusBadge, EmptyState, PageHeader, Modal, Textarea, Select } from '@/components/ui';
import { logAudit, createNotification } from '@/lib/helpers';
import { useRealtimeInvalidate } from '@/lib/useRealtimeInvalidate';
import { WorkItem, SurveyPhoto, BoardMarking, DesignVersion, DesignVersionItem, Shop, Organization } from '@/lib/types';
import { numberMarkingsByPhoto } from '@/lib/markingUtils';
import { buildDesignComparisonRows, generateDesignComparisonPDF, generateDesignComparisonPPT } from '@/lib/reports';
import { DesignMarkingPreview } from '@/components/DesignMarkingPreview';
import {
  Palette, Upload, ChevronRight, ChevronDown, ChevronLeft, FileImage, FileText, CheckCircle2, Circle,
  X, Search, MapPin, Phone, User, Layers, Lock, Plus, FileDown,
  Presentation, Calendar, Hash, Clock, Eye, PackageCheck, LayoutList, Loader2, Filter, ArrowUpDown, AlertTriangle, Send,
} from 'lucide-react';
import { Link } from 'react-router-dom';

// Board (work_item) statuses that mean "the survey side of this board isn't
// even approved yet" — nothing for a designer to do until it clears that gate.
const NOT_READY_STATUSES = ['pending', 'surveyed'];
// Board statuses that mean a design has been produced for it at some point
// (whether or not the shop-level task has since been fully approved).
const BOARD_DONE_STATUSES = ['designed', 'design_approved', 'in_production', 'produced', 'production_done', 'installed'];
// A board can only be toggled/covered by a fresh upload while it's in one
// of these — once it's design_approved+ it's locked to protect what's
// already gone to production.
const BOARD_TOGGLEABLE_STATUSES = ['approved', 'designing', 'designed'];

const PAGE_SIZE = 20;

function boardLabel(item: WorkItem) {
  const w = item.approved_width ?? item.survey_width;
  const h = item.approved_height ?? item.survey_height;
  const unit = item.approved_unit ?? item.survey_unit ?? 'ft';
  const qty = item.approved_quantity ?? item.survey_quantity ?? 1;
  const dims = w && h ? `${w}×${h} ${unit}` : null;
  return { dims, qty };
}

const TABS: { key: string; label: string; statuses: string[] | null; statKey: keyof DesignStats | null }[] = [
  { key: 'all', label: 'All', statuses: null, statKey: 'total' },
  { key: 'pending', label: 'Pending', statuses: ['assigned', 'designing'], statKey: 'pending_shops' },
  { key: 'design_ready', label: 'Uploaded', statuses: ['design_ready'], statKey: 'design_ready' },
  { key: 'in_review', label: 'In Review', statuses: ['in_review'], statKey: 'in_review' },
  { key: 'approved', label: 'Approved', statuses: ['approved'], statKey: 'approved' },
  { key: 'ready_for_production', label: 'In Production', statuses: ['ready_for_production'], statKey: 'in_production' },
];

type DesignStats = {
  total: number; pending_shops: number; boards_pending: number; design_ready: number;
  in_review: number; approved: number; in_production: number;
};

// One row per design task, as returned by `v_design_task_list` (migration
// 0055) — every field the list view needs (shop/client identity, PO
// context, latest survey date, board tallies) precomputed in SQL so the
// browser never has to pull full work_items/survey_photos sets just to
// render a summary row. This is what makes the list scale past a handful
// of shops: one indexed, paginated query instead of "fetch everything,
// filter in JS".
type DesignTaskRow = {
  design_task_id: string;
  organization_id: string;
  shop_id: string;
  designer_id: string | null;
  status: string;
  assigned_at: string;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  shop_name: string;
  shop_city: string | null;
  shop_address: string | null;
  shop_owner_name: string | null;
  shop_contact_phone: string | null;
  client_name: string | null;
  designer_name: string | null;
  total_boards: number;
  done_boards: number;
  pending_boards: number;
  not_ready_boards: number;
  version_count: number;
  last_upload_at: string | null;
  survey_date: string | null;
  po_number: string | null;
  po_name: string | null;
  fulfillment_type: string | null;
  board_progress: 'no_boards' | 'not_started' | 'in_progress' | 'done';
  // migration 0061 — true when every board on this shop linked to a
  // po_line_item has requires_design = false (Architecture v2.0 §3.4's
  // "custom" scope, e.g. client-provided art already in hand).
  requires_design_all_false: boolean;
};

// Full per-shop detail — boards, survey photos + markings, and uploaded
// design versions. Loaded on demand for exactly one shop at a time (the
// expanded row / open upload modal), never for the whole list — this is
// the other half of keeping the screen fast no matter how many shops the
// org has.
type ShopDesignDetail = {
  items: WorkItem[];
  photos: SurveyPhoto[];
  markings: BoardMarking[];
  versions: DesignVersion[];
  versionItems: DesignVersionItem[];
};

// Full board/marking/version detail for one shop — the one query every
// "expand row" / "quick action" path funnels through, so the fetching
// logic (and its shape) only exists once.
async function fetchShopDetail(shopId: string, designTaskId: string): Promise<ShopDesignDetail> {
  const [{ data: items, error: itemsErr }, { data: photos, error: photosErr }, { data: versions, error: versionsErr }] =
    await Promise.all([
      supabase.from('work_items').select('*').eq('shop_id', shopId).order('created_at'),
      supabase.from('survey_photos').select('*').eq('shop_id', shopId).order('created_at'),
      supabase.from('design_versions').select('*').eq('design_task_id', designTaskId).order('version_number'),
    ]);
  if (itemsErr) throw new Error(`Could not load boards: ${itemsErr.message}`);
  if (photosErr) throw new Error(`Could not load survey photos: ${photosErr.message}`);
  if (versionsErr) throw new Error(`Could not load design versions: ${versionsErr.message}`);

  const photoIds = (photos || []).map((p) => p.id);
  const versionIds = (versions || []).map((v) => v.id);
  const [markingsRes, versionItemsRes] = await Promise.all([
    photoIds.length
      ? supabase.from('board_markings').select('*').in('survey_photo_id', photoIds)
      : Promise.resolve({ data: [], error: null }),
    versionIds.length
      ? supabase.from('design_version_items').select('*').in('design_version_id', versionIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (markingsRes.error) throw new Error(`Could not load survey markings: ${markingsRes.error.message}`);
  if (versionItemsRes.error) throw new Error(`Could not load design coverage: ${versionItemsRes.error.message}`);

  return {
    items: (items || []) as WorkItem[],
    photos: (photos || []) as SurveyPhoto[],
    markings: (markingsRes.data || []) as BoardMarking[],
    versions: (versions || []) as DesignVersion[],
    versionItems: (versionItemsRes.data || []) as DesignVersionItem[],
  };
}

// Every design-task action notifies exactly the people whose job the next
// step is — never the whole org. Designer-facing events go to that one
// design task's `designer_id`; "needs a decision" events go to whichever
// org members can actually approve a design (agency_owner/admin/demo —
// the same set `canApprove` checks against on this page), never to
// designers, production, or installer accounts who have no reason to see
// design-review traffic.
async function notifyDesignReviewers(orgId: string, shopName: string) {
  const { data: reviewers } = await supabase
    .from('profiles')
    .select('id')
    .eq('organization_id', orgId)
    .in('role', ['agency_owner', 'admin', 'demo'])
    .eq('is_active', true);
  for (const r of reviewers || []) {
    await createNotification(r.id, 'Design Ready for Review', `${shopName}'s design is uploaded and waiting for your review.`, 'info', '/design');
  }
}

function rowToShop(row: DesignTaskRow): Shop {
  return {
    id: row.shop_id,
    organization_id: row.organization_id,
    client_id: '',
    project_id: null,
    name: row.shop_name,
    owner_name: row.shop_owner_name,
    contact_phone: row.shop_contact_phone,
    address: row.shop_address,
    city: row.shop_city,
    district: null,
    village: null,
    zone: null,
    zone_id: null,
    state: null,
    latitude: null,
    longitude: null,
    signage_language: null,
    status: row.status,
    is_demo: false,
    purchase_order_id: null,
    extra_details: {},
    created_at: row.created_at,
  };
}

async function exportShopDesignReport(row: DesignTaskRow, detailData: ShopDesignDetail, format: 'pdf' | 'ppt', org: Organization | null | undefined) {
  const rowsForExport = await buildDesignComparisonRows(
    detailData.items,
    detailData.photos,
    detailData.markings,
    detailData.versions,
    detailData.versionItems
  );
  const shop = rowToShop(row);
  if (format === 'pdf') await generateDesignComparisonPDF(shop, rowsForExport, org);
  else await generateDesignComparisonPPT(shop, rowsForExport, org);
}

// Everything involved in sending one shop's approved design to
// production: create/refresh its production order, notify the assigned
// production person, and flip the shop + work items over — the exact
// same sequence whether it's done for one shop from the modal or for
// several at once from the bulk toolbar.
async function sendDesignTaskToProduction(row: DesignTaskRow, assignedTo: string) {
  const { error: taskError } = await supabase.from('design_tasks').update({ status: 'ready_for_production' }).eq('id', row.design_task_id).select('id');
  if (taskError) throw new Error(`Could not update design task: ${taskError.message}`);

  const { data: existingOrder, error: existingOrderError } = await supabase
    .from('production_orders')
    .select('id')
    .eq('shop_id', row.shop_id)
    .maybeSingle();
  if (existingOrderError) throw new Error(`Could not check for existing production order: ${existingOrderError.message}`);
  if (!existingOrder) {
    const { error: orderInsertError } = await supabase.from('production_orders').insert({
      organization_id: row.organization_id,
      shop_id: row.shop_id,
      design_task_id: row.design_task_id,
      status: 'pending',
      assigned_to: assignedTo,
    });
    if (orderInsertError) throw new Error(`Could not create production order: ${orderInsertError.message}`);
  } else {
    const { error: orderUpdateError } = await supabase.from('production_orders').update({ assigned_to: assignedTo }).eq('id', existingOrder.id).select('id');
    if (orderUpdateError) throw new Error(`Could not assign production order: ${orderUpdateError.message}`);
  }
  await createNotification(assignedTo, 'New Production Order', `A production order for ${row.shop_name} has been assigned to you`, 'info', '/production');
  const { error: shopError } = await supabase.from('shops').update({ status: 'production_pending' }).eq('id', row.shop_id).select('id');
  if (shopError) throw new Error(`Could not update shop status: ${shopError.message}`);
  const { error: workItemsError } = await supabase.from('work_items').update({ status: 'design_approved' }).eq('shop_id', row.shop_id).select('id');
  if (workItemsError) throw new Error(`Could not update work items: ${workItemsError.message}`);

  await logAudit('design_tasks', row.design_task_id, 'update', 'status', row.status, 'ready_for_production', `Design task status changed to ready_for_production for ${row.shop_name}`);
}

export default function DesignerPage() {
  const { profile } = useAuth();
  const orgId = profile?.organization_id;
  const queryClient = useQueryClient();
  const isDesigner = profile?.role === 'designer';
  const canApprove = profile?.role === 'agency_owner' || profile?.role === 'admin' || profile?.role === 'demo';
  const designerFilter = isDesigner ? profile!.id : null;

  // Org letterhead (name/logo/GST/etc.) for the design-comparison PDF/PPT —
  // without this the exported file had no agency identity on it at all.
  const { data: org } = useQuery({
    queryKey: ['organization', orgId],
    queryFn: async () => {
      const { data } = await supabase.from('organizations').select('*').eq('id', orgId).maybeSingle();
      return data as Organization | null;
    },
    enabled: !!orgId,
  });

  const [activeTab, setActiveTab] = useState('all');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  // Order-type filter — owner/admin only. A designer must never see PO
  // context at all (not the badge, not this filter), so it stays gated
  // behind `!isDesigner` everywhere it's rendered below.
  const [typeFilter, setTypeFilter] = useState<'all' | 'survey_install' | 'supply_only' | 'custom' | 'no_po'>('all');
  // Board-progress filter — available to BOTH roles (unlike order type,
  // this has nothing to do with PO/financial context, so a designer gets
  // it too): how far along are a shop's boards, independent of the
  // shop-level task status shown in the tabs above.
  const [boardProgressFilter, setBoardProgressFilter] = useState<'all' | 'not_started' | 'in_progress' | 'done'>('all');
  const [sortDir, setSortDir] = useState<'desc' | 'asc'>('desc');
  const [page, setPage] = useState(0);
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const [expandedShopId, setExpandedShopId] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<string | null>(null);

  // Quick actions (Upload / Review) fire straight from the collapsed row
  // — no expand-and-scroll required to reach them. Each just needs that
  // one shop's detail loaded once, on demand, then opens its modal.
  const [quickActionLoadingId, setQuickActionLoadingId] = useState<string | null>(null);
  const [reviewTask, setReviewTask] = useState<(DesignTaskRow & ShopDesignDetail) | null>(null);
  const [requestingChanges, setRequestingChanges] = useState(false);
  const [changesNote, setChangesNote] = useState('');

  // Multi-select — owner/admin only ("review and approve multiple at
  // once"). Only shops actually awaiting a decision (`in_review`) can be
  // selected, since bulk approve is the only bulk action that makes sense
  // here; a shop leaves the selection automatically once it's no longer
  // in that state (list refetch naturally drops it).
  const [selectedRowIds, setSelectedRowIds] = useState<Set<string>>(new Set());
  const [bulkExportProgress, setBulkExportProgress] = useState<{ done: number; total: number } | null>(null);

  const [uploadTask, setUploadTask] = useState<(DesignTaskRow & ShopDesignDetail) | null>(null);
  const [stagedFiles, setStagedFiles] = useState<{ id: string; file: File; previewUrl: string | null }[]>([]);
  const [batchNotes, setBatchNotes] = useState('');
  const [batchSource, setBatchSource] = useState<'agency_designed' | 'client_provided'>('agency_designed');
  const [selectedItemIds, setSelectedItemIds] = useState<Set<string>>(new Set());
  const [uploadProgress, setUploadProgress] = useState<{ done: number; total: number } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const [productionTask, setProductionTask] = useState<DesignTaskRow | null>(null);
  const [productionUserId, setProductionUserId] = useState('');
  // Bulk "Send to Production" — same modal/person-picker as the single-row
  // flow, just applied to every selected `approved` shop at once.
  const [bulkProductionRows, setBulkProductionRows] = useState<DesignTaskRow[] | null>(null);
  const [bulkProductionUserId, setBulkProductionUserId] = useState('');
  const [exportingTaskId, setExportingTaskId] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  // Debounce search so every keystroke doesn't re-query — meaningful once
  // an org has enough shops that "search" is actually a server filter and
  // not just re-scanning an already-loaded list.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => { setPage(0); setSelectedRowIds(new Set()); }, [activeTab, debouncedSearch, typeFilter, boardProgressFilter, sortDir]);

  const { data: productionPeople } = useQuery({
    queryKey: ['org-production-people', orgId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, full_name')
        .eq('organization_id', orgId)
        .eq('role', 'printing')
        .eq('is_active', true)
        .order('full_name');
      if (error) throw new Error(`Could not load production team: ${error.message}`);
      return data as { id: string; full_name: string }[];
    },
    enabled: !!orgId && (!!productionTask || !!bulkProductionRows),
  });

  // The list itself — server-paginated, server-filtered (status tab +
  // search), sourced entirely from the pre-aggregated `v_design_task_list`
  // view. No client-side filtering of a full data set happens anywhere in
  // this component.
  const tab = TABS.find((t) => t.key === activeTab)!;
  const {
    data: listResult,
    isFetching: listFetching,
    isLoading: listLoading,
    isError: listIsError,
    error: listQueryError,
    refetch: refetchList,
  } = useQuery({
    queryKey: ['design-task-list', orgId, designerFilter, activeTab, debouncedSearch, page, typeFilter, boardProgressFilter, sortDir],
    queryFn: async () => {
      let q = supabase.from('v_design_task_list').select('*', { count: 'exact' }).eq('organization_id', orgId);
      if (designerFilter) q = q.eq('designer_id', designerFilter);
      if (tab.statuses) q = q.in('status', tab.statuses);
      // Order-type filter — never applied for a designer session (the UI
      // never lets one be selected there), so this stays purely an
      // owner/admin convenience for telling supply-only, survey & install,
      // and custom/PO-linked shops apart at a glance.
      if (!isDesigner) {
        if (typeFilter === 'no_po') q = q.is('po_number', null);
        else if (typeFilter !== 'all') q = q.eq('fulfillment_type', typeFilter);
      }
      // Board-progress filter — available to both roles.
      if (boardProgressFilter !== 'all') q = q.eq('board_progress', boardProgressFilter);
      const term = debouncedSearch.replace(/[,%()]/g, ' ').trim();
      if (term) q = q.or(`shop_name.ilike.%${term}%,client_name.ilike.%${term}%,shop_city.ilike.%${term}%`);
      q = q.order('created_at', { ascending: sortDir === 'asc' }).range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
      const { data, error, count } = await q;
      if (error) throw new Error(error.message || 'Could not load design tasks.');
      return { rows: (data || []) as DesignTaskRow[], count: count || 0 };
    },
    enabled: !!orgId,
    placeholderData: keepPreviousData,
    retry: 1,
  });
  const rows = useMemo(() => listResult?.rows || [], [listResult]);
  const totalCount = listResult?.count || 0;
  const pageCount = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  // A row is selectable for bulk action when it's awaiting the exact
  // decision this role makes next: owner/admin bulk-approves shops
  // `in_review`, and separately bulk-sends `approved` shops to
  // production; a designer bulk-sends-for-review shops that are
  // `design_ready` (uploaded, not yet sent up). A single selection can
  // freely mix `in_review` and `approved` rows — each bulk action in the
  // toolbar below only ever acts on the subset of the selection its own
  // status actually applies to.
  function isRowSelectable(row: DesignTaskRow) {
    return (canApprove && (row.status === 'in_review' || row.status === 'approved')) || (isDesigner && row.status === 'design_ready');
  }

  // Keep the selection in sync with what's actually on screen — a shop
  // leaves the selectable set the moment it changes status (approved,
  // sent back for changes, sent for review, or paged away), so a stale
  // checkbox can never linger and get bulk-actioned a second time.
  useEffect(() => {
    setSelectedRowIds((prev) => {
      if (prev.size === 0) return prev;
      const selectable = new Set(rows.filter(isRowSelectable).map((r) => r.design_task_id));
      const next = new Set(Array.from(prev).filter((id) => selectable.has(id)));
      return next.size === prev.size ? prev : next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);

  // Org-wide (or per-designer) totals for the summary strip + tab counts —
  // computed server-side in one aggregate call (`design_task_stats`, RPC,
  // migration 0055) rather than by summing every row in the browser, which
  // is the part that would otherwise not survive 10,000+ shops.
  const { data: stats, isError: statsIsError, error: statsQueryError } = useQuery({
    queryKey: ['design-task-stats', orgId, designerFilter],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('design_task_stats', { p_designer_id: designerFilter }).single();
      if (error) throw new Error(error.message || 'Could not load design stats.');
      return data as DesignStats;
    },
    enabled: !!orgId,
    retry: 1,
  });

  // Full board/marking/version detail — fetched only for whichever single
  // shop's row is currently expanded, never for the whole page.
  const { data: detail, isLoading: detailLoading } = useQuery({
    queryKey: ['design-task-detail', expandedShopId, expandedTaskId],
    queryFn: () => fetchShopDetail(expandedShopId!, expandedTaskId!),
    enabled: !!expandedShopId && !!expandedTaskId,
  });

  useRealtimeInvalidate(
    ['design_tasks', 'design_versions', 'design_version_items', 'work_items', 'board_markings'],
    orgId,
    [
      ['design-task-list', orgId],
      ['design-task-stats', orgId],
      ['design-task-detail'],
    ]
  );

  // Section 5 — every design must be traceable to the exact survey marking
  // it was made for. A shop's boards can have very different sizes, and
  // more than one board can be marked on the same survey photo, so the
  // designer (and the owner reviewing the same screen) need to see, per
  // board, which numbered marking on which photo it corresponds to — not
  // just a bare "Board" name and a size pulled from a form. Scoped to the
  // one expanded shop's markings only.
  const markingNumbering = useMemo(() => numberMarkingsByPhoto(detail?.markings || []), [detail?.markings]);
  const photosById = useMemo(() => new Map((detail?.photos || []).map((p) => [p.id, p])), [detail?.photos]);
  const markingByWorkItem = useMemo(
    () => new Map((detail?.markings || []).filter((m) => m.work_item_id).map((m) => [m.work_item_id as string, m])),
    [detail?.markings]
  );

  function markingRefFor(workItemId: string) {
    const marking = markingByWorkItem.get(workItemId);
    const numbering = markingNumbering.get(workItemId);
    if (!marking || !numbering) return null;
    const photo = photosById.get(marking.survey_photo_id) || null;
    return { marking, photo, number: numbering.number, total: numbering.total };
  }

  function boardCaption(item: WorkItem, ref: ReturnType<typeof markingRefFor>) {
    const { dims } = boardLabel(item);
    const parts = [item.work_type_name || 'Board', dims].filter(Boolean);
    return ref ? `#${ref.number} — ${parts.join(' · ')}` : parts.join(' · ');
  }

  function toggleExpand(row: DesignTaskRow) {
    if (expandedTaskId === row.design_task_id) {
      setExpandedTaskId(null);
      setExpandedShopId(null);
    } else {
      setExpandedTaskId(row.design_task_id);
      setExpandedShopId(row.shop_id);
    }
  }

  const updateStatusMutation = useMutation({
    mutationFn: async ({
      row, status, assignedTo, versions,
    }: { row: DesignTaskRow; status: string; assignedTo?: string; versions?: DesignVersion[] }) => {
      if (status === 'ready_for_production') {
        if (!assignedTo) throw new Error('Pick a production person to assign this order to first.');
        await sendDesignTaskToProduction(row, assignedTo);
        return;
      }

      const { error: taskError } = await supabase.from('design_tasks').update({ status }).eq('id', row.design_task_id).select('id');
      if (taskError) throw new Error(`Could not update design task: ${taskError.message}`);

      if (status === 'approved') {
        const { error: shopError } = await supabase.from('shops').update({ status: 'design_approved' }).eq('id', row.shop_id).select('id');
        if (shopError) throw new Error(`Could not update shop status: ${shopError.message}`);

        const latestVersion = (versions || []).slice().sort((a, b) => b.version_number - a.version_number)[0];
        if (latestVersion) {
          const { error: versionError } = await supabase.from('design_versions').update({ status: 'approved' }).eq('id', latestVersion.id).select('id');
          if (versionError) throw new Error(`Could not mark design version approved: ${versionError.message}`);
        }
        // Only the designer who actually owns this task needs to know it
        // was approved — nobody else's notification list should get this.
        if (row.designer_id) {
          await createNotification(row.designer_id, 'Design Approved', `Your design for ${row.shop_name} was approved.`, 'success', '/design');
        }
      }

      // Designer just sent this shop's design up for a decision — the
      // people who need to hear about it are whoever can actually approve
      // a design (agency_owner/admin/demo), not the whole org.
      if (status === 'in_review') {
        await notifyDesignReviewers(row.organization_id, row.shop_name);
      }

      await logAudit('design_tasks', row.design_task_id, 'update', 'status', row.status, status, `Design task status changed to ${status} for ${row.shop_name}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['design-task-list', orgId] });
      queryClient.invalidateQueries({ queryKey: ['design-task-stats', orgId] });
      queryClient.invalidateQueries({ queryKey: ['design-task-detail'] });
      queryClient.invalidateQueries({ queryKey: ['production-order-list'] });
      queryClient.invalidateQueries({ queryKey: ['production-order-stats'] });
      queryClient.invalidateQueries({ queryKey: ['shops'] });
      queryClient.invalidateQueries({ queryKey: ['nav-pending-counts', orgId] });
      setProductionTask(null);
      setProductionUserId('');
      setReviewTask(null);
      setRequestingChanges(false);
      setChangesNote('');
    },
  });

  // Owner sends a design back for revision instead of approving it —
  // status returns to 'designing' (the normal "still with the designer"
  // state, same one a fresh assignment starts in) with the note recorded
  // on the task, and only that task's designer is notified.
  const requestChangesMutation = useMutation({
    mutationFn: async ({ row, note }: { row: DesignTaskRow; note: string }) => {
      const { error } = await supabase.from('design_tasks').update({ status: 'designing', notes: note || null }).eq('id', row.design_task_id).select('id');
      if (error) throw new Error(`Could not send this design back for changes: ${error.message}`);
      if (row.designer_id) {
        await createNotification(
          row.designer_id,
          'Changes Requested',
          `${row.shop_name}'s design needs changes${note ? `: ${note}` : '.'}`,
          'warning',
          '/design'
        );
      }
      await logAudit('design_tasks', row.design_task_id, 'update', 'status', row.status, 'designing', `Changes requested on design for ${row.shop_name}${note ? `: ${note}` : ''}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['design-task-list', orgId] });
      queryClient.invalidateQueries({ queryKey: ['design-task-stats', orgId] });
      queryClient.invalidateQueries({ queryKey: ['design-task-detail'] });
      setReviewTask(null);
      setRequestingChanges(false);
      setChangesNote('');
    },
  });

  // Manual toggle for a single board — lets a designer correct the marking
  // (or mark something done without a fresh file, e.g. a duplicate board
  // covered by an existing upload) without going through the upload modal.
  const toggleBoardMutation = useMutation({
    mutationFn: async (item: WorkItem) => {
      const nextStatus = item.status === 'designed' ? 'approved' : 'designed';
      const { error } = await supabase.from('work_items').update({ status: nextStatus }).eq('id', item.id).select('id');
      if (error) throw new Error(`Could not update board status: ${error.message}`);
      await logAudit('work_items', item.id, 'update', 'status', item.status, nextStatus, `${item.work_type_name || 'Board'} marked ${nextStatus === 'designed' ? 'designed' : 'pending'}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['design-task-detail'] });
      queryClient.invalidateQueries({ queryKey: ['design-task-list', orgId] });
      queryClient.invalidateQueries({ queryKey: ['design-task-stats', orgId] });
    },
  });

  // Owner reviews and approves several shops' designs in one action
  // instead of one row at a time — each still gets its own design-version
  // "approved" stamp, shop status update, and its own designer
  // notification (never a single blended notification), exactly as if it
  // had been approved individually; this is purely a faster way to fire
  // the same per-shop approval multiple times.
  const bulkApproveMutation = useMutation({
    mutationFn: async (selected: DesignTaskRow[]) => {
      const failures: string[] = [];
      for (const row of selected) {
        try {
          const d = await fetchShopDetail(row.shop_id, row.design_task_id);
          const { error: taskError } = await supabase.from('design_tasks').update({ status: 'approved' }).eq('id', row.design_task_id).select('id');
          if (taskError) throw new Error(taskError.message);
          const { error: shopError } = await supabase.from('shops').update({ status: 'design_approved' }).eq('id', row.shop_id).select('id');
          if (shopError) throw new Error(shopError.message);
          const latestVersion = d.versions.slice().sort((a, b) => b.version_number - a.version_number)[0];
          if (latestVersion) {
            const { error: versionError } = await supabase.from('design_versions').update({ status: 'approved' }).eq('id', latestVersion.id).select('id');
            if (versionError) throw new Error(versionError.message);
          }
          if (row.designer_id) {
            await createNotification(row.designer_id, 'Design Approved', `Your design for ${row.shop_name} was approved.`, 'success', '/design');
          }
          await logAudit('design_tasks', row.design_task_id, 'update', 'status', row.status, 'approved', `Design task status changed to approved for ${row.shop_name} (bulk approve)`);
        } catch (err) {
          failures.push(`${row.shop_name}: ${(err as Error).message}`);
        }
      }
      if (failures.length > 0) {
        throw new Error(`${selected.length - failures.length}/${selected.length} approved. Failed — ${failures.join('; ')}`);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['design-task-list', orgId] });
      queryClient.invalidateQueries({ queryKey: ['design-task-stats', orgId] });
      queryClient.invalidateQueries({ queryKey: ['design-task-detail'] });
      queryClient.invalidateQueries({ queryKey: ['shops'] });
      queryClient.invalidateQueries({ queryKey: ['nav-pending-counts', orgId] });
      setSelectedRowIds(new Set());
    },
  });

  // Bulk "Send to Production" — same per-shop production-order create/
  // reuse + notify + status flips as the single-row flow (via the shared
  // `sendDesignTaskToProduction` helper), just looped over every selected
  // `approved` shop with one production-person pick for all of them.
  const bulkSendToProductionMutation = useMutation({
    mutationFn: async ({ selected, assignedTo }: { selected: DesignTaskRow[]; assignedTo: string }) => {
      if (!assignedTo) throw new Error('Pick a production person to assign these orders to first.');
      const failures: string[] = [];
      for (const row of selected) {
        try {
          await sendDesignTaskToProduction(row, assignedTo);
        } catch (err) {
          failures.push(`${row.shop_name}: ${(err as Error).message}`);
        }
      }
      if (failures.length > 0) {
        throw new Error(`${selected.length - failures.length}/${selected.length} sent. Failed — ${failures.join('; ')}`);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['design-task-list', orgId] });
      queryClient.invalidateQueries({ queryKey: ['design-task-stats', orgId] });
      queryClient.invalidateQueries({ queryKey: ['design-task-detail'] });
      queryClient.invalidateQueries({ queryKey: ['production-order-list'] });
      queryClient.invalidateQueries({ queryKey: ['production-order-stats'] });
      queryClient.invalidateQueries({ queryKey: ['shops'] });
      queryClient.invalidateQueries({ queryKey: ['nav-pending-counts', orgId] });
      setSelectedRowIds(new Set());
      setBulkProductionRows(null);
      setBulkProductionUserId('');
    },
  });

  // Designer's equivalent of bulk approve — send several finished
  // (design_ready) shops up for review in one action instead of opening
  // each one to click "Send for Review" individually. Reviewers still get
  // one notification per shop (never a single blended one), same as the
  // single-row action.
  const bulkSendForReviewMutation = useMutation({
    mutationFn: async (selected: DesignTaskRow[]) => {
      const failures: string[] = [];
      for (const row of selected) {
        try {
          const { error } = await supabase.from('design_tasks').update({ status: 'in_review' }).eq('id', row.design_task_id).select('id');
          if (error) throw new Error(error.message);
          await notifyDesignReviewers(row.organization_id, row.shop_name);
          await logAudit('design_tasks', row.design_task_id, 'update', 'status', row.status, 'in_review', `Design task status changed to in_review for ${row.shop_name} (bulk send)`);
        } catch (err) {
          failures.push(`${row.shop_name}: ${(err as Error).message}`);
        }
      }
      if (failures.length > 0) {
        throw new Error(`${selected.length - failures.length}/${selected.length} sent. Failed — ${failures.join('; ')}`);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['design-task-list', orgId] });
      queryClient.invalidateQueries({ queryKey: ['design-task-stats', orgId] });
      setSelectedRowIds(new Set());
    },
  });

  function toggleRowSelected(id: string) {
    setSelectedRowIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function bulkExport(selected: DesignTaskRow[], format: 'pdf' | 'ppt') {
    setExportError(null);
    setBulkExportProgress({ done: 0, total: selected.length });
    try {
      for (let i = 0; i < selected.length; i++) {
        const row = selected[i];
        const d = await fetchShopDetail(row.shop_id, row.design_task_id);
        await exportShopDesignReport(row, d, format, org);
        setBulkExportProgress({ done: i + 1, total: selected.length });
      }
    } catch (err) {
      setExportError((err as Error).message);
    } finally {
      setBulkExportProgress(null);
    }
  }

  function openUploadModal(row: DesignTaskRow, loadedDetail: ShopDesignDetail) {
    setUploadTask({ ...row, ...loadedDetail });
    setBatchNotes('');
    setBatchSource('agency_designed');
    setStagedFiles([]);
    const pending = loadedDetail.items.filter(
      (i) => !BOARD_DONE_STATUSES.includes(i.status) && !NOT_READY_STATUSES.includes(i.status)
    );
    setSelectedItemIds(new Set(pending.map((i) => i.id)));
  }

  // Row-level quick actions — "Upload" (designer) and "Review" (owner)
  // fire straight from the collapsed list row. Each loads that one shop's
  // detail on demand (bypassing the expand/scroll flow entirely) and opens
  // its modal the moment it's ready, so getting to the actual work is one
  // click, not "expand → scroll → find the button".
  async function quickUpload(row: DesignTaskRow) {
    setQuickActionLoadingId(row.design_task_id);
    try {
      const loadedDetail = await fetchShopDetail(row.shop_id, row.design_task_id);
      queryClient.setQueryData(['design-task-detail', row.shop_id, row.design_task_id], loadedDetail);
      openUploadModal(row, loadedDetail);
    } catch (err) {
      setExportError((err as Error).message);
    } finally {
      setQuickActionLoadingId(null);
    }
  }

  async function quickReview(row: DesignTaskRow) {
    setQuickActionLoadingId(row.design_task_id);
    try {
      const loadedDetail = await fetchShopDetail(row.shop_id, row.design_task_id);
      queryClient.setQueryData(['design-task-detail', row.shop_id, row.design_task_id], loadedDetail);
      setReviewTask({ ...row, ...loadedDetail });
    } catch (err) {
      setExportError((err as Error).message);
    } finally {
      setQuickActionLoadingId(null);
    }
  }

  // Export straight from the collapsed row too — no expanding required to
  // reach the PDF/PPT buttons, same "one click" bar as Upload/Review.
  async function quickExport(row: DesignTaskRow, format: 'pdf' | 'ppt') {
    setQuickActionLoadingId(row.design_task_id);
    setExportError(null);
    try {
      const loadedDetail = await fetchShopDetail(row.shop_id, row.design_task_id);
      queryClient.setQueryData(['design-task-detail', row.shop_id, row.design_task_id], loadedDetail);
      await exportShopDesignReport(row, loadedDetail, format, org);
    } catch (err) {
      setExportError((err as Error).message);
    } finally {
      setQuickActionLoadingId(null);
    }
  }

  function closeUploadModal() {
    stagedFiles.forEach((f) => f.previewUrl && URL.revokeObjectURL(f.previewUrl));
    setUploadTask(null);
    setStagedFiles([]);
    setBatchNotes('');
    setBatchSource('agency_designed');
    setSelectedItemIds(new Set());
    setUploadProgress(null);
  }

  useEffect(() => {
    return () => stagedFiles.forEach((f) => f.previewUrl && URL.revokeObjectURL(f.previewUrl));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleFilesSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files || []);
    const staged = files.map((file) => ({
      id: `${file.name}-${file.size}-${Math.random().toString(36).slice(2)}`,
      file,
      previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : null,
    }));
    setStagedFiles((prev) => [...prev, ...staged]);
    e.target.value = '';
  }

  function removeStaged(id: string) {
    setStagedFiles((prev) => {
      const target = prev.find((f) => f.id === id);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((f) => f.id !== id);
    });
  }

  function toggleSelectedItem(id: string) {
    setSelectedItemIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const uploadMutation = useMutation({
    mutationFn: async () => {
      if (!uploadTask || !profile) return;
      if (stagedFiles.length === 0) throw new Error('Add at least one file before uploading.');
      // Section 5 — "every design upload must be unambiguously tagged to
      // shop + survey + work item ... never a bare file-upload with a
      // freeform 'which shop' text note." The shop/survey side is already
      // implicit in which task this modal was opened from; this is the
      // work-item half of that rule — a batch can't go up covering zero
      // boards, unless this shop genuinely has no recorded boards at all
      // (a pre-existing data edge case — see the empty state below).
      if ((uploadTask.items?.length || 0) > 0 && selectedItemIds.size === 0) {
        throw new Error('Select at least one board this upload covers before uploading.');
      }

      const startVersion = uploadTask.versions?.length || 0;
      const newVersionIds: string[] = [];

      for (let i = 0; i < stagedFiles.length; i++) {
        const versionNum = startVersion + i + 1;
        const file = stagedFiles[i].file;
        const path = `${orgId}/${uploadTask.design_task_id}/v${versionNum}-${file.name}`;
        const { error: uploadError } = await supabase.storage.from('design-files').upload(path, file);
        if (uploadError) throw new Error(`Could not upload ${file.name}: ${uploadError.message}`);
        const { data: urlData } = supabase.storage.from('design-files').getPublicUrl(path);
        const { data: versionRow, error: versionError } = await supabase
          .from('design_versions')
          .insert({
            organization_id: orgId,
            design_task_id: uploadTask.design_task_id,
            version_number: versionNum,
            storage_path: path,
            file_url: urlData.publicUrl,
            file_name: file.name,
            uploaded_by: profile.id,
            notes: batchNotes || null,
            status: 'uploaded',
            source: batchSource,
          })
          .select('id')
          .single();
        if (versionError) throw new Error(`Could not save design version for ${file.name}: ${versionError.message}`);
        newVersionIds.push(versionRow.id);
        setUploadProgress({ done: i + 1, total: stagedFiles.length });
      }

      // Mark the boards this batch covers — this is the actual "which
      // board is designed" system: every selected board gets linked to
      // every file in this batch, then flipped to 'designed', unless it's
      // already moved further along the pipeline than that.
      if (selectedItemIds.size > 0) {
        const links = newVersionIds.flatMap((versionId) =>
          Array.from(selectedItemIds).map((workItemId) => ({
            organization_id: orgId,
            design_version_id: versionId,
            work_item_id: workItemId,
          }))
        );
        const { error: linkError } = await supabase.from('design_version_items').insert(links);
        if (linkError) throw new Error(`Could not mark covered boards: ${linkError.message}`);

        const { error: itemsError } = await supabase
          .from('work_items')
          .update({ status: 'designed' })
          .in('id', Array.from(selectedItemIds))
          .in('status', ['approved', 'designing']);
        if (itemsError) throw new Error(`Could not update board status: ${itemsError.message}`);
      }

      const { error: taskError } = await supabase.from('design_tasks').update({ status: 'design_ready' }).eq('id', uploadTask.design_task_id).select('id');
      if (taskError) throw new Error(`Could not update design task: ${taskError.message}`);

      await logAudit(
        'design_versions',
        null,
        'upload',
        null,
        null,
        null,
        `Uploaded ${stagedFiles.length} design file(s) for ${uploadTask.shop_name}, covering ${selectedItemIds.size} board(s)`
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['design-task-list', orgId] });
      queryClient.invalidateQueries({ queryKey: ['design-task-stats', orgId] });
      queryClient.invalidateQueries({ queryKey: ['design-task-detail'] });
      queryClient.invalidateQueries({ queryKey: ['nav-pending-counts', orgId] });
      closeUploadModal();
    },
    onSettled: () => setUploadProgress(null),
  });

  async function handleExportDesignReport(row: DesignTaskRow, format: 'pdf' | 'ppt') {
    if (!detail) return;
    setExportError(null);
    setExportingTaskId(row.design_task_id);
    try {
      await exportShopDesignReport(row, detail, format, org);
    } catch (err) {
      setExportError((err as Error).message || 'Could not generate the report.');
    } finally {
      setExportingTaskId(null);
    }
  }

  return (
    <div>
      <PageHeader
        title="Design Studio"
        subtitle={isDesigner ? "Your assigned shops — what to design, what's pending, what's done" : 'Manage design tasks for approved shops'}
      />

      {/* Summary strip */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-5">
        <StatTile icon={<Clock className="w-4 h-4" />} label="Pending Shops" value={stats?.pending_shops} accent="amber" />
        <StatTile icon={<Layers className="w-4 h-4" />} label="Boards Pending" value={stats?.boards_pending} accent="fuchsia" />
        <StatTile icon={<Eye className="w-4 h-4" />} label="In Review" value={stats?.in_review} accent="blue" />
        <StatTile icon={<CheckCircle2 className="w-4 h-4" />} label="Approved" value={stats?.approved} accent="green" />
        <StatTile icon={<PackageCheck className="w-4 h-4" />} label="In Production" value={stats?.in_production} accent="teal" />
      </div>

      {/* Filter menu + search */}
      <div className="flex flex-col gap-3 mb-4">
        <div className="flex gap-1.5 overflow-x-auto pb-1 -mx-1 px-1">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setActiveTab(t.key)}
              className={`shrink-0 px-3 py-1.5 rounded-lg text-sm font-medium border transition ${
                activeTab === t.key
                  ? 'bg-slate-900 text-white border-slate-900'
                  : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
              }`}
            >
              {t.label}
              {stats && t.statKey && <span className="opacity-60"> ({stats[t.statKey]})</span>}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2 items-center">
          {/* Board-progress filter — both roles get this; it's purely
              about board completion, nothing PO/financial. */}
          <div className="relative shrink-0">
            <Layers className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <select
              value={boardProgressFilter}
              onChange={(e) => setBoardProgressFilter(e.target.value as typeof boardProgressFilter)}
              className="pl-8 pr-7 py-1.5 border border-slate-200 rounded-lg text-sm text-slate-600 bg-white focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none appearance-none"
            >
              <option value="all">All boards</option>
              <option value="not_started">Not started</option>
              <option value="in_progress">In progress</option>
              <option value="done">Fully designed</option>
            </select>
          </div>
          {/* Order-type filter — owner/admin only, so it's how the app
              answers "chahe supply only ho ya survey wala ho ya kisi PO ka
              ho" without ever exposing PO context to a designer. */}
          {!isDesigner && (
            <div className="relative shrink-0">
              <Filter className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <select
                value={typeFilter}
                onChange={(e) => setTypeFilter(e.target.value as typeof typeFilter)}
                className="pl-8 pr-7 py-1.5 border border-slate-200 rounded-lg text-sm text-slate-600 bg-white focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none appearance-none"
              >
                <option value="all">All types</option>
                <option value="survey_install">Survey & Install</option>
                <option value="supply_only">Supply Only</option>
                <option value="custom">Custom PO</option>
                <option value="no_po">No PO (direct)</option>
              </select>
            </div>
          )}
          <button
            onClick={() => setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'))}
            className="shrink-0 flex items-center gap-1 px-2.5 py-1.5 border border-slate-200 rounded-lg text-sm text-slate-600 bg-white hover:bg-slate-50"
            title="Toggle sort order"
          >
            <ArrowUpDown className="w-3.5 h-3.5" /> {sortDir === 'desc' ? 'Newest first' : 'Oldest first'}
          </button>
          <div className="relative flex-1 min-w-[180px] sm:ml-auto sm:flex-none sm:w-64">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search shop, client, city..."
              className="w-full pl-9 pr-3 py-1.5 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
            />
            {listFetching && !listLoading && (
              <Loader2 className="w-3.5 h-3.5 text-slate-300 animate-spin absolute right-3 top-1/2 -translate-y-1/2" />
            )}
          </div>
        </div>
      </div>

      {/* If the list or stats query itself failed (e.g. a backend
          migration hasn't been applied yet), say so plainly instead of
          just showing an empty list that looks like "the filters aren't
          doing anything". */}
      {(listIsError || statsIsError) && (
        <div className="mb-4 flex items-start gap-2 bg-red-50 border border-red-200 text-red-700 rounded-lg px-3 py-2.5 text-sm">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <div className="min-w-0">
            <p className="font-medium">Couldn't load the design list.</p>
            <p className="text-xs text-red-600/80 break-words">{((listQueryError || statsQueryError) as Error)?.message}</p>
          </div>
          <button onClick={() => refetchList()} className="ml-auto shrink-0 text-xs font-medium underline">Retry</button>
        </div>
      )}

      {/* Bulk toolbar — appears the moment anything is selected. A
          selection can freely mix `in_review` and `approved` shops; each
          action button below only acts on the subset of the current
          selection its own status actually applies to, and says exactly
          how many that is so it's never ambiguous what "Approve 3" vs
          "Send 2 to Production" is about to do. */}
      {(canApprove || isDesigner) && selectedRowIds.size > 0 && (() => {
        const selectedRows = rows.filter((r) => selectedRowIds.has(r.design_task_id));
        const selInReview = selectedRows.filter((r) => r.status === 'in_review');
        const selApproved = selectedRows.filter((r) => r.status === 'approved');
        const selDesignReady = selectedRows.filter((r) => r.status === 'design_ready');
        return (
          <div className="mb-4 flex items-center gap-2 flex-wrap bg-indigo-50 border border-indigo-200 rounded-lg px-3 py-2.5">
            <span className="text-sm font-medium text-indigo-900">{selectedRowIds.size} selected</span>
            <button
              onClick={() => setSelectedRowIds(new Set())}
              className="text-xs text-indigo-600 hover:underline"
            >
              Clear
            </button>
            <div className="ml-auto flex items-center gap-2 flex-wrap">
              {bulkExportProgress && (
                <span className="text-xs text-indigo-700 flex items-center gap-1">
                  <Loader2 className="w-3 h-3 animate-spin" /> Exporting {bulkExportProgress.done}/{bulkExportProgress.total}…
                </span>
              )}
              <button
                onClick={() => bulkExport(selectedRows, 'pdf')}
                disabled={!!bulkExportProgress}
                className="flex items-center gap-1 bg-white border border-indigo-200 text-indigo-700 px-2.5 py-1.5 rounded-lg text-xs font-medium disabled:opacity-50"
              >
                <FileDown className="w-3.5 h-3.5" /> Export PDF
              </button>
              <button
                onClick={() => bulkExport(selectedRows, 'ppt')}
                disabled={!!bulkExportProgress}
                className="flex items-center gap-1 bg-white border border-indigo-200 text-indigo-700 px-2.5 py-1.5 rounded-lg text-xs font-medium disabled:opacity-50"
              >
                <Presentation className="w-3.5 h-3.5" /> Export PPT
              </button>
              {canApprove && selInReview.length > 0 && (
                <button
                  onClick={() => bulkApproveMutation.mutate(selInReview)}
                  disabled={bulkApproveMutation.isPending}
                  className="flex items-center gap-1 bg-green-600 hover:bg-green-700 text-white px-3 py-1.5 rounded-lg text-xs font-medium disabled:opacity-50"
                >
                  <CheckCircle2 className="w-3.5 h-3.5" /> {bulkApproveMutation.isPending ? 'Approving…' : `Approve ${selInReview.length}`}
                </button>
              )}
              {canApprove && selApproved.length > 0 && (
                <button
                  onClick={() => { setBulkProductionRows(selApproved); setBulkProductionUserId(''); }}
                  className="flex items-center gap-1 bg-teal-600 hover:bg-teal-700 text-white px-3 py-1.5 rounded-lg text-xs font-medium"
                >
                  <PackageCheck className="w-3.5 h-3.5" /> Send {selApproved.length} to Production
                </button>
              )}
              {isDesigner && selDesignReady.length > 0 && (
                <button
                  onClick={() => bulkSendForReviewMutation.mutate(selDesignReady)}
                  disabled={bulkSendForReviewMutation.isPending}
                  className="flex items-center gap-1 bg-amber-500 hover:bg-amber-600 text-white px-3 py-1.5 rounded-lg text-xs font-medium disabled:opacity-50"
                >
                  <Send className="w-3.5 h-3.5" /> {bulkSendForReviewMutation.isPending ? 'Sending…' : `Send ${selDesignReady.length} for Review`}
                </button>
              )}
            </div>
          </div>
        );
      })()}
      {bulkApproveMutation.isError && (
        <p className="text-xs text-red-600 mb-3">{(bulkApproveMutation.error as Error).message}</p>
      )}
      {bulkSendToProductionMutation.isError && (
        <p className="text-xs text-red-600 mb-3">{(bulkSendToProductionMutation.error as Error).message}</p>
      )}
      {bulkSendForReviewMutation.isError && (
        <p className="text-xs text-red-600 mb-3">{(bulkSendForReviewMutation.error as Error).message}</p>
      )}
      {exportError && (
        <p className="text-xs text-red-600 mb-3 flex items-center gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> {exportError}
          <button onClick={() => setExportError(null)} className="ml-1 underline shrink-0">Dismiss</button>
        </p>
      )}

      {/* Shop list — one compact row per assigned shop; click to expand the
          full board/marking/version detail. Server-paginated so this stays
          fast at any shop count. */}
      <Card className="overflow-hidden">
        <div className="divide-y divide-slate-100">
          {listLoading &&
            Array.from({ length: 4 }).map((_, i) => <RowSkeleton key={i} />)}

          {!listLoading && rows.map((row) => {
            const progressPct = row.total_boards > 0 ? Math.round((row.done_boards / row.total_boards) * 100) : 0;
            const isOpen = expandedTaskId === row.design_task_id;

            return (
              <div key={row.design_task_id}>
                {/* Summary row — a plain div (not a <button>) because it now
                    hosts real action buttons (Upload / Review / Send to
                    Production) inline, so a designer or owner can act on a
                    shop straight from the collapsed list without expanding
                    it and scrolling down to find the button. Expand/collapse
                    still works by clicking anywhere else in the row. */}
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => toggleExpand(row)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleExpand(row); } }}
                  className="w-full text-left px-4 py-3 flex items-center gap-3 hover:bg-slate-50 transition cursor-pointer"
                >
                  {/* Bulk-select checkbox — owner sees it on shops awaiting
                      their approval, designer sees it on shops of their own
                      that are ready to send up. Whichever bulk action makes
                      sense for the role viewing this row. */}
                  {isRowSelectable(row) && (
                    <input
                      type="checkbox"
                      checked={selectedRowIds.has(row.design_task_id)}
                      onChange={() => toggleRowSelected(row.design_task_id)}
                      onClick={(e) => e.stopPropagation()}
                      className="shrink-0 w-4 h-4 rounded border-slate-300"
                    />
                  )}
                  <div className="shrink-0 w-11 h-11 rounded-lg bg-slate-50 border border-slate-200 flex flex-col items-center justify-center">
                    <span className="text-xs font-bold text-slate-700 leading-none">{row.done_boards}/{row.total_boards || 0}</span>
                    <span className="text-[8px] text-slate-400 mt-0.5">boards</span>
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-semibold text-slate-900 truncate">{row.shop_name}</p>
                      {/* PO context is an owner/admin-only concern — a
                          designer should never see which (or whether a) PO
                          a shop is linked to anywhere on this screen. */}
                      {!isDesigner && row.po_number && (
                        <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-teal-100 text-teal-700 shrink-0">
                          {row.po_name ? `${row.po_name} (${row.po_number})` : `PO ${row.po_number}`}
                        </span>
                      )}
                      {row.requires_design_all_false && (
                        <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-teal-100 text-teal-700 shrink-0">
                          No Design Needed
                        </span>
                      )}
                      {row.survey_date && (
                        <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 shrink-0 flex items-center gap-1">
                          <Calendar className="w-2.5 h-2.5" /> {new Date(row.survey_date).toLocaleDateString('en-IN')}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-slate-500 truncate">
                      {row.client_name}{row.shop_city ? ` · ${row.shop_city}` : ''}
                      {!isDesigner && <span className="text-slate-400"> · Designer: {row.designer_name || 'Unassigned'}</span>}
                    </p>
                  </div>

                  <div className="hidden sm:block w-24 shrink-0">
                    <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
                      <div className="h-1.5 bg-green-500 transition-all" style={{ width: `${progressPct}%` }} />
                    </div>
                    <p className="text-[10px] text-slate-400 mt-1 text-right">{progressPct}%</p>
                  </div>

                  {/* Quick actions — the primary next step for this exact
                      shop, one click away, no expanding required. */}
                  <div className="flex items-center gap-1.5 shrink-0" onClick={(e) => e.stopPropagation()}>
                    {canApprove && row.requires_design_all_false && row.status !== 'ready_for_production' && (
                      <button
                        onClick={() => { setProductionTask(row); setProductionUserId(''); }}
                        title="This PO line item doesn't require design — send straight to Production"
                        className="flex items-center gap-1 bg-teal-600 hover:bg-teal-700 text-white px-2.5 py-1.5 rounded-lg text-xs font-medium"
                      >
                        <PackageCheck className="w-3.5 h-3.5" /> Design Not Required — Send
                      </button>
                    )}
                    {isDesigner && ['assigned', 'designing', 'design_ready'].includes(row.status) && (
                      <button
                        onClick={() => quickUpload(row)}
                        disabled={quickActionLoadingId === row.design_task_id}
                        className="flex items-center gap-1 bg-blue-600 hover:bg-blue-700 text-white px-2.5 py-1.5 rounded-lg text-xs font-medium disabled:opacity-60"
                      >
                        {quickActionLoadingId === row.design_task_id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
                        Upload
                      </button>
                    )}
                    {isDesigner && row.status === 'design_ready' && (
                      <button
                        onClick={() => updateStatusMutation.mutate({ row, status: 'in_review' })}
                        disabled={updateStatusMutation.isPending && updateStatusMutation.variables?.row?.design_task_id === row.design_task_id}
                        className="flex items-center gap-1 bg-amber-500 hover:bg-amber-600 text-white px-2.5 py-1.5 rounded-lg text-xs font-medium disabled:opacity-60"
                      >
                        {updateStatusMutation.isPending && updateStatusMutation.variables?.row?.design_task_id === row.design_task_id ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Send className="w-3.5 h-3.5" />
                        )}
                        Send for Review
                      </button>
                    )}
                    {canApprove && row.status === 'in_review' && (
                      <button
                        onClick={() => quickReview(row)}
                        disabled={quickActionLoadingId === row.design_task_id}
                        className="flex items-center gap-1 bg-amber-500 hover:bg-amber-600 text-white px-2.5 py-1.5 rounded-lg text-xs font-medium disabled:opacity-60"
                      >
                        {quickActionLoadingId === row.design_task_id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Eye className="w-3.5 h-3.5" />}
                        Review
                      </button>
                    )}
                    {canApprove && row.status === 'approved' && (
                      <button
                        onClick={() => { setProductionTask(row); setProductionUserId(''); }}
                        className="flex items-center gap-1 bg-teal-600 hover:bg-teal-700 text-white px-2.5 py-1.5 rounded-lg text-xs font-medium"
                      >
                        <PackageCheck className="w-3.5 h-3.5" /> Send
                      </button>
                    )}
                    {/* Export straight from the row too — a shop with any
                        uploaded design can be exported without expanding. */}
                    {row.version_count > 0 && (
                      <>
                        <button
                          onClick={() => quickExport(row, 'pdf')}
                          disabled={quickActionLoadingId === row.design_task_id}
                          title="Export survey-vs-design PDF"
                          className="flex items-center gap-1 bg-white border border-slate-200 text-slate-500 hover:text-slate-700 hover:bg-slate-50 px-2 py-1.5 rounded-lg text-xs font-medium disabled:opacity-50"
                        >
                          <FileDown className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => quickExport(row, 'ppt')}
                          disabled={quickActionLoadingId === row.design_task_id}
                          title="Export survey-vs-design PPT"
                          className="flex items-center gap-1 bg-white border border-slate-200 text-slate-500 hover:text-slate-700 hover:bg-slate-50 px-2 py-1.5 rounded-lg text-xs font-medium disabled:opacity-50"
                        >
                          <Presentation className="w-3.5 h-3.5" />
                        </button>
                      </>
                    )}
                  </div>

                  <StatusBadge status={row.status} />
                  <ChevronDown className={`w-4 h-4 text-slate-400 shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
                </div>

                {/* Expanded detail */}
                {isOpen && (
                  <div className="px-4 pb-4 border-t border-slate-100 bg-slate-50/50">
                    <div className="flex flex-wrap gap-x-4 gap-y-1 pt-3 pb-3 text-xs text-slate-500">
                      {row.shop_address && <span className="flex items-center gap-1"><MapPin className="w-3.5 h-3.5" /> {row.shop_address}</span>}
                      {row.shop_owner_name && <span className="flex items-center gap-1"><User className="w-3.5 h-3.5" /> {row.shop_owner_name}</span>}
                      {row.shop_contact_phone && <span className="flex items-center gap-1"><Phone className="w-3.5 h-3.5" /> {row.shop_contact_phone}</span>}
                    </div>

                    {detailLoading ? (
                      <div className="flex items-center gap-2 text-sm text-slate-400 py-6 justify-center">
                        <Loader2 className="w-4 h-4 animate-spin" /> Loading boards & survey markings…
                      </div>
                    ) : (
                      <>
                        {/* Boards to design, each tied back to its exact survey
                            marking — with the actual marked-up photo shown, not
                            just a text size, so it's unambiguous which surveyed
                            outline a board's dimensions came from. */}
                        {(detail?.items.length || 0) > 0 ? (
                          <div className="mb-3 border border-slate-200 rounded-lg overflow-hidden bg-white">
                            <div className="flex items-center justify-between px-3 py-2 bg-slate-50 border-b border-slate-100">
                              <span className="text-xs font-semibold text-slate-600 flex items-center gap-1.5">
                                <Layers className="w-3.5 h-3.5" /> Boards to design
                              </span>
                              <span className="text-xs font-medium text-slate-500">{row.done_boards}/{row.total_boards} designed</span>
                            </div>
                            <div className="divide-y divide-slate-100">
                              {detail!.items.map((item) => {
                                const { dims, qty } = boardLabel(item);
                                const isDone = BOARD_DONE_STATUSES.includes(item.status);
                                const isNotReady = NOT_READY_STATUSES.includes(item.status);
                                const canToggle = isDesigner && BOARD_TOGGLEABLE_STATUSES.includes(item.status);
                                const ref = markingRefFor(item.id);
                                return (
                                  <div key={item.id} className="flex items-center gap-3 px-3 py-2.5 text-sm">
                                    <DesignMarkingPreview
                                      photoUrl={ref?.photo?.photo_url}
                                      points={ref?.marking.points}
                                      label={boardCaption(item, ref)}
                                      onClick={setLightbox}
                                    />
                                    <button
                                      disabled={!canToggle || toggleBoardMutation.isPending}
                                      onClick={() => canToggle && toggleBoardMutation.mutate(item)}
                                      className={`shrink-0 ${canToggle ? 'cursor-pointer' : 'cursor-default'}`}
                                      title={canToggle ? (isDone ? 'Mark as pending' : 'Mark as designed') : undefined}
                                    >
                                      {isNotReady ? (
                                        <Lock className="w-4 h-4 text-slate-300" />
                                      ) : isDone ? (
                                        <CheckCircle2 className="w-4 h-4 text-green-600" />
                                      ) : (
                                        <Circle className="w-4 h-4 text-amber-500" />
                                      )}
                                    </button>
                                    <div className="flex-1 min-w-0">
                                      <div className="flex items-center gap-1.5 flex-wrap">
                                        <span className="font-medium text-slate-800">{item.work_type_name || 'Board'}</span>
                                        <span className="text-slate-400">
                                          {[item.material, dims, qty ? `×${qty}` : null].filter(Boolean).join(' · ')}
                                        </span>
                                      </div>
                                      {/* Which survey marking this board is — required
                                          record so it's never ambiguous which design
                                          goes with which measurement, especially when
                                          several boards share one photo. */}
                                      {ref ? (
                                        <span className="inline-flex items-center gap-1 text-[10px] text-indigo-600 bg-indigo-50 border border-indigo-100 rounded px-1.5 py-0.5 mt-1">
                                          <Hash className="w-2.5 h-2.5" /> Marking #{ref.number} of {ref.total}
                                          {ref.photo?.caption ? ` · ${ref.photo.caption}` : ''}
                                        </span>
                                      ) : !isNotReady ? (
                                        <span className="inline-flex items-center gap-1 text-[10px] text-slate-400 mt-1">No survey marking on record</span>
                                      ) : null}
                                    </div>
                                    <span
                                      className={`text-xs px-2 py-0.5 rounded-full font-medium shrink-0 ${
                                        isNotReady ? 'bg-slate-100 text-slate-500' : isDone ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'
                                      }`}
                                    >
                                      {isNotReady ? 'Awaiting Approval' : isDone ? 'Designed' : 'Pending'}
                                    </span>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        ) : (
                          <p className="text-xs text-slate-400 mb-3 italic">No boards recorded from survey for this shop yet.</p>
                        )}

                        {/* Uploaded design versions — each annotated with exactly
                            which numbered marking(s) it covers, so the record is
                            on file for designer and owner alike, not just implied
                            by upload order. */}
                        {(detail?.versions.length || 0) > 0 && (
                          <div className="mb-3 border border-slate-200 rounded-lg overflow-hidden bg-white">
                            <div className="px-3 py-2 bg-slate-50 border-b border-slate-100">
                              <span className="text-xs font-semibold text-slate-600 flex items-center gap-1.5">
                                <FileImage className="w-3.5 h-3.5" /> Uploaded designs
                              </span>
                            </div>
                            <div className="divide-y divide-slate-100">
                              {detail!.versions
                                .slice()
                                .sort((a, b) => b.version_number - a.version_number)
                                .map((v) => {
                                  const coveredItems = detail!.versionItems
                                    .filter((link) => link.design_version_id === v.id)
                                    .map((link) => detail!.items.find((i) => i.id === link.work_item_id))
                                    .filter(Boolean) as WorkItem[];
                                  return (
                                    <div key={v.id} className="px-3 py-2 text-sm">
                                      <div className="flex items-center gap-2 flex-wrap">
                                        <span className="text-slate-500 font-medium">v{v.version_number}</span>
                                        <a href={v.file_url} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline flex items-center gap-1">
                                          <FileImage className="w-3.5 h-3.5" /> {v.file_name || 'View'}
                                        </a>
                                        <StatusBadge status={v.status} />
                                        <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${v.source === 'client_provided' ? 'bg-indigo-100 text-indigo-700' : 'bg-slate-100 text-slate-500'}`}>
                                          {v.source === 'client_provided' ? 'Client-supplied' : 'Agency-designed'}
                                        </span>
                                        <span className="text-[10px] text-slate-400">{new Date(v.created_at).toLocaleDateString('en-IN')}</span>
                                      </div>
                                      {coveredItems.length > 0 && (
                                        <div className="flex flex-wrap gap-1 mt-1.5">
                                          {coveredItems.map((it) => {
                                            const ref = markingRefFor(it.id);
                                            return (
                                              <span key={it.id} className="inline-flex items-center gap-1 text-[10px] bg-slate-50 border border-slate-200 text-slate-600 rounded px-1.5 py-0.5">
                                                {it.work_type_name || 'Board'}
                                                {ref && <span className="text-indigo-500">· Marking #{ref.number}</span>}
                                              </span>
                                            );
                                          })}
                                        </div>
                                      )}
                                      {v.notes && <p className="text-xs text-slate-400 mt-1 italic">"{v.notes}"</p>}
                                    </div>
                                  );
                                })}
                            </div>
                          </div>
                        )}

                        {/* exportError now surfaces once, in the top-level banner — see above the list. */}

                        <div className="flex gap-2 flex-wrap items-center">
                          <Link to={`/shops/${row.shop_id}`} className="text-sm text-blue-600 hover:underline mr-auto flex items-center gap-1">
                            Shop Details <ChevronRight className="w-4 h-4" />
                          </Link>

                          {(detail?.versions.length || 0) > 0 && (
                            <>
                              <button
                                onClick={() => handleExportDesignReport(row, 'pdf')}
                                disabled={exportingTaskId === row.design_task_id}
                                className="flex items-center gap-1 bg-white border border-slate-200 text-slate-600 px-3 py-1.5 rounded-lg text-sm font-medium hover:bg-slate-50 disabled:opacity-50"
                                title="Export survey-vs-design comparison as PDF"
                              >
                                <FileDown className="w-4 h-4" /> {exportingTaskId === row.design_task_id ? 'Exporting…' : 'PDF'}
                              </button>
                              <button
                                onClick={() => handleExportDesignReport(row, 'ppt')}
                                disabled={exportingTaskId === row.design_task_id}
                                className="flex items-center gap-1 bg-white border border-slate-200 text-slate-600 px-3 py-1.5 rounded-lg text-sm font-medium hover:bg-slate-50 disabled:opacity-50"
                                title="Export survey-vs-design comparison as PPT"
                              >
                                <Presentation className="w-4 h-4" /> {exportingTaskId === row.design_task_id ? 'Exporting…' : 'PPT'}
                              </button>
                            </>
                          )}

                          {row.requires_design_all_false && row.status !== 'ready_for_production' && canApprove && (
                            <button onClick={() => { setProductionTask(row); setProductionUserId(''); }} className="bg-teal-50 text-teal-700 border border-teal-200 px-3 py-1.5 rounded-lg text-sm font-medium">
                              Design Not Required — Send to Production
                            </button>
                          )}
                          {isDesigner && (
                            <button onClick={() => detail && openUploadModal(row, detail)} className="flex items-center gap-1 bg-blue-600 text-white px-3 py-1.5 rounded-lg text-sm font-medium">
                              <Upload className="w-4 h-4" /> Upload Designs
                            </button>
                          )}
                          {row.status === 'design_ready' && (
                            <button onClick={() => updateStatusMutation.mutate({ row, status: 'in_review' })} className="bg-amber-50 text-amber-700 border border-amber-200 px-3 py-1.5 rounded-lg text-sm font-medium">
                              Send for Review
                            </button>
                          )}
                          {row.status === 'in_review' && canApprove && (
                            <button onClick={() => updateStatusMutation.mutate({ row, status: 'approved', versions: detail?.versions })} className="bg-green-50 text-green-700 border border-green-200 px-3 py-1.5 rounded-lg text-sm font-medium">
                              Approve Design
                            </button>
                          )}
                          {row.status === 'approved' && canApprove && (
                            <button onClick={() => { setProductionTask(row); setProductionUserId(''); }} className="bg-teal-50 text-teal-700 border border-teal-200 px-3 py-1.5 rounded-lg text-sm font-medium">
                              Ready for Production
                            </button>
                          )}
                        </div>
                        {updateStatusMutation.isError && updateStatusMutation.variables?.row?.design_task_id === row.design_task_id && (
                          <p className="text-xs text-red-600 mt-2">{(updateStatusMutation.error as Error).message}</p>
                        )}
                        {toggleBoardMutation.isError && <p className="text-xs text-red-600 mt-2">{(toggleBoardMutation.error as Error).message}</p>}
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}

          {!listLoading && rows.length === 0 && (
            <EmptyState
              icon={<Palette className="w-12 h-12" />}
              title="No design tasks"
              subtitle={totalCount === 0 && activeTab === 'all' && !debouncedSearch ? 'Approved shops will appear here for design work' : 'Nothing matches this filter/search'}
            />
          )}
        </div>

        {/* Pagination — keeps every page a small, fast, indexed query
            instead of loading the whole org's shop list at once. */}
        {totalCount > 0 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-slate-100 text-sm">
            <p className="text-xs text-slate-500 flex items-center gap-1.5">
              <LayoutList className="w-3.5 h-3.5" />
              Showing {page * PAGE_SIZE + 1}–{Math.min(totalCount, page * PAGE_SIZE + PAGE_SIZE)} of {totalCount}
            </p>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={page === 0 || listFetching}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-200 text-slate-600 text-xs font-medium disabled:opacity-40 hover:bg-slate-50"
              >
                <ChevronLeft className="w-3.5 h-3.5" /> Prev
              </button>
              <span className="text-xs text-slate-400">Page {page + 1} of {pageCount}</span>
              <button
                onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                disabled={page >= pageCount - 1 || listFetching}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-200 text-slate-600 text-xs font-medium disabled:opacity-40 hover:bg-slate-50"
              >
                Next <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        )}
      </Card>

      {/* Lightbox for the marked survey image */}
      {lightbox && (
        <div onClick={() => setLightbox(null)} className="fixed inset-0 z-[100] bg-black/80 flex items-center justify-center p-4 cursor-zoom-out">
          <img src={lightbox} alt="Marked board" className="max-w-full max-h-full rounded-lg" />
        </div>
      )}

      {/* Owner review — the whole point is that this is short: shop
          identity up top, every board's survey-marking vs. latest design
          side by side in one compact list, Approve / Request Changes right
          there. No expanding, no scrolling through the full board/version
          audit trail just to make the one decision this screen exists
          for. */}
      <Modal open={!!reviewTask} onClose={() => { setReviewTask(null); setRequestingChanges(false); setChangesNote(''); }} title="Review Design" size="lg">
        {reviewTask && (
          <div className="space-y-4">
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <p className="font-semibold text-slate-900">{reviewTask.shop_name}</p>
                {reviewTask.po_number && (
                  <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-teal-100 text-teal-700">{reviewTask.po_name ? `${reviewTask.po_name} (${reviewTask.po_number})` : `PO ${reviewTask.po_number}`}</span>
                )}
              </div>
              <p className="text-xs text-slate-500">
                {reviewTask.client_name}{reviewTask.shop_city ? ` · ${reviewTask.shop_city}` : ''}
                {reviewTask.designer_name ? ` · Designed by ${reviewTask.designer_name}` : ''}
              </p>
              <button
                onClick={() => {
                  const { shop_id, design_task_id, items, photos, markings, versions, versionItems } = reviewTask;
                  queryClient.setQueryData(['design-task-detail', shop_id, design_task_id], { items, photos, markings, versions, versionItems });
                  setExpandedShopId(shop_id);
                  setExpandedTaskId(design_task_id);
                  setReviewTask(null);
                  setRequestingChanges(false);
                  setChangesNote('');
                }}
                className="text-xs text-blue-600 hover:underline mt-1"
              >
                See full board & version history →
              </button>
            </div>

            <div className="border border-slate-200 rounded-lg divide-y divide-slate-100 max-h-[50vh] overflow-y-auto">
              {reviewTask.items.length === 0 && <p className="text-xs text-slate-400 italic px-3 py-3">No boards recorded from survey for this shop.</p>}
              {(() => {
                const reviewNumbering = numberMarkingsByPhoto(reviewTask.markings);
                return reviewTask.items.map((item) => {
                const marking = reviewTask.markings.find((m) => m.work_item_id === item.id && m.points?.length >= 3);
                const photo = marking ? reviewTask.photos.find((p) => p.id === marking.survey_photo_id) : null;
                const numbering = reviewNumbering.get(item.id);
                const coveringVersions = reviewTask.versionItems
                  .filter((link) => link.work_item_id === item.id)
                  .map((link) => reviewTask.versions.find((v) => v.id === link.design_version_id))
                  .filter(Boolean) as DesignVersion[];
                const latestDesign = coveringVersions.sort((a, b) => b.version_number - a.version_number)[0] || null;
                const { dims } = boardLabel(item);
                const isDone = BOARD_DONE_STATUSES.includes(item.status);
                return (
                  <div key={item.id} className="flex items-center gap-2.5 px-3 py-2.5 text-sm">
                    <DesignMarkingPreview
                      photoUrl={photo?.photo_url}
                      points={marking?.points}
                      label={numbering ? `#${numbering.number} — ${item.work_type_name || 'Board'}` : item.work_type_name}
                      className="w-20 h-20"
                      onClick={setLightbox}
                    />
                    <ChevronRight className="w-3.5 h-3.5 text-slate-300 shrink-0" />
                    {latestDesign?.file_url && /\.(png|jpe?g|webp|gif)$/i.test(latestDesign.file_name || '') ? (
                      <DesignFilePreview url={latestDesign.file_url} onClick={setLightbox} />
                    ) : (
                      <div className="shrink-0 w-20 h-20 rounded-lg border border-dashed border-slate-200 bg-slate-50 flex items-center justify-center">
                        <FileImage className="w-4 h-4 text-slate-300" />
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-slate-800 truncate">{item.work_type_name || 'Board'} <span className="text-slate-400 font-normal">{dims}</span></p>
                      <p className="text-[11px] text-slate-400 truncate">
                        {latestDesign ? `v${latestDesign.version_number} · ${latestDesign.source === 'client_provided' ? 'Client-supplied' : 'Agency-designed'}` : 'No design uploaded yet'}
                      </p>
                    </div>
                    <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium shrink-0 ${isDone ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'}`}>
                      {isDone ? 'Designed' : 'Pending'}
                    </span>
                  </div>
                );
                });
              })()}
            </div>

            {requestingChanges ? (
              <div className="space-y-2">
                <Textarea label="What needs to change?" value={changesNote} onChange={setChangesNote} rows={2} placeholder="e.g. Logo too small, wrong colour on the flex board..." />
                <div className="flex gap-2">
                  <button onClick={() => { setRequestingChanges(false); setChangesNote(''); }} className="flex-1 border border-slate-200 text-slate-600 font-medium py-2 rounded-lg text-sm">
                    Cancel
                  </button>
                  <button
                    onClick={() => requestChangesMutation.mutate({ row: reviewTask, note: changesNote })}
                    disabled={requestChangesMutation.isPending}
                    className="flex-1 bg-amber-500 hover:bg-amber-600 text-white font-medium py-2 rounded-lg text-sm disabled:opacity-50"
                  >
                    {requestChangesMutation.isPending ? 'Sending…' : 'Send Back to Designer'}
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex gap-2">
                <button onClick={() => setRequestingChanges(true)} className="flex-1 border border-amber-200 text-amber-700 bg-amber-50 font-medium py-2.5 rounded-lg text-sm">
                  Request Changes
                </button>
                <button
                  onClick={() => updateStatusMutation.mutate({ row: reviewTask, status: 'approved', versions: reviewTask.versions })}
                  disabled={updateStatusMutation.isPending}
                  className="flex-1 bg-green-600 hover:bg-green-700 text-white font-medium py-2.5 rounded-lg text-sm disabled:opacity-50"
                >
                  {updateStatusMutation.isPending ? 'Approving…' : 'Approve Design'}
                </button>
              </div>
            )}
            {(updateStatusMutation.isError || requestChangesMutation.isError) && (
              <p className="text-xs text-red-600">{((updateStatusMutation.error || requestChangesMutation.error) as Error).message}</p>
            )}
          </div>
        )}
      </Modal>

      {/* Multi-file upload with review-before-submit */}
      <Modal open={!!uploadTask} onClose={closeUploadModal} title="Upload Design(s)" size="lg">
        <div className="space-y-4">
          <p className="text-sm text-slate-600">Shop: <span className="font-medium text-slate-900">{uploadTask?.shop_name}</span></p>

          {(uploadTask?.items?.length || 0) > 0 && (
            <div>
              <p className="text-sm font-medium text-slate-700 mb-2">Which boards does this batch cover?</p>
              <p className="text-xs text-slate-400 mb-2">
                Each board below shows the exact survey marking it was measured from — check the outline and size before uploading, since sizes differ per marking.
              </p>
              <div className="border border-slate-200 rounded-lg divide-y divide-slate-100 max-h-64 overflow-y-auto">
                {uploadTask!.items
                  .filter((i) => !NOT_READY_STATUSES.includes(i.status))
                  .map((item) => {
                    const { dims, qty } = boardLabel(item);
                    const checked = selectedItemIds.has(item.id);
                    const ref = markingRefFor(item.id);
                    return (
                      <label key={item.id} className="flex items-start gap-2 px-3 py-2 text-sm cursor-pointer hover:bg-slate-50">
                        <input type="checkbox" checked={checked} onChange={() => toggleSelectedItem(item.id)} className="rounded border-slate-300 mt-0.5" />
                        <DesignMarkingPreview
                          photoUrl={ref?.photo?.photo_url}
                          points={ref?.marking.points}
                          label={boardCaption(item, ref)}
                          className="w-10 h-10"
                          onClick={setLightbox}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="font-medium text-slate-800">{item.work_type_name || 'Board'}</span>
                            <span className="text-slate-400">{[item.material, dims, qty ? `×${qty}` : null].filter(Boolean).join(' · ')}</span>
                          </div>
                          {ref ? (
                            <span className="inline-flex items-center gap-1 text-[10px] text-indigo-600 bg-indigo-50 border border-indigo-100 rounded px-1.5 py-0.5 mt-1">
                              <Hash className="w-2.5 h-2.5" /> Marking #{ref.number} of {ref.total} on this photo
                            </span>
                          ) : (
                            <span className="text-[10px] text-slate-400">No survey marking on record</span>
                          )}
                        </div>
                        {BOARD_DONE_STATUSES.includes(item.status) && <span className="ml-auto text-xs text-green-600 shrink-0">already designed</span>}
                      </label>
                    );
                  })}
              </div>
              <p className="text-xs text-slate-400 mt-1">Checked boards will be marked "Designed" once this batch uploads, and this upload will be recorded against each marking shown above. Required — at least one board must be selected.</p>
            </div>
          )}

          <Select
            label="Design Source"
            value={batchSource}
            onChange={(v) => setBatchSource(v as 'agency_designed' | 'client_provided')}
            options={[
              { value: 'agency_designed', label: 'Agency-designed (made in-house)' },
              { value: 'client_provided', label: 'Client-provided (received from client)' },
            ]}
          />

          <Textarea label="Notes" value={batchNotes} onChange={setBatchNotes} rows={2} placeholder="Notes for this batch (applies to every file uploaded)..." />

          <input ref={fileRef} type="file" accept="image/*,.pdf" multiple onChange={handleFilesSelected} className="hidden" />
          <button
            onClick={() => fileRef.current?.click()}
            className="w-full flex items-center justify-center gap-2 border-2 border-dashed border-slate-300 text-slate-600 font-medium py-3 rounded-lg hover:border-blue-400 hover:text-blue-600 transition"
          >
            <Plus className="w-5 h-5" /> Add Files
          </button>

          {stagedFiles.length > 0 && (
            <div>
              <p className="text-sm font-medium text-slate-700 mb-2">Review before uploading ({stagedFiles.length} file{stagedFiles.length > 1 ? 's' : ''})</p>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {stagedFiles.map((f) => (
                  <div key={f.id} className="relative border border-slate-200 rounded-lg overflow-hidden group">
                    <button onClick={() => removeStaged(f.id)} className="absolute top-1 right-1 bg-black/60 hover:bg-black/80 text-white rounded-full p-0.5 z-10">
                      <X className="w-3.5 h-3.5" />
                    </button>
                    {f.previewUrl ? (
                      <img src={f.previewUrl} alt={f.file.name} className="w-full h-24 object-cover" />
                    ) : (
                      <div className="w-full h-24 flex items-center justify-center bg-slate-50">
                        <FileText className="w-8 h-8 text-slate-400" />
                      </div>
                    )}
                    <p className="text-[11px] text-slate-600 px-1.5 py-1 truncate bg-white">{f.file.name}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {uploadMutation.isError && <p className="text-sm text-red-600">{(uploadMutation.error as Error).message}</p>}

          <button
            onClick={() => uploadMutation.mutate()}
            disabled={uploadMutation.isPending || stagedFiles.length === 0 || ((uploadTask?.items?.length || 0) > 0 && selectedItemIds.size === 0)}
            className="w-full flex items-center justify-center gap-2 bg-blue-600 text-white font-medium py-3 rounded-lg disabled:opacity-50"
          >
            <Upload className="w-5 h-5" />
            {uploadMutation.isPending
              ? `Uploading ${uploadProgress ? `${uploadProgress.done}/${uploadProgress.total}` : '...'}`
              : `Upload ${stagedFiles.length || ''} Design${stagedFiles.length === 1 ? '' : 's'}`}
          </button>
        </div>
      </Modal>

      <Modal open={!!productionTask} onClose={() => setProductionTask(null)} title="Send to Production">
        <div className="space-y-4">
          <p className="text-sm text-slate-600">Shop: <span className="font-medium text-slate-900">{productionTask?.shop_name}</span></p>
          {productionTask?.requires_design_all_false && (
            <p className="text-xs text-teal-700 bg-teal-50 border border-teal-200 rounded-lg p-2.5">
              This PO line item doesn't require design — sending straight to Production without an uploaded design file.
            </p>
          )}
          <Select
            label="Assign Production Person"
            value={productionUserId}
            onChange={setProductionUserId}
            options={[
              { value: '', label: 'Select a person...' },
              ...(productionPeople || []).map((p) => ({ value: p.id, label: p.full_name })),
            ]}
            required
          />
          {productionPeople && productionPeople.length === 0 && (
            <p className="text-xs text-amber-600">No active production/printing team members found. Add one from Owner Console → Users first.</p>
          )}
          {updateStatusMutation.isError && updateStatusMutation.variables?.row?.design_task_id === productionTask?.design_task_id && (
            <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-2">{(updateStatusMutation.error as Error).message}</p>
          )}
          <button
            onClick={() => productionTask && updateStatusMutation.mutate({ row: productionTask, status: 'ready_for_production', assignedTo: productionUserId })}
            disabled={updateStatusMutation.isPending || !productionUserId}
            className="w-full bg-teal-600 hover:bg-teal-700 text-white font-medium py-2.5 rounded-lg disabled:opacity-50"
          >
            {updateStatusMutation.isPending ? 'Sending...' : 'Confirm & Send to Production'}
          </button>
        </div>
      </Modal>

      {/* Bulk "Send to Production" — one production-person pick applied to
          every selected approved shop at once. */}
      <Modal open={!!bulkProductionRows} onClose={() => { setBulkProductionRows(null); setBulkProductionUserId(''); }} title="Send to Production">
        <div className="space-y-4">
          <div>
            <p className="text-sm text-slate-600 mb-1.5">Sending <span className="font-medium text-slate-900">{bulkProductionRows?.length}</span> shop(s):</p>
            <div className="max-h-32 overflow-y-auto border border-slate-200 rounded-lg divide-y divide-slate-100">
              {bulkProductionRows?.map((r) => (
                <p key={r.design_task_id} className="text-xs text-slate-600 px-2.5 py-1.5">{r.shop_name}</p>
              ))}
            </div>
          </div>
          <Select
            label="Assign Production Person"
            value={bulkProductionUserId}
            onChange={setBulkProductionUserId}
            options={[
              { value: '', label: 'Select a person...' },
              ...(productionPeople || []).map((p) => ({ value: p.id, label: p.full_name })),
            ]}
            required
          />
          {productionPeople && productionPeople.length === 0 && (
            <p className="text-xs text-amber-600">No active production/printing team members found. Add one from Owner Console → Users first.</p>
          )}
          {bulkSendToProductionMutation.isError && (
            <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-2">{(bulkSendToProductionMutation.error as Error).message}</p>
          )}
          <button
            onClick={() => bulkProductionRows && bulkSendToProductionMutation.mutate({ selected: bulkProductionRows, assignedTo: bulkProductionUserId })}
            disabled={bulkSendToProductionMutation.isPending || !bulkProductionUserId}
            className="w-full bg-teal-600 hover:bg-teal-700 text-white font-medium py-2.5 rounded-lg disabled:opacity-50"
          >
            {bulkSendToProductionMutation.isPending ? 'Sending...' : `Confirm & Send ${bulkProductionRows?.length || ''} to Production`}
          </button>
        </div>
      </Modal>
    </div>
  );
}

const ACCENTS: Record<string, string> = {
  amber: 'text-amber-600 bg-amber-50 border-amber-100',
  fuchsia: 'text-fuchsia-600 bg-fuchsia-50 border-fuchsia-100',
  blue: 'text-blue-600 bg-blue-50 border-blue-100',
  green: 'text-green-600 bg-green-50 border-green-100',
  teal: 'text-teal-600 bg-teal-50 border-teal-100',
};

function StatTile({ icon, label, value, accent }: { icon: React.ReactNode; label: string; value: number | undefined; accent: string }) {
  return (
    <Card className="p-3.5 flex items-center gap-3">
      <div className={`w-9 h-9 rounded-lg border flex items-center justify-center shrink-0 ${ACCENTS[accent]}`}>{icon}</div>
      <div className="min-w-0">
        <p className="text-xl font-bold text-slate-900 leading-none">{value ?? '–'}</p>
        <p className="text-[11px] text-slate-500 mt-1 truncate">{label}</p>
      </div>
    </Card>
  );
}

// The uploaded design file's own preview inside the Review modal — same
// "always show something real, never a permanent spinner" rule as
// DesignMarkingPreview: it renders the image directly and only swaps to
// the placeholder icon if the file genuinely fails to load.
function DesignFilePreview({ url, onClick }: { url: string; onClick?: (src: string) => void }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <div className="shrink-0 w-20 h-20 rounded-lg border border-dashed border-slate-200 bg-slate-50 flex items-center justify-center">
        <FileImage className="w-4 h-4 text-slate-300" />
      </div>
    );
  }
  return (
    <button type="button" onClick={() => onClick?.(url)} className="shrink-0 w-20 h-20 rounded-lg overflow-hidden border border-slate-200 bg-slate-100">
      <img src={url} alt="Design" onError={() => setFailed(true)} className="w-full h-full object-cover" />
    </button>
  );
}

function RowSkeleton() {
  return (
    <div className="px-4 py-3 flex items-center gap-3 animate-pulse">
      <div className="w-11 h-11 rounded-lg bg-slate-100 shrink-0" />
      <div className="flex-1 space-y-2">
        <div className="h-3.5 bg-slate-100 rounded w-1/3" />
        <div className="h-2.5 bg-slate-100 rounded w-1/4" />
      </div>
      <div className="hidden sm:block w-28 h-1.5 bg-slate-100 rounded-full shrink-0" />
      <div className="w-16 h-5 bg-slate-100 rounded-full shrink-0" />
    </div>
  );
}
