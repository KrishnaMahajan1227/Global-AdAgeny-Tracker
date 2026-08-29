import { useState, useRef, useMemo, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSearchParams, Link } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import {
  Modal, ConfirmDialog, Card, Input, Select, Textarea, StatusBadge, EmptyState, PageHeader, ProgressBar,
  FilterButton, FilterDrawer, FilterSection, Drawer, Pagination,
} from '@/components/ui';
import { PurchaseOrder, POLineItem, POLineItemUtilization, Campaign, Zone, RateCard } from '@/lib/types';
import { logAudit, notifyLinkedOrg } from '@/lib/helpers';
import { useRealtimeInvalidate } from '@/lib/useRealtimeInvalidate';
import { computeUtilization, formatQty, formatRupees, isAreaUom, getActualForStage, UtilizationStage } from '@/lib/poUtilization';
import { DonutChart } from '@/components/DonutChart';
import {
  Plus, Pencil, Trash2, ShoppingCart, FileText, Upload, X, Loader2, IndianRupee, ListChecks, AlertTriangle, TrendingUp, ChevronDown,
  Inbox, Check, XCircle, Building2, Store, Ban, ChevronRight, Calendar, Layers,
} from 'lucide-react';

const UOM_OPTIONS = [
  { value: 'sqft', label: 'Sq.ft' },
  { value: 'piece', label: 'Piece' },
  { value: 'lot', label: 'Lot' },
];

const FULFILLMENT_OPTIONS = [
  { value: 'survey_install', label: 'Survey + Install' },
  { value: 'supply_only', label: 'Supply Only' },
];

const emptyPoForm = {
  client_id: '', project_id: '', po_number: '', name: '', po_date: '', fulfillment_type: 'survey_install',
  notes: '', payment_terms: '', gst_percentage: '',
};

const emptyLineForm = { work_type_id: '', description: '', uom: 'sqft', budgeted_qty: '', budgeted_area: '', rate: '', hsn_code: '' };

const PO_PAGE_SIZES = [10, 25, 50, 100];

const PO_STATUS_LABELS: Record<string, string> = { active: 'Active', closed: 'Closed', cancelled: 'Cancelled' };

type PoRow = PurchaseOrder & {
  clients: { name: string } | null;
  projects: { name: string } | null;
  campaigns: { name: string } | null;
  po_line_items: { id: string; budgeted_area: number | null; budgeted_qty: number | null }[];
  client_org: { name: string } | null;
};

/** Every derived number a Work Order row (or its detail drawer) needs —
 *  computed once here from the shared utilization rollup so the compact
 *  table row and the full detail drawer never show two different answers
 *  for "how complete is this PO". */
function getPoMetrics(po: PoRow, utilization: POLineItemUtilization[]) {
  const lineCount = po.po_line_items?.length || 0;
  const poRows = utilization.filter((r) => r.purchase_order_id === po.id);
  const stage: UtilizationStage = po.fulfillment_type === 'supply_only' ? 'produced' : 'installed';
  let budgetedAmount = 0;
  let invoicedAmount = 0;
  let hasBudget = false;
  let anyVariance = false;
  let completionWeightedSum = 0;
  let completionWeightBase = 0;
  for (const row of poRows) {
    const fig = computeUtilization(row, stage);
    if (fig.budgetedAmount != null) {
      budgetedAmount += fig.budgetedAmount;
      hasBudget = true;
      // Weight each line item's own % complete (installed/produced vs its
      // budgeted qty) by that item's rupee value, so a PO mixing e.g.
      // sqft foam sheet and piece-count poles still gets one meaningful
      // "how much of this PO is done" number.
      if (fig.utilizationPct != null) {
        completionWeightedSum += fig.utilizationPct * fig.budgetedAmount;
        completionWeightBase += fig.budgetedAmount;
      }
    }
    invoicedAmount += fig.invoicedAmount;
    if (fig.hasVariance) anyVariance = true;
  }
  const balance = hasBudget ? budgetedAmount - invoicedAmount : null;
  const invoicedPct = hasBudget && budgetedAmount > 0 ? (invoicedAmount / budgetedAmount) * 100 : null;
  const completionPct = completionWeightBase > 0 ? completionWeightedSum / completionWeightBase : null;
  const campaignName = po.projects?.name || po.campaigns?.name || null;
  return { lineCount, poRows, stage, budgetedAmount, invoicedAmount, hasBudget, anyVariance, balance, invoicedPct, completionPct, campaignName };
}

/** The single, primary status a row/drawer leads with — a client-assigned
 *  PO still waiting on Accept/Reject is more important to surface than its
 *  underlying 'active' status, so that takes priority when applicable. */
function getPrimaryStatus(po: PoRow): { status: string; label: string } {
  if (po.origin === 'client_created') {
    if (po.assignment_status === 'pending_acceptance') return { status: 'in_review', label: 'Awaiting Response' };
    if (po.assignment_status === 'rejected') return { status: 'rejected', label: 'Declined' };
  }
  return { status: po.status, label: PO_STATUS_LABELS[po.status] || po.status };
}

