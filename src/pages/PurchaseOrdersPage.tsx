import { useState, useRef, useMemo, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSearchParams, Link } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import {
  Modal, ConfirmDialog, Card, Input, Select, Textarea, StatusBadge, EmptyState, ProgressBar,
  FilterButton, FilterDrawer, FilterSection, Drawer, Pagination,
} from '@/components/ui';
import { PurchaseOrder, POLineItem, POLineItemUtilization, Campaign, Zone, RateCard, PoAssignment } from '@/lib/types';
import { logAudit, notifyLinkedOrg, createNotification } from '@/lib/helpers';
import { useRealtimeInvalidate } from '@/lib/useRealtimeInvalidate';
import { computeUtilization, calculatePoProgress, formatQty, formatRupees, isAreaUom, UtilizationStage, fulfillmentTypeLabel, defaultUtilizationStage } from '@/lib/poUtilization';
import type { PoProgressSummary } from '@/lib/poUtilization';
import { DonutChart } from '@/components/DonutChart';
import {
  Plus, Pencil, Trash2, ShoppingCart, FileText, Upload, X, Loader2, IndianRupee, ListChecks, AlertTriangle, TrendingUp, ChevronDown,
  Inbox, Check, XCircle, Building2, Store, ChevronRight, Calendar, Layers, Users, UserPlus, UserMinus,
} from 'lucide-react';

const UOM_OPTIONS = [
  { value: 'sqft', label: 'Sq.ft' },
  { value: 'piece', label: 'Piece' },
  { value: 'lot', label: 'Lot' },
];

