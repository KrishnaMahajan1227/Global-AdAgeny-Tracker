import { ReactNode, useEffect, useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { Card, StatusBadge, EmptyState, PageHeader, Modal, Textarea, Select, Input } from '@/components/ui';
import { VehicleLoadLogView } from '@/components/VehicleLoadLogView';
import { logAudit, createNotification } from '@/lib/helpers';
import { useRealtimeInvalidate } from '@/lib/useRealtimeInvalidate';
import { WorkItem, ProductionItem, WorkItemComponent, COMPONENT_STATUSES, VehicleLoadShopSummary, VehicleLoadStats } from '@/lib/types';
import { formatDim } from '@/lib/units';
import {
  Printer, ChevronRight, ChevronDown, ChevronLeft, Search, MapPin, Phone, User, Layers,
  CheckCircle2, Circle, MinusCircle, Pencil, Check, X, ListChecks,
  Plus, Trash2, AlertTriangle, Clock, Boxes, Loader2, Filter, ArrowUpDown,
  Factory, CheckCircle, LayoutList, PackageCheck, Send, Truck, LayoutGrid, PackageOpen,
  CircleDot, CircleCheck, Info, Users, CheckSquare, Square,
} from 'lucide-react';
import { Link } from 'react-router-dom';

// Work-item statuses relevant to the Production screen at all.
const PRODUCTION_ELIGIBLE_STATUSES = ['approved', 'design_approved', 'in_production', 'produced', 'production_done'];
// Statuses that mean this board is fully done and locked from further edits
// here (it's moved on to/through installation).
const BOARD_LOCKED_STATUSES = ['production_done', 'installed'];
const PAGE_SIZE = 20;

const TABS: { key: string; label: string; statuses: string[] | null; statKey: keyof ProductionStats | null }[] = [
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
};

// Full per-shop board + BOM detail, loaded on demand for exactly one
// order at a time (the expanded row / an open modal), never for the
// whole list.
type ProductionOrderDetail = {
  items: WorkItem[];
  productionItems: ProductionItem[];
  components: WorkItemComponent[];
};

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

function boardLabel(item: WorkItem) {
  const w = formatDim(item.approved_width ?? item.survey_width);
  const h = formatDim(item.approved_height ?? item.survey_height);
  const unit = item.approved_unit ?? item.survey_unit ?? 'ft';
  const dims = w && h ? `${w}×${h} ${unit}` : null;
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
  const { profile } = useAuth();
  const orgId = profile?.organization_id;
  const queryClient = useQueryClient();

  const canApprove = profile?.role === 'agency_owner' || profile?.role === 'admin' || profile?.role === 'demo';
  const isProduction = profile?.role === 'printing';
  const canLogProduction = isProduction || canApprove;
  const assignedFilterValue = isProduction ? profile!.id : null;

  // Three distinct screens sharing one page/flow — Overview (numbers at a
  // glance for Owner/Admin/Production alike), Production (the existing
  // per-board work list), and Vehicle Load (Production hands off finished
  // boards to an installer's vehicle). One click switches between them;
  // nothing here is a separate route, so there's no navigation dead-end.
  const [mainView, setMainView] = useState<'overview' | 'production' | 'vehicle_load'>('overview');
  const [activeTab, setActiveTab] = useState('all');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [zoneFilter, setZoneFilter] = useState('');
  const [poFilter, setPoFilter] = useState('');
  const [workTypeFilter, setWorkTypeFilter] = useState('');
  const [fulfillmentFilter, setFulfillmentFilter] = useState('');
  const [assignedFilter, setAssignedFilter] = useState(''); // owner/admin only
  const [sortBy, setSortBy] = useState<'attention' | 'oldest' | 'newest' | 'zone' | 'completion'>('attention');
  const [page, setPage] = useState(0);

  const [expandedOrderId, setExpandedOrderId] = useState<string | null>(null);
  const [expandedShopId, setExpandedShopId] = useState<string | null>(null);
  const [selectedOrderIds, setSelectedOrderIds] = useState<Set<string>>(new Set());

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
  const [itemQty, setItemQty] = useState('');
  const [itemNotes, setItemNotes] = useState('');

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
  }, [activeTab, debouncedSearch, zoneFilter, poFilter, workTypeFilter, fulfillmentFilter, assignedFilter, sortBy]);

  // ---- Lightweight, dedicated option lists for filter dropdowns — never
  // derived from the (paginated, filtered) orders list itself, so the
  // dropdowns always show every zone/PO/work-type the org has regardless
  // of what's on the current page or matches the current filters. ----
  const { data: zoneOptions } = useQuery({
    queryKey: ['production-filter-zones', orgId],
    queryFn: async () => {
      const { data, error } = await supabase.from('zones').select('id, name').eq('organization_id', orgId).order('name');
      if (error) throw new Error(error.message);
      return data as { id: string; name: string }[];
    },
    enabled: !!orgId,
  });
  const { data: poOptions } = useQuery({
    queryKey: ['production-filter-pos', orgId],
    queryFn: async () => {
      const { data, error } = await supabase.from('v_po_work_context').select('id, po_number, name').eq('organization_id', orgId).order('po_number');
      if (error) throw new Error(error.message);
      return data as { id: string; po_number: string; name: string | null }[];
    },
    enabled: !!orgId,
  });
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
    enabled: !!orgId && ((!!editOrder && isCompleting && !skipsInstaller) || !!bulkCompleteOrders),
  });

  const tab = TABS.find((t) => t.key === activeTab)!;
  const {
    data: listResult,
    isFetching: listFetching,
    isLoading: listLoading,
    isError: listIsError,
    error: listQueryError,
    refetch: refetchList,
  } = useQuery({
    queryKey: ['production-order-list', orgId, assignedFilterValue, activeTab, debouncedSearch, page, zoneFilter, poFilter, workTypeFilter, fulfillmentFilter, assignedFilter, sortBy],
    queryFn: async () => {
      let q = supabase.from('v_production_order_list').select('*', { count: 'exact' }).eq('organization_id', orgId);
      if (assignedFilterValue) q = q.eq('assigned_to', assignedFilterValue);
      else if (assignedFilter) q = q.eq('assigned_to', assignedFilter);
      if (activeTab === 'needs_materials') q = q.gt('materials_pending_boards', 0);
      else if (tab.statuses) q = q.in('status', tab.statuses);
      if (zoneFilter) q = q.eq('zone_id', zoneFilter);
      if (poFilter) q = q.eq('po_id', poFilter);
      if (workTypeFilter) q = q.contains('work_type_ids', [workTypeFilter]);
      if (fulfillmentFilter) q = q.eq('fulfillment_type', fulfillmentFilter);
      const term = debouncedSearch.replace(/[,%()]/g, ' ').trim();
      if (term) q = q.or(`shop_name.ilike.%${term}%,client_name.ilike.%${term}%,shop_city.ilike.%${term}%,shop_contact_phone.ilike.%${term}%,po_number.ilike.%${term}%,po_name.ilike.%${term}%`);

      if (sortBy === 'oldest') q = q.order('created_at', { ascending: true });
      else if (sortBy === 'newest') q = q.order('created_at', { ascending: false });
      else if (sortBy === 'zone') q = q.order('zone_name', { ascending: true, nullsFirst: false });
      else if (sortBy === 'completion') q = q.order('progress_pct', { ascending: false });
      else q = q.order('attention_rank', { ascending: true }).order('created_at', { ascending: false });

      q = q.range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
      const { data, error, count } = await q;
      if (error) throw new Error(error.message || 'Could not load production orders.');
      return { rows: (data || []) as ProductionOrderRow[], count: count || 0 };
    },
    enabled: !!orgId,
    placeholderData: keepPreviousData,
    retry: 1,
  });
  const rows = useMemo(() => listResult?.rows || [], [listResult]);
  const totalCount = listResult?.count || 0;
  const pageCount = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

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

  function openEditOrder(row: ProductionOrderRow) {
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
      const producedQty = Number(itemQty);
      if (itemQty === '' || isNaN(producedQty) || producedQty < 0) {
        throw new Error('Enter a valid produced quantity (0 or more).');
      }
      const { targetQty } = boardLabel(item);

      if (record) {
        const { error } = await supabase.from('production_items').update({ produced_qty: producedQty, notes: itemNotes || null }).eq('id', record.id).select('id');
        if (error) throw new Error(`Could not update production record: ${error.message}`);
      } else {
        const { error } = await supabase.from('production_items').insert({
          organization_id: orgId,
          production_order_id: row.production_order_id,
          work_item_id: item.id,
          requested_qty: targetQty,
          approved_qty: item.approved_quantity ?? null,
          produced_qty: producedQty,
          notes: itemNotes || null,
        });
        if (error) throw new Error(`Could not save production record: ${error.message}`);
      }

      const nextItemStatus = producedQty >= targetQty && componentsReady ? 'produced' : 'in_production';
      const { error: itemError } = await supabase
        .from('work_items')
        .update({ produced_quantity: producedQty, produced_notes: itemNotes || null, produced_at: new Date().toISOString(), status: nextItemStatus })
        .eq('id', item.id)
        .in('status', ['approved', 'design_approved', 'in_production', 'produced'])
        .select('id');
      if (itemError) throw new Error(`Could not update board status: ${itemError.message}`);

      if (row.status === 'pending') {
        const { error: orderError } = await supabase.from('production_orders').update({ status: 'in_production' }).eq('id', row.production_order_id).select('id');
        if (orderError) throw new Error(`Could not update order status: ${orderError.message}`);
      }

      await logAudit(
        'production_items', record?.id || null, record ? 'update' : 'insert', 'produced_qty',
        record?.produced_qty != null ? String(record.produced_qty) : null, String(producedQty),
        `${item.work_type_name || 'Board'} production logged (${producedQty}/${targetQty}) for ${row.shop_name}`
      );
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
  async function completeProductionOrder(row: ProductionOrderRow, installer: string) {
    const { error: orderError } = await supabase.from('production_orders').update({ status: 'completed', notes: form.notes || null }).eq('id', row.production_order_id).select('id');
    if (orderError) throw new Error(`Could not update production order: ${orderError.message}`);
    const { error: shopError } = await supabase.from('shops').update({ status: 'production_done' }).eq('id', row.shop_id).select('id');
    if (shopError) throw new Error(`Could not update shop status: ${shopError.message}`);
    const { error: itemsError } = await supabase
      .from('work_items').update({ status: 'production_done' }).eq('shop_id', row.shop_id)
      .in('status', ['approved', 'design_approved', 'in_production', 'produced']).select('id');
    if (itemsError) throw new Error(`Could not update board status: ${itemsError.message}`);

    await logAudit('production_orders', row.production_order_id, 'update', 'status', row.status, 'completed', `Production completed for ${row.shop_name}`);

    if (row.fulfillment_type === 'supply_only') {
      const { error: destSyncError } = await supabase.from('supply_destinations').update({ status: 'packed' }).eq('shop_id', row.shop_id);
      if (destSyncError) console.error('[ProductionPage] could not sync supply_destinations on packing (non-fatal):', destSyncError.message);
      return;
    }

    // §3.4 "custom" scope — this PO line item never asked for
    // installation (design+production only, or re-servicing boards
    // already on-site). Skip installer assignment entirely and mark the
    // shop/boards straight through to 'installed' — the same terminal
    // status a real install would reach, so Billing (which already
    // treats 'installed' as billable) needs no separate handling.
    if (row.requires_installation_all_false) {
      const { error: shopInstalledError } = await supabase.from('shops').update({ status: 'installed' }).eq('id', row.shop_id).select('id');
      if (shopInstalledError) throw new Error(`Could not finalize shop status: ${shopInstalledError.message}`);
      const { error: itemsInstalledError } = await supabase
        .from('work_items').update({ status: 'installed' }).eq('shop_id', row.shop_id)
        .eq('status', 'production_done').select('id');
      if (itemsInstalledError) throw new Error(`Could not finalize board status: ${itemsInstalledError.message}`);
      await logAudit('shops', row.shop_id, 'update', 'status', 'production_done', 'installed', `Installation not required for ${row.shop_name} (PO line item scope) — auto-completed after production`);
      return;
    }

    const { data: existingAssignments } = await supabase.from('shop_assignments').select('user_id, status').eq('shop_id', row.shop_id).eq('role', 'installer');
    const alreadyAssigned = (existingAssignments || []).some((a) => a.user_id === installer && a.status !== 'declined');
    if (!alreadyAssigned) {
      const { error: assignError } = await supabase.from('shop_assignments').insert({
        organization_id: row.organization_id, shop_id: row.shop_id, user_id: installer, role: 'installer', status: 'assigned',
      });
      if (assignError) throw new Error(`Could not assign installer: ${assignError.message}`);
    }
    const notifyIds = new Set([installer, ...(existingAssignments || []).filter((a) => a.status !== 'declined').map((a) => a.user_id)]);
    for (const userId of notifyIds) {
      await createNotification(userId, 'Ready for Installation', `Production completed for ${row.shop_name}`, 'info', '/installation');
    }
  }

  const updateMutation = useMutation({
    mutationFn: async () => {
      if (!editOrder) return;
      if (form.status === 'completed' && !installerId && !skipsInstaller) {
        throw new Error('Pick an installer to assign before marking production completed.');
      }
      if (form.status === 'completed' && editOrder.pending_boards > 0 && !form.forceComplete) {
        throw new Error(`${editOrder.pending_boards} board(s) on this shop still have no production logged. Log them above, or tick "Mark completed anyway" to override.`);
      }
      if (form.status === 'completed') {
        await completeProductionOrder(editOrder, installerId);
        return;
      }
      const { error: orderError } = await supabase.from('production_orders').update({ status: form.status, notes: form.notes || null }).eq('id', editOrder.production_order_id).select('id');
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

  // Bulk status change (In Production / Ready / On Hold) — both roles can
  // use this; it never touches "completed" (that stays a deliberate,
  // per-batch decision via bulk complete below, never a drive-by status
  // pick that could skip installer assignment or the pending-boards
  // check).
  const bulkStatusMutation = useMutation({
    mutationFn: async ({ selected, status }: { selected: ProductionOrderRow[]; status: string }) => {
      const failures: string[] = [];
      for (const row of selected) {
        try {
          const { error } = await supabase.from('production_orders').update({ status }).eq('id', row.production_order_id).select('id');
          if (error) throw new Error(error.message);
          await logAudit('production_orders', row.production_order_id, 'update', 'status', row.status, status, `Production ${status} for ${row.shop_name} (bulk)`);
        } catch (err) {
          failures.push(`${row.shop_name}: ${(err as Error).message}`);
        }
      }
      if (failures.length > 0) throw new Error(`${selected.length - failures.length}/${selected.length} updated. Failed — ${failures.join('; ')}`);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['production-order-list', orgId] });
      queryClient.invalidateQueries({ queryKey: ['production-order-stats', orgId] });
      setSelectedOrderIds(new Set());
      setBulkStatusOrders(null);
    },
  });

  // Bulk complete — owner/admin only. Only ever acts on the selected
  // orders that actually have zero pending boards; anything still short
  // is skipped and named in the result rather than silently force-
  // completed, so a batch action can never quietly cover for a board that
  // was never actually logged as produced.
  const bulkCompleteMutation = useMutation({
    mutationFn: async ({ selected, installer }: { selected: ProductionOrderRow[]; installer: string }) => {
      const eligible = selected.filter((r) => r.pending_boards === 0);
      const skipped = selected.filter((r) => r.pending_boards > 0);
      if (eligible.length === 0) {
        throw new Error('None of the selected orders are fully produced yet — nothing to complete.');
      }
      const failures: string[] = [];
      for (const row of eligible) {
        try {
          await completeProductionOrder(row, (row.fulfillment_type === 'supply_only' || row.requires_installation_all_false) ? '' : installer);
        } catch (err) {
          failures.push(`${row.shop_name}: ${(err as Error).message}`);
        }
      }
      const notes: string[] = [];
      if (skipped.length > 0) notes.push(`Skipped (still has pending boards): ${skipped.map((s) => s.shop_name).join(', ')}`);
      if (failures.length > 0) notes.push(`Failed: ${failures.join('; ')}`);
      if (notes.length > 0) throw new Error(`${eligible.length - failures.length}/${selected.length} completed. ${notes.join(' — ')}`);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['production-order-list', orgId] });
      queryClient.invalidateQueries({ queryKey: ['production-order-stats', orgId] });
      queryClient.invalidateQueries({ queryKey: ['shops'] });
      queryClient.invalidateQueries({ queryKey: ['nav-pending-counts', orgId] });
      setSelectedOrderIds(new Set());
      setBulkCompleteOrders(null);
      setBulkInstallerId('');
    },
  });

  const activeFilterCount = [poFilter, zoneFilter, workTypeFilter, fulfillmentFilter, assignedFilter].filter(Boolean).length;
  function clearAllFilters() {
    setPoFilter('');
    setZoneFilter('');
    setWorkTypeFilter('');
    setFulfillmentFilter('');
    setAssignedFilter('');
  }

  return (
    <div>
      <PageHeader title="Production Studio" subtitle="What's ready, what's in production, and what's gone out — per board, per shop" />

      {/* Three screens, one flow. Overview = numbers at a glance.
          Production = the per-board work list (unchanged from before).
          Vehicle Load = Production hands finished boards to an
          installer's vehicle, so Owner/Admin can see exactly how much is
          ready vs. how much has actually gone out and to whom. */}
      <div className="flex gap-1.5 mb-5 border-b border-slate-200">
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
              className={`flex items-center gap-2 px-4 py-2.5 text-sm font-semibold border-b-2 -mb-px transition ${
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

      {/* Filters + search — every option list here is its own small,
          dedicated query (zones/POs/work types/team), never derived from
          the orders on screen, so filters stay complete and accurate no
          matter how the list itself is currently filtered or paged. */}
      <Card className="p-3.5 mb-4">
        <div className="relative mb-3">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by shop, client, city, phone, or PO number..."
            className="w-full pl-9 pr-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
          />
          {listFetching && !listLoading && <Loader2 className="w-3.5 h-3.5 text-slate-300 animate-spin absolute right-3 top-1/2 -translate-y-1/2" />}
        </div>

        <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400 mb-1.5">
          <Filter className="w-3.5 h-3.5" /> Filters
        </div>
        <div className={`grid grid-cols-2 sm:grid-cols-3 ${canApprove ? 'lg:grid-cols-5' : 'lg:grid-cols-4'} gap-2.5 mb-3`}>
          <LabeledSelect label="Fulfillment" value={fulfillmentFilter} onChange={setFulfillmentFilter}>
            <option value="">All types</option>
            <option value="survey_install">Survey + Install</option>
            <option value="supply_only">Supply Only</option>
          </LabeledSelect>
          <LabeledSelect label="Purchase Order" value={poFilter} onChange={setPoFilter}>
            <option value="">All POs</option>
            {(poOptions || []).map((p) => <option key={p.id} value={p.id}>{p.name ? `${p.name} (${p.po_number})` : p.po_number}</option>)}
          </LabeledSelect>
          <LabeledSelect label="Zone" value={zoneFilter} onChange={setZoneFilter}>
            <option value="">All zones</option>
            {(zoneOptions || []).map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
          </LabeledSelect>
          <LabeledSelect label="Work Type" value={workTypeFilter} onChange={setWorkTypeFilter}>
            <option value="">All work types</option>
            {(workTypeOptions || []).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </LabeledSelect>
          {/* "Assigned To" is management-only — a production teammate's own
              session is already scoped to just their orders, so picking a
              different person here would be a no-op for them. */}
          {canApprove && (
            <LabeledSelect label="Assigned To" value={assignedFilter} onChange={setAssignedFilter}>
              <option value="">Everyone</option>
              {(productionTeam || []).map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}
            </LabeledSelect>
          )}
        </div>

        <div className="flex flex-wrap items-end gap-2.5 pt-3 border-t border-slate-100">
          <div className="flex-1 min-w-[200px]">
            <label className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400 mb-1">
              <ArrowUpDown className="w-3.5 h-3.5" /> Sort
            </label>
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
              className="w-full px-2.5 py-1.5 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none bg-white"
            >
              <option value="attention">Needs attention first</option>
              <option value="oldest">Oldest pending first</option>
              <option value="newest">Newest first</option>
              <option value="zone">Zone (for batching)</option>
              <option value="completion">% complete</option>
            </select>
          </div>
          {activeFilterCount > 0 && (
            <button onClick={clearAllFilters} className="flex items-center gap-1 text-xs font-medium text-slate-500 hover:text-blue-600 px-2.5 py-1.5">
              <X className="w-3.5 h-3.5" /> Clear {activeFilterCount} filter{activeFilterCount > 1 ? 's' : ''}
            </button>
          )}
          <span className="text-xs text-slate-400 sm:ml-auto">{totalCount} order{totalCount === 1 ? '' : 's'}</span>
        </div>
      </Card>

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

      {/* Bulk toolbar */}
      {selectedOrderIds.size > 0 && (() => {
        const selected = rows.filter((r) => selectedOrderIds.has(r.production_order_id));
        return (
          <div className="mb-4 flex items-center gap-2 flex-wrap bg-indigo-50 border border-indigo-200 rounded-lg px-3 py-2.5">
            <span className="text-sm font-medium text-indigo-900">{selected.length} selected</span>
            <button onClick={() => setSelectedOrderIds(new Set())} className="text-xs text-indigo-600 hover:underline">Clear</button>
            <div className="ml-auto flex items-center gap-2 flex-wrap">
              <button
                onClick={() => { setBulkStatusOrders(selected); setBulkStatus('in_production'); }}
                className="flex items-center gap-1 bg-white border border-indigo-200 text-indigo-700 px-2.5 py-1.5 rounded-lg text-xs font-medium"
              >
                <Send className="w-3.5 h-3.5" /> Change Status
              </button>
              {canApprove && (
                <button
                  onClick={() => { setBulkCompleteOrders(selected); setBulkInstallerId(''); }}
                  className="flex items-center gap-1 bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-1.5 rounded-lg text-xs font-medium"
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
            return (
              <div key={row.production_order_id} className={`border-l-4 ${STATUS_BORDER[row.status] || 'border-l-slate-300'}`}>
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => toggleExpand(row)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleExpand(row); } }}
                  className="w-full text-left pl-3 pr-4 py-3 flex items-center gap-3 hover:bg-slate-50 transition cursor-pointer"
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
                  <div className="shrink-0 w-11 h-11 rounded-lg bg-slate-50 border border-slate-200 flex flex-col items-center justify-center">
                    <span className="text-xs font-bold text-slate-700 leading-none">{row.done_boards}/{row.total_boards || 0}</span>
                    <span className="text-[8px] text-slate-400 mt-0.5">boards</span>
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
                      <div className={`h-1.5 transition-all ${row.progress_pct === 100 ? 'bg-emerald-500' : 'bg-blue-500'}`} style={{ width: `${row.progress_pct}%` }} />
                    </div>
                    <p className="text-[10px] text-slate-400 mt-1 text-right">{row.progress_pct}%</p>
                  </div>

                  {/* Quick status change — right here on the row, so
                      updating an order never requires opening it, scrolling
                      through its boards, and finding the button at the
                      bottom. That's the whole point of this redesign. */}
                  <button
                    onClick={(e) => { e.stopPropagation(); openEditOrder(row); }}
                    className="shrink-0 flex items-center gap-1 bg-blue-600 hover:bg-blue-700 text-white px-2.5 py-1.5 rounded-lg text-xs font-medium"
                  >
                    <Send className="w-3.5 h-3.5" /> Status
                  </button>

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

                    {detailLoading ? (
                      <div className="flex items-center gap-2 text-sm text-slate-400 py-6 justify-center">
                        <Loader2 className="w-4 h-4 animate-spin" /> Loading boards & materials…
                      </div>
                    ) : boards.length > 0 ? (
                      <div className="mb-3 border border-slate-200 rounded-lg overflow-hidden bg-white divide-y divide-slate-100">
                        {boards.map((entry) => {
                          const { item, targetQty, producedQty, locked, isDone, isPartial, comps, componentsReady, qtyMet } = entry;
                          const isEditing = editingItem?.orderId === row.production_order_id && editingItem?.itemId === item.id;
                          // Auto-open the materials checklist for a board
                          // that's actually blocked on it, so the person
                          // sees exactly what's missing without an extra
                          // tap; a board with no issues stays collapsed.
                          const needsAttentionOpen = qtyMet && !componentsReady;
                          const bomOpen = expandedBom.has(item.id) || needsAttentionOpen;
                          const readyCount = comps.filter((c) => c.status === 'ready').length;
                          return (
                            <div key={item.id} className="px-3 py-2.5 text-sm">
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
                      <p className="text-xs text-slate-400 mb-3 italic">No approved boards found for this shop yet.</p>
                    )}

                    <div className="flex gap-2">
                      <Link to={`/shops/${row.shop_id}`} className="text-sm text-blue-600 hover:underline mr-auto flex items-center gap-1">
                        Shop Details <ChevronRight className="w-4 h-4" />
                      </Link>
                      <button onClick={() => openEditOrder(row)} className="bg-blue-600 text-white px-3 py-1.5 rounded-lg text-sm font-medium">
                        Update Order Status
                      </button>
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
              <LayoutList className="w-3.5 h-3.5" /> Showing {page * PAGE_SIZE + 1}–{Math.min(totalCount, page * PAGE_SIZE + PAGE_SIZE)} of {totalCount}
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
                    value={installerId}
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
            disabled={updateMutation.isPending || (isCompleting && !installerId && !skipsInstaller)}
            className="w-full bg-blue-600 text-white font-medium py-2.5 rounded-lg disabled:opacity-50"
          >
            {updateMutation.isPending ? 'Updating...' : 'Update'}
          </button>
        </div>
      </Modal>

      {/* Bulk status change */}
      <Modal open={!!bulkStatusOrders} onClose={() => setBulkStatusOrders(null)} title="Change Status">
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
            disabled={bulkStatusMutation.isPending}
            className="w-full bg-blue-600 text-white font-medium py-2.5 rounded-lg disabled:opacity-50"
          >
            {bulkStatusMutation.isPending ? 'Updating...' : `Update ${bulkStatusOrders?.length || ''} Order(s)`}
          </button>
        </div>
      </Modal>

      {/* Bulk complete */}
      <Modal open={!!bulkCompleteOrders} onClose={() => { setBulkCompleteOrders(null); setBulkInstallerId(''); }} title="Complete Production">
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
                      value={bulkInstallerId}
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
                  onClick={() => bulkCompleteOrders && bulkCompleteMutation.mutate({ selected: bulkCompleteOrders, installer: bulkInstallerId })}
                  disabled={bulkCompleteMutation.isPending || eligible.length === 0 || (anyNeedsInstaller && !bulkInstallerId)}
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
            {needsLoadAttention} shop{needsLoadAttention > 1 ? 's have' : ' has'} ready material not (fully) loaded into a vehicle yet — kuch missing na ho, check karo.
            <ChevronRight className="w-4 h-4 ml-auto shrink-0" />
          </button>
        )}
        {vehicleLoadStats && needsLoadAttention === 0 && (vehicleLoadStats.shops_loaded > 0) && (
          <p className="flex items-center gap-2 text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3.5 py-2.5">
            <CheckCircle2 className="w-4 h-4 shrink-0" /> Sab kuch loaded hai — every ready shop's material has been fully handed off to an installer's vehicle.
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