export default function PurchaseOrdersPage() {
  const { profile } = useAuth();
  const orgId = profile?.organization_id;
  const queryClient = useQueryClient();
  const canDelete = profile?.role === 'agency_owner' || profile?.role === 'admin';

  // /purchase-orders?campaign=<client campaign id>  or  ?project=<agency campaign id>
  // — landed on from the Campaigns page's "Work Orders" link, so this list
  // opens pre-filtered to just that campaign's Work Orders.
  const [searchParams] = useSearchParams();
  const campaignFilter = searchParams.get('campaign');
  const projectFilter = searchParams.get('project');

  const [modalOpen, setModalOpen] = useState(false);
  const [editPo, setEditPo] = useState<PurchaseOrder | null>(null);
  const [deletePo, setDeletePo] = useState<PurchaseOrder | null>(null);
  const [form, setForm] = useState(emptyPoForm);
  const [file, setFile] = useState<File | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [clientFilter, setClientFilter] = useState('');
  const [fulfillmentFilter, setFulfillmentFilter] = useState('');
  // Combined "Campaign" filter value — either `proj:<project id>` (this
  // agency's own campaign) or `camp:<client campaign id>` (a client's
  // campaign), since a PO's campaign grouping can be either depending on
  // origin, and the person filtering shouldn't have to know which.
  const [campaignFilterValue, setCampaignFilterValue] = useState('');
  const [zoneFilter, setZoneFilter] = useState('');
  const [sortBy, setSortBy] = useState('date_desc');
  const [filterDrawerOpen, setFilterDrawerOpen] = useState(false);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(PO_PAGE_SIZES[1]);

  const [lineItemsPo, setLineItemsPo] = useState<PurchaseOrder | null>(null);
  const [detailPoId, setDetailPoId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: 'error' | 'success'; message: string } | null>(null);

  useEffect(() => {
    setPage(0);
  }, [search, statusFilter, clientFilter, fulfillmentFilter, campaignFilterValue, zoneFilter, sortBy, pageSize]);

  useRealtimeInvalidate(['purchase_orders', 'po_line_items', 'work_items', 'invoice_items'], orgId, [
    ['purchase_orders', orgId],
    ['po-utilization', orgId],
  ]);

  const { data: clients } = useQuery({
    queryKey: ['clients', orgId],
    queryFn: async () => {
      const { data } = await supabase.from('clients').select('id, name').eq('organization_id', orgId).eq('is_active', true).order('name');
      return data || [];
    },
    enabled: !!orgId,
  });

  const { data: projects } = useQuery({
    queryKey: ['projects', orgId, form.client_id],
    queryFn: async () => {
      const { data } = await supabase.from('projects').select('id, name, client_id').eq('organization_id', orgId).order('name');
      return data || [];
    },
    enabled: !!orgId,
  });

  const { data: pos } = useQuery({
    queryKey: ['purchase_orders', orgId],
    queryFn: async () => {
      // client_org — hydrated so a Client-Assigned PO can show the client
      // organization's name (Client Requests inbox + Origin badge below).
      // Safe to select thanks to the orgs_select RLS branch added in
      // migration 0038 (an agency can see the org on the other side of
      // its own client_agency_links rows).
      const { data, error } = await supabase
        .from('purchase_orders')
        .select('*, clients(name), projects(name), campaigns(name), po_line_items(id, budgeted_area, budgeted_qty), client_org:organizations!purchase_orders_client_org_id_fkey(name)')
        .eq('organization_id', orgId)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data as PoRow[];
    },
    enabled: !!orgId,
  });

  // Shop counts per Work Order — a narrow, single-column projection (not
  // full shop rows) used only to decide whether a Work Order is safe to
  // permanently delete (never used on any shop yet) or must be kept as a
  // record and merely cancelled (already has shops/history against it).
  // Also doubles as the source for the Zone filter below — same query,
  // just reading zone_id off the same narrow projection instead of a
  // second round-trip.
  const { data: poShopLinks } = useQuery({
    queryKey: ['po-shop-links', orgId],
    queryFn: async () => {
      const { data, error } = await supabase.from('shops').select('purchase_order_id, zone_id').eq('organization_id', orgId).not('purchase_order_id', 'is', null);
      if (error) throw error;
      return data as { purchase_order_id: string; zone_id: string | null }[];
    },
    enabled: !!orgId,
  });
  const shopCountByPo = useMemo(() => {
    const map = new Map<string, number>();
    for (const row of poShopLinks || []) {
      map.set(row.purchase_order_id, (map.get(row.purchase_order_id) || 0) + 1);
    }
    return map;
  }, [poShopLinks]);
  // Which zone(s) each Work Order's shops actually fall in — a PO has no
  // zone of its own, its shops do, so "zone-wise" filtering here means
  // "does this Work Order have at least one shop in the selected zone".
  const zoneIdsByPo = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const row of poShopLinks || []) {
      if (!row.zone_id) continue;
      const set = map.get(row.purchase_order_id) || new Set<string>();
      set.add(row.zone_id);
      map.set(row.purchase_order_id, set);
    }
    return map;
  }, [poShopLinks]);

  const { data: zones } = useQuery({
    queryKey: ['zones', orgId],
    queryFn: async () => {
      const { data, error } = await supabase.from('zones').select('id, name').eq('organization_id', orgId).order('name');
      if (error) throw error;
      return data as Pick<Zone, 'id' | 'name'>[];
    },
    enabled: !!orgId,
  });

  // Client-owned campaigns with at least one Work Order assigned to this
  // agency (RLS already scopes this) — combined with `projects` (this
  // agency's own campaigns) below to build one unified Campaign filter,
  // the same way the agency's own Campaigns page does.
  const { data: clientCampaigns } = useQuery({
    queryKey: ['client-campaigns', orgId],
    queryFn: async () => {
      const { data, error } = await supabase.from('campaigns').select('id, name').order('name');
      if (error) throw error;
      return data as Pick<Campaign, 'id' | 'name'>[];
    },
    enabled: !!orgId,
  });

  // A Work Order's "Campaign" is whichever grouping it actually has: the
  // client's own campaign for a client-assigned PO (campaign_id), or this
  // agency's own campaign for one created in-house (project_id). At most
  // one of the two is ever set on a given PO.
  const scopedPos = (pos || []).filter((po) => {
    if (campaignFilter) return po.campaign_id === campaignFilter;
    if (projectFilter) return po.project_id === projectFilter;
    return true;
  });

  const filteredPos = scopedPos.filter((po) => {
    if (search) {
      const term = search.toLowerCase();
      const matches = po.po_number.toLowerCase().includes(term) || (po.name || '').toLowerCase().includes(term) || (po.clients?.name || '').toLowerCase().includes(term);
      if (!matches) return false;
    }
    if (statusFilter && po.status !== statusFilter) return false;
    if (clientFilter && po.client_id !== clientFilter) return false;
    if (fulfillmentFilter && po.fulfillment_type !== fulfillmentFilter) return false;
    if (campaignFilterValue) {
      const [kind, id] = campaignFilterValue.split(':');
      if (kind === 'proj' && po.project_id !== id) return false;
      if (kind === 'camp' && po.campaign_id !== id) return false;
    }
    if (zoneFilter && !(zoneIdsByPo.get(po.id)?.has(zoneFilter))) return false;
    return true;
  });

  const visiblePos = [...filteredPos].sort((a, b) => {
    switch (sortBy) {
      case 'date_asc':
        return new Date(a.po_date).getTime() - new Date(b.po_date).getTime();
      case 'po_number_asc':
        return a.po_number.localeCompare(b.po_number);
      case 'client_asc':
        return (a.clients?.name || '').localeCompare(b.clients?.name || '');
      case 'amount_desc':
        return (b.total_amount || 0) - (a.total_amount || 0);
      case 'date_desc':
      default:
        return new Date(b.po_date).getTime() - new Date(a.po_date).getTime();
    }
  });

  const totalPos = visiblePos.length;
  const totalPages = Math.max(1, Math.ceil(totalPos / pageSize));
  const currentPage = Math.min(page, totalPages - 1);
  const pagedPos = visiblePos.slice(currentPage * pageSize, currentPage * pageSize + pageSize);

  const activeFilterCount = [statusFilter, clientFilter, fulfillmentFilter, campaignFilterValue, zoneFilter].filter(Boolean).length;
  const SORT_OPTIONS = [
    { value: 'date_desc', label: 'Order Date (Newest first)' },
    { value: 'date_asc', label: 'Order Date (Oldest first)' },
    { value: 'po_number_asc', label: 'Work Order No. (A–Z)' },
    { value: 'client_asc', label: 'Client (A–Z)' },
    { value: 'amount_desc', label: 'Amount (Highest first)' },
  ];

  // Combined dropdown options for the Campaign filter — this agency's own
  // campaigns (projects) first, then client campaigns, each tagged so the
  // filter logic above knows which PO field to match against.
  const campaignFilterOptions = [
    ...(projects || []).map((p) => ({ value: `proj:${p.id}`, label: p.name, group: 'My Campaigns' })),
    ...(clientCampaigns || []).map((c) => ({ value: `camp:${c.id}`, label: c.name, group: 'Client Campaigns' })),
  ];

  // Client Requests inbox — POs a linked Client Organization created and
  // assigned to this agency, still waiting on Accept/Reject (doc section
  // 5 + 6, Phase 2). Client-created POs already land in the query above
  // (organization_id = this agency, enforced by the 0037 insert RLS), so
  // this is just a client-side filter, not a separate fetch.
  const clientRequests = (pos || []).filter((po) => po.origin === 'client_created' && po.assignment_status === 'pending_acceptance');

  const respondMutation = useMutation({
    mutationFn: async ({ po, decision }: { po: PurchaseOrder & { client_org: { name: string } | null }; decision: 'accepted' | 'rejected' }) => {
      const { error } = await supabase.from('purchase_orders').update({ assignment_status: decision }).eq('id', po.id);
      if (error) throw error;
      await logAudit('purchase_orders', po.id, 'update', 'assignment_status', 'pending_acceptance', decision, `${decision === 'accepted' ? 'Accepted' : 'Rejected'} client PO ${po.po_number}`);
      if (po.client_org_id) {
        await notifyLinkedOrg(
          po.client_org_id,
          decision === 'accepted' ? 'PO Accepted' : 'PO Declined',
          decision === 'accepted'
            ? `Your PO ${po.po_number} was accepted and work has started.`
            : `Your PO ${po.po_number} was declined by the agency.`,
          decision === 'accepted' ? 'approval' : 'warning',
          null
        );
      }
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['purchase_orders', orgId] }),
    onSuccess: (_data, { po, decision }) => {
      setNotice({ kind: 'success', message: `Work Order ${po.po_number} ${decision === 'accepted' ? 'accepted' : 'declined'}.` });
    },
    onError: (err: Error) => {
      setNotice({ kind: 'error', message: err.message || 'Could not respond to this Work Order. Please try again.' });
    },
  });

  // Phase 6 — PO Utilization: budgeted vs surveyed/approved/produced/installed
  // vs invoiced, per line item. Backed by v_po_line_item_utilization
  // (migration 0025), which does the rollup math in SQL so it stays in
  // sync with work_items/invoice_items without extra client-side joins.
  const { data: utilization } = useQuery({
    queryKey: ['po-utilization', orgId],
    queryFn: async () => {
      const { data, error } = await supabase.from('v_po_line_item_utilization').select('*');
      if (error) throw error;
      return data as POLineItemUtilization[];
    },
    enabled: !!orgId,
  });

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!orgId) return null;
      let storage_path: string | null = editPo?.storage_path || null;
      let file_url: string | null = editPo?.file_url || null;

      if (file) {
        const path = `${orgId}/${Date.now()}-${file.name}`;
        const { error: uploadError } = await supabase.storage.from('purchase-orders').upload(path, file);
        if (uploadError) throw new Error(`Could not upload PO file: ${uploadError.message}`);
        const { data: urlData } = supabase.storage.from('purchase-orders').getPublicUrl(path);
        storage_path = path;
        file_url = urlData.publicUrl;
      }

      // total_amount is NOT sent here — it's derived automatically from
      // this PO's line items (budgeted qty/area x rate) by a DB trigger
      // (migration 0026), so the header and line items can never drift
      // out of sync the way they could when both were typed by hand.
      const payload = {
        organization_id: orgId,
        client_id: form.client_id,
        project_id: form.project_id || null,
        po_number: form.po_number,
        name: form.name || null,
        po_date: form.po_date,
        fulfillment_type: form.fulfillment_type,
        notes: form.notes || null,
        payment_terms: form.payment_terms || null,
        gst_percentage: form.gst_percentage ? Number(form.gst_percentage) : null,
        storage_path,
        file_url,
      };

      if (editPo) {
        const { error } = await supabase.from('purchase_orders').update(payload).eq('id', editPo.id);
        if (error) throw error;
        await logAudit('purchase_orders', editPo.id, 'update', null, null, null, `Updated PO ${form.po_number}`);
        return null;
      } else {
        const { data, error } = await supabase.from('purchase_orders').insert({ ...payload, created_by: profile?.id }).select().single();
        if (error) throw error;
        await logAudit('purchase_orders', data.id, 'insert', null, null, null, `Created PO ${form.po_number}`);
        return data as PurchaseOrder;
      }
    },
    onSuccess: (createdPo) => {
      queryClient.invalidateQueries({ queryKey: ['purchase_orders', orgId] });
      setModalOpen(false);
      setFile(null);
      setNotice({ kind: 'success', message: editPo ? `Work Order ${form.po_number} updated.` : `Work Order ${form.po_number} created.` });
      // Straight into Line Items after uploading a new PO — this is where
      // the required budget details (qty/area + rate per work type) get
      // filled in, so the PO is actually usable right away instead of
      // sitting with zero line items until someone remembers to add them.
      if (createdPo) setLineItemsPo(createdPo);
    },
    onError: (err: Error) => {
      setNotice({ kind: 'error', message: err.message || 'Could not save this Work Order. Please try again.' });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (po: PurchaseOrder) => {
      const hasShops = (shopCountByPo.get(po.id) || 0) > 0;
      const stage: UtilizationStage = po.fulfillment_type === 'supply_only' ? 'produced' : 'installed';
      const invoicedAmount = (utilization || [])
        .filter((r) => r.purchase_order_id === po.id)
        .reduce((sum, r) => sum + computeUtilization(r, stage).invoicedAmount, 0);
      // A Work Order that's never been attached to a shop and never had
      // anything invoiced against it is safe to permanently remove — it's
      // pure setup, not history. Anything with real activity against it
      // (shops assigned, or an invoice raised) is cancelled instead, so
      // that history and audit trail stay intact.
      const canHardDelete = canDelete && !hasShops && invoicedAmount === 0;

      if (canHardDelete) {
        const { error } = await supabase.from('purchase_orders').delete().eq('id', po.id);
        if (error) throw error;
        await logAudit('purchase_orders', po.id, 'delete', null, null, null, `Deleted unused Work Order ${po.po_number}`);
      } else {
        const { error } = await supabase.from('purchase_orders').update({ status: 'cancelled' }).eq('id', po.id);
        if (error) throw error;
        await logAudit('purchase_orders', po.id, 'delete', null, null, null, `Cancelled Work Order ${po.po_number}`);
      }
      return canHardDelete;
    },
    // Always resync from the DB, whether this succeeded or failed, so the
    // list can never keep showing a Work Order that was actually deleted
    // (or keep hiding one that failed to delete) after a partial error.
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['purchase_orders', orgId] });
      queryClient.invalidateQueries({ queryKey: ['po-shop-links', orgId] });
    },
    onSuccess: (hardDeleted, po) => {
      setNotice({ kind: 'success', message: hardDeleted ? `Work Order ${po.po_number} deleted.` : `Work Order ${po.po_number} cancelled — it had shops or invoices attached, so it's kept for record-keeping.` });
      setDeletePo(null);
    },
    onError: (err: Error) => {
      setNotice({ kind: 'error', message: err.message || 'Could not delete this Work Order. Please try again.' });
    },
  });

  function openAdd() {
    setEditPo(null);
    setForm(emptyPoForm);
    setFile(null);
    setNotice(null);
    setModalOpen(true);
  }

  function openEdit(po: PurchaseOrder) {
    setEditPo(po);
    setForm({
      client_id: po.client_id, project_id: po.project_id || '', po_number: po.po_number, name: po.name || '',
      po_date: po.po_date, fulfillment_type: po.fulfillment_type,
      notes: po.notes || '',
      payment_terms: po.payment_terms || '', gst_percentage: po.gst_percentage != null ? String(po.gst_percentage) : '',
    });
    setFile(null);
    setNotice(null);
    setModalOpen(true);
  }

  const filteredProjects = (projects || []).filter((p) => !form.client_id || p.client_id === form.client_id);

  // Whether the Work Order currently queued for delete/cancel is safe to
  // permanently delete (mirrors the same check used per-row and inside
  // deleteMutation itself, so the confirm dialog's title/message always
  // match what will actually happen).
  const deletePoCanHardDelete = useMemo(() => {
    if (!deletePo) return false;
    const shopCount = shopCountByPo.get(deletePo.id) || 0;
    if (shopCount > 0) return false;
    const stage: UtilizationStage = deletePo.fulfillment_type === 'supply_only' ? 'produced' : 'installed';
    const invoicedAmount = (utilization || [])
      .filter((r) => r.purchase_order_id === deletePo.id)
      .reduce((sum, r) => sum + computeUtilization(r, stage).invoicedAmount, 0);
    return canDelete && invoicedAmount === 0;
  }, [deletePo, shopCountByPo, utilization, canDelete]);

  const detailPo = (pos || []).find((p) => p.id === detailPoId) || null;
  const detailPoCanHardDelete = useMemo(() => {
    if (!detailPo) return false;
    const shopCount = shopCountByPo.get(detailPo.id) || 0;
    if (shopCount > 0) return false;
    const stage: UtilizationStage = detailPo.fulfillment_type === 'supply_only' ? 'produced' : 'installed';
    const invoicedAmount = (utilization || [])
      .filter((r) => r.purchase_order_id === detailPo.id)
      .reduce((sum, r) => sum + computeUtilization(r, stage).invoicedAmount, 0);
    return canDelete && invoicedAmount === 0;
  }, [detailPo, shopCountByPo, utilization, canDelete]);

  return (
    <div>
      <PageHeader
        title="Work Orders"
        subtitle="Every Work Order (PO), its rates, and budgeted quantities per work type"
        action={
          <button onClick={openAdd} className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg font-medium text-sm transition">
            <Plus className="w-4 h-4" /> Add Work Order
          </button>
        }
      />

      {notice && (
        <div className={`flex items-start gap-2.5 rounded-lg px-4 py-3 mb-4 text-sm ${notice.kind === 'error' ? 'bg-red-50 text-red-700 border border-red-100' : 'bg-emerald-50 text-emerald-700 border border-emerald-100'}`}>
          {notice.kind === 'error' ? <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> : <Check className="w-4 h-4 mt-0.5 shrink-0" />}
          <p className="flex-1">{notice.message}</p>
          <button onClick={() => setNotice(null)} className="text-current opacity-60 hover:opacity-100"><X className="w-4 h-4" /></button>
        </div>
      )}

      {(campaignFilter || projectFilter) && (
        <div className="mb-4 flex items-center gap-2 text-sm text-blue-700 bg-blue-50 border border-blue-200 rounded-lg px-3 py-2">
          <ListChecks className="w-4 h-4" />
          Showing Work Orders for one campaign only.
          <a href="/purchase-orders" className="ml-1 underline hover:no-underline">Clear filter</a>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 mb-4">
        <div className="relative flex-1 min-w-[220px]">
          <ShoppingCart className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search Work Order no. or client..."
            className="w-full pl-9 pr-3 py-2 border border-slate-300 rounded-lg text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <select value={sortBy} onChange={(e) => setSortBy(e.target.value)} className="px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500">
          {SORT_OPTIONS.map((o) => <option key={o.value} value={o.value}>Sort: {o.label}</option>)}
        </select>
        <FilterButton activeCount={activeFilterCount} onClick={() => setFilterDrawerOpen(true)} />
        {(search || activeFilterCount > 0) && <span className="text-xs text-slate-400">{visiblePos.length} of {scopedPos.length} shown</span>}
      </div>

      <FilterDrawer
        open={filterDrawerOpen}
        onClose={() => setFilterDrawerOpen(false)}
        onClear={() => { setStatusFilter(''); setClientFilter(''); setFulfillmentFilter(''); setCampaignFilterValue(''); setZoneFilter(''); }}
        activeCount={activeFilterCount}
        resultCount={filteredPos.length}
        resultLabel="Work Orders"
      >
        <FilterSection label="Client">
          <select value={clientFilter} onChange={(e) => setClientFilter(e.target.value)} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500">
            <option value="">All Clients</option>
            {(clients || []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </FilterSection>
        {campaignFilterOptions.length > 0 && (
          <FilterSection label="Campaign">
            <select value={campaignFilterValue} onChange={(e) => setCampaignFilterValue(e.target.value)} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500">
              <option value="">All Campaigns</option>
              {(projects || []).length > 0 && (
                <optgroup label="My Campaigns">
                  {(projects || []).map((p) => <option key={`proj:${p.id}`} value={`proj:${p.id}`}>{p.name}</option>)}
                </optgroup>
              )}
              {(clientCampaigns || []).length > 0 && (
                <optgroup label="Client Campaigns">
                  {(clientCampaigns || []).map((c) => <option key={`camp:${c.id}`} value={`camp:${c.id}`}>{c.name}</option>)}
                </optgroup>
              )}
            </select>
          </FilterSection>
        )}
        {(zones || []).length > 0 && (
          <FilterSection label="Zone">
            <select value={zoneFilter} onChange={(e) => setZoneFilter(e.target.value)} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500">
              <option value="">All Zones</option>
              {(zones || []).map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
            </select>
            <p className="text-[11px] text-slate-400 mt-1">Matches Work Orders that have at least one shop in this zone.</p>
          </FilterSection>
        )}
        <FilterSection label="Status">
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500">
            <option value="">All Statuses</option>
            <option value="active">Active</option>
            <option value="closed">Closed</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </FilterSection>
        <FilterSection label="Fulfillment Type">
          <select value={fulfillmentFilter} onChange={(e) => setFulfillmentFilter(e.target.value)} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500">
            <option value="">All Types</option>
            {FULFILLMENT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </FilterSection>
      </FilterDrawer>

      {clientRequests.length > 0 && (
        <Card className="p-5 mb-6 border-blue-200 bg-blue-50/40">
          <div className="flex items-center gap-2 mb-3">
            <Inbox className="w-4.5 h-4.5 text-blue-600" />
            <h2 className="font-semibold text-slate-900">Client Requests</h2>
            <span className="min-w-[20px] h-5 px-1.5 rounded-full bg-blue-600 text-white text-[11px] font-bold flex items-center justify-center">
              {clientRequests.length}
            </span>
          </div>
          <div className="space-y-2">
            {clientRequests.map((po) => (
              <div key={po.id} className="flex items-center justify-between gap-3 flex-wrap bg-white rounded-lg border border-slate-200 px-4 py-3">
                <div className="flex items-center gap-3">
                  <Building2 className="w-4 h-4 text-slate-400 shrink-0" />
                  <div>
                    <p className="font-medium text-slate-900 text-sm">{po.name ? `${po.name} — ${po.po_number}` : po.po_number} — {po.client_org?.name || 'A linked client'}</p>
                    <p className="text-xs text-slate-500">{new Date(po.po_date).toLocaleDateString('en-IN')} · {po.po_line_items?.length || 0} line item{(po.po_line_items?.length || 0) === 1 ? '' : 's'}{po.total_amount != null ? ` · ₹${po.total_amount.toLocaleString('en-IN')}` : ''}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => respondMutation.mutate({ po, decision: 'accepted' })}
                    disabled={respondMutation.isPending}
                    className="flex items-center gap-1.5 bg-green-600 hover:bg-green-700 text-white px-3 py-1.5 rounded-lg text-sm font-medium transition disabled:opacity-50"
                  >
                    <Check className="w-3.5 h-3.5" /> Accept
                  </button>
                  <button
                    onClick={() => respondMutation.mutate({ po, decision: 'rejected' })}
                    disabled={respondMutation.isPending}
                    className="flex items-center gap-1.5 bg-white border border-slate-300 hover:border-red-300 hover:text-red-600 text-slate-600 px-3 py-1.5 rounded-lg text-sm font-medium transition disabled:opacity-50"
                  >
                    <XCircle className="w-3.5 h-3.5" /> Reject
                  </button>
                </div>
              </div>
            ))}
          </div>
          {respondMutation.isError && <p className="text-sm text-red-600 mt-2">{(respondMutation.error as Error).message}</p>}
        </Card>
      )}

      {/* LISTING — one clean line per Work Order: number, client, campaign,
          a single primary status, completion, amount, date. Everything
          else (line items, utilization breakdown, burndown, invoicing
          balance, actions) lives in the detail drawer a row click opens —
          keeps the list itself scannable instead of every row trying to
          show everything at once. */}
      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[880px]">
            <thead className="bg-slate-50 text-slate-500 text-xs uppercase tracking-wide">
              <tr>
                <th className="text-left px-4 py-3 font-semibold">Work Order</th>
                <th className="text-left px-4 py-3 font-semibold">Client</th>
                <th className="text-left px-4 py-3 font-semibold">Campaign</th>
                <th className="text-left px-4 py-3 font-semibold">Status</th>
                <th className="text-left px-4 py-3 font-semibold w-40">Completion</th>
                <th className="text-right px-4 py-3 font-semibold">Amount</th>
                <th className="text-left px-4 py-3 font-semibold whitespace-nowrap">Date</th>
                <th className="px-4 py-3 w-8"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {pagedPos.map((po) => {
                const { lineCount, hasBudget, anyVariance, completionPct, campaignName } = getPoMetrics(po, utilization || []);
                const shopCount = shopCountByPo.get(po.id) || 0;
                const primary = getPrimaryStatus(po);

                return (
                  <tr
                    key={po.id}
                    onClick={() => setDetailPoId(po.id)}
                    className="hover:bg-blue-50/50 cursor-pointer transition-colors group"
                  >
                    <td className="px-4 py-3.5">
                      {po.name && <p className="font-semibold text-slate-900">{po.name}</p>}
                      <p className={po.name ? 'text-xs text-slate-400 mt-0.5' : 'font-semibold text-slate-900'}>{po.po_number}</p>
                      <p className="text-xs text-slate-400 mt-0.5">
                        {lineCount} item{lineCount === 1 ? '' : 's'}{shopCount > 0 ? ` · ${shopCount} shop${shopCount === 1 ? '' : 's'}` : ''}
                      </p>
                    </td>
                    <td className="px-4 py-3.5 text-slate-700">{po.clients?.name || <span className="text-slate-300">—</span>}</td>
                    <td className="px-4 py-3.5 text-slate-600">
                      {campaignName ? (
                        <span className="inline-flex items-center gap-1"><Layers className="w-3.5 h-3.5 text-slate-300 shrink-0" />{campaignName}</span>
                      ) : <span className="text-slate-300">—</span>}
                    </td>
                    <td className="px-4 py-3.5">
                      <div className="flex items-center gap-1.5">
                        <StatusBadge status={primary.status} label={primary.label} />
                        {anyVariance && (
                          <span title="Surveyed quantity differs from budget on at least one line item">
                            <AlertTriangle className="w-3.5 h-3.5 text-amber-500" />
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3.5">
                      {hasBudget ? (
                        <div className="flex items-center gap-2">
                          <ProgressBar pct={completionPct} className="flex-1" />
                          <span className="text-xs text-slate-500 w-8 text-right shrink-0">{completionPct != null ? `${Math.round(completionPct)}%` : '—'}</span>
                        </div>
                      ) : <span className="text-slate-300 text-xs">No budget yet</span>}
                    </td>
                    <td className="px-4 py-3.5 text-right whitespace-nowrap">
                      {po.total_amount != null ? (
                        <span className="text-slate-900 font-medium inline-flex items-center gap-0.5"><IndianRupee className="w-3.5 h-3.5" />{po.total_amount.toLocaleString('en-IN')}</span>
                      ) : <span className="text-slate-300">—</span>}
                    </td>
                    <td className="px-4 py-3.5 text-slate-500 text-xs whitespace-nowrap">{new Date(po.po_date).toLocaleDateString('en-IN')}</td>
                    <td className="px-4 py-3.5">
                      <ChevronRight className="w-4 h-4 text-slate-300 group-hover:text-blue-500 transition-colors" />
                    </td>
                  </tr>
                );
              })}
              {visiblePos.length === 0 && (
                <tr>
                  <td colSpan={8}>
                    <EmptyState
                      icon={<ShoppingCart className="w-12 h-12" />}
                      title={(pos || []).length === 0 ? 'No Work Orders yet' : 'No Work Orders match these filters'}
                      subtitle={(pos || []).length === 0 ? 'Add a Work Order to start tracking budgets, rates, and completion against it' : 'Try clearing a filter or search term'}
                    />
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <Pagination
          page={currentPage}
          pageSize={pageSize}
          totalItems={totalPos}
          onPageChange={setPage}
          onPageSizeChange={setPageSize}
          pageSizeOptions={PO_PAGE_SIZES}
          itemLabel="Work Orders"
        />
      </Card>


      {/* Add / Edit PO header */}
      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={editPo ? 'Edit Work Order' : 'Add Work Order'} size="lg">
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <Select
              label="Client"
              value={form.client_id}
              onChange={(v) => setForm({ ...form, client_id: v, project_id: '' })}
              options={(clients || []).map((c) => ({ value: c.id, label: c.name }))}
              required
            />
            <Select
              label="Campaign (optional)"
              value={form.project_id}
              onChange={(v) => setForm({ ...form, project_id: v })}
              options={filteredProjects.map((p) => ({ value: p.id, label: p.name }))}
            />
          </div>

          <Input
            label="Work Order Name (optional)"
            value={form.name}
            onChange={(v) => setForm({ ...form, name: v })}
            placeholder="e.g. Q3 Andheri Dealer Boards"
          />

          <div className="grid grid-cols-2 gap-4">
            <Input label="PO Number" value={form.po_number} onChange={(v) => setForm({ ...form, po_number: v })} required />
            <Input label="PO Date" type="date" value={form.po_date} onChange={(v) => setForm({ ...form, po_date: v })} required />
          </div>

          <Select
            label="Fulfillment Type"
            value={form.fulfillment_type}
            onChange={(v) => setForm({ ...form, fulfillment_type: v })}
            options={FULFILLMENT_OPTIONS}
            required
          />

          <div className="bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5 flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-slate-700">Total Amount</p>
              <p className="text-xs text-slate-500">Calculated automatically from this PO's line items — add/edit line items to set it.</p>
            </div>
            <p className="text-sm font-semibold text-slate-900 flex items-center gap-1 whitespace-nowrap">
              <IndianRupee className="w-3.5 h-3.5" />{(editPo?.total_amount ?? 0).toLocaleString('en-IN')}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Input label="Payment Terms" value={form.payment_terms} onChange={(v) => setForm({ ...form, payment_terms: v })} placeholder="e.g. 50% advance, 50% on installation" />
            <Input label="GST %" type="number" value={form.gst_percentage} onChange={(v) => setForm({ ...form, gst_percentage: v })} placeholder="e.g. 18" />
          </div>
          {editPo && editPo.gst_percentage != null && (
            <p className="text-xs text-slate-400 -mt-2">
              GST amount (auto): ₹{(editPo.gst_amount ?? 0).toLocaleString('en-IN')} on ₹{(editPo.total_amount ?? 0).toLocaleString('en-IN')} @ {editPo.gst_percentage}%
            </p>
          )}

          <Textarea label="Notes" value={form.notes} onChange={(v) => setForm({ ...form, notes: v })} />

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">PO Document (PDF / image)</label>
            <input ref={fileRef} type="file" accept=".pdf,image/*" onChange={(e) => setFile(e.target.files?.[0] || null)} className="hidden" />
            <button
              onClick={() => fileRef.current?.click()}
              className="w-full flex items-center justify-center gap-2 border-2 border-dashed border-slate-300 text-slate-600 font-medium py-3 rounded-lg hover:border-blue-400 hover:text-blue-600 transition"
              type="button"
            >
              <Upload className="w-4 h-4" />
              {file ? file.name : editPo?.file_url ? 'Replace uploaded file' : 'Upload PO file'}
            </button>
            {editPo?.file_url && !file && (
              <a href={editPo.file_url} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-600 hover:underline mt-1 inline-block">
                View currently uploaded file
              </a>
            )}
          </div>

          {saveMutation.isError && <p className="text-sm text-red-600">{(saveMutation.error as Error).message}</p>}

          <button
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending || !form.client_id || !form.po_number || !form.po_date}
            className="w-full flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-700 text-white font-medium py-2.5 rounded-lg transition disabled:opacity-50"
          >
            {saveMutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
            {saveMutation.isPending ? 'Saving...' : editPo ? 'Update PO' : 'Add PO'}
          </button>
        </div>
      </Modal>

      <ConfirmDialog
        open={!!deletePo}
        onClose={() => { setDeletePo(null); deleteMutation.reset(); }}
        onConfirm={() => deletePo && deleteMutation.mutate(deletePo)}
        title={deletePoCanHardDelete ? 'Delete Work Order' : 'Cancel Work Order'}
        message={
          deletePoCanHardDelete
            ? `Permanently delete Work Order "${deletePo?.name ? `${deletePo.name} — ` : ''}${deletePo?.po_number}" and its line items? It has no shops or invoiced amounts attached yet, so this can't be undone.`
            : `Work Order "${deletePo?.name ? `${deletePo.name} — ` : ''}${deletePo?.po_number}" has shops or invoiced amounts attached to it, so it's kept as a record. Mark it as cancelled instead? Its line items and history stay intact.`
        }
        confirmLabel={deletePoCanHardDelete ? 'Delete Work Order' : 'Cancel Work Order'}
        danger
        manualClose
        loading={deleteMutation.isPending}
        error={deleteMutation.isError ? ((deleteMutation.error as Error).message || 'Could not delete this Work Order.') : null}
      />

      {lineItemsPo && (
        <POLineItemsModal
          po={lineItemsPo}
          onClose={() => setLineItemsPo(null)}
          canDelete={canDelete}
          utilization={(utilization || []).filter((r) => r.purchase_order_id === lineItemsPo.id)}
        />
      )}

      {detailPo && (
        <WorkOrderDetailDrawer
          po={detailPo}
          utilization={(utilization || []).filter((r) => r.purchase_order_id === detailPo.id)}
          shopCount={shopCountByPo.get(detailPo.id) || 0}
          canDelete={canDelete}
          canHardDelete={detailPoCanHardDelete}
          onClose={() => setDetailPoId(null)}
          onEdit={() => { setDetailPoId(null); openEdit(detailPo); }}
          onManageLineItems={() => { setDetailPoId(null); setLineItemsPo(detailPo); }}
          onDelete={() => setDeletePo(detailPo)}
          onRespond={
            detailPo.origin === 'client_created' && detailPo.assignment_status === 'pending_acceptance'
              ? (decision) => respondMutation.mutate({ po: detailPo, decision })
              : undefined
          }
          isResponding={respondMutation.isPending}
        />
      )}
    </div>
  );
}


// The detail panel a Work Order row's click opens — everything the table
// row doesn't have room to show: full financial breakdown, per-line-item
// utilization (reusing PoUtilizationTable), execution pace over time
// (reusing PoBurndownPanel), notes/terms, the source PDF, and every
// action that used to be a tiny icon crammed into the row (Edit, Line
// Items, view Shops, Cancel/Delete, Accept/Reject) now has room to be a
// clearly-labelled button instead.
function WorkOrderDetailDrawer({
  po, utilization, shopCount, canDelete, canHardDelete,
  onClose, onEdit, onManageLineItems, onDelete, onRespond, isResponding,
}: {
  po: PoRow;
  utilization: POLineItemUtilization[];
  shopCount: number;
  canDelete: boolean;
  canHardDelete: boolean;
  onClose: () => void;
  onEdit: () => void;
  onManageLineItems: () => void;
  onDelete: () => void;
  onRespond?: (decision: 'accepted' | 'rejected') => void;
  isResponding?: boolean;
}) {
  const { hasBudget, anyVariance, budgetedAmount, invoicedAmount, balance, invoicedPct, completionPct, campaignName, stage } = getPoMetrics(po, utilization);
  const primary = getPrimaryStatus(po);
  const isPending = po.origin === 'client_created' && po.assignment_status === 'pending_acceptance';

  return (
    <Drawer open={!!po} onClose={onClose} title={po.name || po.po_number} subtitle={po.name ? `${po.po_number}${po.clients?.name ? ` · ${po.clients.name}` : ''}` : (po.clients?.name || undefined)} width="xl">
      <div className="space-y-6">
        <div className="flex flex-wrap items-center gap-1.5">
          <StatusBadge status={primary.status} label={primary.label} />
          <StatusBadge status={po.fulfillment_type} label={FULFILLMENT_OPTIONS.find((f) => f.value === po.fulfillment_type)?.label} />
          {anyVariance && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-700">
              <AlertTriangle className="w-3 h-3" /> Variance
            </span>
          )}
        </div>

        {isPending && onRespond && (
          <div className="border border-blue-200 bg-blue-50/60 rounded-lg p-3.5">
            <p className="text-sm text-blue-800 mb-3">
              Assigned by <span className="font-medium">{po.client_org?.name || 'a linked client'}</span> — waiting on your response before work can start.
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => onRespond('accepted')}
                disabled={isResponding}
                className="flex-1 flex items-center justify-center gap-1.5 bg-green-600 hover:bg-green-700 text-white px-3 py-2 rounded-lg text-sm font-medium transition disabled:opacity-50"
              >
                <Check className="w-4 h-4" /> Accept
              </button>
              <button
                onClick={() => onRespond('rejected')}
                disabled={isResponding}
                className="flex-1 flex items-center justify-center gap-1.5 bg-white border border-slate-300 hover:border-red-300 hover:text-red-600 text-slate-600 px-3 py-2 rounded-lg text-sm font-medium transition disabled:opacity-50"
              >
                <XCircle className="w-4 h-4" /> Reject
              </button>
            </div>
          </div>
        )}

        {/* Actions up front — these used to be buried at the very bottom
            of the drawer, past the utilization table and burndown chart,
            which meant the most common things anyone actually opens this
            drawer to do (edit it, manage line items, see the shops on it)
            were the last thing you could reach. */}
        <div className="flex flex-wrap gap-2">
          <button onClick={onEdit} className="flex items-center gap-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 px-3.5 py-2 rounded-lg text-sm font-medium transition">
            <Pencil className="w-4 h-4" /> Edit
          </button>
          <button onClick={onManageLineItems} className="flex items-center gap-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 px-3.5 py-2 rounded-lg text-sm font-medium transition">
            <ListChecks className="w-4 h-4" /> Line Items & Rates
          </button>
          <Link to={`/shops?po=${po.id}`} className="flex items-center gap-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 px-3.5 py-2 rounded-lg text-sm font-medium transition">
            <Store className="w-4 h-4" /> View Shops{shopCount > 0 ? ` (${shopCount})` : ''}
          </Link>
          {canDelete && po.status !== 'cancelled' && (
            <button
              onClick={onDelete}
              title={canHardDelete ? 'No shops or invoices attached yet — safe to permanently delete' : 'Has shops or invoiced amounts — will be cancelled and kept for record-keeping'}
              className={`flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-sm font-medium transition ${
                canHardDelete ? 'bg-red-50 hover:bg-red-100 text-red-600' : 'bg-amber-50 hover:bg-amber-100 text-amber-700'
              }`}
            >
              {canHardDelete ? <Trash2 className="w-4 h-4" /> : <Ban className="w-4 h-4" />}
              {canHardDelete ? 'Delete Work Order' : 'Cancel Work Order'}
            </button>
          )}
        </div>

        <div className="grid grid-cols-2 gap-x-4 gap-y-3">
          <div>
            <p className="text-xs text-slate-400 flex items-center gap-1 mb-0.5"><Building2 className="w-3 h-3" /> Client</p>
            <p className="text-sm font-medium text-slate-900">{po.clients?.name || '—'}</p>
          </div>
          <div>
            <p className="text-xs text-slate-400 flex items-center gap-1 mb-0.5"><Layers className="w-3 h-3" /> Campaign</p>
            <p className="text-sm font-medium text-slate-900">{campaignName || '—'}</p>
          </div>
          <div>
            <p className="text-xs text-slate-400 flex items-center gap-1 mb-0.5"><Calendar className="w-3 h-3" /> Order Date</p>
            <p className="text-sm font-medium text-slate-900">{new Date(po.po_date).toLocaleDateString('en-IN')}</p>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <div className="border border-slate-200 rounded-lg p-3">
            <p className="text-xs text-slate-400 mb-1">Total Amount</p>
            <p className="text-sm font-semibold text-slate-900">{po.total_amount != null ? formatRupees(po.total_amount) : '—'}</p>
            {po.gst_percentage != null && <p className="text-[11px] text-slate-400 mt-0.5">+ GST {po.gst_percentage}%</p>}
          </div>
          <div className="border border-slate-200 rounded-lg p-3">
            <p className="text-xs text-slate-400 mb-1">Invoiced</p>
            <p className="text-sm font-semibold text-slate-900">{hasBudget ? formatRupees(invoicedAmount) : '—'}</p>
            {invoicedPct != null && <p className="text-[11px] text-slate-400 mt-0.5">{Math.round(invoicedPct)}% of budget</p>}
          </div>
          <div className="border border-slate-200 rounded-lg p-3">
            <p className="text-xs text-slate-400 mb-1">Balance</p>
            <p className={`text-sm font-semibold ${balance != null && balance < 0 ? 'text-red-600' : 'text-slate-900'}`}>{hasBudget ? formatRupees(balance) : '—'}</p>
          </div>
        </div>

        <PoCompletionDonut budgetedAmount={hasBudget ? budgetedAmount : null} invoicedAmount={invoicedAmount} completionPct={completionPct} />

        <PoStageProgressChart rows={utilization} stage={stage} />
        <PoUtilizationTable rows={utilization} stage={stage} />

        {(po.payment_terms || po.notes) && (
          <div className="space-y-3 border-t border-slate-100 pt-4">
            {po.payment_terms && (
              <div>
                <p className="text-xs font-medium text-slate-500 mb-1">Payment Terms</p>
                <p className="text-sm text-slate-700">{po.payment_terms}</p>
              </div>
            )}
            {po.notes && (
              <div>
                <p className="text-xs font-medium text-slate-500 mb-1">Notes</p>
                <p className="text-sm text-slate-700 whitespace-pre-wrap">{po.notes}</p>
              </div>
            )}
          </div>
        )}

        {po.file_url && (
          <a href={po.file_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-sm text-blue-600 hover:underline">
            <FileText className="w-4 h-4" /> View source PO document
          </a>
        )}
      </div>
    </Drawer>
  );
}

// Phase 6 — PO Utilization table: budgeted vs surveyed/approved/produced/
// installed vs invoiced, per line item, with a variance flag (surveyed vs
// budgeted). `stage` picks which actual column drives the % bar — installed
// for survey_install POs, produced for supply_only POs (they never reach
// "installed", they dispatch instead).
//
// Collapsed by default behind a "View full utilization" toggle — the
// summary cards + stage progress chart above already answer "how's this
// PO doing", so the full line-by-line breakdown only needs to take up
// space when someone actually asks for it.
function PoUtilizationTable({ rows, stage }: { rows: POLineItemUtilization[]; stage: UtilizationStage }) {
  const [open, setOpen] = useState(false);
  if (rows.length === 0) return null;
  return (
    <div>
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between text-sm font-medium text-slate-700 bg-slate-50 hover:bg-slate-100 border border-slate-200 rounded-lg px-3.5 py-2.5 transition"
      >
        <span>Utilization — budget vs actual ({rows.length} line item{rows.length === 1 ? '' : 's'})</span>
        <ChevronDown className={`w-4 h-4 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="border border-slate-200 border-t-0 rounded-b-lg overflow-x-auto -mt-px">
          <table className="w-full text-sm min-w-[820px]">
            <thead className="bg-slate-50 text-slate-500 text-xs uppercase">
              <tr>
                <th className="text-left px-3 py-2">Description</th>
                <th className="text-right px-3 py-2">Budgeted</th>
                <th className="text-right px-3 py-2">Surveyed</th>
                <th className="text-right px-3 py-2">Approved</th>
                <th className="text-right px-3 py-2">Produced</th>
                <th className="text-right px-3 py-2">Installed</th>
                <th className="text-right px-3 py-2">Invoiced</th>
                <th className="text-right px-3 py-2">Balance</th>
                <th className="text-center px-3 py-2">%</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((row) => {
                const fig = computeUtilization(row, stage);
                return (
                  <tr key={row.po_line_item_id} className="hover:bg-slate-50">
                    <td className="px-3 py-2 text-slate-900">{row.description}</td>
                    <td className="px-3 py-2 text-right text-slate-600">{formatQty(fig.budgetedPrimary, row.uom)}</td>
                    <td className="px-3 py-2 text-right text-slate-600">{formatQty(row.uom === 'sqft' ? row.surveyed_area : row.surveyed_qty, row.uom)}</td>
                    <td className="px-3 py-2 text-right text-slate-600">{formatQty(row.uom === 'sqft' ? row.approved_area : row.approved_qty, row.uom)}</td>
                    <td className="px-3 py-2 text-right text-slate-600">{formatQty(row.produced_qty, row.uom === 'sqft' ? 'piece' : row.uom)}</td>
                    <td className="px-3 py-2 text-right text-slate-600">{formatQty(row.uom === 'sqft' ? row.installed_area : row.installed_qty, row.uom)}</td>
                    <td className="px-3 py-2 text-right text-slate-600">{formatRupees(fig.invoicedAmount)}</td>
                    <td className={`px-3 py-2 text-right font-medium ${fig.remainingBalance != null && fig.remainingBalance < 0 ? 'text-red-600' : 'text-slate-900'}`}>
                      {formatRupees(fig.remainingBalance)}
                    </td>
                    <td className="px-3 py-2">
                      <ProgressBar pct={fig.utilizationPct} className="w-16 mx-auto" />
                    </td>
                    <td className="px-3 py-2 text-center">
                      {fig.hasVariance && (
                        <span title={`Surveyed differs from budgeted by ${fig.variance != null ? Math.round(fig.variance * 100) / 100 : ''} ${row.uom}`}>
                          <AlertTriangle className="w-4 h-4 text-amber-500 inline" />
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// Replaces the old per-line-item cumulative burndown line chart, which
// needed picking one line item at a time and reading overlapping lines to
// answer "how is this PO actually progressing" — not a clear at-a-glance
// view. This aggregates every line item into ₹ terms (the one unit that's
// comparable across sqft/piece/lot line items) and shows, stage by stage,
// how much of the total budget has actually moved through each one so
// far — a much more direct answer to "what work is happening, how".
// Replaces the old flat "Overall Completion: 0% + a progress bar +
// budgeted amount" block, which buried the one thing that actually
// matters — how much of the physical work is actually done — behind a
// rupee figure at the very end that reads as the headline when it's
// really just context. This turns the same three numbers (budgeted,
// invoiced, % complete) already computed for the summary cards above
// into a donut that answers "how much work, of what kind" at a glance:
// how much is done and billed, done but not yet billed, and still
// remaining — money is present but secondary, sized by its slice, not
// spelled out as the headline.
function PoCompletionDonut({
  budgetedAmount, invoicedAmount, completionPct,
}: {
  budgetedAmount: number | null;
  invoicedAmount: number;
  completionPct: number | null;
}) {
  if (budgetedAmount == null || budgetedAmount <= 0) {
    return (
      <div className="border border-dashed border-slate-200 rounded-lg p-4 text-center">
        <p className="text-xs text-slate-400">Add a rate to this PO's line items to see completion here.</p>
      </div>
    );
  }

  const completedAmount = budgetedAmount * ((completionPct ?? 0) / 100);
  const invoiced = Math.min(invoicedAmount, budgetedAmount);
  const completedNotInvoiced = Math.max(0, completedAmount - invoiced);
  const remaining = Math.max(0, budgetedAmount - completedAmount);

  const segments = [
    { key: 'invoiced', label: 'Done & Invoiced', value: invoiced, color: '#10b981' },
    { key: 'completed', label: 'Done, Not Yet Invoiced', value: completedNotInvoiced, color: '#3b82f6' },
    { key: 'remaining', label: 'Work Remaining', value: remaining, color: '#e2e8f0' },
  ];

  return (
    <div>
      <p className="text-sm font-medium text-slate-700 mb-3">Overall Completion — how much work is actually done</p>
      <div className="flex items-center gap-5">
        <DonutChart
          segments={segments}
          size={132}
          strokeWidth={18}
          centerValue={`${Math.round(completionPct ?? 0)}%`}
          centerLabel="done"
        />
        <div className="flex-1 space-y-2.5 min-w-0">
          {segments.map((s) => (
            <div key={s.key} className="flex items-center gap-2 text-xs">
              <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: s.color }} />
              <span className="text-slate-600 flex-1 truncate">{s.label}</span>
              <span className="font-semibold text-slate-800">{formatRupees(s.value)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function PoStageProgressChart({ rows, stage }: { rows: POLineItemUtilization[]; stage: UtilizationStage }) {
  if (rows.length === 0) return null;

  const totalBudget = rows.reduce((sum, r) => {
    const primary = isAreaUom(r.uom) ? r.budgeted_area : r.budgeted_qty;
    return sum + (primary != null && r.rate != null ? primary * r.rate : 0);
  }, 0);

  const stageDefs: { key: UtilizationStage | 'invoiced'; label: string; color: string }[] = [
    { key: 'surveyed', label: 'Surveyed', color: '#3b82f6' },
    { key: 'approved', label: 'Approved', color: '#8b5cf6' },
    { key: stage, label: stage === 'produced' ? 'Produced' : 'Installed', color: '#f59e0b' },
    { key: 'invoiced', label: 'Invoiced', color: '#10b981' },
  ];

  const amountFor = (key: UtilizationStage | 'invoiced') => {
    if (key === 'invoiced') return rows.reduce((sum, r) => sum + (r.invoiced_amount || 0), 0);
    return rows.reduce((sum, r) => sum + (getActualForStage(r, key) || 0) * (r.rate || 0), 0);
  };

  if (totalBudget <= 0) {
    return (
      <div className="border border-dashed border-slate-200 rounded-lg p-4 text-center">
        <p className="text-xs text-slate-400">Add a rate to this PO's line items to see stage-by-stage progress here.</p>
      </div>
    );
  }

  return (
    <div>
      <p className="text-sm font-medium text-slate-700 mb-3 flex items-center gap-1.5">
        <TrendingUp className="w-4 h-4 text-slate-400" /> Progress — how work is moving through each stage
      </p>
      <div className="space-y-3">
        {stageDefs.map((s) => {
          const amount = amountFor(s.key);
          const pct = Math.min(100, Math.round((amount / totalBudget) * 100));
          return (
            <div key={s.label}>
              <div className="flex items-center justify-between text-xs mb-1">
                <span className="font-medium text-slate-600">{s.label}</span>
                <span className="text-slate-500">{formatRupees(amount)} <span className="text-slate-400">({pct}%)</span></span>
              </div>
              <div className="h-2.5 bg-slate-100 rounded-full overflow-hidden">
                <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, backgroundColor: s.color }} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function POLineItemsModal({ po, onClose, canDelete, utilization }: { po: PurchaseOrder; onClose: () => void; canDelete: boolean; utilization: POLineItemUtilization[] }) {
  const { profile } = useAuth();
  const orgId = profile?.organization_id;
  const queryClient = useQueryClient();

  const [form, setForm] = useState(emptyLineForm);
  const [editItem, setEditItem] = useState<POLineItem | null>(null);
  const [deleteItem, setDeleteItem] = useState<POLineItem | null>(null);

  const { data: workTypes } = useQuery({
    queryKey: ['work_types', orgId],
    queryFn: async () => {
      const { data } = await supabase.from('work_types').select('id, name').eq('organization_id', orgId).eq('is_active', true).order('name');
      return data || [];
    },
    enabled: !!orgId,
  });

  // Agency-owner-only convenience: auto-fill Rate the moment a Work Type
  // is picked, using this org's own rate cards — a client-specific rate
  // for this exact PO's client wins if one exists, otherwise a generic
  // (no-client) rate for that work type. Only the owner edits rate cards
  // in the first place (per the role matrix), so this is scoped to that
  // role rather than offered to everyone touching a PO.
  const isOwner = profile?.role === 'agency_owner';
  const { data: rateCards } = useQuery({
    queryKey: ['rate-cards-for-po', orgId],
    queryFn: async () => {
      const { data, error } = await supabase.from('rate_cards').select('*').eq('organization_id', orgId).eq('is_active', true);
      if (error) throw error;
      return data as RateCard[];
    },
    enabled: !!orgId && isOwner,
  });
  const [rateSource, setRateSource] = useState<'client' | 'generic' | null>(null);

  function findRateForWorkType(workTypeId: string): { rate: number; source: 'client' | 'generic' } | null {
    if (!rateCards || !workTypeId) return null;
    const candidates = rateCards.filter((rc) => rc.work_type_id === workTypeId);
    const clientMatch = candidates.find((rc) => rc.client_id === po.client_id);
    if (clientMatch) return { rate: clientMatch.rate, source: 'client' };
    const generic = candidates.find((rc) => rc.client_id === null);
    if (generic) return { rate: generic.rate, source: 'generic' };
    return null;
  }

  function handleWorkTypeChange(workTypeId: string) {
    const match = isOwner ? findRateForWorkType(workTypeId) : null;
    setRateSource(match?.source ?? null);
    setForm((f) => ({ ...f, work_type_id: workTypeId, rate: match ? String(match.rate) : f.rate }));
  }

  const { data: items } = useQuery({
    queryKey: ['po_line_items', po.id],
    queryFn: async () => {
      const { data, error } = await supabase.from('po_line_items').select('*, work_types(name)').eq('purchase_order_id', po.id).order('created_at');
      if (error) throw error;
      return data as (POLineItem & { work_types: { name: string } | null })[];
    },
  });

  const isAreaUom = form.uom === 'sqft';

  const saveMutation = useMutation({
    mutationFn: async () => {
      const payload = {
        organization_id: orgId,
        purchase_order_id: po.id,
        work_type_id: form.work_type_id || null,
        description: form.description,
        uom: form.uom,
        // Only the field this UOM actually uses gets saved — the other
        // stays null, so utilization math (which picks area vs qty by
        // uom) never accidentally reads a stale value left over from a
        // UOM the item was previously set to.
        budgeted_qty: !isAreaUom && form.budgeted_qty ? Number(form.budgeted_qty) : null,
        budgeted_area: isAreaUom && form.budgeted_area ? Number(form.budgeted_area) : null,
        rate: form.rate ? Number(form.rate) : null,
        hsn_code: form.hsn_code || null,
      };
      if (editItem) {
        const { error } = await supabase.from('po_line_items').update(payload).eq('id', editItem.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from('po_line_items').insert(payload);
        if (error) throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['po_line_items', po.id] });
      queryClient.invalidateQueries({ queryKey: ['purchase_orders', orgId] });
      setForm(emptyLineForm);
      setEditItem(null);
      setRateSource(null);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (item: POLineItem) => {
      const { error } = await supabase.from('po_line_items').delete().eq('id', item.id);
      if (error) throw error;
    },
    // Always resync, success or failure, so this list can never keep
    // showing a line item that was actually removed (or hide one whose
    // delete silently failed) after an error partway through.
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['po_line_items', po.id] });
      queryClient.invalidateQueries({ queryKey: ['purchase_orders', orgId] });
    },
    onSuccess: () => setDeleteItem(null),
  });

  function startEdit(item: POLineItem) {
    setEditItem(item);
    setRateSource(null);
    setForm({
      work_type_id: item.work_type_id || '', description: item.description, uom: item.uom,
      budgeted_qty: item.budgeted_qty?.toString() || '', budgeted_area: item.budgeted_area?.toString() || '',
      rate: item.rate?.toString() || '', hsn_code: item.hsn_code || '',
    });
  }

  function cancelEdit() {
    setEditItem(null);
    setRateSource(null);
    setForm(emptyLineForm);
  }

  function changeUom(v: string) {
    // Clear the field that no longer applies so switching UOM mid-entry
    // can't leave a stale qty/area value sitting behind the scenes.
    setForm({ ...form, uom: v, budgeted_qty: v === 'sqft' ? '' : form.budgeted_qty, budgeted_area: v === 'sqft' ? form.budgeted_area : '' });
  }

  const canSaveLineItem = !!form.description && !!form.rate && (isAreaUom ? !!form.budgeted_area : !!form.budgeted_qty);

  // Computed straight from the (always-fresh, query-invalidated) items
  // list rather than po.total_amount, so this total updates the instant a
  // line item is added/edited — no waiting on the parent PO list to refetch.
  const computedTotal = (items || []).reduce((sum, item) => {
    const primary = item.uom === 'sqft' ? item.budgeted_area : item.budgeted_qty;
    return sum + (primary != null && item.rate != null ? primary * item.rate : 0);
  }, 0);

  return (
    <Modal open onClose={onClose} title={`Line Items — ${po.name ? `${po.name} (${po.po_number})` : po.po_number}`} size="xl">
      <div className="space-y-5">
        <div className="flex items-center justify-between bg-blue-50 border border-blue-100 rounded-lg px-4 py-2.5">
          <p className="text-sm font-medium text-blue-900">PO Total (auto-calculated)</p>
          <p className="text-sm font-semibold text-blue-900">{formatRupees(computedTotal)}</p>
        </div>

        <PoStageProgressChart rows={utilization} stage={po.fulfillment_type === 'supply_only' ? 'produced' : 'installed'} />

        <PoUtilizationTable rows={utilization} stage={po.fulfillment_type === 'supply_only' ? 'produced' : 'installed'} />

        <div className="border border-slate-200 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-500 text-xs uppercase">
              <tr>
                <th className="text-left px-3 py-2">Description</th>
                <th className="text-left px-3 py-2">Work Type</th>
                <th className="text-left px-3 py-2">UOM</th>
                <th className="text-right px-3 py-2">Budgeted</th>
                <th className="text-right px-3 py-2">Rate</th>
                <th className="text-right px-3 py-2">Amount</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {items?.map((item) => {
                const budgetedPrimary = item.uom === 'sqft' ? item.budgeted_area : item.budgeted_qty;
                const amount = budgetedPrimary != null && item.rate != null ? budgetedPrimary * item.rate : null;
                return (
                  <tr key={item.id} className="hover:bg-slate-50">
                    <td className="px-3 py-2 text-slate-900">
                      {item.description}
                      {item.hsn_code && <span className="block text-xs text-slate-400">HSN: {item.hsn_code}</span>}
                    </td>
                    <td className="px-3 py-2 text-slate-600">{item.work_types?.name || '—'}</td>
                    <td className="px-3 py-2 text-slate-600">{item.uom}</td>
                    <td className="px-3 py-2 text-right text-slate-600">{budgetedPrimary ?? '—'}</td>
                    <td className="px-3 py-2 text-right text-slate-600">{item.rate ?? '—'}</td>
                    <td className="px-3 py-2 text-right text-slate-900 font-medium">{formatRupees(amount)}</td>
                    <td className="px-3 py-2">
                      <div className="flex items-center justify-end gap-1">
                        <button onClick={() => startEdit(item)} className="p-1 text-slate-400 hover:text-blue-600">
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        {canDelete && (
                          <button onClick={() => setDeleteItem(item)} className="p-1 text-slate-400 hover:text-red-600">
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {items?.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-6 text-center text-slate-400">No line items yet — add one below. PO total will fill in automatically.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="border border-slate-200 rounded-lg p-4 bg-slate-50">
          <div className="flex items-center justify-between mb-3">
            <p className="text-sm font-medium text-slate-700">{editItem ? 'Edit line item' : 'Add line item'}</p>
            {editItem && (
              <button onClick={cancelEdit} className="text-xs text-slate-400 hover:text-slate-600 flex items-center gap-1">
                <X className="w-3.5 h-3.5" /> Cancel edit
              </button>
            )}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
            <Input label="Description" value={form.description} onChange={(v) => setForm({ ...form, description: v })} placeholder="e.g. 5mm foam sheet with UV printing" required />
            <Select
              label="Work Type (optional)"
              value={form.work_type_id}
              onChange={handleWorkTypeChange}
              options={(workTypes || []).map((w) => ({ value: w.id, label: w.name }))}
            />
          </div>
          <div className="grid grid-cols-3 gap-3 mb-3">
            <Select label="UOM" value={form.uom} onChange={changeUom} options={UOM_OPTIONS} required />
            {isAreaUom ? (
              <Input label="Budgeted Area (sqft)" type="number" value={form.budgeted_area} onChange={(v) => setForm({ ...form, budgeted_area: v })} required />
            ) : (
              <Input label="Budgeted Qty" type="number" value={form.budgeted_qty} onChange={(v) => setForm({ ...form, budgeted_qty: v })} required />
            )}
            <div>
              <Input label="Rate (₹)" type="number" value={form.rate} onChange={(v) => { setForm({ ...form, rate: v }); setRateSource(null); }} required />
              {isOwner && rateSource && (
                <p className="text-[11px] text-emerald-600 mt-1">
                  {rateSource === 'client' ? "Auto-filled from this client's rate card" : 'Auto-filled from your generic rate card for this work type'}
                </p>
              )}
              {isOwner && form.work_type_id && !rateSource && !editItem && (
                <p className="text-[11px] text-slate-400 mt-1">No rate card found for this work type — enter manually.</p>
              )}
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
            <Input label="HSN Code (optional)" value={form.hsn_code} onChange={(v) => setForm({ ...form, hsn_code: v })} placeholder="e.g. 4911" />
          </div>
          {saveMutation.isError && <p className="text-sm text-red-600 mb-2">{(saveMutation.error as Error).message}</p>}
          <button
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending || !canSaveLineItem}
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition disabled:opacity-50"
          >
            <Plus className="w-4 h-4" /> {saveMutation.isPending ? 'Saving...' : editItem ? 'Update Line Item' : 'Add Line Item'}
          </button>
        </div>
      </div>

      <ConfirmDialog
        open={!!deleteItem}
        onClose={() => { setDeleteItem(null); deleteMutation.reset(); }}
        onConfirm={() => deleteItem && deleteMutation.mutate(deleteItem)}
        title="Delete Line Item"
        message={`Remove "${deleteItem?.description}" from this PO?`}
        confirmLabel="Delete"
        danger
        manualClose
        loading={deleteMutation.isPending}
        error={deleteMutation.isError ? ((deleteMutation.error as Error).message || 'Could not delete this line item.') : null}
      />
    </Modal>
  );
}
