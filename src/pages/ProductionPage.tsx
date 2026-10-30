import { fetchWorkflowFolderPages } from '@/lib/workflowFolderPages';
import { runBoundedWorkflowBatch, summarizeWorkflowBatch } from '@/lib/workflowBatch';
import { ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { Card, StatusBadge, EmptyState, PageHeader, Modal, Textarea, Select, Input } from '@/components/ui';
import { VehicleLoadLogView } from '@/components/VehicleLoadLogView';
import { logAudit, createNotification } from '@/lib/helpers';
import { useRealtimeInvalidate } from '@/lib/useRealtimeInvalidate';
import { WorkItem, ProductionItem, WorkItemComponent, COMPONENT_STATUSES, VehicleLoadShopSummary, VehicleLoadStats } from '@/lib/types';
import { formatDim, itemSizeLabel } from '@/lib/units';
import {
  Printer, ChevronRight, ChevronDown, ChevronLeft, Search, MapPin, Phone, User, Layers,
  CheckCircle2, Circle, MinusCircle, Pencil, Check, X, ListChecks,
  Plus, Trash2, AlertTriangle, Clock, Boxes, Loader2, Filter,
  Factory, CheckCircle, LayoutList, PackageCheck, Send, Truck, LayoutGrid, PackageOpen,
  CircleDot, CircleCheck, Info, Users, CheckSquare, Square, Folder, FolderTree,
} from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import { validWorkOrderId } from '@/lib/operationalNavigation';

// Work-item statuses relevant to the Production screen at all.
// Include downstream installed work for read-only history; never expose quantity edits on closed orders.
const PRODUCTION_ELIGIBLE_STATUSES = ['approved', 'design_approved', 'in_production', 'produced', 'production_done', 'installed'];
// Statuses that mean this board is fully done and locked from further edits
// here (it's moved on to/through installation).
const BOARD_LOCKED_STATUSES = ['production_done', 'installed'];
const DEFAULT_PAGE_SIZE = 50;

// Sentinel for the folder browser's "No Campaign" / "No Work Order" /
// "No Zone" bucket — distinct from '' (which means "haven't narrowed by
// this level at all, show everything"). No real campaign/PO/zone id will
// ever equal this string.
const NO_FOLDER_BUCKET = '__none__';

const TABS: { key: string; label: string; statuses: string[] | null; statKey: keyof ProductionStats | null }[] = [
  { key: 'active', label: 'Action Queue', statuses: ['pending', 'in_production', 'ready'], statKey: null },
  { key: 'all', label: 'All', statuses: null, statKey: 'total' },
  { key: 'needs_materials', label: 'Needs Materials', statuses: null, statKey: 'needs_materials_orders' },
  { key: 'pending', label: 'Pending', statuses: ['pending'], statKey: 'pending' },
  { key: 'in_production', label: 'In Production', statuses: ['in_production'], statKey: 'in_production' },
  { key: 'ready', label: 'Ready', statuses: ['ready'], statKey: 'ready' },
  { key: 'hold', label: 'On Hold', statuses: ['hold'], statKey: 'hold' },
  { key: 'completed', label: 'Completed', statuses: ['completed'], statKey: 'completed' },
];

const STATUS_BORDER: Record<string, string> = {
  pending: 'border-l-slate-300',
  in_production: 'border-l-orange-400',
  ready: 'border-l-blue-400',
  hold: 'border-l-red-400',
  completed: 'border-l-emerald-400',
};

// A fully recorded, material-ready order can be sent through the same atomic
// completion RPC without an intermediate dialog. Empty orders are never eligible.
function readyForDirectCompletion(row: ProductionOrderRow): boolean {
  return row.total_boards > 0 && row.pending_boards === 0 && row.materials_pending_boards === 0
    && ['in_production', 'ready'].includes(row.status);
}

type ProductionStats = {
  total: number; pending: number; in_production: number; ready: number; hold: number; completed: number;
  boards_pending: number; materials_pending: number; needs_materials_orders: number;
};

// One row per production order, as returned by `v_production_order_list`
// (migration 0058) — shop/client/zone/PO identity and board tallies all
// precomputed in SQL, so the list itself is one paginated, filtered,
// sorted query instead of "fetch every order and every board for the
// whole org, then filter in the browser". This is what keeps the screen
// fast whether the org has 12 shops in production or 12,000.
type ProductionOrderRow = {
  production_order_id: string;
  organization_id: string;
  shop_id: string;
  status: string;
  notes: string | null;
  assigned_to: string | null;
  created_at: string;
  updated_at: string;
  shop_name: string;
  shop_city: string | null;
  shop_address: string | null;
  shop_owner_name: string | null;
  shop_contact_phone: string | null;
  zone_id: string | null;
  zone_name: string | null;
  client_name: string | null;
  assigned_name: string | null;
  po_id: string | null;
  po_number: string | null;
  po_name: string | null;
  fulfillment_type: string | null;
  total_boards: number;
  done_boards: number;
  pending_boards: number;
  materials_pending_boards: number;
  work_type_ids: string[];
  progress_pct: number;
  attention_rank: number;
  // migration 0060 — true when every board on this shop linked to a
  // po_line_item has requires_installation = false (Architecture v2.0
  // §3.4's "Others" custom scope, e.g. design+production only).
  requires_installation_all_false: boolean;
  // migration 0079 — nullable: most agency-created POs never have a
  // client-side campaign (client-side, optional concept, migration
  // 0051). Folder browser groups these under a "No Campaign" bucket
  // rather than hiding them. At most one of project_id/campaign_id is
  // ever set on a given PO — see PurchaseOrdersPage.tsx.
  project_id: string | null;
  project_name: string | null;
  campaign_id: string | null;
  campaign_name: string | null;
  // migration 0083 — stable key for the folder browser's Client level
  // (client_name alone can't be browsed by reliably: two clients could
  // share a display name).
  client_id: string;
};

// Full per-shop board + BOM detail, loaded on demand for exactly one
// order at a time (the expanded row / an open modal), never for the
// whole list.
type ProductionOrderDetail = {
  items: WorkItem[];
  productionItems: ProductionItem[];
  components: WorkItemComponent[];
};

// The Production workbench never guesses which design belongs to a board.
// Only explicit design_version_items links may display an approved artwork.
type ProductionArtwork = { id: string; file_name: string | null; file_url: string; status: string; version_number: number };
type ProductionArtworkState = { byItem: Record<string, ProductionArtwork[]>; warning: string | null };

const EMPTY_ARTWORK: ProductionArtworkState = { byItem: {}, warning: null };
function artworkIsImage(file: ProductionArtwork): boolean {
  const filename = (file.file_name || file.file_url).split('?')[0].toLowerCase();
  return /\.(png|jpe?g|webp|gif|avif|svg)$/.test(filename);
}

async function fetchApprovedProductionArtwork(orderId: string, shopId: string, itemIds: string[]): Promise<ProductionArtworkState> {
  // For supply / direct work with no design task, absence of artwork is valid.
  const { data: order, error: orderError } = await supabase.from('production_orders')
    .select('id,shop_id,design_task_id').eq('id', orderId).maybeSingle();
  if (orderError) return { ...EMPTY_ARTWORK, warning: `Artwork unavailable: ${orderError.message}` };
  if (!order || order.shop_id !== shopId) return { ...EMPTY_ARTWORK, warning: 'Production order changed. Refresh before using artwork.' };
  if (!order.design_task_id || !itemIds.length) return EMPTY_ARTWORK;

  const { data: versions, error: versionsError } = await supabase.from('design_versions')
    .select('id,file_name,file_url,status,version_number')
    .eq('design_task_id', order.design_task_id).eq('status', 'approved')
    .order('version_number', { ascending: false }).limit(200);
  if (versionsError) return { ...EMPTY_ARTWORK, warning: `Artwork unavailable: ${versionsError.message}` };
  if (!versions?.length) return EMPTY_ARTWORK;

  const { data: links, error: linksError } = await supabase.from('design_version_items')
    .select('design_version_id,work_item_id')
    .in('design_version_id', versions.map(v => v.id));
  if (linksError) return { ...EMPTY_ARTWORK, warning: `Artwork mapping unavailable: ${linksError.message}` };
  const allowed = new Set(itemIds);
  const byVersion = new Map(versions.map(v => [v.id, v]));
  const byItem: Record<string, ProductionArtwork[]> = {};
  for (const link of links || []) {
    if (!allowed.has(link.work_item_id)) continue;
    const version = byVersion.get(link.design_version_id);
    if (!version) continue;
    (byItem[link.work_item_id] ||= []).push(version as ProductionArtwork);
  }
  for (const matches of Object.values(byItem)) matches.sort((a, b) => b.version_number - a.version_number);
  return { byItem, warning: null };
}

type EnrichedBoard = {
  item: WorkItem;
  record?: ProductionItem;
  targetQty: number;
  producedQty: number | null;
  locked: boolean;
  isDone: boolean;
  isPartial: boolean;
  comps: WorkItemComponent[];
  componentsReady: boolean;
  qtyMet: boolean;
};

function telHref(phone: string) {
  return `tel:${phone.replace(/[^\d+]/g, '')}`;
}

function mapsHref(address: string) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
}

// Bulk "as planned" is available only for a real, explicitly measured plan.
// The display-only fallback of 1 piece is never evidence of production.
function hasRecordedProductionPlan(item: WorkItem): boolean {
  const planned = item.approved_quantity ?? item.survey_quantity;
  return planned != null && Number.isSafeInteger(planned) && planned > 0;
}

function boardLabel(item: WorkItem) {
  const w = formatDim(item.approved_width ?? item.survey_width);
  const h = formatDim(item.approved_height ?? item.survey_height);
  const unit = item.approved_unit ?? item.survey_unit ?? 'ft';
  const sizeTxt = itemSizeLabel(item);
  const dims = sizeTxt !== '—' ? sizeTxt : (w && h ? `${w}×${h} ${unit}` : null);
  const targetQty = item.approved_quantity ?? item.survey_quantity ?? 1;
  return { dims, targetQty };
}

// Full board/BOM detail for one shop's production order — the one query
// every "expand row" / "quick action" path funnels through.
async function fetchOrderDetail(shopId: string, orderId: string): Promise<ProductionOrderDetail> {
  const { data: items, error: itemsErr } = await supabase
    .from('work_items')
    .select('*')
    .eq('shop_id', shopId)
    .in('status', PRODUCTION_ELIGIBLE_STATUSES)
    .order('created_at');
  if (itemsErr) throw new Error(`Could not load boards: ${itemsErr.message}`);

  const { data: productionItems, error: piErr } = await supabase
    .from('production_items')
    .select('*')
    .eq('production_order_id', orderId);
  if (piErr) throw new Error(`Could not load production records: ${piErr.message}`);

  const itemIds = (items || []).map((i) => i.id);
  const { data: components, error: compErr } = itemIds.length
    ? await supabase.from('work_item_components').select('*').in('work_item_id', itemIds).order('created_at')
    : { data: [], error: null };
  if (compErr) throw new Error(`Could not load materials: ${compErr.message}`);

  return {
    items: (items || []) as WorkItem[],
    productionItems: (productionItems || []) as ProductionItem[],
    components: (components || []) as WorkItemComponent[],
  };
}

// Turns raw detail rows into the same enriched per-board shape the UI
// renders — target/produced qty, locked, done/partial, BOM readiness.
function enrichBoards(detail: ProductionOrderDetail): EnrichedBoard[] {
  const productionByItem = new Map(detail.productionItems.filter((p) => p.work_item_id).map((p) => [p.work_item_id as string, p]));
  const compsByItem = new Map<string, WorkItemComponent[]>();
  for (const c of detail.components) {
    const list = compsByItem.get(c.work_item_id) || [];
    list.push(c);
    compsByItem.set(c.work_item_id, list);
  }
  return detail.items.map((item) => {
    const record = productionByItem.get(item.id);
    const { targetQty } = boardLabel(item);
    const producedQty = record?.produced_qty ?? null;
    const locked = BOARD_LOCKED_STATUSES.includes(item.status);
    const comps = compsByItem.get(item.id) || [];
    const componentsReady = comps.length === 0 || comps.every((c) => c.status === 'ready');
    const qtyMet = producedQty != null && producedQty >= targetQty;
    const isDone = locked || (qtyMet && componentsReady);
    const isPartial = !isDone && ((producedQty != null && producedQty > 0) || (qtyMet && !componentsReady));
    return { item, record, targetQty, producedQty, locked, isDone, isPartial, comps, componentsReady, qtyMet };
  });
}

