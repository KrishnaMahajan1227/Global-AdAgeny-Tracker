import { SecureImage, SecureAnchor } from '@/lib/secureMedia';
import { fetchWorkflowFolderPages } from '@/lib/workflowFolderPages';
import { runBoundedWorkflowBatch, summarizeWorkflowBatch } from '@/lib/workflowBatch';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { hasUsableApprovedSize, usesPreDesignMeasurements } from '@/lib/noSurveySizing';
import { useAuth } from '@/lib/auth';
import { Card, StatusBadge, EmptyState, PageHeader, Modal, Textarea, Select } from '@/components/ui';
import { logAudit, createNotification } from '@/lib/helpers';
import { getCompanyApprovalStatus } from '@/lib/companyApproval';
import { latestReviewArtworkByItem, reviewArtworkCoverage, validateDesignCorrection, reviewQueueFromSelection, reviewQueueRemaining, latestReviewArtworkGroupByItem } from '@/lib/designReview';
import { CompanyApprovalHandoff } from '@/components/CompanyApprovalHandoff';
import { useRealtimeInvalidate } from '@/lib/useRealtimeInvalidate';
import { WorkItem, SurveyPhoto, BoardMarking, DesignVersion, DesignVersionItem, Shop, Organization } from '@/lib/types';
import { numberMarkingsByPhoto } from '@/lib/markingUtils';
import { designCoverage, editableDesignBoards, validateArtworkMappings } from '@/lib/designArtworkMapping';
import { designWorkDisplay, designArtworkDisplayName, designArtworkStorageStem } from '@/lib/designPresentation';
import { formatDim, itemSizeLabel } from '@/lib/units';
import { buildDesignComparisonRows, generateDesignComparisonPDF, generateDesignComparisonPPT } from '@/lib/reports';
import { DesignMarkingPreview } from '@/components/DesignMarkingPreview';
import { MarkedPhotoGrid } from '@/components/MarkedPhotoGrid';
import {
  Palette, Upload, ChevronRight, ChevronDown, ChevronLeft, FileImage, FileText, CheckCircle2, Circle,
  X, Search, MapPin, Phone, User, Layers, Lock, Plus, FileDown,
  Presentation, Calendar, Hash, Clock, Eye, PackageCheck, LayoutList, Loader2, Filter, ArrowUpDown, AlertTriangle, Send, Camera,
  Folder, FolderTree, ImagePlus,
} from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import { validWorkOrderId } from '@/lib/operationalNavigation';

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

const DEFAULT_PAGE_SIZE = 50;

// Sentinel for the folder browser's "No Campaign" / "No Work Order" /
// "No Zone" bucket — distinct from '' (which means "haven't narrowed by
// this level at all, show everything"). Same convention as Production
// Studio's folder browser (ProductionPage.tsx).
const NO_FOLDER_BUCKET = '__none__';