const FULFILLMENT_OPTIONS = [
  { value: 'survey_install', label: 'Survey + Install', description: 'Full Dealer Boards pipeline — field survey, design approval, production, then an installer completes an on-site install job per shop.' },
  { value: 'supply_only', label: 'Supply Only', description: 'Production + zone-wise dispatch (tape, flex printing, nails...). No field survey and no on-site install job.' },
  { value: 'direct_install', label: 'Direct Installation', description: 'Wall-painting / on-ground campaigns with no shop list up front (e.g. "paint dealer walls between City A and City B, wherever possible"). No survey, no design, no production — the ground crew/agency team goes straight to a wall, paints it, and logs the site, size and photos themselves from the Installer app. Budgeted qty/area on the line items below is still tracked exactly the same way, against what actually gets logged.' },
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
  const stage: UtilizationStage = defaultUtilizationStage(po.fulfillment_type);
  const summary = calculatePoProgress(poRows, stage, lineCount);
  const anyVariance = poRows.some(row => computeUtilization(row, stage).hasVariance);
  const campaignName = po.projects?.name || po.campaigns?.name || null;
  return {
    lineCount, poRows, stage, anyVariance, campaignName,
    ...summary,
    // Existing row and drawer consumers use the same physical completion.
    completionPct: summary.workPct,
    hasBudget: summary.budgetedAmount != null,
  };
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
  const [searchParams, setSearchParams] = useSearchParams();
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
  const [clientFilter, setClientFilter] = useState(() => new URLSearchParams(window.location.search).get('client') || '');
  // Keep client-scoped navigation in sync with filter controls, refresh and browser Back.
  const urlClientFilter = searchParams.get('client') || '';
  useEffect(() => { setClientFilter(urlClientFilter); }, [urlClientFilter]);
  const changeClientFilter = (nextId: string) => {
    setClientFilter(nextId);
    setSearchParams(previous => {
      const next = new URLSearchParams(previous);
      if (nextId) next.set('client', nextId);
      else next.delete('client');
      next.delete('campaign');
      next.delete('project');
      next.delete('order');
      return next;
    }, { replace: true });
  };
  const [fulfillmentFilter, setFulfillmentFilter] = useState('');
  // Combined "Campaign" filter value — either `proj:<project id>` (this
  // agency's own campaign) or `camp:<client campaign id>` (a client's
  // campaign), since a PO's campaign grouping can be either depending on
  // origin, and the person filtering shouldn't have to know which.
  const [campaignFilterValue, setCampaignFilterValue] = useState('');
  const [zoneFilter, setZoneFilter] = useState('');
  const [sortBy, setSortBy] = useState('date_desc');
  const [filterDrawerOpen, setFilterDrawerOpen] = useState(false);
  const [requestsExpanded, setRequestsExpanded] = useState(false);
  const [clientOptionSearch, setClientOptionSearch] = useState('');
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(PO_PAGE_SIZES[1]);

  const [lineItemsPo, setLineItemsPo] = useState<PurchaseOrder | null>(null);
  const [detailPoId, setDetailPoId] = useState<string | null>(() => new URLSearchParams(window.location.search).get('order'));
  useEffect(() => { setDetailPoId(searchParams.get('order')); }, [searchParams]);
  const openWorkOrder = (id: string | null) => {
    setDetailPoId(id);
    setSearchParams(previous => {
      const next = new URLSearchParams(previous);
      if (id) next.set('order', id);
      else next.delete('order');
      return next;
    }, { replace: true });
  };
  const [notice, setNotice] = useState<{ kind: 'error' | 'success'; message: string } | null>(null);

  useEffect(() => {
    setPage(0);
  }, [search, statusFilter, clientFilter, fulfillmentFilter, campaignFilterValue, zoneFilter, sortBy, pageSize]);

  useRealtimeInvalidate(['purchase_orders', 'po_line_items', 'work_items', 'invoices', 'invoice_items', 'shops'], orgId, [
    ['purchase_orders', orgId],
    ['po-utilization', orgId],
    ['po-shop-links', orgId],
    ['po-billing-items', orgId],
  ]);

  const { data: clients } = useQuery({
    queryKey: ['clients', orgId, 'active-for-po'],
    queryFn: async () => {
      const result: { id: string; name: string }[] = [];
      for (let from = 0; ; from += 500) {
        const { data, error } = await supabase.from('clients').select('id, name')
          .eq('organization_id', orgId).eq('is_active', true).order('name').range(from, from + 499);
        if (error) throw error;
        result.push(...(data || []));
        if (!data || data.length < 500) break;
      }
      return result;
    },
    enabled: !!orgId,
  });
  const { data: selectedClientRecord } = useQuery({
    queryKey: ['selected-po-client', orgId, clientFilter],
    queryFn: async () => {
      const { data, error } = await supabase.from('clients').select('id,name')
        .eq('organization_id', orgId).eq('id', clientFilter).maybeSingle();
      if (error) throw error;
      return data;
    },
    enabled: !!orgId && !!clientFilter,
  });
  const clientName = selectedClientRecord?.name || clients?.find(c => c.id === clientFilter)?.name || 'Selected client';
  const clientOptions = (clients || []).filter(c => c.name.toLowerCase().includes(clientOptionSearch.toLowerCase())).slice(0, 75);
  if (selectedClientRecord && !clientOptions.some(c => c.id === selectedClientRecord.id)) clientOptions.unshift(selectedClientRecord);

  const { data: projects } = useQuery({
    queryKey: ['projects', orgId, form.client_id],
    queryFn: async () => {
      const { data } = await supabase.from('projects').select('id, name, client_id').eq('organization_id', orgId).order('name');
      return data || [];
    },
    enabled: !!orgId,
  });

  const { data: pos, isLoading: ordersLoading, isError: ordersError, error: ordersErrorDetail, refetch: refetchOrders } = useQuery({
    queryKey: ['purchase_orders', orgId, clientFilter],
    queryFn: async () => {
      // A client-scoped visit downloads only that client's POs. A general
      // visit pages through Supabase's row limit rather than silently
      // dropping orders after the first 1,000.
      const result: PoRow[] = [];
      for (let from = 0; ; from += 500) {
        let request = supabase.from('purchase_orders')
          .select('*, clients(name), projects(name), campaigns(name), po_line_items(id, budgeted_area, budgeted_qty), client_org:organizations!purchase_orders_client_org_id_fkey(name)')
          .eq('organization_id', orgId);
        if (clientFilter) request = request.eq('client_id', clientFilter);
        const { data, error } = await request.order('created_at', { ascending: false })
          .order('id', { ascending: true }).range(from, from + 499);
        if (error) throw error;
        result.push(...((data || []) as PoRow[]));
        if (!data || data.length < 500) break;
      }
      return result;
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
  const { data: poShopLinks, isError: shopsError } = useQuery({
    queryKey: ['po-shop-links', orgId, clientFilter],
    queryFn: async () => {
      // PostgREST caps a single response (commonly 1,000 rows). Fetch each
      // page so Work Orders always show every linked shop, not only page one.
      const result: { purchase_order_id: string; zone_id: string | null }[] = [];
      const batchSize = 500;
      for (let start = 0; ; start += batchSize) {
        let request = supabase.from('shops')
          .select('purchase_order_id, zone_id')
          .eq('organization_id', orgId)
          .not('purchase_order_id', 'is', null);
        if (clientFilter) request = request.eq('client_id', clientFilter);
        const { data, error } = await request.order('id', { ascending: true })
          .range(start, start + batchSize - 1);
        if (error) throw error;
        result.push(...(data || []));
        if (!data || data.length < batchSize) break;
      }
      return result;
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
    if (statusFilter === 'awaiting_response') {
      if (!(po.origin === 'client_created' && po.assignment_status === 'pending_acceptance')) return false;
    } else if (statusFilter && po.status !== statusFilter) return false;
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
  const { data: utilization, isError: utilizationError } = useQuery({
    queryKey: ['po-utilization', orgId, clientFilter],
    queryFn: async () => {
      const rows: POLineItemUtilization[] = [];
      for (let from = 0; ; from += 500) {
        let request = supabase.from('v_po_line_item_utilization').select('*').eq('organization_id', orgId);
        if (clientFilter) request = request.eq('client_id', clientFilter);
        const { data, error } = await request.order('po_line_item_id', { ascending: true }).range(from, from + 499);
        if (error) throw error;
        rows.push(...((data || []) as POLineItemUtilization[]));
        if (!data || data.length < 500) break;
      }
      return rows;
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
      const { data, error } = await supabase.rpc('delete_purchase_order_cascade', { p_po_id: po.id });
      if (error) throw error;
      return data as { shops: number; invoices: number } | null;
    },
    // Always resync from the DB, whether this succeeded or failed, so the
    // list can never keep showing a Work Order that was actually deleted
    // (or keep hiding one that failed to delete) after a partial error.
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['purchase_orders', orgId] });
      queryClient.invalidateQueries({ queryKey: ['po-shop-links', orgId] });
      queryClient.invalidateQueries({ queryKey: ['shops', orgId] });
      queryClient.invalidateQueries({ queryKey: ['invoices', orgId] });
    },
    onSuccess: (counts, po) => {
      const parts = [];
      if (counts?.shops) parts.push(`${counts.shops} shop${counts.shops === 1 ? '' : 's'} (and all their survey/design/production/installation records)`);
      if (counts?.invoices) parts.push(`${counts.invoices} invoice${counts.invoices === 1 ? '' : 's'}`);
      setNotice({ kind: 'success', message: parts.length > 0 ? `Work Order ${po.po_number} deleted, along with ${parts.join(' and ')}.` : `Work Order ${po.po_number} deleted.` });
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

  // Whether the Work Order queued for delete has real shops/invoices
  // attached — deleting it always genuinely deletes it either way now;
  // this only changes how strongly the confirmation dialog warns.
  const deletePoIsEmpty = useMemo(() => {
    if (!deletePo) return true;
    const shopCount = shopCountByPo.get(deletePo.id) || 0;
    if (shopCount > 0) return false;
    const stage: UtilizationStage = defaultUtilizationStage(deletePo.fulfillment_type);
    const invoicedAmount = (utilization || [])
      .filter((r) => r.purchase_order_id === deletePo.id)
      .reduce((sum, r) => sum + computeUtilization(r, stage).invoicedAmount, 0);
    return invoicedAmount === 0;
  }, [deletePo, shopCountByPo, utilization]);

  // Reconcile *all* PO invoice lines, including older invoice items that
  // have a PO-linked invoice header but no individual po_line_item_id.
  // Map by invoice_item.id: an item linked both ways is counted only once.
  // Amount is ex-tax (invoice_items.amount), not invoice.total/GST/payments.
  const { data: detailInvoicedAmount, isPending: billingPending, isError: billingError } = useQuery({
    queryKey: ['po-billing-items', orgId, detailPoId],
    queryFn: async () => {
      if (!detailPoId || !orgId) return 0;
      const lineIds = ((pos || []).find(p => p.id === detailPoId)?.po_line_items || []).map(l => l.id);
      const invoiceIds: string[] = [];
      for (let from = 0; ; from += 500) {
        const { data, error } = await supabase.from('invoices').select('id')
          .eq('organization_id', orgId).eq('purchase_order_id', detailPoId)
          .order('id').range(from, from + 499);
        if (error) throw error;
        invoiceIds.push(...(data || []).map(row => row.id));
        if (!data || data.length < 500) break;
      }
      const amounts = new Map<string, number>();
      const readItems = async (field: 'invoice_id' | 'po_line_item_id', ids: string[]) => {
        for (let i = 0; i < ids.length; i += 50) {
          for (let from = 0; ; from += 500) {
            const { data, error } = await supabase.from('invoice_items')
              .select('id,amount').eq('organization_id', orgId)
              .in(field, ids.slice(i, i + 50)).order('id').range(from, from + 499);
            if (error) throw error;
            for (const item of data || []) amounts.set(item.id, Number(item.amount) || 0);
            if (!data || data.length < 500) break;
          }
        }
      };
      await readItems('invoice_id', invoiceIds);
      await readItems('po_line_item_id', lineIds);
      return Array.from(amounts.values()).reduce((total, n) => total + n, 0);
    },
    enabled: !!orgId && !!detailPoId && !!pos,
  });

  const detailPo = (pos || []).find((p) => p.id === detailPoId) || null;
  const detailPoIsEmpty = useMemo(() => {
    if (!detailPo) return true;
    const shopCount = shopCountByPo.get(detailPo.id) || 0;
    if (shopCount > 0) return false;
    const stage: UtilizationStage = defaultUtilizationStage(detailPo.fulfillment_type);
    const invoicedAmount = (utilization || [])
      .filter((r) => r.purchase_order_id === detailPo.id)
      .reduce((sum, r) => sum + computeUtilization(r, stage).invoicedAmount, 0);
    return invoicedAmount === 0;
  }, [detailPo, shopCountByPo, utilization]);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div><h1 className="text-xl font-semibold tracking-tight text-slate-900">Work orders</h1><p className="mt-1 text-xs text-slate-500">Track delivery, items and site execution</p></div>
        <button onClick={openAdd} className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-3.5 py-2 text-sm font-medium text-white hover:bg-blue-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"><Plus className="h-4 w-4"/> Add work order</button>
      </div>

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

      {clientFilter && (
        <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
          <Link to="/clients" className="font-medium text-blue-700 hover:underline">Clients</Link>
          <ChevronRight className="h-3.5 w-3.5 text-slate-400" />
          <span className="rounded-md bg-blue-50 px-2.5 py-1.5 font-medium text-blue-800">{clientName}</span>
          <span className="tabular-nums text-slate-500">{ordersLoading ? 'Loading orders…' : `${totalPos} orders`}</span>
          <button type="button" onClick={() => changeClientFilter('')} className="rounded-md border border-slate-200 px-2.5 py-1.5 text-slate-600 hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-600">Clear client filter</button>
        </div>
      )}
      {(ordersError || shopsError || utilizationError) && (
        <div role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          <p className="font-medium">Some Work Order information could not be loaded.</p>
          <p className="mt-1">{ordersError ? (ordersErrorDetail instanceof Error ? ordersErrorDetail.message : 'Unable to load orders.') : 'Shop or progress data is temporarily unavailable.'}</p>
          <button type="button" onClick={() => { void refetchOrders(); void queryClient.invalidateQueries({ queryKey: ['po-utilization', orgId] }); void queryClient.invalidateQueries({ queryKey: ['po-shop-links', orgId] }); }} className="mt-2 rounded border border-red-300 bg-white px-3 py-1.5 font-medium focus-visible:outline focus-visible:outline-2">Retry</button>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <div className="relative flex-1 min-w-[220px]">
          <ShoppingCart className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search order name, PO number or client"
            aria-label="Search work orders"
            className="w-full pl-9 pr-3 py-2 border border-slate-300 rounded-lg text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <select aria-label="Filter work orders by status" value={statusFilter} onChange={e => setStatusFilter(e.target.value)} className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-600">
          <option value="">All statuses</option><option value="active">Active</option><option value="awaiting_response">Awaiting response</option><option value="closed">Closed</option><option value="cancelled">Cancelled</option>
        </select>
        <select aria-label="Sort work orders" value={sortBy} onChange={(e) => setSortBy(e.target.value)} className="px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500">
          {SORT_OPTIONS.map((o) => <option key={o.value} value={o.value}>Sort: {o.label}</option>)}
        </select>
        <FilterButton activeCount={activeFilterCount} onClick={() => setFilterDrawerOpen(true)} />
        <span className="ml-auto text-xs tabular-nums text-slate-500" role="status">{ordersLoading ? 'Loading…' : `${visiblePos.length.toLocaleString('en-IN')} work orders`}</span>
      </div>

      <FilterDrawer
        open={filterDrawerOpen}
        onClose={() => setFilterDrawerOpen(false)}
        onClear={() => { setStatusFilter(''); changeClientFilter(''); setFulfillmentFilter(''); setCampaignFilterValue(''); setZoneFilter(''); }}
        activeCount={activeFilterCount}
        resultCount={filteredPos.length}
        resultLabel="Work Orders"
      >
        <FilterSection label="Client">
          <input aria-label="Find client" value={clientOptionSearch} onChange={e => setClientOptionSearch(e.target.value)} placeholder="Find a client…" className="mb-2 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-600" />
          <select value={clientFilter} aria-label="Filter by client" onChange={e => changeClientFilter(e.target.value)} className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-600">
            <option value="">All clients</option>
            {clientOptions.map(c => <option value={c.id} key={c.id}>{c.name}</option>)}
          </select>
          <p className="mt-1 text-xs text-slate-500">Showing the first 75 matches. Type to find a client.</p>
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
        <FilterSection label="Fulfillment Type">
          <select value={fulfillmentFilter} onChange={(e) => setFulfillmentFilter(e.target.value)} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500">
            <option value="">All Types</option>
            {FULFILLMENT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </FilterSection>
      </FilterDrawer>

      {clientRequests.length > 0 && (
        <details className="group mb-3 rounded-lg border border-amber-200 bg-amber-50/60" open={requestsExpanded} onToggle={event => setRequestsExpanded(event.currentTarget.open)}>
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm text-amber-950 focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-600">
            <span className="flex items-center gap-2"><Inbox className="h-4 w-4 text-amber-700"/><strong className="font-medium">{clientRequests.length} client {clientRequests.length === 1 ? 'request' : 'requests'} awaiting acceptance</strong></span>
            <span className="text-xs text-amber-700">Review <ChevronDown className="inline h-4 w-4 group-open:rotate-180"/></span>
          </summary>
          <div className="space-y-2 border-t border-amber-200 px-3 py-3">

            {clientRequests.slice(0, 5).map((po) => (
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
          {clientRequests.length > 5 && <button type="button" onClick={() => { setStatusFilter('awaiting_response'); setRequestsExpanded(false); }} className="px-2 py-2 text-xs font-medium text-blue-700 hover:underline">See all {clientRequests.length} pending requests in the Work Orders list →</button>}
          {respondMutation.isError && <p className="px-2 text-sm text-red-600 mt-2">{(respondMutation.error as Error).message}</p>}
        </details>
      )}

      {/* LISTING — one clean line per Work Order: number, client, campaign,
          a single primary status, completion, amount, date. Everything
          else (line items, utilization breakdown, burndown, invoicing
          balance, actions) lives in the detail drawer a row click opens —
          keeps the list itself scannable instead of every row trying to
          show everything at once. */}
      <Card className="overflow-hidden">
        <div className="divide-y divide-slate-100 md:hidden" role="region" aria-label="Work orders list on mobile">
          {!ordersLoading && !ordersError && pagedPos.map(po => {
            const { completionPct, lineCount } = getPoMetrics(po, utilization || []);
            const primary = getPrimaryStatus(po);
            return <button type="button" key={po.id} onClick={() => openWorkOrder(po.id)} className="block w-full px-4 py-3 text-left hover:bg-blue-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-600">
              <div className="flex items-start justify-between gap-2"><div className="min-w-0"><p className="truncate text-sm font-medium text-slate-900">{po.name || po.po_number}</p><p className="mt-0.5 text-xs text-slate-500">{po.po_number} · {po.clients?.name || 'Client not set'}</p></div><StatusBadge status={primary.status} label={primary.label}/></div>
              <div className="mt-3 flex items-center justify-between gap-3 text-xs text-slate-500"><span>{lineCount} items · {shopCountByPo.get(po.id) || 0} sites</span><span>{new Date(po.po_date).toLocaleDateString('en-IN')}</span></div>
              {completionPct == null
                ? <p className="mt-2 text-xs text-slate-500">Set planned scope to calculate work completion</p>
                : <div className="mt-2 flex items-center gap-2"><ProgressBar pct={completionPct} className="flex-1"/><span className="w-10 text-right text-xs text-slate-600">{`${Math.round(completionPct)}%`}</span></div>}
            </button>;
          })}
          {ordersLoading && <p className="px-4 py-8 text-center text-sm text-slate-500" role="status">Loading work orders…</p>}
          {!ordersLoading && !ordersError && !pagedPos.length && <p className="px-4 py-8 text-center text-sm text-slate-500">No matching work orders.</p>}
        </div>
        <div className="hidden overflow-x-auto md:block" role="region" aria-label="Work orders list" tabIndex={0}>
          <table className="w-full text-sm min-w-[720px]">
            <thead className="bg-slate-50 text-slate-500 text-xs uppercase tracking-wide">
              <tr>
                <th className="text-left px-4 py-3 font-semibold">Work Order</th>
                <th className="text-left px-4 py-3 font-semibold">Client</th>
                <th className="text-left px-4 py-3 font-semibold">Status</th>
                <th className="text-left px-4 py-3 font-semibold w-40">Completion</th>
                <th className="text-right px-4 py-3 font-semibold">Amount</th>
                <th className="text-left px-4 py-3 font-semibold whitespace-nowrap">Date</th>
                <th className="px-4 py-3 w-8"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {!ordersLoading && !ordersError && pagedPos.map((po) => {
                const { lineCount, anyVariance, completionPct } = getPoMetrics(po, utilization || []);
                const shopCount = shopCountByPo.get(po.id) || 0;
                const primary = getPrimaryStatus(po);

                return (
                  <tr
                    key={po.id}
                    onClick={() => openWorkOrder(po.id)}
                    onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openWorkOrder(po.id); } }}
                    tabIndex={0}
                    aria-label={`Open Work Order ${po.name || po.po_number}`}
                    className="hover:bg-blue-50/50 cursor-pointer transition-colors group focus-visible:bg-blue-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500"
                  >
                    <td className="px-4 py-3.5">
                      {po.name && <p className="font-semibold text-slate-900">{po.name}</p>}
                      <p className={po.name ? 'text-xs text-slate-400 mt-0.5' : 'font-semibold text-slate-900'}>{po.po_number}</p>
                      <p className="text-xs text-slate-400 mt-0.5">
                        {lineCount} item{lineCount === 1 ? '' : 's'}{shopCount > 0 ? ` · ${shopCount} shop${shopCount === 1 ? '' : 's'}` : ''}
                      </p>
                    </td>
                    <td className="px-4 py-3.5 text-slate-700">{po.clients?.name || <span className="text-slate-300">—</span>}</td>
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
                      {completionPct != null ? (
                        <div className="flex items-center gap-2">
                          <ProgressBar pct={completionPct} className="flex-1" />
                          <span className="text-xs text-slate-500 w-8 text-right shrink-0">{`${Math.round(completionPct)}%`}</span>
                        </div>
                      ) : <span className="text-slate-500 text-xs" title="Set planned quantities on every line item to calculate work completion">Scope needed</span>}
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
              {ordersLoading && (
                <tr><td colSpan={7} className="px-4 py-12 text-center text-sm text-slate-500"><Loader2 className="mx-auto mb-2 h-5 w-5 animate-spin" />Loading work orders…</td></tr>
              )}
              {!ordersLoading && !ordersError && visiblePos.length === 0 && (
                <tr>
                  <td colSpan={7}>
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
          <p className="text-xs text-slate-500 -mt-2">
            {FULFILLMENT_OPTIONS.find((f) => f.value === form.fulfillment_type)?.description}
          </p>

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
        title="Delete Work Order"
        message={
          deletePoIsEmpty
            ? `Permanently delete Work Order "${deletePo?.name ? `${deletePo.name} — ` : ''}${deletePo?.po_number}" and its line items? This cannot be undone.`
            : `Work Order "${deletePo?.name ? `${deletePo.name} — ` : ''}${deletePo?.po_number}" has shops and/or invoices attached. Deleting it will permanently delete ALL of them too — every survey, design, production and installation record under those shops. This cannot be undone.`
        }
        confirmLabel="Delete Work Order"
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
          reconciledInvoiced={detailInvoicedAmount}
          billingPending={billingPending}
          billingError={billingError}
          shopCount={shopCountByPo.get(detailPo.id) || 0}
          canDelete={canDelete}
          canHardDelete={detailPoIsEmpty}
          onClose={() => openWorkOrder(null)}
          onEdit={() => { openWorkOrder(null); openEdit(detailPo); }}
          onManageLineItems={() => { openWorkOrder(null); setLineItemsPo(detailPo); }}
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
// Ground-crew assignment for a Direct Install Work Order (migration 0078).
// A shop can be assigned to a surveyor/installer via `shop_assignments`
// because a shop already exists at that point — a Direct Install PO's
// whole point is that no shop exists yet, so this is the PO-level
// equivalent: pick who on the ground team is on this job, and only THEY
// see it in their Installer app's Direct Install tab (InstallerPage.tsx).
function DirectInstallTeamCard({ po }: { po: PoRow }) {
  const { profile } = useAuth();
  const orgId = profile?.organization_id;
  const queryClient = useQueryClient();
  const [selectedInstaller, setSelectedInstaller] = useState('');
  const [error, setError] = useState<string | null>(null);

  const { data: installers } = useQuery({
    queryKey: ['org-installers', orgId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('profiles').select('id, full_name')
        .eq('organization_id', orgId).eq('role', 'installer').eq('is_active', true)
        .order('full_name');
      if (error) throw new Error(error.message);
      return data as { id: string; full_name: string }[];
    },
    enabled: !!orgId,
  });

  const assignmentsKey = ['po-assignments', po.id];
  const { data: assignments } = useQuery({
    queryKey: assignmentsKey,
    queryFn: async () => {
      const { data, error } = await supabase.from('po_assignments').select('*').eq('purchase_order_id', po.id).order('assigned_at');
      if (error) throw new Error(error.message);
      return data as PoAssignment[];
    },
    enabled: !!po.id,
  });

  useRealtimeInvalidate(['po_assignments'], orgId, [assignmentsKey]);

  const assignedIds = new Set((assignments || []).map((a) => a.user_id));
  const availableInstallers = (installers || []).filter((i) => !assignedIds.has(i.id));

  const assignMutation = useMutation({
    mutationFn: async (userId: string) => {
      const { error: insertError } = await supabase.from('po_assignments').insert({
        organization_id: orgId, purchase_order_id: po.id, user_id: userId, role: 'installer', assigned_by: profile?.id,
      });
      if (insertError) throw new Error(insertError.message);
      const installer = (installers || []).find((i) => i.id === userId);
      await logAudit('po_assignments', po.id, 'create', null, null, null, `Assigned ${installer?.full_name || 'an installer'} to Direct Install ${po.po_number}`);
      await createNotification(
        userId,
        'Assigned: Direct Install Work Order',
        `You've been assigned to ${po.name || po.po_number} — open the Direct Install tab in your app to log a site.`,
        'info',
        '/mobile'
      );
    },
    onSuccess: () => { setSelectedInstaller(''); setError(null); queryClient.invalidateQueries({ queryKey: assignmentsKey }); },
    onError: (err: any) => setError(err?.message || 'Could not assign this installer.'),
  });

  const removeMutation = useMutation({
    mutationFn: async (assignment: PoAssignment) => {
      const { error: deleteError } = await supabase.from('po_assignments').delete().eq('id', assignment.id);
      if (deleteError) throw new Error(deleteError.message);
      await logAudit('po_assignments', po.id, 'delete', null, null, null, `Removed an installer from Direct Install ${po.po_number}`);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: assignmentsKey }),
    onError: (err: any) => setError(err?.message || 'Could not remove this installer.'),
  });

  return (
    <div className="border border-amber-200 bg-amber-50/60 rounded-lg p-3.5">
      <div className="flex items-center gap-1.5 mb-1">
        <Users className="w-4 h-4 text-amber-700" />
        <span className="text-sm font-medium text-amber-900">Ground Team Assigned</span>
      </div>
      <p className="text-xs text-amber-700/80 mb-3">
        Only the installers listed here will see this Work Order in their app's Direct Install tab.
      </p>

      {(assignments || []).length > 0 ? (
        <div className="space-y-1.5 mb-3">
          {(assignments || []).map((a) => {
            const installer = (installers || []).find((i) => i.id === a.user_id);
            return (
              <div key={a.id} className="flex items-center justify-between bg-white rounded-lg px-3 py-2 text-sm border border-amber-100">
                <span className="font-medium text-slate-900">{installer?.full_name || 'Installer'}</span>
                <button
                  onClick={() => removeMutation.mutate(a)}
                  disabled={removeMutation.isPending}
                  title="Remove from this Work Order"
                  className="text-slate-400 hover:text-red-600 transition disabled:opacity-50"
                >
                  <UserMinus className="w-4 h-4" />
                </button>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="text-xs text-amber-700/70 mb-3 italic">Nobody assigned yet — no installer can log a site here until you add one.</p>
      )}

      {error && <p className="text-xs text-red-600 mb-2">{error}</p>}

      <div className="flex gap-2 items-end">
        <div className="flex-1">
          <Select value={selectedInstaller} onChange={setSelectedInstaller} options={availableInstallers.map((i) => ({ value: i.id, label: i.full_name }))} label="" />
        </div>
        <button
          disabled={!selectedInstaller || assignMutation.isPending}
          onClick={() => assignMutation.mutate(selectedInstaller)}
          className="shrink-0 flex items-center gap-1.5 bg-amber-600 hover:bg-amber-700 disabled:bg-amber-300 text-white px-3 py-2 rounded-lg text-sm font-medium transition"
        >
          <UserPlus className="w-4 h-4" /> Assign
        </button>
      </div>
      {availableInstallers.length === 0 && (installers || []).length > 0 && (
        <p className="text-[11px] text-amber-700/60 mt-1.5">Every active installer in your org is already assigned to this Work Order.</p>
      )}
      {(installers || []).length === 0 && (
        <p className="text-[11px] text-amber-700/60 mt-1.5">No active installer accounts in your org yet — add one from Owner Console → Team.</p>
      )}
    </div>
  );
}

function WorkOrderDetailDrawer({
  po, utilization, shopCount, canDelete, canHardDelete,
  onClose, onEdit, onManageLineItems, onDelete, onRespond, isResponding,
  reconciledInvoiced, billingPending, billingError,
}: {
  po: PoRow;
  utilization: POLineItemUtilization[];
  reconciledInvoiced?: number;
  billingPending: boolean;
  billingError: boolean;
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
  const { anyVariance, stage } = getPoMetrics(po, utilization);
  const progress = calculatePoProgress(utilization, stage, po.po_line_items?.length || 0, reconciledInvoiced);
  const primary = getPrimaryStatus(po);
  const isPending = po.origin === 'client_created' && po.assignment_status === 'pending_acceptance';

  return (
    <Drawer open={!!po} onClose={onClose} title={po.name || po.po_number} subtitle={po.name ? `${po.po_number}${po.clients?.name ? ` · ${po.clients.name}` : ''}` : (po.clients?.name || undefined)} width="xl">
      <div className="space-y-6">
        <div className="flex flex-wrap items-center gap-1.5">
          <StatusBadge status={primary.status} label={primary.label} />
          <StatusBadge status={po.fulfillment_type} label={fulfillmentTypeLabel(po.fulfillment_type)} />
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
          {canDelete && (
            <button
              onClick={onDelete}
              title={canHardDelete ? 'No shops or invoices attached — safe to permanently delete' : 'Has shops and/or invoices attached — deleting this Work Order permanently deletes all of them too'}
              className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-sm font-medium transition bg-red-50 hover:bg-red-100 text-red-600"
            >
              <Trash2 className="w-4 h-4" />
              Delete Work Order
            </button>
          )}
        </div>

        {/* Direct Install (migration 0077) has no shop to assign a
            surveyor/installer to until the ground crew logs one — this is
            the PO-level equivalent (migration 0078), so the right people
            actually see this Work Order in their app instead of every
            installer in the org seeing every Direct Install PO. */}
        {po.fulfillment_type === 'direct_install' && <DirectInstallTeamCard po={po} />}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3">
          <div>
            <p className="text-xs text-slate-400 flex items-center gap-1 mb-0.5"><Building2 className="w-3 h-3" /> Client</p>
            <p className="text-sm font-medium text-slate-900">{po.clients?.name || '—'}</p>
          </div>
          <div>
            <p className="text-xs text-slate-400 flex items-center gap-1 mb-0.5"><Calendar className="w-3 h-3" /> Order Date</p>
            <p className="text-sm font-medium text-slate-900">{new Date(po.po_date).toLocaleDateString('en-IN')}</p>
          </div>
        </div>

        <PoCompletionDonut
          key={po.id}
          progress={progress}
          stage={stage}
          billingPending={billingPending}
          billingError={billingError}
        />

        <PoStageProgressChart rows={utilization} stage={stage} fulfillmentType={po.fulfillment_type} />
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
                const comparable = !(stage === 'produced' && isAreaUom(row.uom));
                const rowPct = comparable ? fig.utilizationPct : null;
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
                      <div className="mx-auto w-24 text-center" title={!comparable ? 'Production pieces cannot be compared with a sqft budget' : undefined}>
                        <ProgressBar pct={rowPct} />
                        <span className="text-[11px] text-slate-500">
                          {rowPct == null ? '—' : `${Math.round(Math.max(0, Math.min(100, rowPct)))}%${rowPct > 100 ? '+' : ''}`}
                        </span>
                      </div>
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
      {open && <p className="mt-2 text-[11px] text-slate-500">Per-line invoicing includes only invoice items linked to that line. The financial overview also reconciles PO-level invoice items that were not linked individually.</p>}
    </div>
  );
}

// The existing donut is now one selectable, non-overlapping view. Work is
// operational scope (default); Financial is billing against the PO budget.
// These measures NEVER share a numerator: invoices do not prove work done.
function PoCompletionDonut({ progress, stage, billingPending, billingError }: { progress: PoProgressSummary; stage: UtilizationStage; billingPending?: boolean; billingError?: boolean }) {
  const [mode, setMode] = useState<'work' | 'financial'>('work');
  const isWork = mode === 'work';
  const pct = isWork ? progress.workPct : (billingPending || billingError ? null : progress.financialPct);
  const budget = progress.budgetedAmount;
  const segments = isWork
    ? [
        { key: 'done', label: 'Executed', value: pct ?? 0, color: '#2563eb' },
        { key: 'remaining', label: 'Remaining', value: 100 - (pct ?? 0), color: '#e2e8f0' },
      ]
    : [
        { key: 'billed', label: 'Invoiced', value: budget != null ? Math.min(budget, progress.invoicedAmount) : 0, color: '#059669' },
        { key: 'unbilled', label: 'Not invoiced', value: budget != null ? Math.max(0, budget - progress.invoicedAmount) : 0, color: '#e2e8f0' },
      ];
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4" aria-label="Overall completion">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div>
          <h3 className="text-sm font-semibold text-slate-900">Overall completion</h3>
          <p className="text-xs text-slate-500 mt-0.5">{isWork ? `Actual ${stage === 'produced' ? 'production' : 'installation'} against planned scope` : 'Invoicing against planned line-item value (excl. GST)'}</p>
        </div>
        <div className="inline-flex rounded-lg border border-slate-200 bg-slate-50 p-0.5" role="group" aria-label="Completion calculation">
          {(['work', 'financial'] as const).map((value) => (
            <button key={value} type="button" aria-pressed={mode === value} onClick={() => setMode(value)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-600 ${mode === value ? 'bg-white text-blue-700 shadow-sm' : 'text-slate-600 hover:text-slate-900'}`}>
              {value === 'work' ? 'Work' : 'Financial'}
            </button>
          ))}
        </div>
      </div>
      {pct == null ? (
        <div className="rounded-lg bg-slate-50 px-4 py-5 text-sm text-slate-600" role="status">
          {isWork
            ? 'Work completion is not available until every line item has a planned quantity or area.'
            : billingPending ? 'Reconciling invoice items…' : billingError ? 'Could not load invoice items. Please retry the Work Order.' : 'Financial completion is not available until every line item has planned scope and a rate, with a positive total budget.'}
        </div>
      ) : (
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:gap-6">
          <DonutChart segments={segments} size={140} strokeWidth={17} centerValue={`${Math.round(pct)}%`} centerLabel={isWork ? 'work done' : 'invoiced'} />
          <div className="min-w-0 flex-1 space-y-3">
            {isWork ? (
              <>
                <p className="text-xs text-slate-600">{Math.round(100 - pct)}% of planned scope remains. Breakdown by unit:</p>
                <div className="text-xs text-slate-600 space-y-1">
                  {progress.groups.map((g) => <p key={g.uom} className="flex items-center justify-between gap-2"><span>{g.uom === 'sqft' ? 'Area' : g.uom === 'piece' ? 'Pieces' : 'Lots'}:</span><span className="font-medium tabular-nums">{formatQty(g.completed, g.uom)} / {formatQty(g.planned, g.uom)}</span></p>)}
                </div>
                {progress.groups.length > 1 && <p className="text-[11px] text-slate-500">Mixed units are reconciled within each unit, then weighted equally by unit type.</p>}
                {progress.excessScope && <p className="text-xs text-amber-700">Recorded execution exceeds planned scope on at least one line. Progress is capped at 100%.</p>}
              </>
            ) : (
              <>
                <div className="space-y-2 text-xs">
                  <p className="flex items-center justify-between gap-3"><span className="text-slate-500">Planned value</span><span className="font-semibold tabular-nums text-slate-900">{formatRupees(budget)}</span></p>
                  <p className="flex items-center justify-between gap-3"><span className="text-slate-500">Invoiced</span><span className="font-semibold tabular-nums text-emerald-700">{formatRupees(progress.invoicedAmount)}</span></p>
                  <p className="flex items-center justify-between gap-3 border-t border-slate-100 pt-2"><span className="text-slate-500">Uninvoiced balance</span><span className="font-semibold tabular-nums text-slate-900">{formatRupees(Math.max(0, progress.balance ?? 0))}</span></p>
                </div>
                {progress.overInvoicedAmount > 0 && <p className="text-xs font-medium text-red-700">Invoiced {formatRupees(progress.overInvoicedAmount)} above planned value. Chart is capped at 100%.</p>}
                <p className="text-[11px] text-slate-500">Billing progress, not payment collection or physical work completion.</p>
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function PoStageProgressChart({ rows, stage, fulfillmentType }: {
  rows: POLineItemUtilization[];
  stage: UtilizationStage;
  fulfillmentType?: string | null;
}) {
  // Supply-only and direct-install skip these upstream stages entirely.
  // The final installation/production % is already the donut above.
  if (!rows.length || fulfillmentType === 'supply_only' || fulfillmentType === 'direct_install' || stage !== 'installed') return null;
  const steps: { key: UtilizationStage; label: string; color: string }[] = [
    { key: 'surveyed', label: 'Survey recorded', color: '#2563eb' },
    { key: 'approved', label: 'Design approved', color: '#7c3aed' },
    { key: 'produced', label: 'Production recorded', color: '#d97706' },
  ];
  return (
    <section className="rounded-xl border border-slate-200 p-4">
      <h3 className="mb-3 flex items-center gap-1.5 text-sm font-semibold text-slate-900"><TrendingUp className="h-4 w-4 text-slate-500" /> Upstream stages</h3>
      <div className="space-y-3">
        {steps.map((s) => {
          const summary = calculatePoProgress(rows, s.key);
          const pct = summary.workPct;
          const producedPieces = s.key === 'produced' ? rows.reduce((n, r) => n + Math.max(0, r.produced_qty || 0), 0) : 0;
          return (
            <div key={s.key}>
              <div className="flex items-center justify-between gap-3 text-xs mb-1.5">
                <span className="font-medium text-slate-600">{s.label}</span>
                <span className="text-slate-500 tabular-nums">{pct == null ? (s.key === 'produced' ? `${producedPieces.toLocaleString('en-IN')} pcs recorded · no comparable area target` : 'Scope needed') : `${Math.round(pct)}%`}</span>
              </div>
              <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden" role="progressbar" aria-label={s.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? 0}>
                <div className="h-full rounded-full" style={{ width: `${pct ?? 0}%`, backgroundColor: s.color }} />
              </div>
            </div>
          );
        })}
      </div>
      <p className="mt-3 text-[11px] text-slate-500">Stage figures are recorded quantities against planned scope, not paid value. Production is reported in pieces where area is not comparable.</p>
    </section>
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

        <PoStageProgressChart rows={utilization} stage={defaultUtilizationStage(po.fulfillment_type)} fulfillmentType={po.fulfillment_type} />

        <PoUtilizationTable rows={utilization} stage={defaultUtilizationStage(po.fulfillment_type)} />

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