export default function ProductionPage() {
  const [routeParams, setRouteParams] = useSearchParams();
  const linkedPoId = validWorkOrderId(routeParams.get('po'));
  const { profile } = useAuth();
  const orgId = profile?.organization_id;
  const queryClient = useQueryClient();

  const canApprove = profile?.role === 'agency_owner' || profile?.role === 'admin';
  const isProduction = profile?.role === 'printing';
  const canLogProduction = isProduction || canApprove;
  const assignedFilterValue = isProduction ? profile!.id : null;

  // Three distinct screens sharing one page/flow — Overview (numbers at a
  // glance for Owner/Admin/Production alike), Production (the existing
  // per-board work list), and Vehicle Load (Production hands off finished
  // boards to an installer's vehicle). One click switches between them;
  // nothing here is a separate route, so there's no navigation dead-end.
  const [mainView, setMainView] = useState<'overview' | 'production' | 'vehicle_load'>('production');
  const [activeTab, setActiveTab] = useState('active');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [zoneFilter, setZoneFilter] = useState('');
  const [poFilter, setPoFilter] = useState(linkedPoId);
  const [campaignFilter, setCampaignFilter] = useState('');
  const [clientFilter, setClientFilter] = useState('');
  const [workTypeFilter, setWorkTypeFilter] = useState('');
  const [fulfillmentFilter, setFulfillmentFilter] = useState('');
  const [assignedFilter, setAssignedFilter] = useState(''); // owner/admin only
  const [sortBy, setSortBy] = useState<'attention' | 'oldest' | 'newest' | 'zone' | 'completion'>('attention');
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);

  const [expandedOrderId, setExpandedOrderId] = useState<string | null>(null);
  const [expandedShopId, setExpandedShopId] = useState<string | null>(null);
  const [selectedOrderIds, setSelectedOrderIds] = useState<Set<string>>(new Set());
  // Folder browser reveal state — false means "show folder tiles for the
  // current level", true means "show the actual order list for whatever
  // Campaign/Work Order/Zone has been chosen so far". Becomes true either
  // by picking all the way down to a Zone, or by tapping "View All Here"
  // at any level to skip the rest of the folder tree.
  const [browsingList, setBrowsingList] = useState(true);
  // Mobile: the sidebar (View switcher + Status + Filters) collapses into
  // this panel below the lg breakpoint, opened via a "Filters" button
  // next to search — so a production floor tablet/phone isn't
  // permanently missing a third of its screen to a sidebar.
  useEffect(() => {
    setPoFilter(linkedPoId);
    if (linkedPoId) { setClientFilter(''); setCampaignFilter(''); setZoneFilter(''); setBrowsingList(true); setMainView('production'); }
  }, [linkedPoId]);
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);

  const [editOrder, setEditOrder] = useState<ProductionOrderRow | null>(null);
  const [form, setForm] = useState({ notes: '', status: 'in_production', forceComplete: false });
  const [installerId, setInstallerId] = useState('');
  const isCompleting = form.status === 'completed';
  const isSupplyOnly = editOrder?.fulfillment_type === 'supply_only';
  // §3.4 custom-scope shops (design+production only, no install) skip the
  // installer step exactly like Supply Only does — same UI treatment,
  // different reason.
  const skipsInstaller = isSupplyOnly || !!editOrder?.requires_installation_all_false;

  const [bulkStatusOrders, setBulkStatusOrders] = useState<ProductionOrderRow[] | null>(null);
  const [bulkStatus, setBulkStatus] = useState<'in_production' | 'ready' | 'hold'>('in_production');
  const [bulkCompleteOrders, setBulkCompleteOrders] = useState<ProductionOrderRow[] | null>(null);
  const [bulkInstallerId, setBulkInstallerId] = useState('');

  const [editingItem, setEditingItem] = useState<{ orderId: string; itemId: string } | null>(null);
  const [quickLogError, setQuickLogError] = useState<string | null>(null);
  const [itemQty, setItemQty] = useState('');
  const [itemNotes, setItemNotes] = useState('');

  // One shop, one quantity workbench: actual output is entered explicitly for
  // each board, then saved with per-item failure/retry reporting.
  const [quantityWorkbench, setQuantityWorkbench] = useState<{ row: ProductionOrderRow; boards: EnrichedBoard[] } | null>(null);
  const [workbenchValues, setWorkbenchValues] = useState<Record<string, string>>({});
  const [workbenchBaseline, setWorkbenchBaseline] = useState<Record<string, string>>({});
  const [workbenchErrors, setWorkbenchErrors] = useState<Record<string, string>>({});
  const [workbenchSaving, setWorkbenchSaving] = useState(false);
  const [workbenchLoadingId, setWorkbenchLoadingId] = useState<string | null>(null);
  const [workbenchMessage, setWorkbenchMessage] = useState('');
  const [workbenchArtwork, setWorkbenchArtwork] = useState<ProductionArtworkState>(EMPTY_ARTWORK);
  const [workbenchInstaller, setWorkbenchInstaller] = useState('');
  // A single review session may span many server pages. Never cycle back to a shop
  // already visited in that session or guess that a partially saved item is done.
  const visitedProductionIds = useRef<Set<string>>(new Set());
  // Synchronous guard closes the double-click / Ctrl+Enter race before React re-renders.
  const workbenchActionLock = useRef(false);


  const [expandedBom, setExpandedBom] = useState<Set<string>>(new Set());
  const [newComponentName, setNewComponentName] = useState<Record<string, string>>({});
  const [newComponentQty, setNewComponentQty] = useState<Record<string, string>>({});
  const [newComponentSource, setNewComponentSource] = useState<Record<string, 'component' | 'consumable'>>({});
  const [componentError, setComponentError] = useState<Record<string, string>>({});

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    setPage(0);
    setSelectedOrderIds(new Set());
  }, [activeTab, debouncedSearch, zoneFilter, poFilter, campaignFilter, clientFilter, workTypeFilter, fulfillmentFilter, assignedFilter, sortBy]);

  // ---- Lightweight, dedicated option lists for filter dropdowns — never
  // derived from the (paginated, filtered) orders list itself, so the
  // dropdowns always show every zone/PO/work-type the org has regardless
  // of what's on the current page or matches the current filters. ----
  // (Zone and Purchase Order option lists moved into the folder browser's
  // own campaignFolders/poFolders/zoneFolders — derived from treeRows —
  // since those are now navigated as folders, not flat dropdowns.)
  const { data: workTypeOptions } = useQuery({
    queryKey: ['production-filter-worktypes', orgId],
    queryFn: async () => {
      const { data, error } = await supabase.from('work_types').select('id, name').eq('organization_id', orgId).eq('is_active', true).order('name');
      if (error) throw new Error(error.message);
      return data as { id: string; name: string }[];
    },
    enabled: !!orgId,
  });
  const { data: productionTeam } = useQuery({
    queryKey: ['production-filter-team', orgId],
    queryFn: async () => {
      const { data, error } = await supabase.from('profiles').select('id, full_name').eq('organization_id', orgId).eq('role', 'printing').eq('is_active', true).order('full_name');
      if (error) throw new Error(error.message);
      return data as { id: string; full_name: string }[];
    },
    enabled: !!orgId && canApprove,
  });
  const { data: orgInstallers } = useQuery({
    queryKey: ['org-installers', orgId],
    queryFn: async () => {
      const { data, error } = await supabase.from('profiles').select('id, full_name').eq('organization_id', orgId).eq('role', 'installer').eq('is_active', true).order('full_name');
      if (error) throw new Error(`Could not load installers: ${error.message}`);
      return data as { id: string; full_name: string }[];
    },
    // Load once for the action queue too: when exactly one installer exists, completion needs no picker.
    enabled: !!orgId && canApprove && (mainView === 'production' || (!!editOrder && isCompleting && !skipsInstaller) || !!bulkCompleteOrders),
  });

  // Reuse the only available installer automatically, avoiding a redundant click.
  // Multiple active installers still require an explicit choice.
  const effectiveInstallerId = installerId || (orgInstallers?.length === 1 ? orgInstallers[0].id : '');
  const effectiveBulkInstallerId = bulkInstallerId || (orgInstallers?.length === 1 ? orgInstallers[0].id : '');

  const tab = TABS.find((t) => t.key === activeTab)!;
  // One canonical list fetch for the visible queue AND its cross-page Next action.
  // No separate unfiltered/permission-bypassing query for navigation.
  async function fetchProductionPage(pageNumber: number, size: number) {
      let q = supabase.from('v_production_order_list').select('*', { count: 'exact' }).eq('organization_id', orgId);
      if (assignedFilterValue) q = q.eq('assigned_to', assignedFilterValue);
      else if (assignedFilter) q = q.eq('assigned_to', assignedFilter);
      if (activeTab === 'needs_materials') q = q.gt('materials_pending_boards', 0);
      else if (tab.statuses) q = q.in('status', tab.statuses);
      if (clientFilter) q = q.eq('client_id', clientFilter);
      // A PO's "Campaign" is project_id (agency's own) OR campaign_id
      // (client's own) — never both — same unified concept the folder
      // browser groups by (see campaignKeyAndName below).
      if (campaignFilter === NO_FOLDER_BUCKET) q = q.is('project_id', null).is('campaign_id', null);
      else if (campaignFilter) q = q.or(`project_id.eq.${campaignFilter},campaign_id.eq.${campaignFilter}`);
      if (poFilter === NO_FOLDER_BUCKET) q = q.is('po_id', null);
      else if (poFilter) q = q.eq('po_id', poFilter);
      if (zoneFilter === NO_FOLDER_BUCKET) q = q.is('zone_id', null);
      else if (zoneFilter) q = q.eq('zone_id', zoneFilter);
      if (workTypeFilter) q = q.contains('work_type_ids', [workTypeFilter]);
      if (fulfillmentFilter) q = q.eq('fulfillment_type', fulfillmentFilter);
      const term = debouncedSearch.replace(/[,%()]/g, ' ').trim();
      if (term) q = q.or(`shop_name.ilike.%${term}%,client_name.ilike.%${term}%,shop_city.ilike.%${term}%,shop_contact_phone.ilike.%${term}%,po_number.ilike.%${term}%,po_name.ilike.%${term}%`);

      if (sortBy === 'oldest') q = q.order('created_at', { ascending: true });
      else if (sortBy === 'newest') q = q.order('created_at', { ascending: false });
      else if (sortBy === 'zone') q = q.order('zone_name', { ascending: true, nullsFirst: false });
      else if (sortBy === 'completion') q = q.order('progress_pct', { ascending: false });
      else q = q.order('attention_rank', { ascending: true }).order('created_at', { ascending: false });

      q = q.range(pageNumber * size, pageNumber * size + size - 1);
      const { data, error, count } = await q;
      if (error) throw new Error(error.message || 'Could not load production orders.');
      return { rows: (data || []) as ProductionOrderRow[], count: count || 0 };
  }

  const {
    data: listResult,
    isFetching: listFetching,
    isLoading: listLoading,
    isError: listIsError,
    error: listQueryError,
    refetch: refetchList,
  } = useQuery({
    queryKey: ['production-order-list', orgId, assignedFilterValue, activeTab, debouncedSearch, page, pageSize, zoneFilter, poFilter, campaignFilter, clientFilter, workTypeFilter, fulfillmentFilter, assignedFilter, sortBy],
    queryFn: () => fetchProductionPage(page, pageSize),
    enabled: !!orgId,
    placeholderData: keepPreviousData,
    retry: 1,
  });
  const rows = useMemo(() => listResult?.rows || [], [listResult]);
  const totalCount = listResult?.count || 0;
  const pageCount = Math.max(1, Math.ceil(totalCount / pageSize));

  // After saving the current order, move FORWARD through the same filtered,
  // paginated queue (including its role/assignment scope). No looping back to
  // the first task, and no manual Next Page click for 1000+ shop queues.
  async function openNextProductionTask(currentOrderId: string) {
    visitedProductionIds.current.add(currentOrderId);
    // When someone chose a workset, Save & Next must stay inside that
    // workset. Normal queue navigation still continues across server pages.
    const selectedWorkset = selectedOrderIds.has(currentOrderId) ? selectedOrderIds : null;
    const eligible = (row: ProductionOrderRow) => row.pending_boards > 0 &&
      !['completed', 'hold'].includes(row.status) &&
      !visitedProductionIds.current.has(row.production_order_id) &&
      (!selectedWorkset || selectedWorkset.has(row.production_order_id));
    const currentIndex = rows.findIndex(row => row.production_order_id === currentOrderId);
    const nextInPage = rows.slice(Math.max(0, currentIndex + 1)).find(eligible);
    if (nextInPage) {
      await openQuantityWorkbench(nextInPage, true);
      if (selectedWorkset) setSelectedOrderIds(previous => new Set([...previous].filter(id => id !== currentOrderId)));
      return;
    }
    if (selectedWorkset) {
      // Selection belongs only to the visible page, never silently approve or
      // fetch unrelated shops. Another selection may be started afterwards.
      setSelectedOrderIds(previous => new Set([...previous].filter(id => id !== currentOrderId)));
      setQuantityWorkbench(null);
      return;
    }
    const count = totalCount;
    for (let nextPage = page + 1; nextPage * pageSize < count; nextPage++) {
      const result = await fetchProductionPage(nextPage, pageSize);
      const next = result.rows.find(eligible);
      if (!next) continue;
      setPage(nextPage);
      await openQuantityWorkbench(next, true);
      return;
    }
    setQuantityWorkbench(null);
  }


  // ---- Folder browser (Campaign → Work Order → Zone) ----
  // One lightweight, UNPAGINATED fetch — same status tab / search / work
  // type / fulfillment / assigned filters as the list above, but
  // deliberately NOT scoped by campaign/PO/zone (those are exactly the
  // three levels being browsed) and selecting only the handful of columns
  // needed to build folder tiles + counts. Every level's tile counts are
  // then derived from this one result set client-side, so drilling from
  // Campaign -> PO -> Zone never re-queries the server, and the counts at
  // every level always agree with what the list below will actually show.
  const {
    data: treeRows,
    isFetching: treeFetching,
  } = useQuery({
    queryKey: ['production-order-tree', orgId, assignedFilterValue, activeTab, debouncedSearch, workTypeFilter, fulfillmentFilter, assignedFilter],
    queryFn: async () => {
      let q = supabase
        .from('v_production_order_list')
        .select('production_order_id, client_id, client_name, project_id, project_name, campaign_id, campaign_name, po_id, po_number, po_name, zone_id, zone_name, status, materials_pending_boards')
        .eq('organization_id', orgId);
      if (assignedFilterValue) q = q.eq('assigned_to', assignedFilterValue);
      else if (assignedFilter) q = q.eq('assigned_to', assignedFilter);
      if (activeTab === 'needs_materials') q = q.gt('materials_pending_boards', 0);
      else if (tab.statuses) q = q.in('status', tab.statuses);
      if (workTypeFilter) q = q.contains('work_type_ids', [workTypeFilter]);
      if (fulfillmentFilter) q = q.eq('fulfillment_type', fulfillmentFilter);
      const term = debouncedSearch.replace(/[,%()]/g, ' ').trim();
      if (term) q = q.or(`shop_name.ilike.%${term}%,client_name.ilike.%${term}%,shop_city.ilike.%${term}%,shop_contact_phone.ilike.%${term}%,po_number.ilike.%${term}%,po_name.ilike.%${term}%`);
      q = q.order('production_order_id', { ascending: true });
      const data = await fetchWorkflowFolderPages(async (from, to) => {
        const { data: batch, error } = await q.range(from, to);
        if (error) throw new Error(`Could not load the folder browser: ${error.message}`);
        return batch || [];
      });
      return data as {
        production_order_id: string; client_id: string; client_name: string | null; project_id: string | null; project_name: string | null;
        campaign_id: string | null; campaign_name: string | null;
        po_id: string | null; po_number: string | null; po_name: string | null;
        zone_id: string | null; zone_name: string | null; status: string; materials_pending_boards: number;
      }[];
    },
    // The task-first queue is paginated: only load the whole folder tree when the user asks for it.
    enabled: !!orgId && !browsingList && !debouncedSearch,
    staleTime: 30_000,
  });

  // Client tiles — the new top level. Every distinct client present in
  // treeRows; no "No Client" bucket needed since every shop always has
  // exactly one (shops.client_id is NOT NULL).
  const clientFolders = useMemo(() => {
    const map = new Map<string, { id: string; name: string; count: number; materialsPending: number }>();
    for (const r of treeRows || []) {
      const entry = map.get(r.client_id) || { id: r.client_id, name: r.client_name || 'Unnamed Client', count: 0, materialsPending: 0 };
      entry.count += 1;
      if (r.materials_pending_boards > 0) entry.materialsPending += 1;
      map.set(r.client_id, entry);
    }
    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [treeRows]);

  // A PO's "Campaign" is whichever grouping it actually has — the
  // agency's own project (project_id, the common case) or the client's
  // own campaign (campaign_id, client-portal-only) — never both at once
  // (same rule PurchaseOrdersPage.tsx's own Campaign filter relies on).
  function campaignKeyAndName(r: { project_id: string | null; project_name: string | null; campaign_id: string | null; campaign_name: string | null }) {
    if (r.project_id) return { key: r.project_id, name: r.project_name || 'Unnamed Campaign' };
    if (r.campaign_id) return { key: r.campaign_id, name: r.campaign_name || 'Unnamed Campaign' };
    return { key: NO_FOLDER_BUCKET, name: 'No Campaign' };
  }

  function rowMatchesCampaign(r: { project_id: string | null; campaign_id: string | null }, filterValue: string) {
    if (!filterValue) return true;
    if (filterValue === NO_FOLDER_BUCKET) return !r.project_id && !r.campaign_id;
    return r.project_id === filterValue || r.campaign_id === filterValue;
  }

  // Campaign tiles — scoped to whichever client is chosen ('' means
  // "haven't chosen one yet", so every campaign org-wide) — plus a "No
  // Campaign" bucket for POs that were never grouped under one (the
  // normal case for agency-created POs; campaigns are a client-side,
  // optional concept — migration 0051).
  const campaignFolders = useMemo(() => {
    const scoped = (treeRows || []).filter((r) => !clientFilter || r.client_id === clientFilter);
    const map = new Map<string, { id: string; name: string; count: number; materialsPending: number }>();
    for (const r of scoped) {
      const { key, name } = campaignKeyAndName(r);
      const entry = map.get(key) || { id: key, name, count: 0, materialsPending: 0 };
      entry.count += 1;
      if (r.materials_pending_boards > 0) entry.materialsPending += 1;
      map.set(key, entry);
    }
    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [treeRows, clientFilter]);

  // Work Order tiles — scoped to whichever client AND campaign are
  // currently chosen ('' at the campaign level means "haven't chosen one
  // yet", in which case this is every PO under the chosen client;
  // NO_FOLDER_BUCKET means specifically the "No Campaign" bucket).
  const poFolders = useMemo(() => {
    const scoped = (treeRows || []).filter((r) => (!clientFilter || r.client_id === clientFilter) && rowMatchesCampaign(r, campaignFilter));
    const map = new Map<string, { id: string; name: string; count: number; materialsPending: number }>();
    for (const r of scoped) {
      const key = r.po_id || NO_FOLDER_BUCKET;
      const name = r.po_id ? (r.po_name ? `${r.po_name} (${r.po_number})` : r.po_number || 'Unnamed Work Order') : 'No Work Order';
      const entry = map.get(key) || { id: key, name, count: 0, materialsPending: 0 };
      entry.count += 1;
      if (r.materials_pending_boards > 0) entry.materialsPending += 1;
      map.set(key, entry);
    }
    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [treeRows, clientFilter, campaignFilter]);

  // Zone tiles — scoped to whichever client, campaign AND work order are chosen.
  const zoneFolders = useMemo(() => {
    const scoped = (treeRows || []).filter((r) => {
      if (clientFilter && r.client_id !== clientFilter) return false;
      if (!rowMatchesCampaign(r, campaignFilter)) return false;
      if (poFilter === NO_FOLDER_BUCKET) return !r.po_id;
      if (poFilter) return r.po_id === poFilter;
      return true;
    });
    const map = new Map<string, { id: string; name: string; count: number; materialsPending: number }>();
    for (const r of scoped) {
      const key = r.zone_id || NO_FOLDER_BUCKET;
      const name = r.zone_id ? (r.zone_name || 'Unnamed Zone') : 'No Zone';
      const entry = map.get(key) || { id: key, name, count: 0, materialsPending: 0 };
      entry.count += 1;
      if (r.materials_pending_boards > 0) entry.materialsPending += 1;
      map.set(key, entry);
    }
    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [treeRows, clientFilter, campaignFilter, poFilter]);

  const selectedClientName = clientFilter ? (clientFolders.find((c) => c.id === clientFilter)?.name || 'Client') : null;
  const selectedCampaignName = campaignFilter
    ? (campaignFolders.find((c) => c.id === campaignFilter)?.name || (campaignFilter === NO_FOLDER_BUCKET ? 'No Campaign' : 'Campaign'))
    : null;
  const selectedPoName = poFilter
    ? (poFilter === NO_FOLDER_BUCKET ? 'No Work Order' : (poFolders.find((p) => p.id === poFilter)?.name || (treeRows || []).find((r) => r.po_id === poFilter)?.po_number || 'Work Order'))
    : null;
  const selectedZoneName = zoneFilter
    ? (zoneFilter === NO_FOLDER_BUCKET ? 'No Zone' : (zoneFolders.find((z) => z.id === zoneFilter)?.name || (treeRows || []).find((r) => r.zone_id === zoneFilter)?.zone_name || 'Zone'))
    : null;

  function resetFolderFrom(level: 'root' | 'client' | 'campaign' | 'po' | 'zone') {
    if (level === 'root') { setClientFilter(''); setCampaignFilter(''); setPoFilter(''); setZoneFilter(''); }
    else if (level === 'client') { setCampaignFilter(''); setPoFilter(''); setZoneFilter(''); }
    else if (level === 'campaign') { setPoFilter(''); setZoneFilter(''); }
    else if (level === 'po') { setZoneFilter(''); }
    else if (level === 'zone') { setZoneFilter(''); }
    setBrowsingList(false);
  }

  const { data: stats, isError: statsIsError, error: statsQueryError } = useQuery({
    queryKey: ['production-order-stats', orgId, assignedFilterValue],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('production_order_stats', { p_assigned_to: assignedFilterValue }).single();
      if (error) throw new Error(error.message || 'Could not load production stats.');
      return data as ProductionStats;
    },
    enabled: !!orgId,
  });

  // Vehicle Load counters for the Overview screen — same "computed in SQL,
  // not summed client-side" approach as production_order_stats above.
  const { data: vehicleLoadStats } = useQuery({
    queryKey: ['vehicle-load-stats', orgId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('vehicle_load_stats').single();
      if (error) throw new Error(error.message || 'Could not load vehicle load stats.');
      return data as VehicleLoadStats;
    },
    enabled: !!orgId,
  });

  useRealtimeInvalidate(
    ['vehicle_loads', 'vehicle_load_items'],
    orgId,
    [
      ['vehicle-load-stats', orgId],
      ['vehicle-load-shops', orgId],
    ]
  );

  const { data: detail, isLoading: detailLoading } = useQuery({
    queryKey: ['production-order-detail', expandedShopId, expandedOrderId],
    queryFn: () => fetchOrderDetail(expandedShopId!, expandedOrderId!),
    enabled: !!expandedShopId && !!expandedOrderId,
  });
  const boards = useMemo(() => (detail ? enrichBoards(detail) : []), [detail]);
  const componentsQueryKey = ['production-order-detail', expandedShopId, expandedOrderId] as const;

  useRealtimeInvalidate(
    ['production_orders', 'production_items', 'work_items', 'work_item_components'],
    orgId,
    [
      ['production-order-list', orgId],
      ['production-order-stats', orgId],
      ['production-order-detail'],
      ['production-order-tree', orgId],
    ]
  );

  function isRowSelectable(row: ProductionOrderRow) {
    return row.status !== 'completed';
  }
  useEffect(() => {
    setSelectedOrderIds((prev) => {
      if (prev.size === 0) return prev;
      const selectable = new Set(rows.filter(isRowSelectable).map((r) => r.production_order_id));
      const next = new Set(Array.from(prev).filter((id) => selectable.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [rows]);
  function toggleOrderSelected(id: string) {
    setSelectedOrderIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleExpand(row: ProductionOrderRow) {
    if (expandedOrderId === row.production_order_id) {
      setExpandedOrderId(null);
      setExpandedShopId(null);
    } else {
      setExpandedOrderId(row.production_order_id);
      setExpandedShopId(row.shop_id);
      setEditingItem(null);
    }
  }

  // Details are fetched fresh when the operator opens a shop. They are not
  // preloaded for hundreds of shops and never expose another agency's tasks.
  async function openQuantityWorkbench(row: ProductionOrderRow, afterSave = false) {
    if (!canLogProduction || (!afterSave && workbenchLoadingId) || (!afterSave && workbenchSaving) || ['completed', 'hold'].includes(row.status)) return;
    if (!afterSave) visitedProductionIds.current.clear();
    setQuickLogError(null);
    setWorkbenchLoadingId(row.production_order_id);
    try {
      const loaded = await queryClient.fetchQuery({
        queryKey: ['production-order-detail', row.shop_id, row.production_order_id],
        queryFn: () => fetchOrderDetail(row.shop_id, row.production_order_id),
        staleTime: 0,
      });
      const boardRows = enrichBoards(loaded);
      if (boardRows.length === 0 || boardRows.every(board => board.locked)) {
        throw new Error('No editable boards in this production order.');
      }
      const artwork = await fetchApprovedProductionArtwork(row.production_order_id, row.shop_id, boardRows.map(b => b.item.id));
      const original = Object.fromEntries(boardRows.map(board => [board.item.id, board.producedQty == null ? '' : String(board.producedQty)]));
      setWorkbenchArtwork(artwork);
      setWorkbenchInstaller('');
      setQuantityWorkbench({ row, boards: boardRows });
      setWorkbenchValues(original);
      setWorkbenchBaseline(original);
      setWorkbenchErrors({});
      setWorkbenchMessage('');
    } catch (error) {
      const message = (error as Error).message || 'Unable to load production quantities.';
      if (afterSave) setWorkbenchMessage(`Could not open the next shop: ${message}`);
      else setQuickLogError(message);
      if (afterSave) throw error;
    } finally {
      setWorkbenchLoadingId(null);
    }
  }

  // Existing single-board and multi-board paths use one persistence contract.
  // A board's real produced quantity must come from the operator; a PO target
  // is a helper in the form, never silently recorded as actual output.
  async function saveProducedBoard(
    row: ProductionOrderRow,
    board: Pick<EnrichedBoard, 'item' | 'record' | 'componentsReady' | 'targetQty'>,
    producedQty: number,
    notes: string,
    expectedQty?: number | null
  ) {
    if (!canLogProduction || !orgId) throw new Error('You do not have permission to record production.');
    if (row.status === 'completed') throw new Error('Production is completed and is read-only.');
    if (!Number.isSafeInteger(producedQty) || producedQty < 0) throw new Error('Enter a whole-number actual quantity (0 or more).');
    const { data: current, error: currentError } = await supabase.from('work_items')
      .select('id,status,shop_id').eq('id', board.item.id).maybeSingle();
    if (currentError) throw new Error(currentError.message);
    if (!current || current.shop_id !== row.shop_id || !['approved', 'design_approved', 'in_production', 'produced'].includes(current.status)) {
      throw new Error('This board has moved to another stage. Refresh before saving.');
    }
    // Re-read this item's production record to prevent lost updates. When a
    // prior request saved the production row but failed on its work-item status
    // write, retrying the exact same quantity safely resumes that write.
    const { data: persisted, error: persistedError } = await supabase.from('production_items')
      .select('id,produced_qty,notes')
      .eq('production_order_id', row.production_order_id).eq('work_item_id', board.item.id).maybeSingle();
    if (persistedError) throw new Error(`Could not verify current quantity: ${persistedError.message}`);
    const expected = expectedQty === undefined ? (board.record?.produced_qty ?? null) : expectedQty;
    if (board.record) {
      if (!persisted || persisted.id !== board.record.id ||
          (persisted.produced_qty !== expected && persisted.produced_qty !== producedQty)) {
        throw new Error('This quantity changed in another session. Refresh this order before saving.');
      }
    } else if (persisted && persisted.produced_qty !== expected && persisted.produced_qty !== producedQty) {
      throw new Error('Another operator recorded a quantity for this board. Refresh before changing it.');
    }
    if (persisted && (persisted.produced_qty !== producedQty || (persisted.notes || '') !== notes.trim())) {
      let request = supabase.from('production_items')
        .update({ produced_qty: producedQty, notes: notes.trim() || null })
        .eq('id', persisted.id).eq('production_order_id', row.production_order_id)
        .eq('work_item_id', board.item.id);
      request = persisted.produced_qty == null ? request.is('produced_qty', null) : request.eq('produced_qty', persisted.produced_qty);
      const { data: saved, error: productionError } = await request.select('id');
      if (productionError) throw new Error(`Could not update quantity: ${productionError.message}`);
      if (!saved?.length) throw new Error('Production quantity changed in another session. Refresh and retry.');
    } else if (!persisted) {
      const { error: productionError } = await supabase.from('production_items').insert({
        organization_id: orgId,
        production_order_id: row.production_order_id,
        work_item_id: board.item.id,
        requested_qty: board.targetQty,
        approved_qty: board.item.approved_quantity ?? null,
        produced_qty: producedQty,
        notes: notes.trim() || null,
      });
      if (productionError) throw new Error(`Could not save quantity: ${productionError.message}. Refresh and retry if this board was updated elsewhere.`);
    }
    const status = producedQty >= board.targetQty && board.componentsReady ? 'produced' : 'in_production';
    const { data: updated, error: itemError } = await supabase.from('work_items')
      .update({ produced_quantity: producedQty, produced_notes: notes.trim() || null,
        produced_at: new Date().toISOString(), status })
      .eq('id', board.item.id)
      .in('status', ['approved', 'design_approved', 'in_production', 'produced'])
      .select('id');
    if (itemError) throw new Error(`Quantity saved but board status could not update: ${itemError.message}`);
    if (!updated?.length) throw new Error('Quantity saved but board changed concurrently. Refresh before continuing.');
    if (row.status === 'pending') {
      const { error: orderError } = await supabase.from('production_orders')
        .update({ status: 'in_production' }).eq('id', row.production_order_id).eq('status', 'pending');
      if (orderError) throw new Error(`Quantity saved but production status could not update: ${orderError.message}`);
    }
    await logAudit('production_items', persisted?.id || null, persisted ? 'update' : 'insert',
      'produced_qty', expected == null ? null : String(expected),
      String(producedQty), `${board.item.work_type_name || 'Board'} production logged (${producedQty}/${board.targetQty}) for ${row.shop_name}`);
  }

  // One workbench for all board quantities; save/next/complete reuse the
  // same write path. Completion still goes through phase3_complete_production.
  async function saveWorkbenchQuantities(action: 'save' | 'next' | 'complete' = 'save', confirmBlankPlans = false) {
    if (!quantityWorkbench || workbenchSaving || workbenchActionLock.current) return;
    workbenchActionLock.current = true;
    const currentRow = quantityWorkbench.row;
    const valuesToSave = { ...workbenchValues };
    if (confirmBlankPlans) {
      // Explicit user confirmation only. Never overwrite an existing actual
      // quantity, an operator's edits, or any locked work item.
      for (const board of quantityWorkbench.boards) {
        if (board.locked || valuesToSave[board.item.id] !== '') continue;
        if (!hasRecordedProductionPlan(board.item) || !Number.isSafeInteger(board.targetQty) || board.targetQty <= 0) {
          setWorkbenchMessage('A verified planned quantity is missing. Enter the actual output manually for this board.');
          workbenchActionLock.current = false;
          return;
        }
        valuesToSave[board.item.id] = String(board.targetQty);
      }
      setWorkbenchValues(valuesToSave);
    }
    const changed = quantityWorkbench.boards.filter(board =>
      !board.locked && valuesToSave[board.item.id] !== workbenchBaseline[board.item.id]);
    if (!changed.length && action !== 'complete') {
      if (action === 'next') {
        try { await openNextProductionTask(currentRow.production_order_id); }
        catch { /* openNextProductionTask already reports the load failure */ }
        finally { workbenchActionLock.current = false; }
      } else {
        setWorkbenchMessage('No changes to save.');
        workbenchActionLock.current = false;
      }
      return;
    }
    setWorkbenchSaving(true);
    setWorkbenchMessage('');
    const errors: Record<string, string> = {};
    const nextBaseline = { ...workbenchBaseline };
    let successes = 0;
    try {
      // Each board is independent; bounded concurrency shortens multi-board
      // saves without flooding Supabase or weakening per-board CAS checks.
      const result = await runBoundedWorkflowBatch(changed, async board => {
        const raw = (valuesToSave[board.item.id] || '').trim();
        const qty = Number(raw);
        if (!raw || !Number.isSafeInteger(qty) || qty < 0) {
          throw new Error('Enter a whole-number actual quantity (0 or more).');
        }
        const baseline = workbenchBaseline[board.item.id];
        await saveProducedBoard(currentRow, board, qty, board.record?.notes || '', baseline === '' ? null : Number(baseline));
        nextBaseline[board.item.id] = raw;
      }, undefined, 3);
      successes = result.completed.length;
      for (const failure of result.failed) errors[failure.item.item.id] = failure.message;
      setWorkbenchBaseline(nextBaseline);
      setWorkbenchErrors(errors);
      queryClient.invalidateQueries({ queryKey: ['production-order-list', orgId] });
      queryClient.invalidateQueries({ queryKey: ['production-order-stats', orgId] });
      queryClient.invalidateQueries({ queryKey: ['production-order-detail'] });
      queryClient.invalidateQueries({ queryKey: ['production-order-tree', orgId] });
      queryClient.invalidateQueries({ queryKey: ['nav-pending-counts', orgId] });
      if (Object.keys(errors).length > 0) {
        setWorkbenchMessage(`${successes} saved. ${Object.keys(errors).length} board(s) need correction or retry. Successful quantities won't be re-submitted.`);
        return;
      }
      if (action === 'complete') {
        if (!canApprove) throw new Error('Only Owner/Admin may complete production.');
        // Fresh database state: no completion based solely on typed numbers.
        const verified = enrichBoards(await fetchOrderDetail(currentRow.shop_id, currentRow.production_order_id));
        if (!verified.length || verified.some(b => !b.locked && (!b.qtyMet || !b.componentsReady))) {
          throw new Error('Quantities saved. Some boards or materials are still pending; complete after resolving them.');
        }
        const skipInstall = currentRow.fulfillment_type === 'supply_only' || currentRow.requires_installation_all_false;
        const installer = skipInstall ? '' : (workbenchInstaller || (orgInstallers?.length === 1 ? orgInstallers[0].id : ''));
        if (!skipInstall && (!installer || !orgInstallers?.some(x => x.id === installer))) {
          throw new Error('Quantities saved. Select an active Installer before completion.');
        }
        await completeProductionOrder(currentRow, installer, currentRow.notes || '');
        queryClient.invalidateQueries({ queryKey: ['shops'] });
      }
      if (action === 'next') await openNextProductionTask(currentRow.production_order_id);
      else setQuantityWorkbench(null);
    } catch (error) {
      setWorkbenchMessage((error as Error).message || 'Could not finish this action.');
    } finally {
      workbenchActionLock.current = false;
      setWorkbenchSaving(false);
    }
  }

  useEffect(() => {
    if (!editingItem) return;
    const timer = window.setTimeout(() => {
      document.getElementById(`production-board-${editingItem.itemId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 75);
    return () => window.clearTimeout(timer);
  }, [editingItem]);

  function openEditOrder(row: ProductionOrderRow) {
    if (row.status === 'completed') return; // A finished production handoff is read-only.
    setEditOrder(row);
    setForm({ notes: row.notes || '', status: row.status === 'pending' ? 'in_production' : row.status, forceComplete: false });
    setInstallerId('');
  }

  function toggleBom(itemId: string) {
    setExpandedBom((prev) => {
      const next = new Set(prev);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  }

  function openItemEditor(orderId: string, entry: EnrichedBoard) {
    setEditingItem({ orderId, itemId: entry.item.id });
    setItemQty(String(entry.producedQty ?? entry.targetQty ?? ''));
    setItemNotes(entry.record?.notes || '');
  }

  const addComponentMutation = useMutation({
    mutationFn: async ({ item }: { item: WorkItem }) => {
      const name = (newComponentName[item.id] || '').trim();
      if (!name) throw new Error('Enter a component name.');
      const qtyStr = newComponentQty[item.id] || '';
      const required_qty = qtyStr === '' ? null : Number(qtyStr);
      if (qtyStr !== '' && (isNaN(required_qty as number) || (required_qty as number) < 0)) {
        throw new Error('Required qty must be 0 or more.');
      }
      const { data, error } = await supabase
        .from('work_item_components')
        .insert({
          organization_id: orgId,
          work_item_id: item.id,
          component_name: name,
          required_qty,
          source: newComponentSource[item.id] || 'component',
        })
        .select('*')
        .single();
      if (error) throw new Error(`Could not add component: ${error.message}`);
      await logAudit('work_item_components', null, 'insert', 'component_name', null, name, `Added ${newComponentSource[item.id] === 'consumable' ? 'consumable' : 'component'} "${name}" for ${item.work_type_name || 'board'}`);
      return data as WorkItemComponent;
    },
    onSuccess: (created, { item }) => {
      queryClient.setQueryData<ProductionOrderDetail>(componentsQueryKey, (old) =>
        old ? { ...old, components: [...old.components, created] } : old
      );
      setNewComponentName((prev) => ({ ...prev, [item.id]: '' }));
      setNewComponentQty((prev) => ({ ...prev, [item.id]: '' }));
    },
  });

  const setComponentStatusMutation = useMutation({
    mutationFn: async ({ component, status }: { component: WorkItemComponent; status: WorkItemComponent['status'] }) => {
      const { error } = await supabase.from('work_item_components').update({ status }).eq('id', component.id);
      if (error) throw new Error(error.message || 'Could not update status.');
      await logAudit('work_item_components', component.id, 'update', 'status', component.status, status, `${component.component_name} → ${status}`);
      return { componentId: component.id, status };
    },
    onMutate: ({ component }) => {
      setComponentError((prev) => {
        const next = { ...prev };
        delete next[component.id];
        return next;
      });
    },
    onError: (err: Error, { component }) => {
      setComponentError((prev) => ({ ...prev, [component.id]: err.message }));
    },
    onSuccess: ({ componentId, status }) => {
      queryClient.setQueryData<ProductionOrderDetail>(componentsQueryKey, (old) =>
        old ? { ...old, components: old.components.map((c) => (c.id === componentId ? { ...c, status } : c)) } : old
      );
      queryClient.invalidateQueries({ queryKey: ['production-order-list', orgId] });
      queryClient.invalidateQueries({ queryKey: ['production-order-stats', orgId] });
    },
  });

  const deleteComponentMutation = useMutation({
    mutationFn: async (component: WorkItemComponent) => {
      const { error } = await supabase.from('work_item_components').delete().eq('id', component.id);
      if (error) throw new Error(`Could not remove component: ${error.message}`);
      await logAudit('work_item_components', component.id, 'delete', null, component.status, null, `Removed component "${component.component_name}"`);
      return component.id;
    },
    onSuccess: (deletedId) => {
      queryClient.setQueryData<ProductionOrderDetail>(componentsQueryKey, (old) =>
        old ? { ...old, components: old.components.filter((c) => c.id !== deletedId) } : old
      );
      queryClient.invalidateQueries({ queryKey: ['production-order-list', orgId] });
      queryClient.invalidateQueries({ queryKey: ['production-order-stats', orgId] });
    },
  });

  const logProductionMutation = useMutation({
    mutationFn: async ({ row, item, record, componentsReady }: { row: ProductionOrderRow; item: WorkItem; record?: ProductionItem; componentsReady: boolean }) => {
      if (itemQty.trim() === '') throw new Error('Enter the actual produced quantity.');
      await saveProducedBoard(row, { item, record, componentsReady, targetQty: boardLabel(item).targetQty }, Number(itemQty), itemNotes);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['production-order-list', orgId] });
      queryClient.invalidateQueries({ queryKey: ['production-order-stats', orgId] });
      queryClient.invalidateQueries({ queryKey: ['production-order-detail'] });
      queryClient.invalidateQueries({ queryKey: ['nav-pending-counts', orgId] });
      setEditingItem(null);
    },
  });

  // Everything involved in marking one order completed: order + shop +
  // work-item status flips, plus (unless Supply Only) assigning/notifying
  // the installer — shared by the single-row modal and bulk complete so
  // both paths can never drift apart.
  async function completeProductionOrder(row: ProductionOrderRow, installer: string, notes = '', forceComplete = false) {
    // Atomic production -> packing / installer handoff. The server enforces
    // the team role, recorded quantities/materials, and idempotent assignment.
    const { error } = await supabase.rpc('phase3_complete_production', {
      p_production_order_id: row.production_order_id,
      p_installer_id: installer || null,
      p_notes: notes.trim() || null,
      p_force_complete: forceComplete,
    });
    if (error) {
      if (/could not find the function|schema cache/i.test(error.message)) {
        throw new Error('Phase 3 database migration (0099) is not applied. Deploy it before completing production tasks.');
      }
      throw new Error(`Production completion failed: ${error.message}`);
    }
  }

  const updateMutation = useMutation({
    mutationFn: async () => {
      if (!editOrder) return;
      if (editOrder.status === 'completed') throw new Error('This production order is already completed and cannot be reopened here.');
      if (form.status === 'completed' && !effectiveInstallerId && !skipsInstaller) {
        throw new Error('Pick an installer to assign before marking production completed.');
      }
      if (form.status === 'completed' && editOrder.pending_boards > 0 && !form.forceComplete) {
        throw new Error(`${editOrder.pending_boards} board(s) on this shop still have no production logged. Log them above, or tick "Mark completed anyway" to override.`);
      }
      if (form.status === 'completed') {
        await completeProductionOrder(editOrder, effectiveInstallerId, form.notes || '', Boolean(form.forceComplete));
        return;
      }
      const { data: updatedOrder, error: orderError } = await supabase.from('production_orders').update({ status: form.status, notes: form.notes || null }).eq('id', editOrder.production_order_id).eq('status', editOrder.status).select('id');
      if (!orderError && !updatedOrder?.length) throw new Error('This production order changed in another session. Refresh before changing its status.');
      if (orderError) throw new Error(`Could not update production order: ${orderError.message}`);
      await logAudit('production_orders', editOrder.production_order_id, 'update', 'status', editOrder.status, form.status, `Production ${form.status} for ${editOrder.shop_name}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['production-order-list', orgId] });
      queryClient.invalidateQueries({ queryKey: ['production-order-stats', orgId] });
      queryClient.invalidateQueries({ queryKey: ['production-order-detail'] });
      queryClient.invalidateQueries({ queryKey: ['shops'] });
      queryClient.invalidateQueries({ queryKey: ['nav-pending-counts', orgId] });
      setEditOrder(null);
      setInstallerId('');
    },
  });

  // One-click completion for genuinely ready orders only. The same atomic RPC
  // performs quantity/material checks, organization/role authorization and handoff.
  // Never guess an installer when the agency has multiple active members.
  const instantCompleteMutation = useMutation({
    mutationFn: async ({ row, installer }: { row: ProductionOrderRow; installer: string }) => {
      if (!canApprove) throw new Error('Only Owner/Admin may complete production.');
      if (!readyForDirectCompletion(row)) {
        throw new Error('This order is not yet ready for completion. Review pending work first.');
      }
      const needsInstaller = row.fulfillment_type !== 'supply_only' && !row.requires_installation_all_false;
      if (needsInstaller && (!installer || orgInstallers?.length !== 1 || orgInstallers[0].id !== installer)) {
        throw new Error('Select the correct installer in the completion form.');
      }
      await completeProductionOrder(row, installer, row.notes || '');
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['production-order-list', orgId] });
      queryClient.invalidateQueries({ queryKey: ['production-order-stats', orgId] });
      queryClient.invalidateQueries({ queryKey: ['production-order-detail'] });
      queryClient.invalidateQueries({ queryKey: ['production-order-tree', orgId] });
      queryClient.invalidateQueries({ queryKey: ['shops'] });
      queryClient.invalidateQueries({ queryKey: ['nav-pending-counts', orgId] });
    },
  });

  // Bulk status change (In Production / Ready / On Hold) — both roles can
  // use this; it never touches "completed" (that stays a deliberate,
  // per-batch decision via bulk complete below, never a drive-by status
  // pick that could skip installer assignment or the pending-boards
  // check).
  const [productionBatchProgress, setProductionBatchProgress] = useState<{ done: number; total: number } | null>(null);
  const [productionBatchResult, setProductionBatchResult] = useState<string | null>(null);
  const productionProgress = (done: number, total: number) => setProductionBatchProgress({ done, total });
  const refreshProductionBatch = () => {
    queryClient.invalidateQueries({ queryKey: ['production-order-list', orgId] });
    queryClient.invalidateQueries({ queryKey: ['production-order-tree', orgId] });
    queryClient.invalidateQueries({ queryKey: ['production-order-stats', orgId] });
    queryClient.invalidateQueries({ queryKey: ['shops'] });
    queryClient.invalidateQueries({ queryKey: ['dispatch-ready-shops', orgId] });
    queryClient.invalidateQueries({ queryKey: ['nav-pending-counts', orgId] });
  };
  const bulkStatusMutation = useMutation({
    mutationFn: ({ selected, status }: { selected: ProductionOrderRow[]; status: string }) =>
      runBoundedWorkflowBatch(selected, async row => {
        const { data: updated, error } = await supabase.from('production_orders').update({ status }).eq('id', row.production_order_id).eq('status', row.status).select('id');
        if (error) throw new Error(error.message);
        if (!updated?.length) throw new Error('Order status changed elsewhere; reload and retry this item.');
        await logAudit('production_orders', row.production_order_id, 'update', 'status', row.status, status, `Production ${status} for ${row.shop_name} (bulk)`);
      }, productionProgress),
    onSuccess: result => {
      setProductionBatchResult(summarizeWorkflowBatch(result, 'production statuses updated', row => row.shop_name));
      const succeeded = new Set(result.completed.map(row => row.production_order_id));
      setSelectedOrderIds(prev => new Set([...prev].filter(id => !succeeded.has(id))));
      if (result.failed.length) setBulkStatusOrders(result.failed.map(f => f.item));
      else setBulkStatusOrders(null);
    },
    onSettled: () => { setProductionBatchProgress(null); refreshProductionBatch(); },
  });

  const bulkCompleteMutation = useMutation({
    mutationFn: async ({ selected, installer }: { selected: ProductionOrderRow[]; installer: string }) => {
      const eligible = selected.filter(r => r.pending_boards === 0);
      const skipped = selected.filter(r => r.pending_boards > 0);
      if (!eligible.length) throw new Error('No selected orders are fully produced. Complete their pending boards first.');
      const result = await runBoundedWorkflowBatch(eligible, async row => {
        await completeProductionOrder(row, (row.fulfillment_type === 'supply_only' || row.requires_installation_all_false) ? '' : installer, '', false);
      }, productionProgress);
      return { result, skipped };
    },
    onSuccess: ({ result, skipped }) => {
      const summary = summarizeWorkflowBatch(result, 'production orders completed', row => row.shop_name);
      setProductionBatchResult(`${summary}${skipped.length ? ` ${skipped.length} unfinished orders remain selected.` : ''}`);
      const succeeded = new Set(result.completed.map(row => row.production_order_id));
      setSelectedOrderIds(prev => new Set([...prev].filter(id => !succeeded.has(id))));
      const remaining = [...skipped, ...result.failed.map(f => f.item)];
      if (remaining.length) setBulkCompleteOrders(remaining);
      else { setBulkCompleteOrders(null); setBulkInstallerId(''); }
    },
    onSettled: () => { setProductionBatchProgress(null); refreshProductionBatch(); },
  });

  const activeFilterCount = [clientFilter, campaignFilter, poFilter, zoneFilter, workTypeFilter, fulfillmentFilter, assignedFilter].filter(Boolean).length;
  function clearAllFilters() {
    setClientFilter('');
    setCampaignFilter('');
    setPoFilter('');
    setZoneFilter('');
    setWorkTypeFilter('');
    setFulfillmentFilter('');
    setAssignedFilter('');
    setBrowsingList(false);
  }
  // Typing a search term always shows results immediately, regardless of
  // how deep the folder tree is currently browsed to — searching for a
  // specific shop shouldn't require clicking through Campaign -> Work
  // Order -> Zone first. Clearing the search box falls back to whatever
  // browsingList was already set to.
  const showList = browsingList || !!debouncedSearch;

  return (
    <div>
      {linkedPoId && <div role="status" className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-900"><span>Production tasks filtered to the selected Work Order</span><button type="button" className="font-semibold text-blue-700 underline" onClick={() => setRouteParams(previous => { const next = new URLSearchParams(previous); next.delete('po'); return next; }, { replace: true })}>Show all Production work</button></div>}
      <PageHeader title="Production Studio" subtitle="What's ready, what's in production, and what's gone out — per board, per shop" />

      {/* Three screens, one flow — horizontal tabs, not a second sidebar.
          This page already lives inside the app's own left nav (which
          has its own "Production" entry); a second, page-level sidebar
          here read as two navigation systems stacked side by side. Every
          control lives in the single content column instead, same as
          every other page in this app (Survey Review, Installation
          Review, Design Studio). */}
      <div className="flex gap-1.5 mb-5 border-b border-slate-200 overflow-x-auto">
        {([
          { id: 'overview', label: 'Overview', icon: LayoutGrid },
          { id: 'production', label: 'Production', icon: Factory },
          { id: 'vehicle_load', label: 'Vehicle Load', icon: Truck },
        ] as const).map((t) => {
          const Icon = t.icon;
          const badge = t.id === 'vehicle_load'
            ? (vehicleLoadStats ? vehicleLoadStats.shops_not_loaded + vehicleLoadStats.shops_partial : undefined)
            : undefined;
          return (
            <button
              key={t.id}
              onClick={() => setMainView(t.id)}
              className={`shrink-0 flex items-center gap-2 px-4 py-2.5 text-sm font-semibold border-b-2 -mb-px transition ${
                mainView === t.id ? 'border-blue-600 text-blue-600' : 'border-transparent text-slate-500 hover:text-slate-700'
              }`}
            >
              <Icon className="w-4 h-4" />
              {t.label}
              {!!badge && <span className="ml-0.5 bg-red-100 text-red-700 text-[11px] font-bold px-1.5 py-0.5 rounded-full">{badge}</span>}
            </button>
          );
        })}
      </div>

      {mainView === 'overview' && (
        <ProductionOverviewTab
          stats={stats}
          vehicleLoadStats={vehicleLoadStats}
          onGoToProduction={(tabKey) => { setMainView('production'); if (tabKey) setActiveTab(tabKey); }}
          onGoToVehicleLoad={() => setMainView('vehicle_load')}
        />
      )}

      {mainView === 'vehicle_load' && (
        <VehicleLoadTab canLoad={canLogProduction} onGoToProduction={() => setMainView('production')} />
      )}

      {mainView === 'production' && (
      <>

      {/* Status tabs */}
      <div className="flex gap-1.5 overflow-x-auto pb-1 -mx-1 px-1 mb-3">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setActiveTab(t.key)}
            className={`shrink-0 px-3 py-1.5 rounded-lg text-sm font-medium border transition ${
              activeTab === t.key ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
            }`}
          >
            {t.label}
            {stats && t.statKey && <span className="opacity-75"> ({stats[t.statKey]})</span>}
          </button>
        ))}
      </div>

      {/* Work first. Folder navigation stays available without a four-level drill-down on each visit. */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2.5">
        <div className="flex items-center gap-1.5" role="group" aria-label="Production navigation mode">
          <button type="button" aria-pressed={browsingList} onClick={() => setBrowsingList(true)}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-semibold ${browsingList ? 'bg-blue-600 text-white' : 'text-slate-600 hover:bg-slate-100'}`}>
            <LayoutList className="h-4 w-4" /> Action Queue
          </button>
          <button type="button" aria-pressed={!browsingList} onClick={() => { setSearch(''); setDebouncedSearch(''); setBrowsingList(false); }}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-semibold ${!browsingList ? 'bg-blue-600 text-white' : 'text-slate-600 hover:bg-slate-100'}`}>
            <FolderTree className="h-4 w-4" /> Browse Folders
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {(clientFilter || campaignFilter || poFilter || zoneFilter) && !linkedPoId && (
            <button type="button" onClick={() => { setClientFilter(''); setCampaignFilter(''); setPoFilter(''); setZoneFilter(''); setBrowsingList(true); }}
              className="rounded-md px-2 py-1 text-xs font-semibold text-blue-700 hover:bg-blue-50">Clear folder scope</button>
          )}
          <p className="text-xs text-slate-500">Production tasks first; folders remain optional.</p>
        </div>
      </div>

      {/* Search + Filters — one compact row. Work Type/Fulfillment/
          Assigned/Sort open in a small popover from the "Filters"
          button rather than a permanent inline block, keeping this row
          the same height whether 0 or 4 filters are active. */}
      <div className="flex items-center gap-2 mb-4">
        <div className="relative flex-1">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by shop, client, city, phone, or PO number..."
            className="w-full pl-9 pr-3 py-2.5 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
          />
          {listFetching && !listLoading && <Loader2 className="w-3.5 h-3.5 text-slate-300 animate-spin absolute right-3 top-1/2 -translate-y-1/2" />}
        </div>
        <button
          onClick={() => setMobileFiltersOpen(true)}
          className={`shrink-0 flex items-center gap-1.5 px-3.5 py-2.5 rounded-lg text-sm font-medium border transition ${
            activeFilterCount > 0 ? 'bg-blue-50 border-blue-200 text-blue-700' : 'bg-white border-slate-300 text-slate-600 hover:border-slate-400'
          }`}
        >
          <Filter className="w-4 h-4" />
          Filters
          {activeFilterCount > 0 && (
            <span className="bg-blue-600 text-white text-[10px] font-bold min-w-[1.1rem] h-[1.1rem] px-1 rounded-full flex items-center justify-center">{activeFilterCount}</span>
          )}
        </button>
        <span className="hidden sm:inline text-xs text-slate-400 shrink-0">{totalCount} order{totalCount === 1 ? '' : 's'}</span>
      </div>

      {mobileFiltersOpen && (
        <Modal open onClose={() => setMobileFiltersOpen(false)} title="Filters">
          <div className="space-y-4">
            <LabeledSelect label="Fulfillment" value={fulfillmentFilter} onChange={setFulfillmentFilter}>
              <option value="">All types</option>
              <option value="survey_install">Survey & Installation</option>
              <option value="production_install">Production & Installation</option>
              <option value="supply_only">Production & Delivery</option>
            </LabeledSelect>
            <LabeledSelect label="Work Type" value={workTypeFilter} onChange={setWorkTypeFilter}>
              <option value="">All work types</option>
              {(workTypeOptions || []).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </LabeledSelect>
            {/* "Assigned To" is management-only — a production
                teammate's own session is already scoped to just their
                orders, so picking a different person here would be a
                no-op for them. */}
            {canApprove && (
              <LabeledSelect label="Assigned To" value={assignedFilter} onChange={setAssignedFilter}>
                <option value="">Everyone</option>
                {(productionTeam || []).map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}
              </LabeledSelect>
            )}
            <div className="flex items-center justify-between pt-3 border-t border-slate-100">
              <p className="text-xs text-slate-400">{totalCount} order{totalCount === 1 ? '' : 's'} match</p>
              {activeFilterCount > 0 && (
                <button onClick={clearAllFilters} className="flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-700">
                  <X className="w-3.5 h-3.5" /> Clear all ({activeFilterCount})
                </button>
              )}
            </div>
          </div>
        </Modal>
      )}

        {/* Breadcrumb — a plain text path bar (like Drive/GitHub), not a
            row of pill buttons: every level is a clickable text link,
            except the current/deepest one, which is bold and un-styled
            as a link since it's where you already are. Clicking it still
            works though — it steps back to that level's own tiles. */}
        {(!browsingList || clientFilter || campaignFilter || poFilter || zoneFilter) && <nav aria-label="Folder path" className="flex items-center gap-1.5 text-sm mb-5 flex-wrap text-slate-400">
          <button
            onClick={() => resetFolderFrom('root')}
            className={`flex items-center gap-1.5 ${!clientFilter ? 'font-semibold text-slate-900' : 'hover:text-blue-600 transition-colors'}`}
          >
            <FolderTree className="w-3.5 h-3.5" /> All Production
          </button>
          {clientFilter && (
            <>
              <span aria-hidden>/</span>
              <button
                onClick={() => resetFolderFrom('client')}
                className={`truncate max-w-[200px] ${!campaignFilter ? 'font-semibold text-slate-900' : 'hover:text-blue-600 transition-colors'}`}
              >
                {selectedClientName}
              </button>
            </>
          )}
          {campaignFilter && (
            <>
              <span aria-hidden>/</span>
              <button
                onClick={() => resetFolderFrom('campaign')}
                className={`truncate max-w-[200px] ${!poFilter ? 'font-semibold text-slate-900' : 'hover:text-blue-600 transition-colors'}`}
              >
                {selectedCampaignName}
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
          {browsingList && !zoneFilter && (clientFilter || campaignFilter || poFilter) && (
            <>
              <span aria-hidden>/</span>
              <button onClick={() => setBrowsingList(false)} className="font-semibold text-slate-900">
                All Items
              </button>
            </>
          )}
        </nav>}

        {(listIsError || statsIsError) && (
          <div className="mb-4 flex items-start gap-2 bg-red-50 border border-red-200 text-red-700 rounded-lg px-3 py-2.5 text-sm">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <div className="min-w-0">
              <p className="font-medium">Couldn't load the production list.</p>
              <p className="text-xs text-red-600/80 break-words">{((listQueryError || statsQueryError) as Error)?.message}</p>
            </div>
            <button onClick={() => refetchList()} className="ml-auto shrink-0 text-xs font-medium underline">Retry</button>
          </div>
        )}

        {/* FOLDER TILES — shown until a folder is actually opened all the
            way to a Zone (or "View all" is tapped to skip ahead). No
            list sits underneath these; opening a folder is what reveals
            it, so the production team is never looking at a long list
            they didn't ask to see yet. */}
        {!showList && (() => {
          const level = !clientFilter ? 'client' : !campaignFilter ? 'campaign' : !poFilter ? 'po' : 'zone';
          const levelLabel = level === 'client' ? 'Clients' : level === 'campaign' ? 'Campaigns' : level === 'po' ? 'Work Orders' : 'Zones';
          const folders = level === 'client' ? clientFolders : level === 'campaign' ? campaignFolders : level === 'po' ? poFolders : zoneFolders;
          const onPick = (id: string) => {
            if (level === 'client') setClientFilter(id);
            else if (level === 'campaign') setCampaignFilter(id);
            else if (level === 'po') setPoFilter(id);
            else { setZoneFilter(id); setBrowsingList(true); }
          };
          return (
            <div>
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
                <EmptyState icon={<FolderTree className="w-10 h-10" />} title="Nothing here" subtitle="No orders match the current status, search, or filters at this level." />
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
                        <span className="block text-xs text-slate-400 mt-0.5">
                          {f.count} order{f.count === 1 ? '' : 's'}
                          {f.materialsPending > 0 && <span className="text-red-500 font-medium"> · {f.materialsPending} need materials</span>}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })()}

        {/* LIST — bulk toolbar, per-board rows, pagination. Untouched
            from before, just now only rendered once a folder's actually
            been opened (or search/"View all" skipped ahead). */}
        {showList && (
        <>
        {/* List header — order count, and Sort now lives here (moved out
            of the sidebar since it's presentation for this list, not a
            filter) rather than being buried among filters that don't
            change what's showing, only its order. */}
        <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
          <p className="text-sm text-slate-500">
            <span className="font-semibold text-slate-900">{totalCount}</span> order{totalCount === 1 ? '' : 's'}
          </p>
          <label className="flex items-center gap-2 text-sm">
            <span className="text-slate-400">Sort</span>
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
              className="px-2.5 py-1.5 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none bg-white text-slate-700"
            >
              <option value="attention">Needs attention first</option>
              <option value="oldest">Oldest pending first</option>
              <option value="newest">Newest first</option>
              <option value="zone">Zone (for batching)</option>
              <option value="completion">% complete</option>
            </select>
          </label>
        </div>

        {quickLogError && <div role="alert" className="mb-3 flex items-center justify-between gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800"><span>{quickLogError}</span><button type="button" onClick={() => setQuickLogError(null)} className="underline font-semibold">Dismiss</button></div>}
        {instantCompleteMutation.isError && <div role="alert" className="mb-3 flex items-start justify-between gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800"><span>{(instantCompleteMutation.error as Error).message}</span><button type="button" className="font-semibold underline" onClick={() => instantCompleteMutation.reset()}>Dismiss</button></div>}
        {productionBatchResult && <div role="status" className="mb-3 flex items-start justify-between rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-900">
        <span>{productionBatchResult}</span><button type="button" onClick={() => setProductionBatchResult(null)} className="ml-3 font-semibold">Dismiss</button>
      </div>}
      {productionBatchProgress && <div role="status" aria-live="polite" className="mb-3 text-xs font-medium text-blue-700">Processing {productionBatchProgress.done}/{productionBatchProgress.total} orders…</div>}
      {rows.some(r => isRowSelectable(r)) && selectedOrderIds.size === 0 && (
        <div className="mb-3 flex justify-end">
          <button type="button" onClick={() => setSelectedOrderIds(new Set(rows.filter(r => isRowSelectable(r)).map(r => r.production_order_id)))}
            className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50">
            Select visible {rows.filter(r => isRowSelectable(r)).length} orders
          </button>
        </div>
      )}
      {/* Bulk toolbar */}
      {selectedOrderIds.size > 0 && (() => {
        const selected = rows.filter((r) => selectedOrderIds.has(r.production_order_id));
        return (
          <div className="mb-4 flex items-center gap-2 flex-wrap bg-indigo-50 border border-indigo-200 rounded-lg px-3 py-2.5">
            <span className="text-sm font-medium text-indigo-900">{selected.length} selected</span>
            <button type="button" disabled={!!productionBatchProgress} onClick={() => setSelectedOrderIds(new Set(rows.filter(r => isRowSelectable(r)).map(r => r.production_order_id)))}
              className="rounded-md bg-white border border-indigo-200 px-2 py-1 text-xs font-semibold text-indigo-700 disabled:opacity-50">Select visible</button>
            <button onClick={() => setSelectedOrderIds(new Set())} className="text-xs text-indigo-600 hover:underline">Clear</button>
            <div className="ml-auto flex items-center gap-2 flex-wrap">
              {canLogProduction && selected.some(row => row.pending_boards > 0 && !['completed', 'hold'].includes(row.status)) && (
                <button type="button"
                  onClick={() => {
                    const first = selected.find(row => row.pending_boards > 0 && !['completed', 'hold'].includes(row.status));
                    if (first) void openQuantityWorkbench(first);
                  }}
                  disabled={!!workbenchLoadingId || workbenchSaving || !!productionBatchProgress}
                  title="Process selected shops in order, one quantity sheet at a time; no bulk quantity assumptions"
                  className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50">
                  <Pencil className="w-3.5 h-3.5" /> Process selected shops
                </button>
              )}
              <button
                onClick={() => { setBulkStatusOrders(selected); setBulkStatus('in_production'); }}
                className="flex items-center gap-1 bg-white border border-indigo-200 text-indigo-700 px-2.5 py-1.5 rounded-lg text-xs font-medium"
              >
                <Send className="w-3.5 h-3.5" /> Change Status
              </button>
              {canApprove && (
                <button
                  onClick={() => {
                    const allReady = selected.length > 0 && selected.every(readyForDirectCompletion);
                    const requiresInstaller = selected.some(row => row.fulfillment_type !== 'supply_only' && !row.requires_installation_all_false);
                    if (allReady && (!requiresInstaller || orgInstallers?.length === 1)) {
                      bulkCompleteMutation.mutate({ selected, installer: requiresInstaller ? orgInstallers![0].id : '' });
                    } else {
                      setBulkCompleteOrders(selected);
                      setBulkInstallerId('');
                    }
                  }}
                  disabled={bulkCompleteMutation.isPending || !!productionBatchProgress}
                  title="Fully recorded and material-ready selections complete directly; all other selections require review"
                  className="flex items-center gap-1 bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-1.5 rounded-lg text-xs font-medium disabled:opacity-50"
                >
                  <PackageCheck className="w-3.5 h-3.5" /> Complete {selected.filter((r) => r.pending_boards === 0).length}
                </button>
              )}
            </div>
          </div>
        );
      })()}

      {/* Shop list */}
      <Card className="overflow-hidden">
        <div className="divide-y divide-slate-100">
          {listLoading && Array.from({ length: 4 }).map((_, i) => <RowSkeleton key={i} />)}

          {!listLoading && rows.map((row) => {
            const isOpen = expandedOrderId === row.production_order_id;
            const stageProgress = row.status === 'completed' ? 100 : row.progress_pct;
            return (
              <div key={row.production_order_id} className={`border-l-4 ${STATUS_BORDER[row.status] || 'border-l-slate-300'}`}>
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => toggleExpand(row)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleExpand(row); } }}
                  className="w-full text-left px-3 sm:px-4 py-3 flex flex-wrap sm:flex-nowrap items-center gap-2 sm:gap-3 hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500 transition cursor-pointer"
                >
                  {isRowSelectable(row) && (
                    <input
                      type="checkbox"
                      checked={selectedOrderIds.has(row.production_order_id)}
                      onChange={() => toggleOrderSelected(row.production_order_id)}
                      onClick={(e) => e.stopPropagation()}
                      className="shrink-0 w-4 h-4 rounded border-slate-300"
                    />
                  )}
                  <div className={`shrink-0 min-w-11 h-11 px-1 rounded-lg border flex flex-col items-center justify-center ${row.status === 'completed' ? 'bg-emerald-50 border-emerald-200' : 'bg-slate-50 border-slate-200'}`}
                    title={row.status === 'completed' ? (row.total_boards === 0 ? 'Production complete; no board-level records linked' : `Production completed · ${row.total_boards} board records linked`) : `${row.done_boards} of ${row.total_boards} production boards ready`}>
                    {row.status === 'completed' ? <CheckCircle2 className="w-5 h-5 text-emerald-600" /> : <span className="text-xs font-bold text-slate-700 leading-none">{row.total_boards ? `${row.done_boards}/${row.total_boards}` : '—'}</span>}
                    <span className={`text-[9px] mt-0.5 ${row.status === 'completed' ? 'text-emerald-700' : 'text-slate-500'}`}>{row.status === 'completed' ? 'Done' : row.total_boards ? 'boards' : 'no boards'}</span>
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-semibold text-slate-900 truncate">{row.shop_name}</p>
                      {row.zone_name && <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-purple-100 text-purple-700 shrink-0">{row.zone_name}</span>}
                      {row.fulfillment_type === 'supply_only' && (
                        <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-teal-100 text-teal-700 shrink-0">Supply Only</span>
                      )}
                      {row.requires_installation_all_false && (
                        <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-teal-100 text-teal-700 shrink-0">No Install Needed</span>
                      )}
                      {row.po_number && (
                        <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 shrink-0">{row.po_name ? `${row.po_name} (${row.po_number})` : `PO ${row.po_number}`}</span>
                      )}
                      {row.materials_pending_boards > 0 && (
                        <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-red-100 text-red-700 shrink-0 flex items-center gap-1">
                          <Boxes className="w-2.5 h-2.5" /> Materials pending
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-slate-500 truncate">
                      {row.client_name}{row.shop_city ? ` · ${row.shop_city}` : ''}
                      {canApprove && <span className="text-slate-400"> · Assigned: {row.assigned_name || 'Unassigned'}</span>}
                    </p>
                  </div>

                  <div className="hidden sm:block w-24 shrink-0">
                    <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
                      <div className={`h-1.5 transition-all ${stageProgress === 100 ? 'bg-emerald-500' : 'bg-blue-500'}`} style={{ width: `${stageProgress}%` }} />
                    </div>
                    <p className={`text-[10px] mt-1 text-right ${row.status === 'completed' ? 'font-semibold text-emerald-700' : 'text-slate-500'}`}>
                      {row.status === 'completed' ? '100% · stage done' : `${stageProgress}% · boards`}
                    </p>
                  </div>

                  {canLogProduction && row.pending_boards > 0 && !['completed', 'hold'].includes(row.status) && (
                    <button type="button" onClick={(event) => { event.stopPropagation(); void openQuantityWorkbench(row); }}
                      disabled={!!workbenchLoadingId || workbenchSaving || !!productionBatchProgress}
                      title="Open all boards and record actual produced quantities together"
                      className="shrink-0 inline-flex items-center gap-1 rounded-lg border border-blue-200 bg-blue-50 px-2.5 py-1.5 text-xs font-semibold text-blue-700 hover:bg-blue-100 disabled:opacity-50">
                      {workbenchLoadingId === row.production_order_id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Pencil className="h-3.5 w-3.5" />}
                      Record Qty
                    </button>
                  )}
                  {/* Quick status change — right here on the row, so
                      updating an order never requires opening it, scrolling
                      through its boards, and finding the button at the
                      bottom. That's the whole point of this redesign. */}
                  {row.status !== 'completed' && <button
                    onClick={(e) => {
                      e.stopPropagation();
                      const ready = canApprove && readyForDirectCompletion(row);
                      const needsInstaller = row.fulfillment_type !== 'supply_only' && !row.requires_installation_all_false;
                      if (ready && (!needsInstaller || orgInstallers?.length === 1)) {
                        instantCompleteMutation.mutate({ row, installer: needsInstaller ? orgInstallers![0].id : '' });
                        return;
                      }
                      openEditOrder(row);
                      if (ready) setForm({ notes: row.notes || '', status: 'completed', forceComplete: false });
                    }}
                    disabled={instantCompleteMutation.isPending || updateMutation.isPending || !!productionBatchProgress}
                    title={canApprove && readyForDirectCompletion(row)
                      ? (row.fulfillment_type === 'supply_only' || row.requires_installation_all_false || orgInstallers?.length === 1
                        ? 'Complete now using the existing server-side approval and handoff checks'
                        : 'Choose an installer and confirm completion')
                      : 'Update production status or open the order'}
                    className={`shrink-0 flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium text-white disabled:opacity-50 ${canApprove && readyForDirectCompletion(row) ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-blue-600 hover:bg-blue-700'}`}
                  >
                    {instantCompleteMutation.isPending && instantCompleteMutation.variables?.row.production_order_id === row.production_order_id
                      ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Completing</>
                      : canApprove && readyForDirectCompletion(row)
                        ? <><PackageCheck className="w-3.5 h-3.5" /> Complete{row.fulfillment_type === 'supply_only' || row.requires_installation_all_false || orgInstallers?.length === 1 ? ' now' : ''}</>
                        : <><Send className="w-3.5 h-3.5" /> Status</>}
                  </button>}

                  <StatusBadge status={row.status} />
                  <ChevronDown className={`w-4 h-4 text-slate-400 shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
                </div>

                {isOpen && (
                  <div className="px-4 pb-4 border-t border-slate-100 bg-slate-50/50">
                    <div className="flex flex-wrap gap-x-4 gap-y-1 pt-3 pb-3 text-xs text-slate-500">
                      {row.shop_address && (
                        <a href={mapsHref(row.shop_address)} target="_blank" rel="noreferrer" className="flex items-center gap-1 hover:text-blue-600 hover:underline">
                          <MapPin className="w-3.5 h-3.5" /> {row.shop_address}
                        </a>
                      )}
                      {row.shop_owner_name && <span className="flex items-center gap-1"><User className="w-3.5 h-3.5" /> {row.shop_owner_name}</span>}
                      {row.shop_contact_phone && (
                        <a href={telHref(row.shop_contact_phone)} className="flex items-center gap-1 font-medium text-blue-600 hover:underline">
                          <Phone className="w-3.5 h-3.5" /> {row.shop_contact_phone}
                        </a>
                      )}
                    </div>

                    {row.status === 'completed' && <div role="status" className="mb-3 flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
                      <CheckCircle2 className="h-4 w-4 shrink-0" />
                      <span>Production stage completed. {row.total_boards === 0 ? 'Board-level records are not linked to this shop; no quantities have been assumed.' : `Board records linked: ${row.total_boards}. Actual recorded quantities remain separate from stage completion.`} This record is read-only.</span>
                    </div>}
                    {detailLoading ? (
                      <div className="flex items-center gap-2 text-sm text-slate-400 py-6 justify-center">
                        <Loader2 className="w-4 h-4 animate-spin" /> Loading boards & materials…
                      </div>
                    ) : boards.length > 0 ? (
                      <div className="mb-3 border border-slate-200 rounded-lg overflow-hidden bg-white divide-y divide-slate-100">
                        {boards.map((entry) => {
                          const { item, targetQty, producedQty, isDone, isPartial, comps, componentsReady, qtyMet } = entry;
                          const locked = entry.locked || row.status === 'completed';
                          const isEditing = editingItem?.orderId === row.production_order_id && editingItem?.itemId === item.id;
                          // Auto-open the materials checklist for a board
                          // that's actually blocked on it, so the person
                          // sees exactly what's missing without an extra
                          // tap; a board with no issues stays collapsed.
                          const needsAttentionOpen = qtyMet && !componentsReady;
                          const bomOpen = expandedBom.has(item.id) || needsAttentionOpen;
                          const readyCount = comps.filter((c) => c.status === 'ready').length;
                          return (
                            <div key={item.id} id={`production-board-${item.id}`} className="px-3 py-2.5 text-sm scroll-mt-28">
                              <div className="flex items-center gap-2">
                                {locked ? (
                                  <CheckCircle2 className="w-4 h-4 text-teal-600 shrink-0" />
                                ) : isDone ? (
                                  <CheckCircle2 className="w-4 h-4 text-green-600 shrink-0" />
                                ) : isPartial ? (
                                  <MinusCircle className="w-4 h-4 text-amber-500 shrink-0" />
                                ) : (
                                  <Circle className="w-4 h-4 text-slate-300 shrink-0" />
                                )}
                                <div className="flex-1 min-w-0">
                                  <span className="font-medium text-slate-800">{item.work_type_name || 'Board'}</span>
                                  <span className="text-slate-400 ml-2">{[item.material, boardLabel(item).dims].filter(Boolean).join(' · ')}</span>
                                </div>
                                <span className={`text-xs px-2 py-0.5 rounded-full font-medium shrink-0 ${locked || isDone ? 'bg-green-100 text-green-700' : isPartial ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-500'}`}>
                                  {producedQty != null ? `${producedQty}/${targetQty}` : `0/${targetQty}`}
                                </span>
                                {canLogProduction && !locked && !isEditing && (
                                  <button onClick={() => openItemEditor(row.production_order_id, entry)} className="text-slate-400 hover:text-blue-600 shrink-0">
                                    <Pencil className="w-3.5 h-3.5" />
                                  </button>
                                )}
                              </div>

                              {needsAttentionOpen && !locked && (
                                <p className="ml-6 mt-1 text-xs text-amber-600 flex items-center gap-1">
                                  <AlertTriangle className="w-3 h-3 shrink-0" /> Quantity logged, but not marked produced yet — {comps.length - readyCount} component(s) still not ready.
                                </p>
                              )}

                              <button
                                onClick={() => toggleBom(item.id)}
                                className={`mt-2 ml-6 w-[calc(100%-1.5rem)] flex items-center justify-between gap-2 px-3 py-2 rounded-lg font-semibold text-sm border-2 transition ${
                                  comps.length === 0 ? 'bg-white text-slate-500 border-dashed border-slate-300 hover:border-blue-400 hover:text-blue-600' :
                                  componentsReady ? 'bg-green-50 text-green-700 border-green-300' : 'bg-amber-50 text-amber-700 border-amber-300'
                                }`}
                              >
                                <span className="flex items-center gap-2">
                                  <ListChecks className="w-4 h-4" />
                                  {comps.length === 0 ? 'Materials & Consumables — Add items' : `Materials & Consumables: ${readyCount}/${comps.length} ready — Tap to update`}
                                </span>
                                {bomOpen ? <ChevronDown className="w-4 h-4 rotate-180" /> : <ChevronDown className="w-4 h-4" />}
                              </button>

                              {bomOpen && (
                                <div className="mt-2 ml-6 bg-slate-50 border-2 border-slate-200 rounded-lg p-3 space-y-2">
                                  {!canLogProduction && (
                                    <p className="text-xs font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2 py-1.5">
                                      View only — your account role can't update materials.
                                    </p>
                                  )}
                                  {locked && (
                                    <p className="text-xs font-medium text-teal-700 bg-teal-50 border border-teal-200 rounded-md px-2 py-1.5">
                                      This board is already completed, so materials are locked.
                                    </p>
                                  )}
                                  {comps.length === 0 && (
                                    <p className="text-sm text-slate-500">No materials added yet. Add each item below (e.g. Frame, Vinyl print, Nails, Packing).</p>
                                  )}
                                  {(['component', 'consumable'] as const).map((grp) => {
                                    const grpComps = comps.filter((c) => (c.source || 'component') === grp);
                                    if (grpComps.length === 0) return null;
                                    return (
                                      <div key={grp} className="space-y-1.5">
                                        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 pt-1">{grp === 'component' ? 'Components' : 'Consumables'}</p>
                                        {grpComps.map((c) => {
                                          const rowBusy = setComponentStatusMutation.isPending && setComponentStatusMutation.variables?.component.id === c.id;
                                          const rowError = componentError[c.id];
                                          return (
                                            <div key={c.id} className="bg-white border border-slate-200 rounded-md px-2.5 py-2 space-y-1.5">
                                              <div className="flex items-center gap-2">
                                                <span className="flex-1 min-w-0 text-sm font-medium text-slate-800 truncate">
                                                  {c.component_name}
                                                  {c.required_qty != null && <span className="text-slate-400 font-normal"> · qty {c.required_qty}</span>}
                                                </span>
                                                {canLogProduction && !locked && (
                                                  <button onClick={() => deleteComponentMutation.mutate(c)} disabled={deleteComponentMutation.isPending} className="text-slate-300 hover:text-red-500 shrink-0 p-1">
                                                    <Trash2 className="w-4 h-4" />
                                                  </button>
                                                )}
                                              </div>
                                              <div className="flex items-center gap-1.5">
                                                {COMPONENT_STATUSES.map((s) => {
                                                  const active = c.status === s.value;
                                                  return (
                                                    <button
                                                      key={s.value}
                                                      onClick={() => canLogProduction && !locked && setComponentStatusMutation.mutate({ component: c, status: s.value })}
                                                      disabled={!canLogProduction || locked || rowBusy}
                                                      className={`flex-1 text-sm px-2 py-2 rounded-lg font-semibold border-2 transition ${
                                                        active
                                                          ? s.value === 'ready' ? 'bg-green-600 text-white border-green-600' : s.value === 'in_progress' ? 'bg-amber-500 text-white border-amber-500' : 'bg-slate-400 text-white border-slate-400'
                                                          : 'bg-white text-slate-500 border-slate-200'
                                                      } ${canLogProduction && !locked ? 'hover:opacity-90 active:scale-95 cursor-pointer' : 'cursor-not-allowed opacity-60'}`}
                                                    >
                                                      {rowBusy && active ? '...' : s.label}
                                                    </button>
                                                  );
                                                })}
                                              </div>
                                              {rowError && <p className="text-xs text-red-600">{rowError}</p>}
                                            </div>
                                          );
                                        })}
                                      </div>
                                    );
                                  })}
                                  {canLogProduction && !locked && (
                                    <div className="flex items-center gap-1.5 pt-1 flex-wrap">
                                      <select
                                        value={newComponentSource[item.id] || 'component'}
                                        onChange={(e) => setNewComponentSource((prev) => ({ ...prev, [item.id]: e.target.value as 'component' | 'consumable' }))}
                                        className="px-2 py-2 border border-slate-300 rounded-md text-sm outline-none focus:ring-2 focus:ring-blue-500"
                                      >
                                        <option value="component">Component</option>
                                        <option value="consumable">Consumable</option>
                                      </select>
                                      <input
                                        type="text"
                                        value={newComponentName[item.id] || ''}
                                        onChange={(e) => setNewComponentName((prev) => ({ ...prev, [item.id]: e.target.value }))}
                                        placeholder="Material name (e.g. Frame)"
                                        className="flex-1 min-w-0 px-3 py-2 border border-slate-300 rounded-md text-sm outline-none focus:ring-2 focus:ring-blue-500"
                                      />
                                      <input
                                        type="number"
                                        min="0"
                                        value={newComponentQty[item.id] || ''}
                                        onChange={(e) => setNewComponentQty((prev) => ({ ...prev, [item.id]: e.target.value }))}
                                        placeholder="Qty"
                                        className="w-20 px-3 py-2 border border-slate-300 rounded-md text-sm outline-none focus:ring-2 focus:ring-blue-500"
                                      />
                                      <button
                                        onClick={() => addComponentMutation.mutate({ item })}
                                        disabled={addComponentMutation.isPending || !(newComponentName[item.id] || '').trim()}
                                        className="bg-blue-600 text-white rounded-md px-3 py-2 disabled:opacity-50 shrink-0 flex items-center gap-1 text-sm font-medium"
                                      >
                                        <Plus className="w-4 h-4" /> Add
                                      </button>
                                    </div>
                                  )}
                                  {addComponentMutation.isError && <p className="text-xs text-red-600">{(addComponentMutation.error as Error).message}</p>}
                                </div>
                              )}

                              {isEditing && (
                                <div className="mt-2 ml-6 flex flex-wrap items-end gap-2 bg-slate-50 rounded-lg p-2">
                                  <div className="w-28">
                                    <label className="block text-xs text-slate-500 mb-0.5">Produced Qty</label>
                                    <input type="number" min="0" value={itemQty} onChange={(e) => setItemQty(e.target.value)} className="w-full px-2 py-1.5 border border-slate-300 rounded-md text-sm outline-none focus:ring-2 focus:ring-blue-500" />
                                  </div>
                                  <div className="flex-1 min-w-[140px]">
                                    <label className="block text-xs text-slate-500 mb-0.5">Notes</label>
                                    <input type="text" value={itemNotes} onChange={(e) => setItemNotes(e.target.value)} placeholder="Optional" className="w-full px-2 py-1.5 border border-slate-300 rounded-md text-sm outline-none focus:ring-2 focus:ring-blue-500" />
                                  </div>
                                  <button
                                    onClick={() => logProductionMutation.mutate({ row, item, record: entry.record, componentsReady: entry.componentsReady })}
                                    disabled={logProductionMutation.isPending}
                                    className="bg-blue-600 text-white rounded-md p-1.5 disabled:opacity-50"
                                  >
                                    <Check className="w-4 h-4" />
                                  </button>
                                  <button onClick={() => setEditingItem(null)} className="bg-slate-200 text-slate-600 rounded-md p-1.5"><X className="w-4 h-4" /></button>
                                </div>
                              )}
                              {isEditing && logProductionMutation.isError && <p className="text-xs text-red-600 mt-1 ml-6">{(logProductionMutation.error as Error).message}</p>}
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <p className="text-xs text-slate-500 mb-3 italic">{row.status === 'completed' ? 'Production is completed, but no board-level records are available for this shop.' : 'No production boards found for this shop yet.'}</p>
                    )}

                    <div className="flex gap-2">
                      <Link to={`/shops/${row.shop_id}`} className="text-sm text-blue-600 hover:underline mr-auto flex items-center gap-1">
                        Shop Details <ChevronRight className="w-4 h-4" />
                      </Link>
                      {row.status !== 'completed' && <button onClick={() => openEditOrder(row)} className="bg-blue-600 text-white px-3 py-1.5 rounded-lg text-sm font-medium">
                        Update Order Status
                      </button>}
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          {!listLoading && rows.length === 0 && (
            <EmptyState
              icon={<Printer className="w-12 h-12" />}
              title="No production orders"
              subtitle={totalCount === 0 && activeTab === 'all' && !debouncedSearch ? 'Approved designs will appear here for production' : 'Nothing matches this filter/search'}
            />
          )}
        </div>

        {totalCount > 0 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-slate-100 text-sm">
            <p className="text-xs text-slate-500 flex items-center gap-1.5">
              <select aria-label="Tasks per page" value={pageSize} onChange={event => { setPageSize(Number(event.target.value)); setPage(0); setSelectedOrderIds(new Set()); }} className="mr-2 rounded border border-slate-200 bg-white px-1.5 py-1 text-xs text-slate-700">
                <option value={20}>20/page</option><option value={50}>50/page</option><option value={100}>100/page</option>
              </select> <LayoutList className="w-3.5 h-3.5" /> Showing {page * pageSize + 1}–{Math.min(totalCount, page * pageSize + pageSize)} of {totalCount}
            </p>
            <div className="flex items-center gap-2">
              <button onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0 || listFetching} className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-200 text-slate-600 text-xs font-medium disabled:opacity-40 hover:bg-slate-50">
                <ChevronLeft className="w-3.5 h-3.5" /> Prev
              </button>
              <span className="text-xs text-slate-400">Page {page + 1} of {pageCount}</span>
              <button onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))} disabled={page >= pageCount - 1 || listFetching} className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-200 text-slate-600 text-xs font-medium disabled:opacity-40 hover:bg-slate-50">
                Next <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        )}
      </Card>
      </>
      )}

      {/* Multi-board quantity workbench — one shop, one save, with selective retry. */}
      <Modal open={!!quantityWorkbench} onClose={() => { if (!workbenchSaving) setQuantityWorkbench(null); }} title="Record Production — All Boards" size="lg">
        {quantityWorkbench && (
          <div className="space-y-3" onKeyDown={event => {
            // Desktop quick flow; Enter alone keeps the normal quantity input behavior.
            if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !workbenchSaving) {
              event.preventDefault();
              void saveWorkbenchQuantities('next');
            }
          }}>
            <div className="rounded-lg bg-slate-50 border border-slate-200 px-3 py-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-semibold text-slate-900">Production sheet · {quantityWorkbench.boards.length} work items</p>
                <span className="text-xs text-slate-600 tabular-nums">
                  {quantityWorkbench.boards.filter(board => board.locked || (workbenchValues[board.item.id] !== '' && Number(workbenchValues[board.item.id]) >= board.targetQty)).length}/{quantityWorkbench.boards.length} quantity targets recorded
                </span>
              </div>
              <p className="text-xs text-slate-500">{quantityWorkbench.row.shop_name} · {quantityWorkbench.row.po_number || 'Work Order'} · {quantityWorkbench.row.client_name || 'Client'}</p>
              {selectedOrderIds.has(quantityWorkbench.row.production_order_id) && (
                <p className="text-[11px] font-medium text-blue-700">Focused workset · {selectedOrderIds.size} selected shops · Save & next stays within this selection</p>
              )}
            </div>
            <p className="text-xs text-slate-600">Match each <strong>work type + size</strong> to approved artwork. Record actual production quantities; planned quantities are for reference.</p>
            {workbenchArtwork.warning && <p role="alert" className="text-xs rounded-lg border border-amber-200 bg-amber-50 text-amber-800 px-3 py-2">{workbenchArtwork.warning} — open the Design review before using an unverified file.</p>}
            <div className="max-h-[55vh] overflow-y-auto divide-y divide-slate-100 border border-slate-200 rounded-lg">
              {quantityWorkbench.boards.map((board, index) => {
                const id = board.item.id;
                const disabled = board.locked;
                const actual = workbenchValues[id] ?? '';
                const mappedArtwork = workbenchArtwork.byItem[id] || [];
                const design = mappedArtwork[0];
                const dimension = boardLabel(board.item).dims || 'Size not recorded';
                return <div key={id} className="p-3 sm:p-4 space-y-2">
                  <div className="flex justify-between gap-2 items-start">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-slate-900">{board.item.work_type_name || 'Work Item'} <span className="text-blue-700">· {dimension}</span></p>
                      <p className="text-xs text-slate-500">Work item {index + 1} · {board.item.material || 'Material not specified'} · Planned {board.targetQty} · Recorded {board.producedQty ?? '—'}</p>
                    </div>
                    <span className={`text-[11px] rounded-full px-2 py-0.5 font-medium shrink-0 ${disabled ? 'bg-emerald-100 text-emerald-700' : board.componentsReady ? 'bg-slate-100 text-slate-600' : 'bg-amber-100 text-amber-800'}`}>
                      {disabled ? 'Locked' : board.componentsReady ? 'Materials ready' : 'Materials pending'}
                    </span>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_auto] gap-3 items-center">
                    <div className="flex items-center gap-3 min-w-0 rounded-lg border border-slate-200 bg-slate-50 px-2 py-2">
                      {design && artworkIsImage(design) ? <img src={design.file_url} alt={`Approved artwork for ${board.item.work_type_name || 'work item'} ${dimension}`} loading="lazy" className="w-14 h-12 object-contain bg-white rounded border border-slate-200 shrink-0" /> :
                        <div className="w-14 h-12 shrink-0 flex items-center justify-center rounded bg-white border border-slate-200 text-slate-400"><Layers className="w-5 h-5" /></div>}
                      <div className="min-w-0 flex-1">
                        {design ? <>
                          <a href={design.file_url} target="_blank" rel="noopener noreferrer" className="text-xs font-medium text-blue-700 hover:underline break-all line-clamp-2" title={design.file_name || 'View approved design'}>{design.file_name || `Approved artwork v${design.version_number}`}</a>
                          <p className="text-[11px] text-emerald-700">Approved design{mappedArtwork.length > 1 ? ` · ${mappedArtwork.length} linked` : ''}</p>
                          {mappedArtwork.length > 1 && <div className="flex flex-wrap gap-x-2 gap-y-1 mt-1">
                            {mappedArtwork.slice(1, 4).map((file, fileIndex) => <a key={file.id} href={file.file_url} target="_blank" rel="noopener noreferrer" className="text-[11px] text-blue-700 underline" title={file.file_name || 'Approved design'}>
                              {file.file_name || `Other artwork ${fileIndex + 2}`}
                            </a>)}
                            {mappedArtwork.length > 4 && <span className="text-[11px] text-slate-500">+{mappedArtwork.length - 4} more in Design Studio</span>}
                          </div>}
                        </> : <>
                          <p className="text-xs font-medium text-slate-600">No approved artwork linked</p>
                          <p className="text-[11px] text-slate-400">Valid for work without a design stage; otherwise check Design review</p>
                        </>}
                      </div>
                    </div>
                    <div className="flex items-end gap-2">
                      <label className="text-xs text-slate-600 font-medium flex flex-col gap-1">
                        Actual produced
                        <input aria-label={`Actual produced quantity for ${board.item.work_type_name || 'work item'} ${dimension}`} type="number" min="0" step="1"
                          value={actual} disabled={disabled || workbenchSaving}
                          onChange={event => { setWorkbenchValues(prev => ({ ...prev, [id]: event.target.value })); setWorkbenchErrors(prev => { const next = { ...prev }; delete next[id]; return next; }); }}
                          className="w-24 rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm text-slate-900 focus:ring-2 focus:ring-blue-500" />
                      </label>
                      {!disabled && <button type="button" disabled={workbenchSaving} onClick={() => setWorkbenchValues(prev => ({ ...prev, [id]: String(board.targetQty) }))}
                        className="text-xs font-medium text-blue-700 border border-blue-200 rounded-lg px-2 py-2 hover:bg-blue-50 disabled:opacity-50"
                        title="Use only when the full planned quantity was actually produced">Use plan</button>}
                    </div>
                  </div>
                  {!board.componentsReady && !disabled && <p className="text-xs text-amber-700">Materials incomplete — record quantity now; final completion remains blocked.</p>}
                  {workbenchErrors[id] && <p role="alert" className="text-xs text-red-700">{workbenchErrors[id]}</p>}
                </div>;
              })}
            </div>
            <div className="flex flex-wrap justify-between items-center gap-2">
              {quantityWorkbench.boards.some(board => !board.locked && workbenchValues[board.item.id] === '') &&
                quantityWorkbench.boards.every(board => board.locked || workbenchValues[board.item.id] !== '' || hasRecordedProductionPlan(board.item)) && (
                <button type="button" disabled={workbenchSaving} onClick={() => void saveWorkbenchQuantities('next', true)}
                  className="text-xs font-semibold text-blue-700 border border-blue-200 hover:bg-blue-50 rounded-lg px-3 py-2 disabled:opacity-50"
                  title="Only if you actually produced the full planned quantities for every blank board; saved values and other edits are preserved">
                  Confirm blanks as produced · Save & next
                </button>
              )}
              <span className="text-xs text-slate-500" aria-live="polite">{quantityWorkbench.boards.filter(board => !board.locked && workbenchValues[board.item.id] !== workbenchBaseline[board.item.id]).length} changed</span>
            </div>
            {workbenchMessage && <p role="status" className="text-xs text-amber-700 bg-amber-50 rounded-lg p-2">{workbenchMessage}</p>}
            {canApprove && quantityWorkbench.boards.every(board => board.locked || (
              board.componentsReady && Number.isSafeInteger(Number(workbenchValues[board.item.id])) &&
              (workbenchValues[board.item.id] || '').trim() !== '' && Number(workbenchValues[board.item.id]) >= board.targetQty
            )) && quantityWorkbench.row.fulfillment_type !== 'supply_only' && !quantityWorkbench.row.requires_installation_all_false && (orgInstallers?.length || 0) > 1 && (
              <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">Assign Installer for handoff
                <select value={workbenchInstaller} disabled={workbenchSaving} onChange={e => setWorkbenchInstaller(e.target.value)} className="border border-slate-200 rounded-lg px-3 py-2 text-sm bg-white">
                  <option value="">Choose Installer</option>
                  {(orgInstallers || []).map(person => <option key={person.id} value={person.id}>{person.full_name}</option>)}
                </select>
              </label>
            )}
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-3">
              <span className="text-[11px] text-slate-400 hidden sm:inline">Ctrl / ⌘ + Enter: Save & next</span>
              <div className="flex flex-wrap justify-end gap-2">
              <button type="button" disabled={workbenchSaving} onClick={() => setQuantityWorkbench(null)} className="border border-slate-200 rounded-lg px-3 py-2 text-xs font-medium">Close</button>
              <button type="button" disabled={workbenchSaving || !quantityWorkbench.boards.some(board => !board.locked && workbenchValues[board.item.id] !== workbenchBaseline[board.item.id])}
                onClick={() => void saveWorkbenchQuantities('save')} className="rounded-lg border border-slate-200 bg-white text-slate-700 font-semibold px-3 py-2 text-xs disabled:opacity-50">
                Save only
              </button>
              <button type="button" disabled={workbenchSaving} onClick={() => void saveWorkbenchQuantities('next')}
                className="rounded-lg bg-blue-600 hover:bg-blue-700 text-white px-3 py-2 text-xs font-semibold disabled:opacity-50">
                {workbenchSaving ? 'Saving…' : selectedOrderIds.has(quantityWorkbench.row.production_order_id) ? 'Save & next selected' : 'Save & next shop'}
              </button>
              {canApprove && quantityWorkbench.boards.every(board => board.locked || (
                board.componentsReady && Number.isSafeInteger(Number(workbenchValues[board.item.id])) &&
                (workbenchValues[board.item.id] || '').trim() !== '' && Number(workbenchValues[board.item.id]) >= board.targetQty
              )) && <button type="button" disabled={workbenchSaving || (
                quantityWorkbench.row.fulfillment_type !== 'supply_only' && !quantityWorkbench.row.requires_installation_all_false &&
                !(workbenchInstaller || orgInstallers?.length === 1))}
                onClick={() => void saveWorkbenchQuantities('complete')}
                className="rounded-lg bg-emerald-700 text-white font-semibold px-3 py-2 text-xs disabled:opacity-50">
                Save & complete <Check className="w-3 h-3 inline" />
              </button>}
              </div>
            </div>
          </div>
        )}
      </Modal>

      {/* Single-order status update */}
      <Modal open={!!editOrder} onClose={() => setEditOrder(null)} title="Update Production Order">
        <div className="space-y-4">
          <p className="text-sm text-slate-600">Shop: <span className="font-medium text-slate-900">{editOrder?.shop_name}</span></p>
          <Select
            label="Status"
            value={form.status}
            onChange={(v) => setForm({ ...form, status: v, forceComplete: false })}
            options={[
              { value: 'pending', label: 'Pending' },
              { value: 'in_production', label: 'In Production' },
              { value: 'ready', label: 'Ready' },
              { value: 'hold', label: 'On Hold' },
              ...(canApprove && ['in_production', 'ready'].includes(editOrder?.status || '') ? [{ value: 'completed', label: 'Completed (Approve & Notify Installer)' }] : []),
            ]}
          />
          {!canApprove && <p className="text-xs text-slate-400 -mt-2">Only the Agency Owner or Admin can mark production as completed.</p>}
          {isCompleting && (
            <>
              {editOrder && editOrder.pending_boards > 0 && (
                <label className="flex items-start gap-2 text-sm bg-amber-50 border border-amber-200 rounded-lg p-3">
                  <input type="checkbox" checked={form.forceComplete} onChange={(e) => setForm({ ...form, forceComplete: e.target.checked })} className="mt-0.5 rounded border-slate-300" />
                  <span className="text-amber-800">{editOrder.pending_boards} of {editOrder.total_boards} board(s) have no production logged yet. Mark completed anyway.</span>
                </label>
              )}
              {isSupplyOnly ? (
                <p className="text-xs text-teal-700 bg-teal-50 border border-teal-200 rounded-lg p-3">
                  Supply Only order — no installer needed. Marking this completed makes it ready for packing & zone-wise dispatch from the Supply Orders page.
                </p>
              ) : editOrder?.requires_installation_all_false ? (
                <p className="text-xs text-teal-700 bg-teal-50 border border-teal-200 rounded-lg p-3">
                  This PO line item doesn't require installation — no installer needed. Marking this completed sends it straight to Billing.
                </p>
              ) : (
                <>
                  <Select
                    label="Assign Installer"
                    value={effectiveInstallerId}
                    onChange={setInstallerId}
                    options={[{ value: '', label: 'Select an installer...' }, ...(orgInstallers || []).map((i) => ({ value: i.id, label: i.full_name }))]}
                    required
                  />
                  {orgInstallers && orgInstallers.length === 0 && (
                    <p className="text-xs text-amber-600">No active installers found in your organization. Add one from Owner Console → Users first.</p>
                  )}
                </>
              )}
            </>
          )}
          <Textarea label="Order Notes" value={form.notes} onChange={(v) => setForm({ ...form, notes: v })} rows={2} />
          {updateMutation.isError && <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-2">{(updateMutation.error as Error).message}</p>}
          <button
            onClick={() => updateMutation.mutate()}
            disabled={updateMutation.isPending || (isCompleting && !effectiveInstallerId && !skipsInstaller)}
            className="w-full bg-blue-600 text-white font-medium py-2.5 rounded-lg disabled:opacity-50"
          >
            {updateMutation.isPending ? 'Updating...' : 'Update'}
          </button>
        </div>
      </Modal>

      {/* Bulk status change */}
      <Modal open={!!bulkStatusOrders} onClose={() => { if (!bulkStatusMutation.isPending) setBulkStatusOrders(null); }} title="Change Status">
        <div className="space-y-4">
          <div>
            <p className="text-sm text-slate-600 mb-1.5">Updating <span className="font-medium text-slate-900">{bulkStatusOrders?.length}</span> order(s):</p>
            <div className="max-h-32 overflow-y-auto border border-slate-200 rounded-lg divide-y divide-slate-100">
              {bulkStatusOrders?.map((r) => <p key={r.production_order_id} className="text-xs text-slate-600 px-2.5 py-1.5">{r.shop_name}</p>)}
            </div>
          </div>
          <Select
            label="New Status"
            value={bulkStatus}
            onChange={(v) => setBulkStatus(v as typeof bulkStatus)}
            options={[
              { value: 'in_production', label: 'In Production' },
              { value: 'ready', label: 'Ready' },
              { value: 'hold', label: 'On Hold' },
            ]}
          />
          <p className="text-xs text-slate-400">To mark orders completed, use "Complete" from the selection toolbar instead — it needs an installer and checks each order's boards individually.</p>
          {bulkStatusMutation.isError && <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-2">{(bulkStatusMutation.error as Error).message}</p>}
          <button
            onClick={() => bulkStatusOrders && bulkStatusMutation.mutate({ selected: bulkStatusOrders, status: bulkStatus })}
            disabled={bulkStatusMutation.isPending || !!productionBatchProgress}
            className="w-full bg-blue-600 text-white font-medium py-2.5 rounded-lg disabled:opacity-50"
          >
            {bulkStatusMutation.isPending ? 'Updating...' : `Update ${bulkStatusOrders?.length || ''} Order(s)`}
          </button>
        </div>
      </Modal>

      {/* Bulk complete */}
      <Modal open={!!bulkCompleteOrders} onClose={() => { if (!bulkCompleteMutation.isPending) { setBulkCompleteOrders(null); setBulkInstallerId(''); } }} title="Complete Production">
        <div className="space-y-4">
          {(() => {
            const eligible = (bulkCompleteOrders || []).filter((r) => r.pending_boards === 0);
            const skipped = (bulkCompleteOrders || []).filter((r) => r.pending_boards > 0);
            const anyNeedsInstaller = eligible.some((r) => r.fulfillment_type !== 'supply_only' && !r.requires_installation_all_false);
            return (
              <>
                <div>
                  <p className="text-sm text-slate-600 mb-1.5">
                    <span className="font-medium text-slate-900">{eligible.length}</span> of {bulkCompleteOrders?.length} order(s) are fully produced and will be completed:
                  </p>
                  <div className="max-h-32 overflow-y-auto border border-slate-200 rounded-lg divide-y divide-slate-100">
                    {eligible.map((r) => <p key={r.production_order_id} className="text-xs text-slate-600 px-2.5 py-1.5">{r.shop_name}</p>)}
                  </div>
                </div>
                {skipped.length > 0 && (
                  <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-2.5">
                    Skipped — still has boards with no production logged: {skipped.map((s) => s.shop_name).join(', ')}. Log those first, or complete them individually.
                  </p>
                )}
                {anyNeedsInstaller ? (
                  <>
                    <Select
                      label="Assign Installer (applied to all)"
                      value={effectiveBulkInstallerId}
                      onChange={setBulkInstallerId}
                      options={[{ value: '', label: 'Select an installer...' }, ...(orgInstallers || []).map((i) => ({ value: i.id, label: i.full_name }))]}
                      required
                    />
                    {orgInstallers && orgInstallers.length === 0 && (
                      <p className="text-xs text-amber-600">No active installers found. Add one from Owner Console → Users first.</p>
                    )}
                  </>
                ) : (
                  <p className="text-xs text-teal-700 bg-teal-50 border border-teal-200 rounded-lg p-3">None of the eligible orders here need an installer (Supply Only, or installation not required for that PO line item).</p>
                )}
                {bulkCompleteMutation.isError && <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-2">{(bulkCompleteMutation.error as Error).message}</p>}
                <button
                  onClick={() => bulkCompleteOrders && bulkCompleteMutation.mutate({ selected: bulkCompleteOrders, installer: effectiveBulkInstallerId })}
                  disabled={bulkCompleteMutation.isPending || !!productionBatchProgress || eligible.length === 0 || (anyNeedsInstaller && !effectiveBulkInstallerId)}
                  className="w-full bg-emerald-600 hover:bg-emerald-700 text-white font-medium py-2.5 rounded-lg disabled:opacity-50"
                >
                  {bulkCompleteMutation.isPending ? 'Completing...' : `Complete ${eligible.length} Order(s)`}
                </button>
              </>
            );
          })()}
        </div>
      </Modal>
      </>
      )}
    </div>
  );
}

const STAT_TONE: Record<string, { text: string; iconBg: string }> = {
  slate: { text: 'text-slate-700', iconBg: 'bg-slate-100 text-slate-500' },
  amber: { text: 'text-amber-600', iconBg: 'bg-amber-100 text-amber-600' },
  red: { text: 'text-red-600', iconBg: 'bg-red-100 text-red-600' },
  orange: { text: 'text-orange-600', iconBg: 'bg-orange-100 text-orange-600' },
  blue: { text: 'text-blue-600', iconBg: 'bg-blue-100 text-blue-600' },
  emerald: { text: 'text-emerald-600', iconBg: 'bg-emerald-100 text-emerald-600' },
};

function StatCard({ label, value, tone, icon, sublabel, onClick }: {
  label: string; value: number | undefined; tone: keyof typeof STAT_TONE; icon?: ReactNode; sublabel?: string; onClick?: () => void;
}) {
  const t = STAT_TONE[tone] || STAT_TONE.slate;
  return (
    <Card className={`p-3.5 flex items-start justify-between gap-2 ${onClick ? 'cursor-pointer hover:shadow-md hover:-translate-y-0.5 transition' : ''}`} onClick={onClick}>
      <div className="min-w-0">
        <p className={`text-2xl font-bold ${t.text}`}>{value ?? '–'}</p>
        <p className="text-xs font-medium text-slate-500 mt-0.5">{label}</p>
        {sublabel && <p className="text-[11px] text-slate-400 mt-0.5">{sublabel}</p>}
      </div>
      {icon && <div className={`shrink-0 rounded-lg p-1.5 ${t.iconBg}`}>{icon}</div>}
    </Card>
  );
}

function LabeledSelect({ label, value, onChange, children }: { label: string; value: string; onChange: (v: string) => void; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <label className="block text-[11px] font-medium text-slate-500 mb-1 truncate">{label}</label>
      <select value={value} onChange={(e) => onChange(e.target.value)} className="w-full px-2.5 py-1.5 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none bg-white">
        {children}
      </select>
    </div>
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
      <div className="hidden sm:block w-24 h-1.5 bg-slate-100 rounded-full shrink-0" />
      <div className="w-16 h-5 bg-slate-100 rounded-full shrink-0" />
    </div>
  );
}

// ============================================================
// Overview — the "at a glance" screen. Pulls together Production's own
// counters and the Vehicle Load counters so Owner/Admin/Production see
// one honest picture: how much is ready, how much has actually gone out
// in a vehicle, and how much of that gap still needs attention — without
// having to open two different pages.
// ============================================================
function ProductionOverviewTab({
  stats, vehicleLoadStats, onGoToProduction, onGoToVehicleLoad,
}: {
  stats: ProductionStats | undefined;
  vehicleLoadStats: VehicleLoadStats | undefined;
  onGoToProduction: (tabKey?: string) => void;
  onGoToVehicleLoad: () => void;
}) {
  const needsLoadAttention = (vehicleLoadStats?.shops_not_loaded ?? 0) + (vehicleLoadStats?.shops_partial ?? 0);
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-sm font-semibold text-slate-700 mb-2.5 flex items-center gap-1.5"><Factory className="w-4 h-4 text-slate-400" /> Production</h2>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-3">
          <StatCard label="Pending Orders" value={stats?.pending} tone="slate" icon={<Clock className="w-4 h-4" />} onClick={() => onGoToProduction('pending')} />
          <StatCard label="In Production" value={stats?.in_production} tone="orange" icon={<Factory className="w-4 h-4" />} onClick={() => onGoToProduction('in_production')} />
          <StatCard label="Ready" value={stats?.ready} tone="blue" icon={<CheckCircle className="w-4 h-4" />} onClick={() => onGoToProduction('ready')} />
          <StatCard label="Completed" value={stats?.completed} tone="emerald" icon={<CheckCircle2 className="w-4 h-4" />} onClick={() => onGoToProduction('completed')} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <StatCard label="Boards Pending" value={stats?.boards_pending} tone="amber" icon={<Layers className="w-4 h-4" />} sublabel="Across all open orders" onClick={() => onGoToProduction('all')} />
          <StatCard label="Materials Pending" value={stats?.materials_pending} tone="red" icon={<Boxes className="w-4 h-4" />} sublabel="Boards waiting on BOM items" onClick={() => onGoToProduction('needs_materials')} />
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-2.5">
          <h2 className="text-sm font-semibold text-slate-700 flex items-center gap-1.5"><Truck className="w-4 h-4 text-slate-400" /> Vehicle Load</h2>
          <button onClick={onGoToVehicleLoad} className="text-xs font-medium text-blue-600 hover:text-blue-700 flex items-center gap-0.5">
            Open Vehicle Load <ChevronRight className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-3">
          <StatCard label="Awaiting Load" value={vehicleLoadStats?.shops_not_loaded} tone="red" icon={<PackageOpen className="w-4 h-4" />} sublabel="Ready, nothing loaded yet" onClick={onGoToVehicleLoad} />
          <StatCard label="Partially Loaded" value={vehicleLoadStats?.shops_partial} tone="amber" icon={<Truck className="w-4 h-4" />} sublabel="Some boards still behind" onClick={onGoToVehicleLoad} />
          <StatCard label="Fully Loaded" value={vehicleLoadStats?.shops_loaded} tone="emerald" icon={<PackageCheck className="w-4 h-4" />} sublabel="Nothing missing" onClick={onGoToVehicleLoad} />
          <StatCard label="Vehicles Today" value={vehicleLoadStats?.vehicles_today} tone="blue" icon={<Truck className="w-4 h-4" />} sublabel="Distinct vehicles loaded" />
          <StatCard label="Trips Today" value={vehicleLoadStats?.trips_today} tone="blue" icon={<Users className="w-4 h-4" />} sublabel="1 multi-shop trip = 1" />
        </div>
        {needsLoadAttention > 0 && (
          <button
            onClick={onGoToVehicleLoad}
            className="w-full flex items-center gap-2.5 bg-red-50 border border-red-200 text-red-700 rounded-lg px-3.5 py-2.5 text-sm font-medium hover:bg-red-100 transition"
          >
            <AlertTriangle className="w-4 h-4 shrink-0" />
            {needsLoadAttention} shop{needsLoadAttention > 1 ? 's have' : ' has'} ready material not (fully) loaded into a vehicle yet — Please verify that no items are missing.
            <ChevronRight className="w-4 h-4 ml-auto shrink-0" />
          </button>
        )}
        {vehicleLoadStats && needsLoadAttention === 0 && (vehicleLoadStats.shops_loaded > 0) && (
          <p className="flex items-center gap-2 text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3.5 py-2.5">
            <CheckCircle2 className="w-4 h-4 shrink-0" /> All ready materials have been loaded and handed over to installers.
          </p>
        )}
      </div>
    </div>
  );
}

// ============================================================
// Vehicle Load — Production's own screen for handing finished boards to
// an installer's vehicle. Lists every shop with production-done boards,
// ready vs. loaded qty side by side (from v_vehicle_load_shop_summary),
// and lets Production open a shop to record what's actually going out —
// which boards, how much of each, which installer, which vehicle.
// ============================================================
const LOAD_STATUS_META: Record<string, { label: string; tone: string; icon: any }> = {
  not_loaded: { label: 'Not Loaded', tone: 'bg-red-100 text-red-700', icon: PackageOpen },
  partial: { label: 'Partially Loaded', tone: 'bg-amber-100 text-amber-700', icon: Truck },
  loaded: { label: 'Fully Loaded', tone: 'bg-emerald-100 text-emerald-700', icon: PackageCheck },
  no_boards: { label: 'No Boards Yet', tone: 'bg-slate-100 text-slate-500', icon: Circle },
};

// Shop rows rendered at once in the "By Shop" list. At 10K+ shops this is
// what keeps the tab responsive — totals below cover the full filtered set
// regardless of how many rows are actually mounted.
const SHOP_PAGE_SIZE = 40;

function VehicleLoadTab({ canLoad, onGoToProduction }: { canLoad: boolean; onGoToProduction: () => void }) {
  const { profile } = useAuth();
  const orgId = profile?.organization_id;
  const [subView, setSubView] = useState<'shops' | 'log'>('shops');
  const [filter, setFilter] = useState<'attention' | 'not_loaded' | 'partial' | 'loaded' | 'all'>('attention');
  const [search, setSearch] = useState('');
  const [loadShop, setLoadShop] = useState<VehicleLoadShopSummary | null>(null);
  const [historyShop, setHistoryShop] = useState<VehicleLoadShopSummary | null>(null);
  const [multiShopLoadOpen, setMultiShopLoadOpen] = useState(false);
  const [visibleShopCount, setVisibleShopCount] = useState(SHOP_PAGE_SIZE);

  const { data: shops, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['vehicle-load-shops', orgId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('v_vehicle_load_shop_summary')
        .select('*')
        .neq('fulfillment_type', 'supply_only')
        .order('load_status', { ascending: true })
        .order('shop_name', { ascending: true });
      if (error) throw new Error(error.message || 'Could not load the Vehicle Load list.');
      return (data || []) as VehicleLoadShopSummary[];
    },
    enabled: !!orgId,
  });

  const filtered = useMemo(() => {
    let list = shops || [];
    if (filter === 'attention') list = list.filter((s) => s.load_status === 'not_loaded' || s.load_status === 'partial');
    else if (filter !== 'all') list = list.filter((s) => s.load_status === filter);
    const term = search.trim().toLowerCase();
    if (term) list = list.filter((s) => s.shop_name.toLowerCase().includes(term) || (s.zone_name || '').toLowerCase().includes(term) || (s.assigned_installer_name || '').toLowerCase().includes(term));
    return list;
  }, [shops, filter, search]);

  const counts = useMemo(() => {
    const c = { not_loaded: 0, partial: 0, loaded: 0, all: shops?.length || 0 };
    for (const s of shops || []) {
      if (s.load_status === 'not_loaded') c.not_loaded++;
      else if (s.load_status === 'partial') c.partial++;
      else if (s.load_status === 'loaded') c.loaded++;
    }
    return c;
  }, [shops]);

  // Totals across the whole filtered set — the number Owner/Production want
  // ("kitna total ready/loaded/pending hai") shown once up top, instead of
  // having to scroll a possibly huge shop list and add it up by eye.
  const qtyTotals = useMemo(() => {
    let ready = 0, loaded = 0, pending = 0;
    for (const s of filtered) { ready += s.total_ready_qty; loaded += s.total_loaded_qty; pending += s.pending_qty; }
    return { ready, loaded, pending };
  }, [filtered]);

  useEffect(() => { setVisibleShopCount(SHOP_PAGE_SIZE); }, [filter, search, shops]);

  const visibleShops = useMemo(() => filtered.slice(0, visibleShopCount), [filtered, visibleShopCount]);

  return (
    <div>
      <Card className="p-3.5 mb-4">
        <p className="text-sm text-slate-600">
          Every shop whose boards are produced and ready shows up here. Pick a shop, confirm what's actually going out, and load it into the installer's vehicle —
          Owner/Admin sees the same ready-vs-loaded numbers on the Overview screen, so nothing goes missing between the workshop and the site.
        </p>
        {!canLoad && (
          <p className="mt-2 flex items-center gap-1.5 text-xs text-slate-500"><Info className="w-3.5 h-3.5 shrink-0" /> View-only for your role — Production or Owner/Admin can record a load.</p>
        )}
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
        <div className="flex gap-1.5">
          <button
            onClick={() => setSubView('shops')}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium border transition ${subView === 'shops' ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}`}
          >
            By Shop
          </button>
          <button
            onClick={() => setSubView('log')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium border transition ${subView === 'log' ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}`}
          >
            <ListChecks className="w-3.5 h-3.5" /> Load Log
          </button>
        </div>
        {canLoad && subView === 'shops' && (
          <button
            onClick={() => setMultiShopLoadOpen(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-700"
          >
            <Users className="w-4 h-4" /> Load Multiple Shops (Same Vehicle)
          </button>
        )}
      </div>

      {subView === 'log' ? (
        <VehicleLoadLogView canManage={canLoad} />
      ) : (
      <>
      <div className="relative mb-3">
        <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by shop, zone, or installer..."
          className="w-full pl-9 pr-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
        />
      </div>

      {/* Total-first: ready/loaded/pending qty across the current filter,
          before the shop-by-shop list below. */}
      <Card className="p-3.5 mb-4">
        <div className="grid grid-cols-3 gap-3">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-wide text-slate-400">Total ready qty</p>
            <p className="text-lg font-semibold text-slate-800">{qtyTotals.ready.toLocaleString('en-IN')}</p>
          </div>
          <div>
            <p className="text-[11px] font-medium uppercase tracking-wide text-slate-400">Total loaded qty</p>
            <p className="text-lg font-semibold text-emerald-700">{qtyTotals.loaded.toLocaleString('en-IN')}</p>
          </div>
          <div>
            <p className="text-[11px] font-medium uppercase tracking-wide text-slate-400">Total pending qty</p>
            <p className={`text-lg font-semibold ${qtyTotals.pending > 0 ? 'text-red-600' : 'text-slate-800'}`}>{qtyTotals.pending.toLocaleString('en-IN')}</p>
          </div>
        </div>
      </Card>

      <div className="flex gap-1.5 overflow-x-auto pb-1 -mx-1 px-1 mb-4">
        {([
          { key: 'attention', label: 'Needs Attention', count: counts.not_loaded + counts.partial },
          { key: 'not_loaded', label: 'Not Loaded', count: counts.not_loaded },
          { key: 'partial', label: 'Partial', count: counts.partial },
          { key: 'loaded', label: 'Fully Loaded', count: counts.loaded },
          { key: 'all', label: 'All', count: counts.all },
        ] as const).map((t) => (
          <button
            key={t.key}
            onClick={() => setFilter(t.key)}
            className={`shrink-0 px-3 py-1.5 rounded-lg text-sm font-medium border transition ${
              filter === t.key ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
            }`}
          >
            {t.label} <span className="opacity-75">({t.count})</span>
          </button>
        ))}
      </div>

      {isError && (
        <div className="mb-4 flex items-start gap-2 bg-red-50 border border-red-200 text-red-700 rounded-lg px-3 py-2.5 text-sm">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <div className="min-w-0">
            <p className="font-medium">Couldn't load the Vehicle Load list.</p>
            <p className="text-xs text-red-600/80 break-words">{(error as Error)?.message}</p>
          </div>
          <button onClick={() => refetch()} className="ml-auto shrink-0 text-xs font-medium underline">Retry</button>
        </div>
      )}

      <Card className="overflow-hidden">
        {isLoading ? (
          <div className="divide-y divide-slate-100">{Array.from({ length: 4 }).map((_, i) => <RowSkeleton key={i} />)}</div>
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={<Truck className="w-12 h-12" />}
            title={shops && shops.length > 0 ? 'Nothing matches this filter' : 'Nothing ready to load yet'}
            subtitle={shops && shops.length > 0 ? 'Try a different tab or clear your search.' : 'Complete production on a shop to see it here.'}
          />
        ) : (
          <div className="divide-y divide-slate-100">
            {visibleShops.map((s) => {
              const meta = LOAD_STATUS_META[s.load_status] || LOAD_STATUS_META.no_boards;
              const Icon = meta.icon;
              return (
                <div key={s.shop_id} className="px-4 py-3 flex items-center gap-3">
                  <div className={`w-10 h-10 rounded-lg shrink-0 flex items-center justify-center ${meta.tone}`}>
                    <Icon className="w-5 h-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-slate-900 truncate">{s.shop_name}</p>
                    <p className="text-xs text-slate-500 truncate">
                      {[s.zone_name, s.shop_city].filter(Boolean).join(' · ') || '—'}
                      {s.assigned_installer_name && <> · Installer: <span className="text-slate-700 font-medium">{s.assigned_installer_name}</span></>}
                    </p>
                    <p className="text-xs text-slate-400 mt-0.5">
                      Ready <span className="font-semibold text-slate-600">{s.total_ready_qty}</span> · Loaded <span className="font-semibold text-slate-600">{s.total_loaded_qty}</span>
                      {s.pending_qty > 0 && <span className="text-red-600 font-semibold"> · {s.pending_qty} pending</span>}
                      {s.latest_vehicle_number && <span> · Vehicle <span className="font-medium text-slate-600">{s.latest_vehicle_number}</span></span>}
                    </p>
                  </div>
                  <span className={`shrink-0 text-[11px] font-semibold px-2 py-1 rounded-full ${meta.tone}`}>{meta.label}</span>
                  <div className="shrink-0 flex items-center gap-1.5">
                    {s.latest_vehicle_load_id && (
                      <button onClick={() => setHistoryShop(s)} className="p-2 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50" title="Load history">
                        <ListChecks className="w-4 h-4" />
                      </button>
                    )}
                    {canLoad && s.load_status !== 'no_boards' && (
                      <button
                        onClick={() => setLoadShop(s)}
                        className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-700"
                      >
                        <Truck className="w-4 h-4" /> {s.load_status === 'loaded' ? 'Adjust' : 'Load'}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>
      {visibleShopCount < filtered.length && (
        <button
          onClick={() => setVisibleShopCount((n) => n + SHOP_PAGE_SIZE)}
          className="mt-3 w-full text-sm font-medium text-blue-600 hover:text-blue-700 bg-white border border-slate-200 rounded-lg py-2.5 hover:bg-slate-50"
        >
          Load more ({filtered.length - visibleShopCount} more shop{filtered.length - visibleShopCount === 1 ? '' : 's'})
        </button>
      )}

      {loadShop && <LoadVehicleModal shop={loadShop} onClose={() => setLoadShop(null)} />}
      {historyShop && <VehicleLoadHistoryModal shop={historyShop} onClose={() => setHistoryShop(null)} />}
      </>
      )}

      {multiShopLoadOpen && (
        <MultiShopLoadModal shops={(shops || []).filter((s) => s.load_status !== 'no_boards')} onClose={() => setMultiShopLoadOpen(false)} />
      )}
    </div>
  );
}

type LoadableBoard = { work_item_id: string; work_type_name: string; material: string | null; dims: string | null; ready_qty: number; already_loaded: number };

function LoadVehicleModal({ shop, onClose }: { shop: VehicleLoadShopSummary; onClose: () => void }) {
  const { profile } = useAuth();
  const queryClient = useQueryClient();
  const [installerId, setInstallerId] = useState(shop.assigned_installer_id || '');
  const [vehicleNumber, setVehicleNumber] = useState('');
  const [driverName, setDriverName] = useState('');
  const [notes, setNotes] = useState('');
  const [qtyByItem, setQtyByItem] = useState<Record<string, string>>({});

  const { data: installers } = useQuery({
    queryKey: ['org-installers', profile?.organization_id],
    queryFn: async () => {
      const { data, error } = await supabase.from('profiles').select('id, full_name').eq('organization_id', profile!.organization_id).eq('role', 'installer').eq('is_active', true).order('full_name');
      if (error) throw new Error(`Could not load installers: ${error.message}`);
      return data as { id: string; full_name: string }[];
    },
    enabled: !!profile?.organization_id,
  });

  // Ready boards for this shop + how much of each has already been
  // loaded (across earlier, non-cancelled loads) — so the form defaults
  // to exactly what's still outstanding, not the full ready qty again.
  const { data: boards, isLoading: boardsLoading } = useQuery({
    queryKey: ['vehicle-load-boards', shop.shop_id],
    queryFn: async (): Promise<LoadableBoard[]> => {
      const { data: items, error: itemsErr } = await supabase.from('work_items').select('*').eq('shop_id', shop.shop_id).in('status', ['production_done', 'installed']).order('created_at');
      if (itemsErr) throw new Error(itemsErr.message);
      const workItems = (items || []) as WorkItem[];
      const itemIds = workItems.map((i) => i.id);

      const { data: prodItems } = itemIds.length
        ? await supabase.from('production_items').select('work_item_id, produced_qty').in('work_item_id', itemIds)
        : { data: [] as { work_item_id: string | null; produced_qty: number | null }[] };
      const producedByItem = new Map<string, number>();
      for (const p of prodItems || []) { if (p.work_item_id) producedByItem.set(p.work_item_id, Math.max(producedByItem.get(p.work_item_id) || 0, p.produced_qty || 0)); }

      const { data: loadItems } = itemIds.length
        ? await supabase.from('vehicle_load_items').select('work_item_id, qty_loaded, vehicle_loads!inner(status)').in('work_item_id', itemIds).neq('vehicle_loads.status', 'cancelled')
        : { data: [] as { work_item_id: string; qty_loaded: number }[] };
      const loadedByItem = new Map<string, number>();
      for (const l of (loadItems || []) as any[]) { loadedByItem.set(l.work_item_id, (loadedByItem.get(l.work_item_id) || 0) + (l.qty_loaded || 0)); }

      return workItems.map((it) => {
        const { dims } = boardLabel(it);
        const ready_qty = producedByItem.get(it.id) ?? it.produced_quantity ?? it.approved_quantity ?? it.survey_quantity ?? 1;
        return {
          work_item_id: it.id,
          work_type_name: it.work_type_name || it.material || 'Item',
          material: it.material,
          dims,
          ready_qty,
          already_loaded: loadedByItem.get(it.id) || 0,
        };
      });
    },
    enabled: !!shop.shop_id,
  });

  useEffect(() => {
    if (!boards) return;
    setQtyByItem((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const b of boards) {
        if (next[b.work_item_id] === undefined) {
          next[b.work_item_id] = String(Math.max(b.ready_qty - b.already_loaded, 0));
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [boards]);

  const totalToLoad = useMemo(() => (boards || []).reduce((sum, b) => sum + (parseFloat(qtyByItem[b.work_item_id]) || 0), 0), [boards, qtyByItem]);

  const submitMutation = useMutation({
    mutationFn: async () => {
      if (!profile) throw new Error('Not signed in.');
      if (!installerId) throw new Error('Pick which installer this vehicle is for.');
      if (!vehicleNumber.trim()) throw new Error('Enter the vehicle number.');
      const items = (boards || [])
        .map((b) => ({ b, qty: parseFloat(qtyByItem[b.work_item_id]) || 0 }))
        .filter(({ qty }) => qty > 0);
      if (items.length === 0) throw new Error('Enter at least one board quantity to load.');

      const { data: load, error: loadError } = await supabase.from('vehicle_loads').insert({
        organization_id: profile.organization_id,
        shop_id: shop.shop_id,
        installer_id: installerId,
        loaded_by: profile.id,
        vehicle_number: vehicleNumber.trim(),
        driver_name: driverName.trim() || null,
        notes: notes.trim() || null,
        status: 'loaded',
      }).select('id').single();
      if (loadError) throw new Error(`Could not save the vehicle load: ${loadError.message}`);

      const rows = items.map(({ b, qty }) => ({
        organization_id: profile.organization_id,
        vehicle_load_id: load.id,
        work_item_id: b.work_item_id,
        work_type_name: b.work_type_name,
        material: b.material,
        qty_ready: b.ready_qty,
        qty_loaded: qty,
      }));
      const { error: itemsError } = await supabase.from('vehicle_load_items').insert(rows);
      if (itemsError) throw new Error(`Could not save loaded boards: ${itemsError.message}`);

      await logAudit('vehicle_loads', load.id, 'insert', null, null, null, `${items.length} board(s), ${totalToLoad} total qty loaded into ${vehicleNumber.trim()} for ${shop.shop_name}`);

      // If this load (plus anything loaded before it) now covers every
      // ready board, nudge the shop into the existing 'dispatched'
      // status — the same status the app already treats as "material is
      // out of the workshop" (InstallerPage's queue, the Dashboard's
      // "Ready for Dispatch" card) so nothing new has to be taught about
      // this status; it just starts meaning the same thing here too.
      const fullyLoaded = items.every(({ b, qty }) => qty + b.already_loaded >= b.ready_qty)
        && (boards || []).every((b) => (b.already_loaded + (parseFloat(qtyByItem[b.work_item_id]) || 0)) >= b.ready_qty);
      if (fullyLoaded) {
        await supabase.from('shops').update({ status: 'dispatched' }).eq('id', shop.shop_id).eq('status', 'production_done');
      }

      await createNotification(installerId, 'Material Loaded for You', `${vehicleNumber.trim()} loaded with ${items.length} board(s) for ${shop.shop_name}. Ready for installation.`, 'info', '/installation');
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['vehicle-load-shops'] });
      queryClient.invalidateQueries({ queryKey: ['vehicle-load-stats'] });
      queryClient.invalidateQueries({ queryKey: ['shops'] });
      queryClient.invalidateQueries({ queryKey: ['nav-pending-counts'] });
      onClose();
    },
  });

  return (
    <Modal open onClose={onClose} title={`Load Vehicle — ${shop.shop_name}`} size="lg">
      <div className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Select label="Installer" value={installerId} onChange={setInstallerId} required
            options={[{ value: '', label: 'Select installer...' }, ...(installers || []).map((i) => ({ value: i.id, label: i.full_name }))]} />
          <Input label="Vehicle Number" value={vehicleNumber} onChange={setVehicleNumber} placeholder="e.g. MH12 AB 1234" required />
          <Input label="Driver Name (optional)" value={driverName} onChange={setDriverName} placeholder="e.g. Ramesh" />
        </div>

        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-1.5">Boards to Load</p>
          {boardsLoading ? (
            <div className="space-y-2">{Array.from({ length: 3 }).map((_, i) => <div key={i} className="h-10 bg-slate-100 rounded-lg animate-pulse" />)}</div>
          ) : (boards || []).length === 0 ? (
            <p className="text-sm text-slate-400 py-3">No production-done boards found for this shop.</p>
          ) : (
            <div className="border border-slate-200 rounded-lg divide-y divide-slate-100 max-h-72 overflow-y-auto">
              {(boards || []).map((b) => {
                const remaining = Math.max(b.ready_qty - b.already_loaded, 0);
                return (
                  <div key={b.work_item_id} className="flex items-center gap-3 px-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-slate-800 truncate">{b.work_type_name}{b.dims ? ` — ${b.dims}` : ''}</p>
                      <p className="text-[11px] text-slate-400">Ready {b.ready_qty} · Already loaded {b.already_loaded} · Remaining {remaining}</p>
                    </div>
                    <input
                      type="number" min="0" step="1"
                      value={qtyByItem[b.work_item_id] ?? ''}
                      onChange={(e) => setQtyByItem((prev) => ({ ...prev, [b.work_item_id]: e.target.value }))}
                      className="w-20 px-2 py-1.5 border border-slate-300 rounded-lg text-sm text-right focus:ring-2 focus:ring-blue-500 outline-none"
                    />
                  </div>
                );
              })}
            </div>
          )}
          <p className="text-xs text-slate-500 mt-1.5">Total this trip: <span className="font-semibold text-slate-700">{totalToLoad}</span>. Pre-filled with what's still outstanding — edit if less is going this trip.</p>
        </div>

        <Textarea label="Notes (optional)" value={notes} onChange={setNotes} placeholder="Anything the installer or Owner/Admin should know about this load" rows={2} />

        {submitMutation.isError && <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-2">{(submitMutation.error as Error).message}</p>}

        <button
          onClick={() => submitMutation.mutate()}
          disabled={submitMutation.isPending || boardsLoading}
          className="w-full flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-700 text-white font-medium py-2.5 rounded-lg disabled:opacity-50"
        >
          <Truck className="w-4 h-4" /> {submitMutation.isPending ? 'Saving...' : 'Confirm Vehicle Load'}
        </button>
      </div>
    </Modal>
  );
}

// ============================================================
// Multi-Shop Load — one vehicle trip covering several shops at once
// (a route: one truck, many stops). Shares the same underlying tables as
// the single-shop LoadVehicleModal above (vehicle_loads + vehicle_load_items,
// one vehicle_loads row per shop) — the only difference is every row
// created in this submission carries the same vehicle_trip_id, so the
// Vehicle Load Log and Owner Console can show them as one trip instead of
// unrelated loads that happen to share a vehicle number.
// ============================================================
type MultiShopSelection = { installerId: string; qtyByItem: Record<string, string> };

function useMultiShopBoards(shopIds: string[]) {
  const sortedKey = useMemo(() => [...shopIds].sort().join(','), [shopIds]);
  return useQuery({
    queryKey: ['multi-vehicle-load-boards', sortedKey],
    queryFn: async (): Promise<Record<string, LoadableBoard[]>> => {
      if (shopIds.length === 0) return {};
      const { data: items, error: itemsErr } = await supabase.from('work_items').select('*').in('shop_id', shopIds).in('status', ['production_done', 'installed']).order('created_at');
      if (itemsErr) throw new Error(itemsErr.message);
      const workItems = (items || []) as WorkItem[];
      const itemIds = workItems.map((i) => i.id);

      const { data: prodItems } = itemIds.length
        ? await supabase.from('production_items').select('work_item_id, produced_qty').in('work_item_id', itemIds)
        : { data: [] as { work_item_id: string | null; produced_qty: number | null }[] };
      const producedByItem = new Map<string, number>();
      for (const p of prodItems || []) { if (p.work_item_id) producedByItem.set(p.work_item_id, Math.max(producedByItem.get(p.work_item_id) || 0, p.produced_qty || 0)); }

      const { data: loadItems } = itemIds.length
        ? await supabase.from('vehicle_load_items').select('work_item_id, qty_loaded, vehicle_loads!inner(status)').in('work_item_id', itemIds).neq('vehicle_loads.status', 'cancelled')
        : { data: [] as { work_item_id: string; qty_loaded: number }[] };
      const loadedByItem = new Map<string, number>();
      for (const l of (loadItems || []) as any[]) { loadedByItem.set(l.work_item_id, (loadedByItem.get(l.work_item_id) || 0) + (l.qty_loaded || 0)); }

      const byShop: Record<string, LoadableBoard[]> = {};
      for (const it of workItems) {
        const { dims } = boardLabel(it);
        const ready_qty = producedByItem.get(it.id) ?? it.produced_quantity ?? it.approved_quantity ?? it.survey_quantity ?? 1;
        const board: LoadableBoard = {
          work_item_id: it.id,
          work_type_name: it.work_type_name || it.material || 'Item',
          material: it.material,
          dims,
          ready_qty,
          already_loaded: loadedByItem.get(it.id) || 0,
        };
        (byShop[it.shop_id] ||= []).push(board);
      }
      return byShop;
    },
    enabled: shopIds.length > 0,
  });
}

function MultiShopLoadModal({ shops, onClose }: { shops: VehicleLoadShopSummary[]; onClose: () => void }) {
  const { profile } = useAuth();
  const queryClient = useQueryClient();
  const [vehicleNumber, setVehicleNumber] = useState('');
  const [driverName, setDriverName] = useState('');
  const [notes, setNotes] = useState('');
  const [pickerSearch, setPickerSearch] = useState('');
  const [selectedShopIds, setSelectedShopIds] = useState<Set<string>>(new Set());
  const [selections, setSelections] = useState<Record<string, MultiShopSelection>>({});
  // Per-shop board editor stays collapsed by default — quantities are
  // auto-filled to "remaining" the moment a shop is selected (see effect
  // below), so most shops on a big multi-shop trip need zero manual edits.
  // Expand only the ones you actually need to change, instead of every
  // shop's full board list rendering open at once.
  const [expandedShopIds, setExpandedShopIds] = useState<Set<string>>(new Set());

  const { data: installers } = useQuery({
    queryKey: ['org-installers', profile?.organization_id],
    queryFn: async () => {
      const { data, error } = await supabase.from('profiles').select('id, full_name').eq('organization_id', profile!.organization_id).eq('role', 'installer').eq('is_active', true).order('full_name');
      if (error) throw new Error(`Could not load installers: ${error.message}`);
      return data as { id: string; full_name: string }[];
    },
    enabled: !!profile?.organization_id,
  });

  const pickerList = useMemo(() => {
    const term = pickerSearch.trim().toLowerCase();
    if (!term) return shops;
    return shops.filter((s) => s.shop_name.toLowerCase().includes(term) || (s.zone_name || '').toLowerCase().includes(term) || (s.assigned_installer_name || '').toLowerCase().includes(term));
  }, [shops, pickerSearch]);

  const selectedShopIdsArray = useMemo(() => Array.from(selectedShopIds), [selectedShopIds]);
  const selectedShops = useMemo(() => shops.filter((s) => selectedShopIds.has(s.shop_id)), [shops, selectedShopIds]);

  const { data: boardsByShop, isLoading: boardsLoading } = useMultiShopBoards(selectedShopIdsArray);

  // Default each newly-selected shop's installer + per-board qty to what's
  // still outstanding, exactly like the single-shop modal — edit if less
  // is actually going on this trip.
  useEffect(() => {
    if (!boardsByShop) return;
    setSelections((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const shopId of selectedShopIdsArray) {
        const boards = boardsByShop[shopId] || [];
        const shop = shops.find((s) => s.shop_id === shopId);
        if (!next[shopId]) {
          const qtyByItem: Record<string, string> = {};
          for (const b of boards) qtyByItem[b.work_item_id] = String(Math.max(b.ready_qty - b.already_loaded, 0));
          next[shopId] = { installerId: shop?.assigned_installer_id || '', qtyByItem };
          changed = true;
        } else {
          const qtyByItem = { ...next[shopId].qtyByItem };
          let innerChanged = false;
          for (const b of boards) {
            if (qtyByItem[b.work_item_id] === undefined) { qtyByItem[b.work_item_id] = String(Math.max(b.ready_qty - b.already_loaded, 0)); innerChanged = true; }
          }
          if (innerChanged) { next[shopId] = { ...next[shopId], qtyByItem }; changed = true; }
        }
      }
      return changed ? next : prev;
    });
  }, [boardsByShop, selectedShopIdsArray, shops]);

  function toggleShop(shopId: string) {
    setSelectedShopIds((prev) => {
      const next = new Set(prev);
      if (next.has(shopId)) next.delete(shopId); else next.add(shopId);
      return next;
    });
  }

  function toggleShopExpanded(shopId: string) {
    setExpandedShopIds((prev) => {
      const next = new Set(prev);
      if (next.has(shopId)) next.delete(shopId); else next.add(shopId);
      return next;
    });
  }

  function setInstaller(shopId: string, installerId: string) {
    setSelections((prev) => ({ ...prev, [shopId]: { ...(prev[shopId] || { qtyByItem: {} }), installerId } }));
  }

  function setQty(shopId: string, workItemId: string, value: string) {
    setSelections((prev) => ({
      ...prev,
      [shopId]: { ...(prev[shopId] || { installerId: '', qtyByItem: {} }), qtyByItem: { ...(prev[shopId]?.qtyByItem || {}), [workItemId]: value } },
    }));
  }

  const grandTotal = useMemo(() => {
    let total = 0;
    for (const shopId of selectedShopIdsArray) {
      const sel = selections[shopId];
      if (!sel) continue;
      for (const v of Object.values(sel.qtyByItem)) total += parseFloat(v) || 0;
    }
    return total;
  }, [selections, selectedShopIdsArray]);

  // Material-wise total across every selected shop — "konsa material kitna
  // ja raha hai is trip me", visible before confirming, not just one opaque
  // grand-total number.
  const materialTotals = useMemo(() => {
    const map = new Map<string, number>();
    for (const shopId of selectedShopIdsArray) {
      const boards = (boardsByShop || {})[shopId] || [];
      const sel = selections[shopId];
      if (!sel) continue;
      for (const b of boards) {
        const qty = parseFloat(sel.qtyByItem[b.work_item_id] || '0') || 0;
        if (qty <= 0) continue;
        map.set(b.work_type_name, (map.get(b.work_type_name) || 0) + qty);
      }
    }
    return Array.from(map.entries()).map(([name, qty]) => ({ name, qty })).sort((a, b) => b.qty - a.qty);
  }, [selections, selectedShopIdsArray, boardsByShop]);

  const submitMutation = useMutation({
    mutationFn: async () => {
      if (!profile) throw new Error('Not signed in.');
      if (!vehicleNumber.trim()) throw new Error('Enter the vehicle number.');
      if (selectedShopIdsArray.length < 2) throw new Error('Select at least 2 shops for a multi-shop trip — for one shop, use the regular Load button instead.');

      const tripId = crypto.randomUUID();
      const perShopRows: { shop: VehicleLoadShopSummary; installerId: string; items: { b: LoadableBoard; qty: number }[]; fullyLoaded: boolean }[] = [];

      for (const shopId of selectedShopIdsArray) {
        const shop = shops.find((s) => s.shop_id === shopId)!;
        const sel = selections[shopId];
        if (!sel?.installerId) throw new Error(`Pick an installer for ${shop.shop_name}.`);
        const boards = (boardsByShop || {})[shopId] || [];
        const items = boards.map((b) => ({ b, qty: parseFloat(sel.qtyByItem[b.work_item_id]) || 0 })).filter(({ qty }) => qty > 0);
        if (items.length === 0) throw new Error(`Enter at least one board quantity for ${shop.shop_name}, or unselect that shop.`);
        const fullyLoaded = boards.every((b) => (b.already_loaded + (parseFloat(sel.qtyByItem[b.work_item_id]) || 0)) >= b.ready_qty);
        perShopRows.push({ shop, installerId: sel.installerId, items, fullyLoaded });
      }

      // 1. All per-shop vehicle_loads headers in ONE insert call — either
      // every shop's header is saved, or none are (a single INSERT
      // statement with multiple rows is atomic in Postgres).
      const loadInserts = perShopRows.map(({ shop, installerId }) => ({
        organization_id: profile.organization_id,
        shop_id: shop.shop_id,
        installer_id: installerId,
        loaded_by: profile.id,
        vehicle_number: vehicleNumber.trim(),
        driver_name: driverName.trim() || null,
        notes: notes.trim() || null,
        status: 'loaded' as const,
        vehicle_trip_id: tripId,
      }));
      const { data: insertedLoads, error: loadsError } = await supabase.from('vehicle_loads').insert(loadInserts).select('id, shop_id');
      if (loadsError) throw new Error(`Could not save the vehicle trip: ${loadsError.message}`);
      const loadIdByShop = new Map((insertedLoads || []).map((l: any) => [l.shop_id as string, l.id as string]));

      // 2. Every board across every shop in ONE insert call — same
      // all-or-nothing guarantee as step 1.
      const itemRows: any[] = [];
      for (const { shop, items } of perShopRows) {
        const loadId = loadIdByShop.get(shop.shop_id);
        if (!loadId) continue;
        for (const { b, qty } of items) {
          itemRows.push({
            organization_id: profile.organization_id,
            vehicle_load_id: loadId,
            work_item_id: b.work_item_id,
            work_type_name: b.work_type_name,
            material: b.material,
            qty_ready: b.ready_qty,
            qty_loaded: qty,
          });
        }
      }
      const { error: itemsError } = await supabase.from('vehicle_load_items').insert(itemRows);
      if (itemsError) throw new Error(`Could not save loaded boards: ${itemsError.message}`);

      // 3. Same "flip to dispatched once fully loaded" rule as the
      // single-shop flow, batched across every fully-loaded shop in the trip.
      const fullyLoadedShopIds = perShopRows.filter((r) => r.fullyLoaded).map((r) => r.shop.shop_id);
      if (fullyLoadedShopIds.length > 0) {
        await supabase.from('shops').update({ status: 'dispatched' }).in('id', fullyLoadedShopIds).eq('status', 'production_done');
      }

      // 4. Audit + notify per shop — so each shop's own load history AND
      // the trip-level log both read correctly, and every installer on the
      // route gets their own notification.
      const totalQtyAll = perShopRows.reduce((sum, r) => sum + r.items.reduce((s2, { qty }) => s2 + qty, 0), 0);
      for (const { shop, installerId, items } of perShopRows) {
        const loadId = loadIdByShop.get(shop.shop_id) || null;
        const shopQty = items.reduce((s, { qty }) => s + qty, 0);
        await logAudit(
          'vehicle_loads', loadId, 'insert', null, null, null,
          `Multi-shop trip ${vehicleNumber.trim()} — ${items.length} board(s), ${shopQty} qty loaded for ${shop.shop_name} (trip covers ${perShopRows.length} shops, ${totalQtyAll} total qty)`
        );
        await createNotification(installerId, 'Material Loaded for You', `${vehicleNumber.trim()} loaded with ${items.length} board(s) for ${shop.shop_name} (multi-shop trip). Ready for installation.`, 'info', '/installation');
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['vehicle-load-shops'] });
      queryClient.invalidateQueries({ queryKey: ['vehicle-load-stats'] });
      queryClient.invalidateQueries({ queryKey: ['vehicle-load-log'] });
      queryClient.invalidateQueries({ queryKey: ['shops'] });
      queryClient.invalidateQueries({ queryKey: ['nav-pending-counts'] });
      onClose();
    },
  });

  return (
    <Modal open onClose={onClose} title="Load Vehicle — Multiple Shops (One Trip)" size="xl">
      <div className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Input label="Vehicle Number" value={vehicleNumber} onChange={setVehicleNumber} placeholder="e.g. MH12 AB 1234" required />
          <Input label="Driver Name (optional)" value={driverName} onChange={setDriverName} placeholder="e.g. Ramesh" />
          <div className="flex items-end pb-1.5">
            <p className="text-xs text-slate-500">
              <span className="font-semibold text-slate-700">{selectedShopIdsArray.length}</span> shop{selectedShopIdsArray.length === 1 ? '' : 's'} selected
            </p>
          </div>
        </div>

        {/* Total-first: this is the number that matters most on a big
            multi-shop trip — kept prominent and pinned above the shop list,
            so it never gets lost while scrolling through many shops. */}
        {selectedShopIdsArray.length > 0 && (
          <div className="bg-indigo-50 border border-indigo-100 rounded-lg px-3.5 py-2.5">
            <div className="flex items-center justify-between">
              <span className="text-sm text-indigo-700">Total quantity this trip</span>
              <span className="text-xl font-bold text-indigo-900">{grandTotal}</span>
            </div>
            {materialTotals.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-2">
                {materialTotals.map((m) => (
                  <span key={m.name} className="text-[11px] bg-white border border-indigo-200 text-indigo-700 px-2 py-0.5 rounded-full">
                    {m.name} · {m.qty}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-1.5">Pick the shops on this trip</p>
          <div className="relative mb-2">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              value={pickerSearch}
              onChange={(e) => setPickerSearch(e.target.value)}
              placeholder="Search by shop, zone, or installer..."
              className="w-full pl-9 pr-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none"
            />
          </div>
          <div className="border border-slate-200 rounded-lg divide-y divide-slate-100 max-h-48 overflow-y-auto">
            {pickerList.length === 0 ? (
              <p className="text-sm text-slate-400 py-3 px-3">No shops match this search.</p>
            ) : pickerList.map((s) => {
              const checked = selectedShopIds.has(s.shop_id);
              return (
                <label key={s.shop_id} className="flex items-center gap-3 px-3 py-2 hover:bg-slate-50 cursor-pointer">
                  <button type="button" onClick={() => toggleShop(s.shop_id)} className="shrink-0 text-slate-400">
                    {checked ? <CheckSquare className="w-4 h-4 text-blue-600" /> : <Square className="w-4 h-4" />}
                  </button>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-slate-800 truncate">{s.shop_name}</p>
                    <p className="text-[11px] text-slate-400">
                      Ready {s.total_ready_qty} · Loaded {s.total_loaded_qty} · Pending {s.pending_qty}
                      {s.assigned_installer_name && <> · {s.assigned_installer_name}</>}
                    </p>
                  </div>
                </label>
              );
            })}
          </div>
        </div>

        {selectedShops.length > 0 && (
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-1.5">
              Confirm each shop's boards + installer
              <span className="normal-case font-normal text-slate-400"> — quantities are pre-filled to what's remaining; open a shop only if you need to change something</span>
            </p>
            <div className="space-y-2 max-h-96 overflow-y-auto pr-1">
              {selectedShops.map((shop) => {
                const boards = (boardsByShop || {})[shop.shop_id] || [];
                const sel = selections[shop.shop_id];
                const shopTotal = boards.reduce((sum, b) => sum + (parseFloat(sel?.qtyByItem[b.work_item_id] || '0') || 0), 0);
                const isExpanded = expandedShopIds.has(shop.shop_id);
                const installerName = installers?.find((i) => i.id === sel?.installerId)?.full_name;
                return (
                  <div key={shop.shop_id} className="border border-slate-200 rounded-lg">
                    {/* Collapsed summary row — enough to verify the shop at a
                        glance on a trip with many shops. */}
                    <div className="w-full flex items-center gap-2 p-3">
                      <button
                        type="button"
                        onClick={() => toggleShopExpanded(shop.shop_id)}
                        className="flex items-center gap-2 min-w-0 flex-1 text-left"
                      >
                        <ChevronDown className={`w-4 h-4 text-slate-400 shrink-0 transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-semibold text-slate-800 truncate">{shop.shop_name}</p>
                          <p className="text-[11px] text-slate-400 truncate">
                            {installerName || <span className="text-amber-600 font-medium">Installer not set</span>}
                            {boards.length > 0 && (
                              <>
                                {' · '}
                                {boards.map((b) => `${b.work_type_name} ×${parseFloat(sel?.qtyByItem[b.work_item_id] || '0') || 0}`).join(', ')}
                              </>
                            )}
                          </p>
                        </div>
                        <span className="text-sm font-semibold text-slate-700 shrink-0">{shopTotal}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => toggleShop(shop.shop_id)}
                        className="text-xs font-medium text-red-600 hover:text-red-700 shrink-0 pl-2"
                      >
                        Remove
                      </button>
                    </div>

                    {isExpanded && (
                      <div className="px-3 pb-3">
                        <Select
                          label="Installer"
                          value={sel?.installerId || ''}
                          onChange={(v) => setInstaller(shop.shop_id, v)}
                          required
                          options={[{ value: '', label: 'Select installer...' }, ...(installers || []).map((i) => ({ value: i.id, label: i.full_name }))]}
                        />
                        <div className="mt-2 border border-slate-100 rounded-lg divide-y divide-slate-100">
                          {boardsLoading ? (
                            <div className="p-2"><div className="h-8 bg-slate-100 rounded animate-pulse" /></div>
                          ) : boards.length === 0 ? (
                            <p className="text-sm text-slate-400 py-2 px-2">No production-done boards found for this shop.</p>
                          ) : boards.map((b) => {
                            const remaining = Math.max(b.ready_qty - b.already_loaded, 0);
                            return (
                              <div key={b.work_item_id} className="flex items-center gap-3 px-2 py-2">
                                <div className="min-w-0 flex-1">
                                  <p className="text-sm text-slate-700 truncate">{b.work_type_name}{b.dims ? ` — ${b.dims}` : ''}</p>
                                  <p className="text-[11px] text-slate-400">Ready {b.ready_qty} · Already loaded {b.already_loaded} · Remaining {remaining}</p>
                                </div>
                                <input
                                  type="number" min="0" step="1"
                                  value={sel?.qtyByItem[b.work_item_id] ?? ''}
                                  onChange={(e) => setQty(shop.shop_id, b.work_item_id, e.target.value)}
                                  className="w-20 px-2 py-1.5 border border-slate-300 rounded-lg text-sm text-right focus:ring-2 focus:ring-blue-500 outline-none"
                                />
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <Textarea label="Trip Notes (optional)" value={notes} onChange={setNotes} placeholder="Anything Owner/Admin or the installers should know about this trip" rows={2} />

        {submitMutation.isError && <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-2">{(submitMutation.error as Error).message}</p>}

        <button
          onClick={() => submitMutation.mutate()}
          disabled={submitMutation.isPending || boardsLoading || selectedShopIdsArray.length < 2}
          className="w-full flex items-center justify-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white font-medium py-2.5 rounded-lg disabled:opacity-50"
        >
          <Truck className="w-4 h-4" /> {submitMutation.isPending ? 'Saving...' : `Confirm Trip — ${selectedShopIdsArray.length} Shop${selectedShopIdsArray.length === 1 ? '' : 's'}`}
        </button>
      </div>
    </Modal>
  );
}

function VehicleLoadHistoryModal({ shop, onClose }: { shop: VehicleLoadShopSummary; onClose: () => void }) {
  const { profile } = useAuth();
  const queryClient = useQueryClient();
  const canMarkDelivered = profile?.role === 'agency_owner' || profile?.role === 'admin' || profile?.role === 'printing' || profile?.role === 'demo';

  const { data: loads, isLoading } = useQuery({
    queryKey: ['vehicle-load-history', shop.shop_id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('vehicle_loads')
        .select('*, loaded_by_profile:profiles!vehicle_loads_loaded_by_fkey(full_name), installer_profile:profiles!vehicle_loads_installer_id_fkey(full_name), vehicle_load_items(*)')
        .eq('shop_id', shop.shop_id)
        .order('loaded_at', { ascending: false });
      if (error) throw new Error(error.message);
      return data as any[];
    },
  });

  const markDeliveredMutation = useMutation({
    mutationFn: async (loadId: string) => {
      if (!profile) return;
      const { error } = await supabase.from('vehicle_loads').update({ status: 'delivered', delivered_at: new Date().toISOString(), delivered_by: profile.id }).eq('id', loadId);
      if (error) throw new Error(error.message);
      await logAudit('vehicle_loads', loadId, 'update', 'status', 'loaded', 'delivered', `Vehicle load marked delivered for ${shop.shop_name}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['vehicle-load-history', shop.shop_id] });
      queryClient.invalidateQueries({ queryKey: ['vehicle-load-shops'] });
    },
  });

  return (
    <Modal open onClose={onClose} title={`Load History — ${shop.shop_name}`} size="lg">
      {isLoading ? (
        <div className="space-y-2">{Array.from({ length: 2 }).map((_, i) => <div key={i} className="h-16 bg-slate-100 rounded-lg animate-pulse" />)}</div>
      ) : !loads || loads.length === 0 ? (
        <p className="text-sm text-slate-400 py-4 text-center">No vehicle loads recorded yet.</p>
      ) : (
        <div className="space-y-3 max-h-[28rem] overflow-y-auto">
          {loads.map((l) => (
            <div key={l.id} className={`border rounded-lg p-3 ${l.status === 'cancelled' ? 'border-slate-200 bg-slate-50 opacity-60' : 'border-slate-200'}`}>
              <div className="flex items-center justify-between gap-2 mb-1.5">
                <div className="flex items-center gap-2">
                  <Truck className="w-4 h-4 text-slate-400" />
                  <span className="text-sm font-semibold text-slate-800">{l.vehicle_number}</span>
                  {l.driver_name && <span className="text-xs text-slate-400">· {l.driver_name}</span>}
                  {l.vehicle_trip_id && (
                    <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-700">
                      <Users className="w-3 h-3" /> Multi-shop trip
                    </span>
                  )}
                </div>
                <StatusBadge status={l.status} />
              </div>
              <p className="text-xs text-slate-500">
                For <span className="font-medium text-slate-700">{l.installer_profile?.full_name || '—'}</span> · Loaded by {l.loaded_by_profile?.full_name || '—'} · {new Date(l.loaded_at).toLocaleString('en-IN')}
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {(l.vehicle_load_items || []).map((it: any) => (
                  <span key={it.id} className="text-[11px] bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full">{it.work_type_name} ×{it.qty_loaded}</span>
                ))}
              </div>
              {l.notes && <p className="text-xs text-slate-500 mt-1.5 italic">"{l.notes}"</p>}
              {l.status === 'loaded' && canMarkDelivered && (
                <button
                  onClick={() => markDeliveredMutation.mutate(l.id)}
                  disabled={markDeliveredMutation.isPending}
                  className="mt-2 flex items-center gap-1.5 text-xs font-medium text-emerald-700 hover:text-emerald-800"
                >
                  <CheckCircle2 className="w-3.5 h-3.5" /> Mark Delivered
                </button>
              )}
              {l.status === 'delivered' && l.delivered_at && (
                <p className="mt-1.5 flex items-center gap-1 text-xs text-emerald-600"><CheckCircle2 className="w-3.5 h-3.5" /> Delivered {new Date(l.delivered_at).toLocaleString('en-IN')}</p>
              )}
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