function boardLabel(item: WorkItem) {
  const w = formatDim(item.approved_width ?? item.survey_width);
  const h = formatDim(item.approved_height ?? item.survey_height);
  const unit = item.approved_unit ?? item.survey_unit ?? 'ft';
  const qty = item.approved_quantity ?? item.survey_quantity ?? 1;
  const sizeTxt = itemSizeLabel(item);
  const dims = sizeTxt !== '—' ? sizeTxt : (w && h ? `${w}×${h} ${unit}` : null);
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
  // migration 0080 — same folder-browser columns Production's list
  // already has (migration 0079). At most one of project_id/campaign_id
  // is ever set on a given PO (agency's own vs. client's own campaign —
  // see PurchaseOrdersPage.tsx).
  zone_id: string | null;
  zone_name: string | null;
  po_id: string | null;
  project_id: string | null;
  project_name: string | null;
  campaign_id: string | null;
  campaign_name: string | null;
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
  photoItems: { survey_photo_id: string; work_item_id: string }[];
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
  const [markingsRes, versionItemsRes, photoItemsRes] = await Promise.all([
    photoIds.length
      ? supabase.from('board_markings').select('*').in('survey_photo_id', photoIds)
      : Promise.resolve({ data: [], error: null }),
    versionIds.length
      ? supabase.from('design_version_items').select('*').in('design_version_id', versionIds)
      : Promise.resolve({ data: [], error: null }),
    photoIds.length
      ? supabase.from('survey_photo_items').select('survey_photo_id,work_item_id').in('survey_photo_id', photoIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (markingsRes.error) throw new Error(`Could not load survey markings: ${markingsRes.error.message}`);
  if (versionItemsRes.error) throw new Error(`Could not load design coverage: ${versionItemsRes.error.message}`);
  if (photoItemsRes.error && !/survey_photo_items|schema cache|could not find the table/i.test(photoItemsRes.error.message || '')) throw new Error(`Could not load survey photo coverage: ${photoItemsRes.error.message}`);

  return {
    items: (items || []) as WorkItem[],
    photos: (photos || []) as SurveyPhoto[],
    markings: (markingsRes.data || []) as BoardMarking[],
    versions: (versions || []) as DesignVersion[],
    versionItems: (versionItemsRes.data || []) as DesignVersionItem[],
    photoItems: (photoItemsRes.error ? [] : (photoItemsRes.data || [])) as { survey_photo_id: string; work_item_id: string }[],
  };
}

// Every design-task action notifies exactly the people whose job the next
// step is — never the whole org. Designer-facing events go to that one
// design task's `designer_id`; "needs a decision" events go to whichever
// org members can actually approve a design (agency_owner/admin —
// the same set `canApprove` checks against on this page), never to
// designers, production, or installer accounts who have no reason to see
// design-review traffic.
async function notifyDesignReviewers(orgId: string, shopName: string) {
  const { data: reviewers } = await supabase
    .from('profiles')
    .select('id')
    .eq('organization_id', orgId)
    .in('role', ['agency_owner', 'admin'])
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
    detailData.versionItems,
    detailData.photoItems
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
async function decideDesignReview(row: DesignTaskRow, redoItemIds: string[] = [], note = '') {
  // One database transaction for all board decisions. The RPC rejects stale
  // tasks, incomplete artwork and missing company approvals before finalization.
  const { data, error } = await supabase.rpc('design_review_decide', {
    p_task_id: row.design_task_id, p_redo_item_ids: redoItemIds, p_note: note.trim() || null,
  });
  if (error) {
    if (/design_review_decide|schema cache|could not find the function/i.test(error.message)) {
      throw new Error('Design Review database migration 0119 is missing. Apply the pending migration before approving.');
    }
    throw new Error(`Design review failed: ${error.message}`);
  }
  return data as { finalized: boolean; left_review?: boolean };
}

async function sendDesignTaskToProduction(row: DesignTaskRow, assignedTo: string) {
  if (!assignedTo) throw new Error('Select a production team member first.');
  // One atomic, audited operation; no partial design/order/shop state on network failure.
  // Retry is safe: the database returns the existing production order.
  const { error } = await supabase.rpc('phase3_send_to_production', {
    p_design_task_id: row.design_task_id,
    p_assignee_id: assignedTo,
  });
  if (error) {
    if (/could not find the function|schema cache/i.test(error.message)) {
      throw new Error('Phase 3 database migration (0099) is not applied. Ask the agency administrator to deploy it before sending production tasks.');
    }
    throw new Error(`Production handoff failed: ${error.message}`);
  }
}

export default function DesignerPage() {
  const [routeParams, setRouteParams] = useSearchParams();
  const linkedPoId = validWorkOrderId(routeParams.get('po'));
  const { profile } = useAuth();
  const orgId = profile?.organization_id;
  const queryClient = useQueryClient();
  const isDesigner = profile?.role === 'designer';
  const canApprove = profile?.role === 'agency_owner' || profile?.role === 'admin';
  // The assigned Designer works their own queue; Owner/Admin may also prepare or
  // correct artwork without impersonating the assigned person. Approval stays privileged.
  const canEditArtwork = isDesigner || canApprove;
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

  const [activeTab, setActiveTab] = useState(isDesigner ? 'pending' : (linkedPoId ? 'all' : 'in_review'));
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  // Order-type filter — owner/admin only. A designer must never see PO
  // context at all (not the badge, not this filter), so it stays gated
  // behind `!isDesigner` everywhere it's rendered below.
  const [typeFilter, setTypeFilter] = useState<'all' | 'survey_install' | 'production_install' | 'supply_only' | 'custom' | 'no_po'>('all');
  // Board-progress filter — available to BOTH roles (unlike order type,
  // this has nothing to do with PO/financial context, so a designer gets
  // it too): how far along are a shop's boards, independent of the
  // shop-level task status shown in the tabs above.
  const [boardProgressFilter, setBoardProgressFilter] = useState<'all' | 'not_started' | 'in_progress' | 'done'>('all');
  // Folder browser — Client -> Work Order -> Zone, same
  // levels Production Studio uses (migration 0079/0080/0083). Previously
  // Campaign/Work Order were skipped entirely for a designer session —
  // this no longer holds: a designer gets the same full folder tree
  // Owner/Admin and Production see. (Order-type/fulfillment context
  // above, `typeFilter`, stays designer-hidden — that's financial/
  // billing-flavoured in a way a folder label isn't.)
  const [clientFilter, setClientFilter] = useState('');
  const [poFilter, setPoFilter] = useState(linkedPoId);
  const [zoneFilter, setZoneFilter] = useState('');
  const [browsingList, setBrowsingList] = useState(true);
  useEffect(() => {
    setPoFilter(linkedPoId);
    if (linkedPoId) { setClientFilter(''); setZoneFilter(''); setBrowsingList(true); }
  }, [linkedPoId]);
  const [sortDir, setSortDir] = useState<'desc' | 'asc'>('desc');
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const [expandedShopId, setExpandedShopId] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<string | null>(null);

  // Quick actions (Upload / Review) fire straight from the collapsed row
  // — no expand-and-scroll required to reach them. Each just needs that
  // one shop's detail loaded once, on demand, then opens its modal.
  const [quickActionLoadingId, setQuickActionLoadingId] = useState<string | null>(null);
  const [reviewTask, setReviewTask] = useState<(DesignTaskRow & ShopDesignDetail) | null>(null);
  // Review selected shops sequentially. Only one shop's artwork is loaded at a
  // time; each decision remains independently validated and atomic in the DB.
  const [reviewQueue, setReviewQueue] = useState<DesignTaskRow[]>([]);
  const [reviewQueueTotal, setReviewQueueTotal] = useState(0);
  const reviewRequestId = useRef(0);
  const [requestingChanges, setRequestingChanges] = useState(false);
  const [changesNote, setChangesNote] = useState('');
  const [reviewCorrectionIds, setReviewCorrectionIds] = useState<Set<string>>(new Set());
  const reviewArtwork = useMemo(() => latestReviewArtworkByItem(
    reviewTask?.versions || [], reviewTask?.versionItems || [],
  ), [reviewTask]);
  const reviewArtworkGroups = useMemo(() => latestReviewArtworkGroupByItem(
    reviewTask?.versions || [], reviewTask?.versionItems || [],
  ), [reviewTask]);
  const reviewCoverage = useMemo(() => reviewArtworkCoverage(
    reviewTask?.items || [], reviewArtwork,
  ), [reviewTask, reviewArtwork]);
  // Same query as CompanyApprovalHandoff: React Query de-duplicates requests.
  // An unknown approval state is not permission to bypass a company gate.
  const companyApproval = useQuery({
    queryKey: ['phase2-company-approval', 'design', reviewTask?.design_task_id],
    queryFn: () => getCompanyApprovalStatus('design', reviewTask!.design_task_id),
    enabled: !!reviewTask && canApprove,
    staleTime: 8000,
  });
  const companyGateReady = !!companyApproval.data && (!companyApproval.data.required || companyApproval.data.valid);

  // Multi-select — owner/admin only ("review and approve multiple at
  // once"). Only shops actually awaiting a decision (`in_review`) can be
  // selected, since bulk approve is the only bulk action that makes sense
  // here; a shop leaves the selection automatically once it's no longer
  // in that state (list refetch naturally drops it).
  const [selectedRowIds, setSelectedRowIds] = useState<Set<string>>(new Set());
  const [bulkExportProgress, setBulkExportProgress] = useState<{ done: number; total: number } | null>(null);

  const [uploadTask, setUploadTask] = useState<(DesignTaskRow & ShopDesignDetail) | null>(null);
  const [stagedFiles, setStagedFiles] = useState<{ id: string; file: File; previewUrl: string | null; workItemIds: string[] }[]>([]);
  const [batchNotes, setBatchNotes] = useState('');
  const [showDesignOptions, setShowDesignOptions] = useState(false);
  const [fileDragOver, setFileDragOver] = useState(false);
  const [stagingError, setStagingError] = useState('');
  const [batchSource, setBatchSource] = useState<'agency_designed' | 'client_provided'>('agency_designed');
  // Default to completing the handoff in the same save. Partial/incomplete boards remain drafts.
  // Every file has its own explicit, shop-scoped work-item/marking mapping.
  // Existing saved drafts also count toward a complete design; uploading a
  // revision for one board must not force reuploading all of its siblings.
  const uploadEditableItems = useMemo(() => editableDesignBoards(uploadTask?.items || []), [uploadTask]);
  const uploadLatestVersionByItem = useMemo(() => {
    const byVersion = new Map((uploadTask?.versions || [])
      .filter(v => !['deleted', 'rejected'].includes(v.status)).map(v => [v.id, v]));
    const mapped = new Map<string, DesignVersion>();
    for (const link of uploadTask?.versionItems || []) {
      const version = byVersion.get(link.design_version_id);
      if (!version) continue;
      const previous = mapped.get(link.work_item_id);
      if (!previous || version.version_number > previous.version_number) mapped.set(link.work_item_id, version);
    }
    return mapped;
  }, [uploadTask]);
  const uploadCoverage = useMemo(() => designCoverage(
    uploadTask?.items || [], uploadTask?.versions || [], uploadTask?.versionItems || [], stagedFiles,
  ), [uploadTask, stagedFiles]);
  const uploadMappingError = validateArtworkMappings(uploadTask?.items || [], stagedFiles);
  const uncoveredEditableItemIds = uploadEditableItems.filter(item => !uploadCoverage.covered.has(item.id)).map(item => item.id);
  const canSubmitUploadForReview = !!uploadTask && !uploadMappingError && uploadCoverage.ready;

  // IMPORTANT: the expanded row may belong to another shop. Upload previews
  // must ALWAYS resolve markings against this modal's own shop detail.
  const uploadNumbering = useMemo(() => numberMarkingsByPhoto(uploadTask?.markings || []), [uploadTask]);
  const uploadMarkingByItem = useMemo(() => new Map((uploadTask?.markings || [])
    .filter(marking => marking.work_item_id).map(marking => [marking.work_item_id as string, marking])), [uploadTask]);
  const uploadPhotosById = useMemo(() => new Map((uploadTask?.photos || [])
    .map(photo => [photo.id, photo])), [uploadTask]);
  function uploadMarkingRefFor(workItemId: string) {
    const marking = uploadMarkingByItem.get(workItemId);
    const numbering = uploadNumbering.get(workItemId);
    if (!marking || !numbering) return null;
    return { marking, photo: uploadPhotosById.get(marking.survey_photo_id) || null,
      number: numbering.number, total: numbering.total };
  }
  const [uploadProgress, setUploadProgress] = useState<{ done: number; total: number } | null>(null);
  const [uploadMustRefresh, setUploadMustRefresh] = useState(false);
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

  useEffect(() => { setPage(0); setSelectedRowIds(new Set()); }, [activeTab, debouncedSearch, typeFilter, boardProgressFilter, sortDir, clientFilter, poFilter, zoneFilter]);
  // Selection belongs to the visible page, not stale IDs from prior pages.
  useEffect(() => { setSelectedRowIds(new Set()); }, [page, pageSize]);

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

  // Zero-click default only when there is exactly one active printing user.
  // With two or more, the owner must explicitly decide the assignee.
  const effectiveProductionUserId = productionUserId || (productionPeople?.length === 1 ? productionPeople[0].id : '');
  const effectiveBulkProductionUserId = bulkProductionUserId || (productionPeople?.length === 1 ? productionPeople[0].id : '');

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
    queryKey: ['design-task-list', orgId, designerFilter, activeTab, debouncedSearch, page, pageSize, typeFilter, boardProgressFilter, sortDir, clientFilter, poFilter, zoneFilter],
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
      // Folder browser — Client/Campaign/Work Order/Zone, available to
      // both roles now.
      if (clientFilter) q = q.eq('client_id', clientFilter);
      if (poFilter === NO_FOLDER_BUCKET) q = q.is('po_id', null);
      else if (poFilter) q = q.eq('po_id', poFilter);
      if (zoneFilter === NO_FOLDER_BUCKET) q = q.is('zone_id', null);
      else if (zoneFilter) q = q.eq('zone_id', zoneFilter);
      const term = debouncedSearch.replace(/[,%()]/g, ' ').trim();
      if (term) q = q.or(`shop_name.ilike.%${term}%,client_name.ilike.%${term}%,shop_city.ilike.%${term}%,po_number.ilike.%${term}%,po_name.ilike.%${term}%`);
      q = q.order('created_at', { ascending: sortDir === 'asc' }).range(page * pageSize, page * pageSize + pageSize - 1);
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
  const pageCount = Math.max(1, Math.ceil(totalCount / pageSize));

  // ---- Folder browser (Campaign -> Work Order -> Zone) ----
  // Same lightweight, unpaginated tree fetch Production Studio uses:
  // same status tab/search/type/board-progress filters as the list
  // above, minus campaign/po/zone (those ARE the tree), minimal columns.
  const { data: treeRows, isFetching: treeFetching } = useQuery({
    queryKey: ['design-task-tree', orgId, designerFilter, activeTab, debouncedSearch, typeFilter, boardProgressFilter],
    queryFn: async () => {
      let q = supabase
        .from('v_design_task_list')
        .select('design_task_id, client_id, client_name, project_id, project_name, campaign_id, campaign_name, po_id, po_number, po_name, zone_id, zone_name, status')
        .eq('organization_id', orgId);
      if (designerFilter) q = q.eq('designer_id', designerFilter);
      if (tab.statuses) q = q.in('status', tab.statuses);
      if (!isDesigner) {
        if (typeFilter === 'no_po') q = q.is('po_number', null);
        else if (typeFilter !== 'all') q = q.eq('fulfillment_type', typeFilter);
      }
      if (boardProgressFilter !== 'all') q = q.eq('board_progress', boardProgressFilter);
      const term = debouncedSearch.replace(/[,%()]/g, ' ').trim();
      if (term) q = q.or(`shop_name.ilike.%${term}%,client_name.ilike.%${term}%,shop_city.ilike.%${term}%,po_number.ilike.%${term}%,po_name.ilike.%${term}%`);
      q = q.order('design_task_id', { ascending: true });
      const data = await fetchWorkflowFolderPages(async (from, to) => {
        const { data: batch, error } = await q.range(from, to);
        if (error) throw new Error(`Could not load the folder browser: ${error.message}`);
        return batch || [];
      });
      return data as {
        design_task_id: string; client_id: string; client_name: string | null; project_id: string | null; project_name: string | null;
        campaign_id: string | null; campaign_name: string | null;
        po_id: string | null; po_number: string | null; po_name: string | null;
        zone_id: string | null; zone_name: string | null; status: string;
      }[];
    },
    // Fetch organization-wide folder data only while browsing folders (or within a selected folder).
    // The default Action Queue uses the server-paginated task list instead of loading the entire tree.
    enabled: !!orgId && !browsingList && !debouncedSearch,
    staleTime: 30_000,
  });

  // Historical grouping remains in stored records, but folder navigation is directly Work Order based.
  const poFolders = useMemo(() => {
    const scoped = (treeRows || []).filter((r) => (!clientFilter || r.client_id === clientFilter));
    const map = new Map<string, { id: string; name: string; count: number }>();
    for (const r of scoped) {
      const key = r.po_id || NO_FOLDER_BUCKET;
      const name = r.po_id ? (r.po_name ? `${r.po_name} (${r.po_number})` : r.po_number || 'Unnamed Work Order') : 'No Work Order';
      const entry = map.get(key) || { id: key, name, count: 0 };
      entry.count += 1;
      map.set(key, entry);
    }
    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [treeRows, clientFilter]);

  const zoneFolders = useMemo(() => {
    const scoped = (treeRows || []).filter((r) => {
      if (clientFilter && r.client_id !== clientFilter) return false;
      if (poFilter === NO_FOLDER_BUCKET) return !r.po_id;
      if (poFilter) return r.po_id === poFilter;
      return true;
    });
    const map = new Map<string, { id: string; name: string; count: number }>();
    for (const r of scoped) {
      const key = r.zone_id || NO_FOLDER_BUCKET;
      const name = r.zone_id ? (r.zone_name || 'Unnamed Zone') : 'No Zone';
      const entry = map.get(key) || { id: key, name, count: 0 };
      entry.count += 1;
      map.set(key, entry);
    }
    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [treeRows, clientFilter, poFilter]);

  // Client tiles — the new top level, same for both roles. No "No
  // Client" bucket needed since every shop always has exactly one
  // (shops.client_id is NOT NULL).
  const clientFolders = useMemo(() => {
    const map = new Map<string, { id: string; name: string; count: number }>();
    for (const r of treeRows || []) {
      const entry = map.get(r.client_id) || { id: r.client_id, name: r.client_name || 'Unnamed Client', count: 0 };
      entry.count += 1;
      map.set(r.client_id, entry);
    }
    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [treeRows]);

  // Designer now gets the exact same folder tree Owner/Admin and
  // Production see — Client -> Work Order -> Zone.
  const folderLevel: 'client' | 'po' | 'zone' = !clientFilter ? 'client' : !poFilter ? 'po' : 'zone';
  const selectedClientName = clientFilter ? (clientFolders.find((c) => c.id === clientFilter)?.name || 'Client') : null;
  const selectedPoName = poFilter
    ? (poFilter === NO_FOLDER_BUCKET ? 'No Work Order' : (poFolders.find((p) => p.id === poFilter)?.name || 'Work Order'))
    : null;
  const selectedZoneName = zoneFilter
    ? (zoneFilter === NO_FOLDER_BUCKET ? 'No Zone' : (zoneFolders.find((z) => z.id === zoneFilter)?.name || 'Zone'))
    : null;

  function resetFolderFrom(level: 'root' | 'client' | 'po' | 'zone') {
    if (level === 'root') { setClientFilter(''); setPoFilter(''); setZoneFilter(''); }
    else if (level === 'client') { setPoFilter(''); setZoneFilter(''); }
    else if (level === 'po') { setZoneFilter(''); }
    else if (level === 'zone') { setZoneFilter(''); }
    setBrowsingList(false);
  }

  // Typing a search term always shows results immediately, same as
  // Production Studio, regardless of how deep the folder tree is
  // currently browsed to.
  const showList = browsingList || !!debouncedSearch;


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
    ['design_tasks', 'design_versions', 'design_version_items', 'work_items', 'board_markings', 'production_orders', 'company_approval_handoffs'],
    orgId,
    [
      ['design-task-list', orgId],
      ['design-task-stats', orgId],
      ['design-task-detail'],
      ['design-task-tree', orgId],
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

  // Only Designer -> Review handoff lives here. Review decisions use the
  // separate design_review_decide RPC below, never an ad-hoc status update.
  const updateStatusMutation = useMutation({
    mutationFn: async ({ row, status, assignedTo }: {
      row: DesignTaskRow; status: 'in_review' | 'ready_for_production'; assignedTo?: string;
    }) => {
      if (status === 'ready_for_production') {
        if (!canApprove) throw new Error('Only Owner/Admin can send an approved design to Production.');
        if (!assignedTo) throw new Error('Select a production person first.');
        await sendDesignTaskToProduction(row, assignedTo);
        return;
      }
      if (!(canApprove || (isDesigner && row.designer_id === profile?.id))) {
        throw new Error('Only the assigned Designer or Owner/Admin may submit for review.');
      }
      if (row.status !== 'design_ready') throw new Error('Only a saved design can be sent for review.');
      const liveDetail = await fetchShopDetail(row.shop_id, row.design_task_id);
      const coverage = designCoverage(liveDetail.items, liveDetail.versions, liveDetail.versionItems, []);
      if (!coverage.ready) throw new Error('Some boards have no mapped artwork. Complete the missing work items first.');
      const { data: updated, error } = await supabase.from('design_tasks')
        .update({ status: 'in_review' }).eq('id', row.design_task_id)
        .eq('organization_id', row.organization_id).eq('status', 'design_ready').select('id');
      if (error) throw new Error(`Could not submit design: ${error.message}`);
      if (!updated?.length) throw new Error('Design was updated elsewhere. Refresh and retry.');
      try { await notifyDesignReviewers(row.organization_id, row.shop_name); }
      catch (error) { console.warn('Design submitted; reviewer notification failed.', error); }
      try { await logAudit('design_tasks', row.design_task_id, 'update', 'status', row.status, 'in_review', `Design submitted for review: ${row.shop_name}`); }
      catch (error) { console.warn('Design submitted; audit notification failed.', error); }
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
    },
  });

  // A review is a single decision surface: approve all, or send ONLY selected
  // boards for correction. The backend makes the whole shop decision atomic.
  const designReviewMutation = useMutation({
    mutationFn: async ({ row, redoIds, note }: { row: DesignTaskRow; redoIds: string[]; note: string }) => {
      if (!canApprove || row.status !== 'in_review') throw new Error('Only Owner/Admin can review a pending design.');
      if (redoIds.length) {
        const message = validateDesignCorrection(reviewTask?.items || [], redoIds, note);
        if (message) throw new Error(message);
      }
      return decideDesignReview(row, redoIds, note);
    },
    onSuccess: (_result, variables) => {
      const remainingQueue = reviewQueueRemaining(reviewQueue, variables.row.design_task_id);
      // A selected multi-shop run never accidentally approves another shop
      // outside that selection. Single-shop review keeps its fast 'Next' flow.
      const nextReview = reviewQueue.length
        ? remainingQueue[0]
        : rows.find(candidate => candidate.status === 'in_review' && candidate.design_task_id !== variables.row.design_task_id);
      setReviewQueue(remainingQueue);
      if (reviewQueue.length && !remainingQueue.length) setReviewQueueTotal(0);
      void refreshDesignBatch();
      queryClient.invalidateQueries({ queryKey: ['design-task-detail'] });
      queryClient.invalidateQueries({ queryKey: ['item-review-decisions'] });
      queryClient.invalidateQueries({ queryKey: ['phase2-company-approval'] });
      setSelectedRowIds(prev => new Set([...prev].filter(id => id !== variables.row.design_task_id)));
      setReviewTask(null);
      setRequestingChanges(false);
      setReviewCorrectionIds(new Set());
      setChangesNote('');
      if (nextReview) void quickReview(nextReview);
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
  const [designBatchProgress, setDesignBatchProgress] = useState<{ done: number; total: number } | null>(null);
  const [designBatchResult, setDesignBatchResult] = useState<string | null>(null);
  const designBatchProgressCallback = (done: number, total: number) => setDesignBatchProgress({ done, total });
  const refreshDesignBatch = () => {
    queryClient.invalidateQueries({ queryKey: ['design-task-list', orgId] });
    queryClient.invalidateQueries({ queryKey: ['design-task-tree', orgId] });
    queryClient.invalidateQueries({ queryKey: ['design-task-stats', orgId] });
    queryClient.invalidateQueries({ queryKey: ['design-task-detail'] });
    queryClient.invalidateQueries({ queryKey: ['production-order-list'] });
    queryClient.invalidateQueries({ queryKey: ['production-order-tree'] });
    queryClient.invalidateQueries({ queryKey: ['production-order-stats'] });
    queryClient.invalidateQueries({ queryKey: ['shops'] });
    queryClient.invalidateQueries({ queryKey: ['nav-pending-counts', orgId] });
  };
  const bulkSendToProductionMutation = useMutation({
    mutationFn: ({ selected, assignedTo }: { selected: DesignTaskRow[]; assignedTo: string }) => {
      if (!assignedTo) throw new Error('Select the Production team member.');
      return runBoundedWorkflowBatch(selected, row => sendDesignTaskToProduction(row, assignedTo), designBatchProgressCallback);
    },
    onSuccess: (result) => {
      setDesignBatchResult(summarizeWorkflowBatch(result, 'sent to Production', row => row.shop_name));
      const succeeded = new Set(result.completed.map(row => row.design_task_id));
      setSelectedRowIds(prev => new Set([...prev].filter(id => !succeeded.has(id))));
      if (result.failed.length) setBulkProductionRows(result.failed.map(f => f.item));
      else { setBulkProductionRows(null); setBulkProductionUserId(''); }
    },
    onSettled: () => { setDesignBatchProgress(null); refreshDesignBatch(); },
  });

  const bulkSendForReviewMutation = useMutation({
    mutationFn: (selected: DesignTaskRow[]) => runBoundedWorkflowBatch(selected, async row => {
      if (!(canApprove || (isDesigner && row.designer_id === profile?.id))) {
        throw new Error('This design is not assigned to your account.');
      }
      if (row.status !== 'design_ready') throw new Error('Only saved designs can be sent for review.');
      // Same evidence-coverage rule as single task submit. A bulk action is
      // a speed shortcut, never a way around marking/board verification.
      const liveDetail = await fetchShopDetail(row.shop_id, row.design_task_id);
      if (!designCoverage(liveDetail.items, liveDetail.versions, liveDetail.versionItems, []).ready) {
        throw new Error('Some boards lack mapped artwork. Open the shop and complete the missing markings.');
      }
      const { data: updatedTask, error } = await supabase.from('design_tasks')
        .update({ status: 'in_review' }).eq('id', row.design_task_id)
        .eq('organization_id', row.organization_id).eq('status', 'design_ready').select('id');
      if (error) throw new Error(error.message);
      if (!updatedTask?.length) throw new Error('This design changed in another session; refresh before retrying.');
      try { await notifyDesignReviewers(row.organization_id, row.shop_name); }
      catch (notificationError) { console.warn('Design sent for review; notification failed.', notificationError); }
      try { await logAudit('design_tasks', row.design_task_id, 'update', 'status', row.status, 'in_review', `Design task status changed to in_review for ${row.shop_name} (bulk send)`); }
      catch (auditError) { console.warn('Design sent for review; audit notification failed.', auditError); }
    }, designBatchProgressCallback),
    onSuccess: (result) => {
      setDesignBatchResult(summarizeWorkflowBatch(result, 'sent for review', row => row.shop_name));
      const succeeded = new Set(result.completed.map(row => row.design_task_id));
      setSelectedRowIds(prev => new Set([...prev].filter(id => !succeeded.has(id))));
    },
    onSettled: () => { setDesignBatchProgress(null); refreshDesignBatch(); },
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
    if (!canEditArtwork || (isDesigner && row.designer_id !== profile?.id)) {
      setExportError('Only the assigned Designer or Agency Owner/Admin can edit this artwork.');
      return;
    }
    setUploadTask({ ...row, ...loadedDetail });
    setUploadMustRefresh(false);
    setBatchNotes('');
    setBatchSource('agency_designed');
    setShowDesignOptions(false);
    setStagingError('');
    setStagedFiles([]);
    // Marking mapping is always explicit for multi-board tasks.
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

  function reviewSelectedShops(selected: DesignTaskRow[]) {
    if (!canApprove || quickActionLoadingId || designReviewMutation.isPending) return;
    const pending = reviewQueueFromSelection(selected);
    if (!pending.length) return;
    setReviewQueue(pending);
    setReviewQueueTotal(pending.length);
    void quickReview(pending[0]);
  }

  function skipReviewShop() {
    if (!reviewTask || designReviewMutation.isPending || quickActionLoadingId) return;
    const next = reviewQueueRemaining(reviewQueue, reviewTask.design_task_id);
    setReviewQueue(next);
    setReviewTask(null);
    if (next.length) void quickReview(next[0]);
    else setReviewQueueTotal(0);
  }

  async function quickReview(row: DesignTaskRow) {
    if (!canApprove || row.status !== 'in_review') return;
    const requestId = ++reviewRequestId.current;
    setQuickActionLoadingId(row.design_task_id);
    setRequestingChanges(false);
    setReviewCorrectionIds(new Set());
    setChangesNote('');
    try {
      const loadedDetail = await fetchShopDetail(row.shop_id, row.design_task_id);
      if (requestId !== reviewRequestId.current) return; // closed or a newer shop opened
      queryClient.setQueryData(['design-task-detail', row.shop_id, row.design_task_id], loadedDetail);
      setReviewTask({ ...row, ...loadedDetail });
    } catch (err) {
      if (requestId === reviewRequestId.current) {
        setExportError((err as Error).message);
        setReviewTask(null);
        setReviewQueue([]);
        setReviewQueueTotal(0);
      }
    } finally {
      if (requestId === reviewRequestId.current) setQuickActionLoadingId(null);
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
    setUploadMustRefresh(false);
    setStagedFiles([]);
    setBatchNotes('');
    setBatchSource('agency_designed');
    setUploadProgress(null);
  }

  useEffect(() => {
    return () => stagedFiles.forEach((f) => f.previewUrl && URL.revokeObjectURL(f.previewUrl));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Browse and drag-and-drop use exactly the same evidence upload path.
  // Duplicate files are ignored so repeated drops cannot create extra design versions.
  function stageDesignFiles(files: File[], workItemId?: string) {
    const accepted = files.filter(file =>
      ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes(file.type) && file.size <= 20 * 1024 * 1024
    );
    setStagingError(accepted.length !== files.length
      ? 'Only JPG, PNG, WebP or PDF files up to 20 MB are supported. Unsupported files were skipped.' : '');
    setStagedFiles(previous => {
      const next = [...previous];
      for (const file of accepted) {
        const key = `${file.name}:${file.size}:${file.lastModified}`;
        const already = next.findIndex(entry => `${entry.file.name}:${entry.file.size}:${entry.file.lastModified}` === key);
        if (already >= 0) {
          // Adding the same shared artwork from another marking card must
          // extend its mapping, rather than silently discarding that action.
          if (workItemId && !next[already].workItemIds.includes(workItemId)) {
            next[already] = { ...next[already], workItemIds: [...next[already].workItemIds, workItemId] };
          }
          continue;
        }
        next.push({
          id: `${file.name}-${file.size}-${Math.random().toString(36).slice(2)}`,
          file,
          previewUrl: URL.createObjectURL(file),
          workItemIds: workItemId ? [workItemId] : uploadEditableItems.length === 1 ? [uploadEditableItems[0].id] : [],
        });
      }
      return next;
    });
  }

  function handleFilesSelected(e: React.ChangeEvent<HTMLInputElement>) {
    stageDesignFiles(Array.from(e.target.files || []));
    e.target.value = '';
  }

  function removeStaged(id: string) {
    setStagedFiles(prev => {
      const target = prev.find(f => f.id === id);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      return prev.filter(f => f.id !== id);
    });
  }

  function toggleFileMarking(fileId: string, workItemId: string) {
    setStagedFiles(prev => prev.map(entry => {
      if (entry.id !== fileId) return entry;
      const ids = entry.workItemIds.includes(workItemId)
        ? entry.workItemIds.filter(id => id !== workItemId)
        : [...entry.workItemIds, workItemId];
      return { ...entry, workItemIds: ids };
    }));
  }

  function assignFilesByMarkingOrder() {
    // The designer deliberately opts into one-file-per-board order and can
    // inspect/change each mapping before the save button is enabled.
    if (stagedFiles.length !== uploadEditableItems.length) return;
    setStagedFiles(prev => prev.map((entry, index) => ({ ...entry, workItemIds: [uploadEditableItems[index].id] })));
  }

  const uploadMutation = useMutation({
    mutationFn: async ({ submitAfterUpload }: { submitAfterUpload: boolean }) => {
      if (!uploadTask || !profile) throw new Error('Sign in to continue.');
      if (!canEditArtwork || profile.organization_id !== uploadTask.organization_id) {
        throw new Error('This account cannot upload artwork for this agency.');
      }
      if (uploadMustRefresh) throw new Error('Reload the shop before attempting another upload.');
      if (stagedFiles.length === 0) throw new Error('Add at least one file before uploading.');
      // Avoid uploading orphaned versions when a reviewer already finished the task.
      const { data: currentTask, error: currentTaskError } = await supabase.from('design_tasks')
        .select('status, designer_id, organization_id, shop_id').eq('id', uploadTask.design_task_id).maybeSingle();
      if (currentTaskError) throw new Error(`Could not verify design state: ${currentTaskError.message}`);
      if (!currentTask || currentTask.organization_id !== orgId || currentTask.shop_id !== uploadTask.shop_id ||
          !['assigned', 'designing', 'design_ready', 'in_review'].includes(currentTask.status)) {
        throw new Error('This design moved or changed ownership. Refresh before uploading new artwork.');
      }
      if (isDesigner && currentTask.designer_id !== profile.id) {
        throw new Error('This design is no longer assigned to you. Refresh your work queue.');
      }
      // Section 5 — "every design upload must be unambiguously tagged to
      // shop + survey + work item ... never a bare file-upload with a
      // freeform 'which shop' text note." The shop/survey side is already
      // implicit in which task this modal was opened from; this is the
      // work-item half of that rule — a batch can't go up covering zero
      // boards, unless this shop genuinely has no recorded boards at all
      // (a pre-existing data edge case — see the empty state below).
      if (usesPreDesignMeasurements(uploadTask.fulfillment_type) && uploadTask.items.some((item) => !hasUsableApprovedSize(item))) {
        throw new Error('Owner/Admin must record valid Work Order quantities and sizes (where required) before artwork can be uploaded.');
      }
      const mappingError = validateArtworkMappings(uploadTask.items, stagedFiles);
      if (mappingError) throw new Error(mappingError);
      const mappedItemIds = Array.from(new Set(stagedFiles.flatMap(entry => entry.workItemIds)));
      const { data: liveItems, error: liveItemsError } = await supabase.from('work_items')
        .select('id,shop_id,status').eq('shop_id', uploadTask.shop_id).in('id', mappedItemIds);
      if (liveItemsError) throw new Error(`Could not verify linked boards: ${liveItemsError.message}`);
      if (liveItems?.length !== mappedItemIds.length ||
          validateArtworkMappings(liveItems || [], stagedFiles)) {
        throw new Error('One or more mapped boards changed or belong to another shop. Reload the shop before uploading.');
      }


      // Use the actual latest version number, not array length (deleted
      // versions and historical gaps can otherwise collide).
      const { data: latestVersion, error: latestVersionError } = await supabase
        .from('design_versions').select('version_number')
        .eq('design_task_id', uploadTask.design_task_id)
        .order('version_number', { ascending: false }).limit(1).maybeSingle();
      if (latestVersionError) throw new Error(`Could not determine design version: ${latestVersionError.message}`);
      const startVersion = latestVersion?.version_number || 0;
      const uploadBatchId = crypto.randomUUID();
      const newVersionIds: string[] = [];
      const uploadedPaths: string[] = [];
      let statusWritesStarted = false;
      try {
      for (let i = 0; i < stagedFiles.length; i++) {
        const versionNum = startVersion + i + 1;
        const entry = stagedFiles[i];
        const file = entry.file;
        // Storage object keys may reject whitespace/unicode/special characters.
        // Keep the original user-facing filename in design_versions.file_name.
        const storageStem = designArtworkStorageStem(entry.workItemIds, uploadTask.items);
        const fileExtension = (file.name.match(/\.(png|jpe?g|webp|pdf)$/i)?.[0] || '.file').toLowerCase();
        const path = `${orgId}/${uploadTask.design_task_id}/v${versionNum}-${Date.now()}-${i}-${storageStem}${fileExtension}`;
        const { error: uploadError } = await supabase.storage.from('design-files').upload(path, file);
        if (uploadError) throw new Error(`Could not upload ${file.name}: ${uploadError.message}`);
        uploadedPaths.push(path);
        const { data: urlData } = supabase.storage.from('design-files').getPublicUrl(path);
        const { data: versionRow, error: versionError } = await supabase
          .from('design_versions')
          .insert({
            organization_id: orgId,
            design_task_id: uploadTask.design_task_id,
            version_number: versionNum,
            upload_batch_id: uploadBatchId,
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
        // Persist the *specific* marking(s) assigned to this file, not a
        // Cartesian join of all files and all boards.
        const links = entry.workItemIds.map(workItemId => ({
          organization_id: orgId, design_version_id: versionRow.id, work_item_id: workItemId,
        }));
        const { error: linkError } = await supabase.from('design_version_items').insert(links);
        if (linkError) throw new Error(`Could not link ${file.name} to its marking(s): ${linkError.message}`);
        setUploadProgress({ done: i + 1, total: stagedFiles.length });
      }

      // Advance only boards actually covered by these files. All IDs were
      // checked against this shop's editable Work Items before storage writes.
      const mappedIds = Array.from(new Set(stagedFiles.flatMap(entry => entry.workItemIds)));
      statusWritesStarted = true;
      if (mappedIds.length) {
        const { error: itemsError } = await supabase.from('work_items')
          .update({ status: 'designed' })
          .eq('shop_id', uploadTask.shop_id)
          .in('id', mappedIds)
          .in('status', ['approved', 'designing']);
        if (itemsError) throw new Error(`Could not update mapped board status: ${itemsError.message}`);
      }

      // One save, one next-stage handoff: never send a partially covered shop for review.
      // The same server-side status and RLS rules still apply to this update.
      const nextTaskStatus = submitAfterUpload && canSubmitUploadForReview ? 'in_review' : 'design_ready';
      const { data: changedTask, error: taskError } = await supabase.from('design_tasks')
        .update({ status: nextTaskStatus })
        .eq('id', uploadTask.design_task_id)
        .in('status', ['assigned', 'designing', 'design_ready', 'in_review'])
        .select('id');
      if (taskError) throw new Error(`Could not update design task: ${taskError.message}`);
      if (!changedTask?.length) throw new Error('This design was updated in another session. Reload the task before continuing.');
      // Refresh the reviewer queue through its existing notification path.
      // A delivery failure must never turn an already-saved upload into a duplicate retry.
      if (nextTaskStatus === 'in_review') {
        try { await notifyDesignReviewers(uploadTask.organization_id, uploadTask.shop_name); }
        catch (notificationError) { console.warn('Design saved for review; reviewer notification failed.', notificationError); }
      }

      try {
        await logAudit(
          'design_versions', null, 'upload', null, null, null,
          `Uploaded ${stagedFiles.length} mapped artwork file(s) for ${uploadTask.shop_name}, covering ${new Set(stagedFiles.flatMap(entry => entry.workItemIds)).size} board(s)`
        );
      } catch (auditError) {
        // Do not offer a second save for an already completed upload just
        // because its best-effort client audit request failed.
        console.warn('Artwork saved, but audit notification failed.', auditError);
      }
      } catch (err) {
        // Before any work-item/task status change, all records created by this
        // attempt can be rolled back. Never leave unlinked design versions.
        if (!statusWritesStarted) {
          const cleanupErrors: string[] = [];
          if (newVersionIds.length) {
            const { error } = await supabase.from('design_versions').delete().in('id', newVersionIds);
            if (error) cleanupErrors.push(error.message);
          }
          if (uploadedPaths.length) {
            const { error } = await supabase.storage.from('design-files').remove(uploadedPaths);
            if (error) cleanupErrors.push(error.message);
          }
          if (!cleanupErrors.length) throw err;
          throw new Error(`Some artwork may have saved, and cleanup failed. Close and reopen this shop before retrying. ${cleanupErrors.join('; ')}`);
        }
        // A network failure after the final database write may mean the save
        // succeeded remotely. Never encourage blind retries/duplicate versions.
        throw new Error(`Artwork may already be saved. Close and reopen this shop to verify its versions before retrying. ${(err as Error).message}`);
      }
    },
    onSuccess: (_data, variables) => {
      const completedTaskId = uploadTask?.design_task_id;
      const sentForReview = variables.submitAfterUpload && canSubmitUploadForReview;
      // A designer proceeds immediately to the next assigned shop after a
      // successful completed handoff. Partial drafts stay on the current task.
      const nextTask = sentForReview && isDesigner
        ? rows.find(row => row.design_task_id !== completedTaskId && ['assigned', 'designing'].includes(row.status))
        : undefined;
      queryClient.invalidateQueries({ queryKey: ['design-task-list', orgId] });
      queryClient.invalidateQueries({ queryKey: ['design-task-stats', orgId] });
      queryClient.invalidateQueries({ queryKey: ['design-task-detail'] });
      queryClient.invalidateQueries({ queryKey: ['nav-pending-counts', orgId] });
      closeUploadModal();
      if (nextTask) void quickUpload(nextTask);
    },
    onError: error => {
      if (/close and reopen|may already be saved/i.test((error as Error).message)) setUploadMustRefresh(true);
      queryClient.invalidateQueries({ queryKey: ['design-task-detail'] });
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
      {linkedPoId && <div role="status" className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-900">
        <span>Showing Design tasks for the selected Work Order</span>
        <button type="button" className="font-semibold text-blue-700 underline" onClick={() => setRouteParams(previous => { const next = new URLSearchParams(previous); next.delete('po'); return next; }, { replace: true })}>Show all Design work</button>
      </div>}
      <PageHeader
        title="Design Studio"
        subtitle={isDesigner ? "Your assigned shops — what to design, what's pending, what's done" : 'Manage design tasks for approved shops'}
      />

      {/* Task-first default: folders are optional organization, never a mandatory four-click path. */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2.5">
        <div className="flex items-center gap-1.5" role="group" aria-label="Design navigation mode">
          <button type="button" aria-pressed={showList && browsingList} onClick={() => setBrowsingList(true)}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-semibold ${browsingList ? 'bg-blue-600 text-white' : 'text-slate-600 hover:bg-slate-100'}`}>
            <LayoutList className="h-4 w-4" /> Action Queue
          </button>
          <button type="button" aria-pressed={!browsingList} onClick={() => { setSearch(''); setDebouncedSearch(''); setBrowsingList(false); }}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-semibold ${!browsingList ? 'bg-blue-600 text-white' : 'text-slate-600 hover:bg-slate-100'}`}>
            <FolderTree className="h-4 w-4" /> Browse Folders
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {(clientFilter || poFilter || zoneFilter) && !linkedPoId && (
            <button type="button" onClick={() => { setClientFilter(''); setPoFilter(''); setZoneFilter(''); setBrowsingList(true); }}
              className="rounded-md px-2 py-1 text-xs font-semibold text-blue-700 hover:bg-blue-50">Clear folder scope</button>
          )}
          <p className="text-xs text-slate-500">Open a task directly, or browse Client → Work Order → Zone.</p>
        </div>
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
                <option value="survey_install">Survey & Installation</option>
                <option value="production_install">Production & Installation</option>
                <option value="supply_only">Production & Delivery</option>
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

      {/* Folder browser — Client -> Work Order -> Zone, same
          pattern and levels as Production Studio, for both roles. */}
      {(!browsingList || clientFilter || poFilter || zoneFilter) && <nav aria-label="Folder path" className="flex items-center gap-1.5 text-sm mb-4 flex-wrap text-slate-400">
        <button
          onClick={() => resetFolderFrom('root')}
          className={`flex items-center gap-1.5 ${!clientFilter ? 'font-semibold text-slate-900' : 'hover:text-blue-600 transition-colors'}`}
        >
          <FolderTree className="w-3.5 h-3.5" /> All Design Tasks
        </button>
        {clientFilter && (
          <>
            <span aria-hidden>/</span>
            <button
              onClick={() => resetFolderFrom('client')}
              className={`truncate max-w-[200px] ${!poFilter ? 'font-semibold text-slate-900' : 'hover:text-blue-600 transition-colors'}`}
            >
              {selectedClientName}
            </button>
          </>
        )}
        {poFilter && (
          <>
            <span aria-hidden>/</span>
            <button
              onClick={() => resetFolderFrom('po')}
              className={`truncate max-w-[200px] ${!zoneFilter ? 'font-semibold text-slate-900' : 'hover:text-blue-600 transition-colors'}`}
            >
              {selectedPoName}
            </button>
          </>
        )}
        {zoneFilter && (
          <>
            <span aria-hidden>/</span>
            <button onClick={() => resetFolderFrom('zone')} className="font-semibold text-slate-900 truncate max-w-[200px]">
              {selectedZoneName}
            </button>
          </>
        )}
        {browsingList && !zoneFilter && (clientFilter || poFilter) && (
          <>
            <span aria-hidden>/</span>
            <button onClick={() => setBrowsingList(false)} className="font-semibold text-slate-900">All Items</button>
          </>
        )}
      </nav>}

      {/* FOLDER TILES — shown until a folder is actually opened all the
          way to a Zone (or "View all" is tapped to skip ahead). No list
          sits underneath these. */}
      {!showList && (() => {
        const levelLabel = folderLevel === 'client' ? 'Clients' : folderLevel === 'po' ? 'Work Orders' : 'Zones';
        const folders = folderLevel === 'client' ? clientFolders : folderLevel === 'po' ? poFolders : zoneFolders;
        const onPick = (id: string) => {
          if (folderLevel === 'client') setClientFilter(id);
          else if (folderLevel === 'po') setPoFilter(id);
          else { setZoneFilter(id); setBrowsingList(true); }
        };
        return (
          <div className="mb-5">
            <div className="flex items-center justify-between mb-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                {levelLabel}{folders.length > 0 && <span className="text-slate-300 font-normal"> · {folders.length}</span>}
              </p>
              {folders.length > 0 && (
                <button onClick={() => setBrowsingList(true)} className="text-xs font-medium text-blue-600 hover:text-blue-700">
                  View all →
                </button>
              )}
            </div>
            {treeFetching && folders.length === 0 && (
              <p className="text-sm text-slate-400 py-8 text-center">Loading folders…</p>
            )}
            {!treeFetching && folders.length === 0 && (
              <EmptyState icon={<FolderTree className="w-10 h-10" />} title="Nothing here" subtitle="No shops match the current status, search, or filters at this level." />
            )}
            {folders.length > 0 && (
              <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-3">
                {folders.map((f) => (
                  <button
                    key={f.id}
                    onClick={() => onPick(f.id)}
                    className="flex items-center gap-3 text-left px-4 py-3.5 rounded-xl border border-slate-200 bg-white hover:border-blue-300 hover:shadow-sm transition"
                  >
                    <span className="w-9 h-9 rounded-lg bg-blue-50 flex items-center justify-center shrink-0">
                      <Folder className="w-4.5 h-4.5 text-blue-600" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold text-slate-800 truncate">{f.name}</span>
                      <span className="block text-xs text-slate-400 mt-0.5">{f.count} shop{f.count === 1 ? '' : 's'}</span>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })()}

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

      {showList && (
      <>
      {/* Bulk toolbar — appears the moment anything is selected. A
          selection can freely mix `in_review` and `approved` shops; each
          action button below only acts on the subset of the current
          selection its own status actually applies to, and says exactly
          how many that is so it's never ambiguous what "Approve 3" vs
          "Send 2 to Production" is about to do. */}
      {(canApprove || isDesigner) && selectedRowIds.size === 0 && rows.some(isRowSelectable) && (
        <div className="mb-3 flex items-center justify-end">
          <button type="button" onClick={() => setSelectedRowIds(new Set(rows.filter(isRowSelectable).map(r => r.design_task_id)))}
            className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50">
            Select actionable ({rows.filter(isRowSelectable).length})
          </button>
        </div>
      )}
      {designBatchResult && <div role="status" className="mb-3 flex items-start justify-between rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-900">
        <span>{designBatchResult}</span><button type="button" onClick={() => setDesignBatchResult(null)} className="ml-3 font-semibold">Dismiss</button>
      </div>}
      {designBatchProgress && <div role="status" aria-live="polite" className="mb-3 text-xs font-medium text-blue-700">Processing {designBatchProgress.done}/{designBatchProgress.total} tasks…</div>}
      {(canApprove || isDesigner) && selectedRowIds.size > 0 && (() => {
        const selectedRows = rows.filter((r) => selectedRowIds.has(r.design_task_id));
        const selInReview = selectedRows.filter((r) => r.status === 'in_review');
        const selApproved = selectedRows.filter((r) => r.status === 'approved');
        const selDesignReady = selectedRows.filter((r) => r.status === 'design_ready');
        return (
          <div className="mb-4 flex items-center gap-2 flex-wrap bg-indigo-50 border border-indigo-200 rounded-lg px-3 py-2.5">
            <span className="text-sm font-medium text-indigo-900">{selectedRowIds.size} selected</span>
            <button type="button" onClick={() => setSelectedRowIds(new Set(rows.filter(isRowSelectable).map(r => r.design_task_id)))}
              disabled={!!designBatchProgress} className="rounded-md bg-white border border-indigo-200 px-2 py-1 text-xs font-semibold text-indigo-700 disabled:opacity-50">
              Select actionable ({rows.filter(isRowSelectable).length})
            </button>
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
                  type="button"
                  onClick={() => reviewSelectedShops(selInReview)}
                  disabled={!!quickActionLoadingId || designReviewMutation.isPending || !!designBatchProgress}
                  className="flex items-center gap-1 bg-amber-500 hover:bg-amber-600 text-white px-3 py-1.5 rounded-lg text-xs font-medium disabled:opacity-50"
                >
                  <Eye className="w-3.5 h-3.5" /> Review {selInReview.length} shop{selInReview.length === 1 ? '' : 's'}
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
                  disabled={bulkSendForReviewMutation.isPending || !!designBatchProgress}
                  className="flex items-center gap-1 bg-amber-500 hover:bg-amber-600 text-white px-3 py-1.5 rounded-lg text-xs font-medium disabled:opacity-50"
                >
                  <Send className="w-3.5 h-3.5" /> {bulkSendForReviewMutation.isPending ? 'Sending…' : `Send ${selDesignReady.length} for Review`}
                </button>
              )}
            </div>
          </div>
        );
      })()}
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
                  className="w-full text-left px-3 sm:px-4 py-3 flex flex-wrap sm:flex-nowrap items-center gap-2 sm:gap-3 hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500 transition cursor-pointer"
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
                  <div className="order-last sm:order-none w-full sm:w-auto flex items-center justify-end gap-1.5 flex-wrap sm:shrink-0" onClick={(e) => e.stopPropagation()}>
                    {canApprove && row.requires_design_all_false && row.status !== 'ready_for_production' && (
                      <button
                        onClick={() => { setProductionTask(row); setProductionUserId(''); }}
                        title="This PO line item doesn't require design — send straight to Production"
                        className="flex items-center gap-1 bg-teal-600 hover:bg-teal-700 text-white px-2.5 py-1.5 rounded-lg text-xs font-medium"
                      >
                        <PackageCheck className="w-3.5 h-3.5" /> Design Not Required — Send
                      </button>
                    )}
                    {canEditArtwork && (!isDesigner || row.designer_id === profile?.id) && !row.requires_design_all_false && ['assigned', 'designing', 'design_ready', 'in_review'].includes(row.status) && (
                      <button
                        onClick={() => quickUpload(row)}
                        disabled={quickActionLoadingId === row.design_task_id}
                        className="flex items-center gap-1 bg-blue-600 hover:bg-blue-700 text-white px-2.5 py-1.5 rounded-lg text-xs font-medium disabled:opacity-60"
                      >
                        {quickActionLoadingId === row.design_task_id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
                        {row.status === 'in_review' ? 'Update artwork' : 'Map artwork'}
                      </button>
                    )}
                    {canEditArtwork && row.status === 'design_ready' && (
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
                        onClick={() => { setReviewQueue([]); setReviewQueueTotal(0); void quickReview(row); }}
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

                        {/* Full survey photos, each with EVERY marking it carries
                            drawn together on the one photo — not just one board's
                            outline at a time like the per-board list above. A shop
                            where two boards were marked on the same shopfront shot
                            needs to be seen that way (both outlines, at once) for
                            the design to actually match how the site is laid out,
                            not just each board's isolated size. Same MarkedPhotoGrid
                            every other role (owner review, agency, installer,
                            client) already sees, so nothing looks different or
                            missing here specifically for the designer. */}
                        {(detail?.photos.length || 0) > 0 && (
                          <details className="mb-3 overflow-hidden rounded-lg border border-slate-200 bg-white">
                            <summary className="cursor-pointer bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-100">
                              Full survey photo gallery ({detail!.photos.length}) · expand only if needed
                            </summary>
                            <div className="p-3">
                              <MarkedPhotoGrid photos={detail!.photos} markings={detail!.markings} workItems={detail!.items} />
                            </div>
                          </details>
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
                                        <SecureAnchor href={v.file_url} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline flex items-center gap-1">
                                          <FileImage className="w-3.5 h-3.5" /> {coveredItems.length ? designArtworkDisplayName(coveredItems.map(item => item.id), detail!.items, markingRefFor) : 'Artwork'}
                                        </SecureAnchor>
                                        <span className="text-[11px] text-slate-500" title={v.file_name || ''}>{v.file_name || 'Original filename unavailable'}</span>
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

                        <div className="flex flex-wrap items-center gap-2">
                          <Link to={`/shops/${row.shop_id}`} className="text-sm text-blue-600 hover:underline inline-flex items-center gap-1">
                            Shop Details <ChevronRight className="h-4 w-4" />
                          </Link>
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
<select aria-label="Tasks per page" value={pageSize} onChange={event => { setPageSize(Number(event.target.value)); setPage(0); setSelectedRowIds(new Set()); }} className="mr-2 rounded border border-slate-200 bg-white px-1.5 py-1 text-xs text-slate-700">
                <option value={20}>20/page</option><option value={50}>50/page</option><option value={100}>100/page</option>
              </select>               Showing {page * pageSize + 1}–{Math.min(totalCount, page * pageSize + pageSize)} of {totalCount}
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
      </>
      )}

      {/* Lightbox for the marked survey image */}
      {lightbox && (
        <div onClick={() => setLightbox(null)} className="fixed inset-0 z-[100] bg-black/80 flex items-center justify-center p-4 cursor-zoom-out">
          <SecureImage src={lightbox} alt="Marked board" className="max-w-full max-h-full rounded-lg" />
        </div>
      )}

      {/* Owner review — the whole point is that this is short: shop
          identity up top, every board's survey-marking vs. latest design
          side by side in one compact list, Approve / Request Changes right
          there. No expanding, no scrolling through the full board/version
          audit trail just to make the one decision this screen exists
          for. */}
      <Modal open={!!reviewTask} onClose={() => { if (!designReviewMutation.isPending) { ++reviewRequestId.current; setReviewTask(null); setReviewQueue([]); setReviewQueueTotal(0); setRequestingChanges(false); setReviewCorrectionIds(new Set()); setChangesNote(''); } }} title="Design Review" size="xl">
        {reviewTask && (
          <div className="space-y-4">
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <p className="font-semibold text-slate-900">{reviewTask.shop_name}</p>
                {reviewQueueTotal > 1 && <p className="text-xs font-medium text-indigo-700" aria-live="polite">Shop {reviewQueueTotal - reviewQueue.length + 1} of {reviewQueueTotal} selected for review</p>}
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
                  const { shop_id, design_task_id, items, photos, markings, versions, versionItems, photoItems } = reviewTask;
                  queryClient.setQueryData(['design-task-detail', shop_id, design_task_id], { items, photos, markings, versions, versionItems, photoItems });
                  setExpandedShopId(shop_id);
                  setExpandedTaskId(design_task_id);
                  ++reviewRequestId.current;
                  setReviewTask(null);
                  setReviewQueue([]);
                  setReviewQueueTotal(0);
                  setRequestingChanges(false);
                  setChangesNote('');
                }}
                className="text-xs text-blue-600 hover:underline mt-1"
              >
                See full board & version history →
              </button>
            </div>

            <div className="flex items-center justify-between gap-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
              <span>{reviewTask.items.length} work item{reviewTask.items.length === 1 ? '' : 's'} · latest mapped artwork shown below</span>
              <div className="flex items-center gap-2">
                {reviewQueue.length > 1 && <button type="button" onClick={skipReviewShop} disabled={designReviewMutation.isPending || !!quickActionLoadingId} className="font-semibold text-slate-600 underline disabled:opacity-40">Skip this shop</button>}
                {!reviewCoverage.ready && <strong role="alert" className="text-red-700">{reviewCoverage.missing.length} artwork missing</strong>}
                {requestingChanges && reviewTask.items.length > 1 && <button type="button" className="font-semibold text-blue-700 hover:underline" onClick={() => setReviewCorrectionIds(current => current.size === reviewTask.items.length ? new Set() : new Set(reviewTask.items.map(item => item.id)))}>
                  {reviewCorrectionIds.size === reviewTask.items.length ? 'Clear selection' : 'Select all'}
                </button>}
              </div>
            </div>

            <div className="divide-y divide-slate-100 rounded-xl border border-slate-200" data-testid="design-review-board-list">
              {reviewTask.items.length === 0 && <p className="px-3 py-5 text-sm text-amber-800">No work items found. Record sizes and map artwork before review.</p>}
              {(() => {
                const numbered = numberMarkingsByPhoto(reviewTask.markings);
                const markingsByItem = new Map(reviewTask.markings.filter(m => m.work_item_id && m.points?.length >= 3).map(m => [m.work_item_id, m]));
                const photosById = new Map(reviewTask.photos.map(p => [p.id, p]));
                return reviewTask.items.map(item => {
                  const marking = markingsByItem.get(item.id);
                  const photo = marking ? photosById.get(marking.survey_photo_id) : null;
                  const number = numbered.get(item.id);
                  const artwork = reviewArtwork.get(item.id);
                  const artworks = reviewArtworkGroups.get(item.id) || [];
                  const selected = reviewCorrectionIds.has(item.id);
                  const { dims } = boardLabel(item);
                  return (
                    <div key={item.id} className={`flex flex-wrap items-center gap-3 px-3 py-3 sm:flex-nowrap ${selected ? 'bg-amber-50 ring-1 ring-inset ring-amber-300' : 'bg-white'}`}>
                      <div className="flex min-w-0 flex-1 items-center gap-2">
                        <figure className="text-center">
                          <DesignMarkingPreview photoUrl={photo?.photo_url} points={marking?.points} label={number ? `#${number.number}` : item.work_type_name} className="h-20 w-20" onClick={setLightbox}/>
                          <figcaption className="mt-1 text-[10px] text-slate-500">Site / marking</figcaption>
                        </figure>
                        <ChevronRight className="h-4 w-4 shrink-0 text-slate-300" />
                        <div className={`flex max-w-full flex-wrap items-start gap-2 ${selected ? 'rounded-lg outline outline-2 outline-offset-2 outline-amber-400' : ''}`} aria-label={`Mapped artwork for ${item.work_type_name || 'work item'}`}>
                          {artworks.length ? artworks.map(file => (
                            <figure key={file.id} className="w-20 text-center" title={file.file_name || `Artwork v${file.version_number}`}>
                              {/\.(png|jpe?g|webp|gif)(\?|$)/i.test(file.file_name || file.file_url || '') ? (
                                <DesignFilePreview url={file.file_url!} onClick={setLightbox} />
                              ) : (
                                <SecureAnchor href={file.file_url!} target="_blank" rel="noopener noreferrer" className="flex h-20 w-20 items-center justify-center rounded-lg border border-blue-200 bg-blue-50 text-blue-700" aria-label={`Open ${file.file_name || 'artwork'}`}><FileText className="h-6 w-6" /></SecureAnchor>
                              )}
                              <figcaption className="mt-1 truncate text-[10px] text-slate-500">{file.file_name || `Artwork v${file.version_number}`}</figcaption>
                            </figure>
                          )) : <figure className="text-center"><div className="flex h-20 w-20 items-center justify-center rounded-lg border border-dashed border-red-200 bg-red-50 text-red-600"><AlertTriangle className="h-5 w-5" /></div><figcaption className="mt-1 text-[10px] text-red-600">Missing artwork</figcaption></figure>}
                        </div>
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-semibold text-slate-800">{number ? `#${number.number} · ` : ''}{item.work_type_name || 'Work item'}</p>
                        <p className="mt-0.5 text-xs text-slate-600">{dims || 'Size not recorded'} · Qty {boardLabel(item).qty}</p>
                        {requestingChanges && <label className="mt-2 inline-flex min-h-8 cursor-pointer items-center gap-2 rounded-md border border-amber-300 bg-white px-2 py-1 text-xs font-semibold text-amber-900">
                          <input type="checkbox" checked={selected} onChange={() => setReviewCorrectionIds(previous => { const next = new Set(previous); if (next.has(item.id)) next.delete(item.id); else next.add(item.id); return next; })} aria-label={`Request changes for ${item.work_type_name || 'work item'}`} className="h-4 w-4 rounded border-amber-300" /> Needs correction
                        </label>}
                        <p className={`mt-1 break-all text-xs ${artwork ? 'text-slate-500' : 'font-medium text-red-700'}`}>
                          {artworks.length > 1 ? `${artworks.length} mapped artwork files · latest upload` : artwork ? `${artwork.file_name || 'Artwork'} · v${artwork.version_number}` : 'Artwork missing — cannot approve'}
                        </p>
                      </div>
                    </div>
                  );
                });
              })()}
            </div>

            {/* External company sign-off is a separate mandatory gate for
                applicable Work Orders. It does not create a second review decision. */}
            {reviewTask.status === 'in_review' && (
              <CompanyApprovalHandoff stage="design" refId={reviewTask.design_task_id} shopId={reviewTask.shop_id} hideWhenNotRequired />
            )}
            {companyApproval.isError && <p role="alert" className="text-xs text-red-700">Approval status couldn't load. {(companyApproval.error as Error).message}</p>}

            <div className="sticky bottom-0 z-10 -mx-1 rounded-xl border border-slate-200 bg-white/95 p-3 shadow-sm backdrop-blur">
            {requestingChanges ? (
              <div className="space-y-2 rounded-xl border border-amber-200 bg-amber-50/50 p-3">
                <p className="text-sm font-semibold text-amber-900">Select only the work items needing correction</p>
                <Textarea label="Instructions for designer" value={changesNote} onChange={setChangesNote} rows={2} placeholder="Example: Change logo size on Board #2" />
                <div className="flex gap-2">
                  <button type="button" disabled={designReviewMutation.isPending} onClick={() => { setRequestingChanges(false); setReviewCorrectionIds(new Set()); setChangesNote(''); }} className="flex-1 rounded-lg border border-slate-200 bg-white py-2.5 text-sm font-medium text-slate-700">Cancel</button>
                  <button type="button" onClick={() => designReviewMutation.mutate({ row: reviewTask, redoIds: [...reviewCorrectionIds], note: changesNote })}
                    disabled={designReviewMutation.isPending || !!validateDesignCorrection(reviewTask.items, [...reviewCorrectionIds], changesNote)}
                    className="flex-1 rounded-lg bg-amber-600 py-2.5 text-sm font-semibold text-white disabled:opacity-40">
                    {designReviewMutation.isPending ? 'Sending…' : `Send ${reviewCorrectionIds.size} for Changes`}
                  </button>
                </div>
                {reviewCorrectionIds.size === 0 && <p className="text-xs text-amber-800">Tick one or more work items above to request changes.</p>}
              </div>
            ) : (
              <div className="flex gap-2">
                <button type="button" onClick={() => { setRequestingChanges(true); setReviewCorrectionIds(new Set()); }} disabled={designReviewMutation.isPending}
                  className="flex-1 rounded-lg border border-amber-200 bg-amber-50 py-2.5 text-sm font-semibold text-amber-800 disabled:opacity-40">
                  Request Changes
                </button>
                <button type="button" onClick={() => designReviewMutation.mutate({ row: reviewTask, redoIds: [], note: '' })}
                  disabled={designReviewMutation.isPending || !reviewCoverage.ready || !companyGateReady}
                  className="flex-1 rounded-lg bg-green-600 py-2.5 text-sm font-semibold text-white hover:bg-green-700 disabled:opacity-40">
                  {designReviewMutation.isPending ? 'Approving…' : reviewQueueTotal > 0 ? (reviewQueue.length > 1 ? 'Approve & Next' : 'Approve Shop') : rows.some(r => r.status === 'in_review' && r.design_task_id !== reviewTask.design_task_id) ? 'Approve & Next' : 'Approve Design'}
                </button>
              </div>
            )}
            {!requestingChanges && !companyGateReady && !companyApproval.isError && <p className="text-xs text-amber-800">Finish required company approval above before approving this design.</p>}
            {designReviewMutation.isError && (
              <p role="alert" className="mt-2 text-xs text-red-700">{(designReviewMutation.error as Error).message}</p>
            )}
            </div>
          </div>
        )}
      </Modal>

      {/* Marking-first artwork mapping: each file gets an explicit work item. */}
      <Modal open={!!uploadTask} onClose={() => { if (!uploadMutation.isPending) closeUploadModal(); }} title="Design artwork · Work & size" size="lg">
        <div className="space-y-4">
          <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5">
            <p className="text-sm font-semibold text-slate-900">{uploadTask?.shop_name} <span className="font-normal text-slate-500">· {uploadTask?.po_number || 'Direct work'}</span></p>
            <p className="mt-0.5 text-xs text-slate-600">Match each file to the Work Item and Size. For no-survey Work Orders, the Owner/Admin records measurements first; the designer only uploads and maps artwork.</p>
          </div>

          <section aria-label="Work items and mapped artwork" className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold text-slate-900">Work & size · artwork mapping</h3>
                <p className="text-xs text-slate-500">One row per Work Item. Survey photo and artwork appear together.</p>
              </div>
              <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-700">
                {uploadCoverage.covered.size}/{uploadTask?.items.length || 0} mapped
              </span>
            </div>
            {!uploadTask?.items.length ? (
              <p role="alert" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">No Work Items are recorded for this shop. Ask Owner/Admin to enter the Work Order scope and sizes before uploading artwork. {canApprove && uploadTask && <Link className="font-semibold underline" to={`/shops/${uploadTask.shop_id}`}>Open shop sizing</Link>}</p>
            ) : (
              <div className="space-y-2" data-testid="design-work-mapping-list">
                {usesPreDesignMeasurements(uploadTask?.fulfillment_type) && uploadTask.items.some((item) => !hasUsableApprovedSize(item) || item.status === 'pending') &&
                  <p role="alert" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
                    Some work items have no approved quantity/size or are awaiting Owner/Admin confirmation. The designer cannot bypass this. {canApprove && uploadTask && <Link className="font-semibold underline" to={`/shops/${uploadTask.shop_id}`}>Record sizes in Shop Details</Link>}
                  </p>}
                
                {uploadTask.items.map((item, index) => {
                  const ref = uploadMarkingRefFor(item.id);
                  const canEdit = uploadEditableItems.some(board => board.id === item.id);
                  const display = designWorkDisplay(item);
                  const staged = stagedFiles.filter(entry => entry.workItemIds.includes(item.id));
                  const latestDesign = uploadLatestVersionByItem.get(item.id);
                  const preview = staged.find(entry => entry.previewUrl) || staged[0];
                  const artworkUrl = preview ? preview.previewUrl : latestDesign?.file_url || null;
                  const isImageArtwork = preview ? preview.file.type.startsWith('image/') : !!latestDesign?.file_name && /\.(png|jpe?g|webp)$/i.test(latestDesign.file_name);
                  const mapped = staged.length > 0 || uploadCoverage.covered.has(item.id);
                  return (
                    <article key={item.id} data-work-item-id={item.id} className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                            <h4 className="text-sm font-bold text-slate-900">{display.work}</h4>
                            <strong className="text-sm font-semibold text-blue-700">{display.size}</strong>
                            {ref && <span className="text-xs text-slate-500">Marking #{ref.number}</span>}
                            {!ref && <span className="text-xs text-slate-400">Item {index + 1} · no survey marking</span>}
                          </div>
                          <p className="mt-0.5 text-xs text-slate-500">{display.meta}</p>
                        </div>
                        <span className={`rounded-full px-2 py-1 text-[11px] font-semibold ${mapped ? 'bg-emerald-50 text-emerald-700' : canEdit ? 'bg-amber-50 text-amber-700' : 'bg-slate-100 text-slate-500'}`}>
                          {mapped ? (staged.length ? 'New artwork mapped' : 'Saved artwork') : canEdit ? 'Artwork needed' : 'Locked'}
                        </span>
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <figure className="flex shrink-0 flex-col items-center gap-0.5">
                          <DesignMarkingPreview photoUrl={ref?.photo?.photo_url} points={ref?.marking.points}
                            label={boardCaption(item, ref)} className="h-14 w-16" onClick={setLightbox} />
                          <figcaption className="text-[10px] text-slate-500">Survey</figcaption>
                        </figure>
                        <ChevronRight className="h-4 w-4 shrink-0 text-slate-300" aria-hidden="true" />
                        <figure className="flex shrink-0 flex-col items-center gap-0.5">
                          {artworkUrl && isImageArtwork ? (
                            <button type="button" className="h-14 w-20 overflow-hidden rounded-md border border-slate-200 bg-slate-50" onClick={() => setLightbox(artworkUrl)} aria-label={`Preview artwork for ${display.work}, ${display.size}`}>
                              <SecureImage src={artworkUrl} alt={`Artwork for ${display.work} ${display.size}`} className="h-full w-full object-contain" loading="lazy" />
                            </button>
                          ) : artworkUrl ? (
                            <SecureAnchor href={artworkUrl} target="_blank" rel="noopener noreferrer" className="flex h-14 w-20 items-center justify-center rounded-md border border-blue-200 bg-blue-50 text-blue-700" aria-label={`Open artwork file for ${display.work}`}><FileText className="h-5 w-5" /></SecureAnchor>
                          ) : (
                            <div className="flex h-14 w-20 items-center justify-center rounded-md border border-dashed border-slate-200 bg-slate-50"><ImagePlus className="h-5 w-5 text-slate-300" /></div>
                          )}
                          <figcaption className="text-[10px] text-slate-500">Artwork</figcaption>
                        </figure>
                        <div className="min-w-0 flex-1 space-y-1">
                          <p className="text-xs font-medium text-slate-700">{staged.length ? designArtworkDisplayName(staged[0].workItemIds, uploadTask.items, uploadMarkingRefFor) : latestDesign ? designArtworkDisplayName([item.id], uploadTask.items, uploadMarkingRefFor) : 'No artwork uploaded'}</p>
                          {(staged.length || latestDesign) && <p className="truncate text-[11px] text-slate-500" title={staged[0]?.file.name || latestDesign?.file_name || ''}>
                            {staged[0]?.file.name || latestDesign?.file_name}{staged.length > 1 ? ` · +${staged.length - 1} files` : ''}
                          </p>}
                        </div>
                        {canEdit && <label className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs font-semibold text-blue-700 hover:bg-blue-100 focus-within:ring-2 focus-within:ring-blue-500">
                          <Upload className="h-3.5 w-3.5" /> {mapped ? 'Add / revise' : 'Add artwork'}
                          <input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" multiple className="sr-only"
                            disabled={uploadMutation.isPending} onChange={event => { stageDesignFiles(Array.from(event.target.files || []), item.id); event.target.value = ''; }} />
                        </label>}
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </section>

          <section className="rounded-xl border border-slate-200 bg-slate-50/60 p-3 space-y-2" aria-label="New artwork files">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-slate-800">New artwork · exact assignment</h3>
              <span className="text-xs text-slate-500">{stagedFiles.length} file(s)</span>
            </div>
            <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp,application/pdf" multiple onChange={handleFilesSelected} className="hidden" />
            <div onDragOver={event => { event.preventDefault(); setFileDragOver(true); }}
              onDragLeave={event => { event.preventDefault(); setFileDragOver(false); }}
              onDrop={event => { event.preventDefault(); setFileDragOver(false); stageDesignFiles(Array.from(event.dataTransfer.files)); }}
              className={`rounded-lg border border-dashed ${fileDragOver ? 'border-blue-400 bg-blue-50' : 'border-slate-300 bg-white'}`}>
              <button type="button" disabled={uploadMutation.isPending || uploadEditableItems.length === 0}
                onClick={() => fileRef.current?.click()}
                className="flex w-full items-center justify-center gap-2 p-2.5 text-sm font-semibold text-blue-700 disabled:opacity-50">
                <Upload className="h-4 w-4" /> Add multiple files / drop here
              </button>
            </div>
            {stagingError && <p role="alert" className="text-xs text-amber-700">{stagingError}</p>}
            {stagedFiles.length === uploadEditableItems.length && stagedFiles.length > 1 && (
              <button type="button" disabled={uploadMutation.isPending} onClick={assignFilesByMarkingOrder}
                className="rounded-md border border-blue-200 bg-white px-2.5 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-50">
                Assign files in Work Item order · verify below
              </button>
            )}
            <div className="space-y-2">
              {stagedFiles.map(entry => (
                <div key={entry.id} className={`rounded-lg border p-2.5 ${entry.workItemIds.length ? 'border-slate-200 bg-white' : 'border-amber-300 bg-amber-50'}`}>
                  <div className="flex items-center gap-2">
                    {entry.previewUrl && entry.file.type.startsWith('image/') ? <SecureImage src={entry.previewUrl} alt={`New artwork ${entry.file.name}`} className="h-12 w-12 shrink-0 rounded-md border border-slate-200 object-contain" />
                      : <FileText className="h-7 w-7 shrink-0 text-slate-400" />}
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-slate-800">{designArtworkDisplayName(entry.workItemIds, uploadTask?.items || [], uploadMarkingRefFor)}</p>
                      <p className="truncate text-xs text-slate-500" title={entry.file.name}>Source: {entry.file.name}</p>
                    </div>
                    <button type="button" aria-label={`Remove ${entry.file.name}`} disabled={uploadMutation.isPending}
                      onClick={() => removeStaged(entry.id)} className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100"><X className="h-4 w-4" /></button>
                  </div>
                  {uncoveredEditableItemIds.length > 0 && (
                    <button type="button" disabled={uploadMutation.isPending}
                      onClick={() => { const remaining = uncoveredEditableItemIds; setStagedFiles(previous => previous.map(file => file.id === entry.id ? { ...file, workItemIds: [...new Set([...file.workItemIds, ...remaining])] } : file)); }}
                      className="mt-1.5 rounded-md px-2 py-1 text-xs font-semibold text-blue-700 hover:bg-blue-50">
                      Apply to {uncoveredEditableItemIds.length} unmapped item(s)
                    </button>
                  )}
                  <div className="mt-1.5 flex flex-wrap gap-1.5" role="group" aria-label={`Work items for ${entry.file.name}`}>
                    {uploadEditableItems.map(item => {
                      const ref = uploadMarkingRefFor(item.id);
                      const checked = entry.workItemIds.includes(item.id);
                      const display = designWorkDisplay(item);
                      return <label key={item.id} className={`flex cursor-pointer items-center gap-1 rounded-md border px-2 py-1 text-xs ${checked ? 'border-blue-300 bg-blue-50 text-blue-800' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'}`}>
                        <input type="checkbox" checked={checked} disabled={uploadMutation.isPending} onChange={() => toggleFileMarking(entry.id, item.id)} className="rounded" />
                        {display.work} · {display.size}{ref ? ` · M${ref.number}` : ''}
                      </label>;
                    })}
                  </div>
                </div>
              ))}
            </div>
          </section>

          <button type="button" onClick={() => setShowDesignOptions(previous => !previous)} aria-expanded={showDesignOptions}
            className="flex items-center gap-1 text-sm font-semibold text-blue-700 hover:underline">
            <ChevronDown className={`h-4 w-4 ${showDesignOptions ? 'rotate-180' : ''}`} /> Artwork source & notes
          </button>
          {showDesignOptions && <div className="space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
            <Select label="Artwork Source" value={batchSource} onChange={v => setBatchSource(v as 'agency_designed' | 'client_provided')}
              options={[{ value: 'agency_designed', label: 'Agency artwork' }, { value: 'client_provided', label: 'Company-provided artwork' }]} />
            <Textarea label="Optional Notes" value={batchNotes} onChange={setBatchNotes} rows={2} placeholder="Revision notes…" />
          </div>}

          <div className={`rounded-lg border p-3 text-xs ${canSubmitUploadForReview ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-amber-200 bg-amber-50 text-amber-800'}`}>
            {stagedFiles.length === 0 && uploadCoverage.ready
              ? (uploadTask?.status === 'in_review' ? 'All required artwork is mapped and already awaiting review.' : 'All required artwork is already saved. Submit the existing designs without uploading them again.')
              : uploadMappingError && stagedFiles.length > 0
                ? uploadMappingError
                : canSubmitUploadForReview
                  ? 'All required markings are covered. Upload will submit this shop for review in one action.'
                  : `${uploadCoverage.missing.length} marking(s) still need artwork. Incomplete work will be saved as a draft.`}
          </div>
          {/* No second checkbox or redundant confirmation. The primary action submits
              only when all required markings have valid artwork coverage; Draft is
              deliberately available for incomplete or in-progress designs. */}
          {uploadCoverage.ready && stagedFiles.length === 0 &&
           uploadTask && ['assigned', 'designing', 'design_ready'].includes(uploadTask.status) && (
            <button type="button" disabled={updateStatusMutation.isPending}
              onClick={() => updateStatusMutation.mutate({ row: uploadTask, status: 'in_review' }, { onSuccess: closeUploadModal })}
              className="w-full rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2.5 text-sm font-semibold text-emerald-800 hover:bg-emerald-100 disabled:opacity-50">
              <Send className="inline h-4 w-4 mr-1" /> Send existing mapped artwork for review
            </button>
          )}
          {uploadMutation.isError && <p role="alert" className="text-sm text-red-600">{(uploadMutation.error as Error).message}</p>}
          {uploadMustRefresh && <button type="button" onClick={closeUploadModal} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700">Close & reload shop</button>}
          {stagedFiles.length > 0 && <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center">
            {canSubmitUploadForReview && (
              <button type="button" onClick={() => uploadMutation.mutate({ submitAfterUpload: false })}
                disabled={uploadMutation.isPending || uploadMustRefresh || !!uploadMappingError}
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50 sm:w-auto">
                Save draft only
              </button>
            )}
            <button type="button" onClick={() => uploadMutation.mutate({ submitAfterUpload: canSubmitUploadForReview })}
              disabled={uploadMutation.isPending || uploadMustRefresh || !!uploadMappingError}
              className="flex w-full flex-1 items-center justify-center gap-2 rounded-lg bg-blue-600 px-3 py-3 font-semibold text-white hover:bg-blue-700 disabled:opacity-50">
              <Upload className="h-4 w-4" /> {uploadMutation.isPending
                ? `Uploading ${uploadProgress ? `${uploadProgress.done}/${uploadProgress.total}` : '…'}`
                : canSubmitUploadForReview ? `Upload & Send for Review` : `Save ${stagedFiles.length} mapped artwork file(s) as draft`}
            </button>
          </div>}
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
            value={effectiveProductionUserId}
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
            onClick={() => productionTask && updateStatusMutation.mutate({ row: productionTask, status: 'ready_for_production', assignedTo: effectiveProductionUserId })}
            disabled={updateStatusMutation.isPending || !effectiveProductionUserId}
            className="w-full bg-teal-600 hover:bg-teal-700 text-white font-medium py-2.5 rounded-lg disabled:opacity-50"
          >
            {updateStatusMutation.isPending ? 'Sending...' : 'Confirm & Send to Production'}
          </button>
        </div>
      </Modal>

      {/* Bulk "Send to Production" — one production-person pick applied to
          every selected approved shop at once. */}
      <Modal open={!!bulkProductionRows} onClose={() => { if (!bulkSendToProductionMutation.isPending) { setBulkProductionRows(null); setBulkProductionUserId(''); } }} title="Send to Production">
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
            value={effectiveBulkProductionUserId}
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
            onClick={() => bulkProductionRows && bulkSendToProductionMutation.mutate({ selected: bulkProductionRows, assignedTo: effectiveBulkProductionUserId })}
            disabled={bulkSendToProductionMutation.isPending || !effectiveBulkProductionUserId}
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

// The uploaded design file's own preview inside the Review modal — same
// "always show something real, never a permanent spinner" rule as
// DesignMarkingPreview: it renders the image directly and only swaps to
// the placeholder icon if the file genuinely fails to load.
function DesignFilePreview({ url, onClick }: { url: string; onClick?: (src: string) => void }) {
  return <button type="button" onClick={() => onClick?.(url)} aria-label="View mapped artwork" className="shrink-0 h-20 w-20 overflow-hidden rounded-lg border border-slate-200 bg-slate-100 focus-visible:ring-2 focus-visible:ring-blue-500">
    <SecureImage src={url} alt="Mapped artwork" loading="lazy" className="h-full w-full object-contain" />
  </button>;
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
