import { useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { Card, EmptyState, Modal, Input, Select, Textarea, ProgressBar, FilterButton, FilterDrawer, FilterSection } from '@/components/ui';
import { logAudit, notifyLinkedOrg } from '@/lib/helpers';
import type { PurchaseOrder, ClientAgencyLink, ClientPOLineItemProgress, Campaign } from '@/lib/types';
import {
  stagePct, finalStage, clientPoWorkStatus, CLIENT_PO_WORK_STATUS_LABELS, CLIENT_PO_WORK_STATUS_COLORS,
} from '@/lib/clientPortal';
import {
  ArrowLeft, Plus, Search, ShoppingCart, Loader2, Trash2, ArrowRight, Store, Building2,
  Megaphone, Pencil, Calendar,
} from 'lucide-react';

type PoRow = PurchaseOrder & { agency_org: { name: string } | null };
type ShopRow = { id: string; purchase_order_id: string | null };
type LinkRow = ClientAgencyLink & { agency_org: { name: string } | null };

const FULFILLMENT_OPTIONS = [
  { value: 'survey_install', label: 'Survey + Install' },
  { value: 'supply_only', label: 'Supply Only' },
];
const UOM_OPTIONS = [
  { value: 'sqft', label: 'Sq.ft' },
  { value: 'piece', label: 'Piece' },
  { value: 'lot', label: 'Lot' },
];
const emptyForm = { agency_org_id: '', po_number: '', name: '', po_date: new Date().toISOString().split('T')[0], fulfillment_type: 'survey_install', notes: '', payment_terms: '' };
const emptyLine = { description: '', uom: 'sqft', budgeted_qty: '', budgeted_area: '' };
const STATUS_OPTIONS = [
  { value: 'active', label: 'Active' },
  { value: 'completed', label: 'Completed' },
  { value: 'cancelled', label: 'Cancelled' },
];
const emptyEditCampaignForm = { name: '', description: '', start_date: '', end_date: '', status: 'active' as Campaign['status'] };

export default function ClientCampaignDetailPage() {
  const { campaignId } = useParams<{ campaignId: string }>();
  const navigate = useNavigate();
  const { profile } = useAuth();
  const orgId = profile?.organization_id;
  const queryClient = useQueryClient();

  const [search, setSearch] = useState('');
  const [agencyFilter, setAgencyFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [sortBy, setSortBy] = useState('date_desc');
  const [filterDrawerOpen, setFilterDrawerOpen] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [lines, setLines] = useState([{ ...emptyLine }]);
  const [editCampaignOpen, setEditCampaignOpen] = useState(false);
  const [editCampaignForm, setEditCampaignForm] = useState(emptyEditCampaignForm);

  const { data: campaign, isLoading: campaignLoading } = useQuery({
    queryKey: ['client-campaign-detail', campaignId],
    queryFn: async () => {
      const { data, error } = await supabase.from('campaigns').select('*').eq('id', campaignId).maybeSingle();
      if (error) throw error;
      return data as Campaign | null;
    },
    enabled: !!campaignId,
  });

  const { data: pos, isLoading } = useQuery({
    queryKey: ['client-campaign-pos', campaignId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('purchase_orders')
        .select('*, agency_org:organizations!purchase_orders_assigned_agency_id_fkey(name)')
        .eq('campaign_id', campaignId)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data as PoRow[];
    },
    enabled: !!campaignId,
  });

  const { data: shops } = useQuery({
    queryKey: ['client-campaign-shops', campaignId, (pos || []).map((p) => p.id).join(',')],
    queryFn: async () => {
      const ids = (pos || []).map((p) => p.id);
      if (ids.length === 0) return [];
      const { data, error } = await supabase.from('shops').select('id, purchase_order_id').in('purchase_order_id', ids);
      if (error) throw error;
      return data as ShopRow[];
    },
    enabled: !!campaignId && !!pos && pos.length > 0,
  });

  const { data: progress } = useQuery({
    queryKey: ['client-campaign-progress', campaignId, (pos || []).map((p) => p.id).join(',')],
    queryFn: async () => {
      const ids = (pos || []).map((p) => p.id);
      if (ids.length === 0) return [];
      const { data, error } = await supabase.from('v_client_po_line_item_progress').select('*').in('purchase_order_id', ids);
      if (error) throw error;
      return data as ClientPOLineItemProgress[];
    },
    enabled: !!campaignId && !!pos && pos.length > 0,
  });

  const { data: links } = useQuery({
    queryKey: ['client-agency-links', orgId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('client_agency_links')
        .select('*, agency_org:organizations!client_agency_links_agency_org_id_fkey(name)')
        .eq('client_org_id', orgId)
        .eq('status', 'active');
      if (error) throw error;
      return data as LinkRow[];
    },
    enabled: !!orgId,
  });
  const assignableAgencies = (links || []).filter((l) => !!l.agency_client_id);

  const createMutation = useMutation({
    mutationFn: async () => {
      const link = assignableAgencies.find((l) => l.agency_org_id === form.agency_org_id);
      if (!link?.agency_client_id) throw new Error('Pick an agency to assign this Work Order to.');

      const { data: po, error } = await supabase.from('purchase_orders').insert({
        organization_id: form.agency_org_id,
        client_id: link.agency_client_id,
        client_org_id: orgId,
        assigned_agency_id: form.agency_org_id,
        campaign_id: campaignId,
        origin: 'client_created',
        assignment_status: 'pending_acceptance',
        po_number: form.po_number,
        name: form.name || null,
        po_date: form.po_date,
        fulfillment_type: form.fulfillment_type,
        notes: form.notes || null,
        payment_terms: form.payment_terms || null,
        created_by: profile?.id,
      }).select().single();
      if (error) throw error;

      const rows = lines
        .filter((li) => li.description.trim())
        .map((li) => ({
          organization_id: form.agency_org_id,
          purchase_order_id: po.id,
          description: li.description.trim(),
          uom: li.uom,
          budgeted_qty: li.uom !== 'sqft' && li.budgeted_qty ? Number(li.budgeted_qty) : null,
          budgeted_area: li.uom === 'sqft' && li.budgeted_area ? Number(li.budgeted_area) : null,
        }));
      if (rows.length) {
        const { error: liErr } = await supabase.from('po_line_items').insert(rows);
        if (liErr) throw liErr;
      }

      await logAudit('purchase_orders', po.id, 'insert', null, null, null, `Created Work Order ${form.po_number} under campaign "${campaign?.name}" and assigned to agency`);
      await notifyLinkedOrg(form.agency_org_id, 'New Work Order from a client', `${po.po_number} was created and is waiting on your Accept/Reject.`, 'info', '/purchase-orders');
      return po as PurchaseOrder;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['client-campaign-pos', campaignId] });
      queryClient.invalidateQueries({ queryKey: ['client-campaigns-pos-rollup', orgId] });
      setModalOpen(false);
      setForm(emptyForm);
      setLines([{ ...emptyLine }]);
    },
  });

  function openCreate() {
    setForm(emptyForm);
    setLines([{ ...emptyLine }]);
    setModalOpen(true);
  }
  function updateLine(idx: number, field: string, value: string) {
    setLines(lines.map((l, i) => (i === idx ? { ...l, [field]: value } : l)));
  }
  function addLine() { setLines([...lines, { ...emptyLine }]); }
  function removeLine(idx: number) { setLines(lines.filter((_, i) => i !== idx)); }

  const editCampaignMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from('campaigns').update({
        name: editCampaignForm.name.trim(),
        description: editCampaignForm.description.trim() || null,
        start_date: editCampaignForm.start_date || null,
        end_date: editCampaignForm.end_date || null,
        status: editCampaignForm.status,
      }).eq('id', campaignId);
      if (error) throw error;
      await logAudit('campaigns', campaignId!, 'update', null, null, null, `Edited campaign "${editCampaignForm.name}"`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['client-campaign-detail', campaignId] });
      queryClient.invalidateQueries({ queryKey: ['client-campaigns', orgId] });
      setEditCampaignOpen(false);
    },
  });

  function openEditCampaign() {
    if (!campaign) return;
    setEditCampaignForm({
      name: campaign.name, description: campaign.description || '',
      start_date: campaign.start_date || '', end_date: campaign.end_date || '', status: campaign.status,
    });
    setEditCampaignOpen(true);
  }

  const canSubmit = !!form.agency_org_id && !!form.po_number && !!form.po_date && lines.some((l) => l.description.trim());

  const siteCountByPo = new Map<string, number>();
  for (const s of shops || []) {
    if (!s.purchase_order_id) continue;
    siteCountByPo.set(s.purchase_order_id, (siteCountByPo.get(s.purchase_order_id) || 0) + 1);
  }
  const progressByPo = new Map<string, ClientPOLineItemProgress[]>();
  for (const row of progress || []) {
    const arr = progressByPo.get(row.purchase_order_id) || [];
    arr.push(row);
    progressByPo.set(row.purchase_order_id, arr);
  }
  const rows = (pos || []).map((po) => {
    const poProgress = progressByPo.get(po.id) || [];
    const completionPct = stagePct(poProgress, finalStage(po.fulfillment_type));
    const workStatus = clientPoWorkStatus(po, completionPct);
    return { po, sites: siteCountByPo.get(po.id) || 0, completionPct, workStatus };
  });

  const agencyOptionsForFilter = Array.from(
    new Map((pos || []).filter((p) => p.assigned_agency_id).map((p) => [p.assigned_agency_id as string, p.agency_org?.name || 'Agency'])).entries()
  ).sort((a, b) => a[1].localeCompare(b[1]));

  const filteredRows = rows.filter(({ po, workStatus }) => {
    if (search && !po.po_number.toLowerCase().includes(search.toLowerCase()) && !(po.name || '').toLowerCase().includes(search.toLowerCase())) return false;
    if (agencyFilter && po.assigned_agency_id !== agencyFilter) return false;
    if (statusFilter && workStatus !== statusFilter) return false;
    return true;
  });

  const sortedRows = [...filteredRows].sort((a, b) => {
    switch (sortBy) {
      case 'po_number_asc':
        return a.po.po_number.localeCompare(b.po.po_number);
      case 'date_asc':
        return new Date(a.po.po_date).getTime() - new Date(b.po.po_date).getTime();
      case 'agency_asc':
        return (a.po.agency_org?.name || '').localeCompare(b.po.agency_org?.name || '');
      case 'progress_desc':
        return (b.completionPct ?? -1) - (a.completionPct ?? -1);
      case 'sites_desc':
        return b.sites - a.sites;
      case 'date_desc':
      default:
        return new Date(b.po.po_date).getTime() - new Date(a.po.po_date).getTime();
    }
  });

  const activeFilterCount = [search, agencyFilter, statusFilter].filter(Boolean).length;
  const hasActiveFilters = activeFilterCount > 0;
  const SORT_OPTIONS = [
    { value: 'date_desc', label: 'Order Date (Newest first)' },
    { value: 'date_asc', label: 'Order Date (Oldest first)' },
    { value: 'po_number_asc', label: 'Work Order No. (A–Z)' },
    { value: 'agency_asc', label: 'Agency (A–Z)' },
    { value: 'progress_desc', label: 'Progress (Highest first)' },
    { value: 'sites_desc', label: 'Sites (Most first)' },
  ];

  if (campaignLoading) {
    return <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 text-blue-600 animate-spin" /></div>;
  }
  if (!campaign) {
    return (
      <div>
        <button onClick={() => navigate('/client/campaigns')} className="flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800 mb-4">
          <ArrowLeft className="w-4 h-4" /> Back to Campaigns
        </button>
        <Card><EmptyState icon={<Megaphone className="w-12 h-12" />} title="Campaign not found" /></Card>
      </div>
    );
  }

  return (
    <div>
      <button onClick={() => navigate('/client/campaigns')} className="flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800 mb-4">
        <ArrowLeft className="w-4 h-4" /> Back to Campaigns
      </button>

      <div className="flex flex-wrap items-start justify-between gap-4 mb-5">
        <div>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-violet-50 flex items-center justify-center shrink-0">
              <Megaphone className="w-5 h-5 text-violet-600" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-slate-900">{campaign.name}</h1>
              {(campaign.start_date || campaign.end_date) && (
                <p className="text-sm text-slate-500 mt-0.5 flex items-center gap-1">
                  <Calendar className="w-3.5 h-3.5" />
                  {campaign.start_date ? new Date(campaign.start_date).toLocaleDateString('en-IN') : '—'} → {campaign.end_date ? new Date(campaign.end_date).toLocaleDateString('en-IN') : '—'}
                </p>
              )}
            </div>
          </div>
          {campaign.description && <p className="text-sm text-slate-600 mt-2 max-w-2xl">{campaign.description}</p>}
        </div>
        <button onClick={openEditCampaign} className="flex items-center gap-1.5 text-sm text-slate-500 border border-slate-200 hover:bg-slate-50 px-3 py-1.5 rounded-lg font-medium">
          <Pencil className="w-3.5 h-3.5" /> Edit Campaign
        </button>
      </div>

      <div className="flex items-center justify-between mb-3">
        <h2 className="font-semibold text-slate-900">Work Orders in this Campaign</h2>
        <button
          onClick={openCreate}
          disabled={assignableAgencies.length === 0}
          title={assignableAgencies.length === 0 ? 'No linked agency yet — ask your agency to invite you, or add one from the Agencies page' : undefined}
          className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg font-medium text-sm transition disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Plus className="w-4 h-4" /> Add Work Order
        </button>
      </div>

      {assignableAgencies.length === 0 && (
        <Card className="p-4 mb-5 border-amber-200 bg-amber-50/40">
          <p className="text-sm text-amber-700">You need at least one linked agency before adding a Work Order. Go to the <Link to="/client/agencies" className="underline font-medium">Agencies page</Link> to add one.</p>
        </Card>
      )}

      {(pos || []).length > 0 && (
        <div className="flex flex-wrap items-center gap-2 mb-4">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by Work Order number..."
              className="w-full pl-9 pr-3 py-2 border border-slate-300 rounded-lg text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value)}
            className="px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500"
          >
            {SORT_OPTIONS.map((o) => <option key={o.value} value={o.value}>Sort: {o.label}</option>)}
          </select>
          <FilterButton activeCount={activeFilterCount} onClick={() => setFilterDrawerOpen(true)} />
          {hasActiveFilters && (
            <span className="text-xs text-slate-400">{filteredRows.length} of {rows.length} shown</span>
          )}
        </div>
      )}

      <FilterDrawer
        open={filterDrawerOpen}
        onClose={() => setFilterDrawerOpen(false)}
        onClear={() => { setSearch(''); setAgencyFilter(''); setStatusFilter(''); }}
        activeCount={activeFilterCount}
        resultCount={filteredRows.length}
        resultLabel="Work Orders"
      >
        {/* Agency is the primary lens — a client can work with several
            agencies at once, so this is shown first, above status. */}
        {agencyOptionsForFilter.length > 0 && (
          <FilterSection label="Agency">
            <select value={agencyFilter} onChange={(e) => setAgencyFilter(e.target.value)} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500">
              <option value="">All Agencies ({agencyOptionsForFilter.length})</option>
              {agencyOptionsForFilter.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </select>
          </FilterSection>
        )}
        <FilterSection label="Status">
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500">
            <option value="">All Statuses</option>
            {Object.entries(CLIENT_PO_WORK_STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </FilterSection>
      </FilterDrawer>

      <div className="space-y-3">
        {sortedRows.map(({ po, sites, completionPct, workStatus }) => (
          <Link key={po.id} to={`/client/campaigns/${campaignId}/po/${po.id}`}>
            <Card className="p-4 hover:border-blue-300 transition">
              <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
                <div className="min-w-[160px]">
                  {po.name && <p className="font-semibold text-slate-900">{po.name}</p>}
                  <p className={po.name ? 'text-xs text-slate-400' : 'font-semibold text-slate-900'}>{po.po_number}</p>
                  <p className="text-xs text-slate-500">{new Date(po.po_date).toLocaleDateString('en-IN')}</p>
                </div>
                <div className="min-w-[140px]">
                  <p className="text-xs text-slate-400">Agency</p>
                  <p className="text-sm text-slate-700 flex items-center gap-1"><Building2 className="w-3.5 h-3.5 text-slate-400" /> {po.agency_org?.name || 'Unassigned'}</p>
                </div>
                <div className="min-w-[90px]">
                  <p className="text-xs text-slate-400">Sites</p>
                  <p className="text-sm text-slate-700 flex items-center gap-1"><Store className="w-3.5 h-3.5 text-slate-400" /> {sites}</p>
                </div>
                <div className="min-w-[140px] flex-1 max-w-[220px]">
                  <div className="flex items-center justify-between text-xs text-slate-400 mb-1">
                    <span>Work Done</span><span>{completionPct != null ? `${Math.round(completionPct)}%` : '—'}</span>
                  </div>
                  <ProgressBar pct={completionPct} />
                </div>
                <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${CLIENT_PO_WORK_STATUS_COLORS[workStatus]}`}>
                  {CLIENT_PO_WORK_STATUS_LABELS[workStatus]}
                </span>
                <ArrowRight className="w-4 h-4 text-slate-300 ml-auto" />
              </div>
            </Card>
          </Link>
        ))}
        {!isLoading && filteredRows.length === 0 && (
          <Card>
            <EmptyState
              icon={<ShoppingCart className="w-12 h-12" />}
              title={pos && pos.length > 0 ? 'No Work Orders match these filters' : 'No Work Orders in this campaign yet'}
              subtitle={pos && pos.length > 0 ? 'Try clearing a filter' : 'Click "Add Work Order" to create one and pick which agency it goes to'}
            />
          </Card>
        )}
      </div>

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="Add Work Order" size="xl">
        <div className="space-y-4">
          <Select label="Assign to Agency" value={form.agency_org_id} onChange={(v) => setForm({ ...form, agency_org_id: v })} options={assignableAgencies.map((l) => ({ value: l.agency_org_id, label: l.agency_org?.name || 'Agency' }))} required />

          <Input
            label="Work Order Name (optional)"
            value={form.name}
            onChange={(v) => setForm({ ...form, name: v })}
            placeholder="e.g. Q3 Andheri Dealer Boards"
          />

          <div className="grid grid-cols-2 gap-4">
            <Input label="Work Order No." value={form.po_number} onChange={(v) => setForm({ ...form, po_number: v })} required />
            <Input label="Order Date" type="date" value={form.po_date} onChange={(v) => setForm({ ...form, po_date: v })} required />
          </div>

          <Select label="Fulfillment Type" value={form.fulfillment_type} onChange={(v) => setForm({ ...form, fulfillment_type: v })} options={FULFILLMENT_OPTIONS} required />
          <Input label="Payment Terms" value={form.payment_terms} onChange={(v) => setForm({ ...form, payment_terms: v })} placeholder="e.g. 50% advance, 50% on installation" />
          <Textarea label="Notes / Timeline" value={form.notes} onChange={(v) => setForm({ ...form, notes: v })} placeholder="Locations, timeline, or any special instructions for the agency" />

          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-sm font-medium text-slate-700">Scope / Line Items</label>
              <button onClick={addLine} type="button" className="text-sm text-blue-600 font-medium">+ Add Item</button>
            </div>
            <div className="space-y-2">
              {lines.map((line, idx) => (
                <div key={idx} className="grid grid-cols-12 gap-2 items-start bg-slate-50 border border-slate-200 rounded-lg p-2">
                  <div className="col-span-6">
                    <input placeholder="Description / work type" value={line.description} onChange={(e) => updateLine(idx, 'description', e.target.value)} className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm" />
                  </div>
                  <div className="col-span-3">
                    <select value={line.uom} onChange={(e) => updateLine(idx, 'uom', e.target.value)} className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm bg-white">
                      {UOM_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  </div>
                  <div className="col-span-2">
                    <input
                      placeholder={line.uom === 'sqft' ? 'Area' : 'Qty'}
                      type="number"
                      value={line.uom === 'sqft' ? line.budgeted_area : line.budgeted_qty}
                      onChange={(e) => updateLine(idx, line.uom === 'sqft' ? 'budgeted_area' : 'budgeted_qty', e.target.value)}
                      className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm"
                    />
                  </div>
                  <div className="col-span-1 flex justify-center pt-1.5">
                    {lines.length > 1 && (
                      <button type="button" onClick={() => removeLine(idx)} className="text-slate-400 hover:text-red-600">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
            <p className="text-xs text-slate-400 mt-1.5">Scope only — quantity/area and work type. Pricing is set and managed by the agency, not here.</p>
          </div>

          {createMutation.isError && <p className="text-sm text-red-600">{(createMutation.error as Error).message}</p>}

          <button
            onClick={() => createMutation.mutate()}
            disabled={createMutation.isPending || !canSubmit}
            className="w-full flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-700 text-white font-medium py-2.5 rounded-lg transition disabled:opacity-50"
          >
            {createMutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
            {createMutation.isPending ? 'Sending to agency...' : 'Create & Send to Agency'}
          </button>
        </div>
      </Modal>

      <Modal open={editCampaignOpen} onClose={() => setEditCampaignOpen(false)} title="Edit Campaign" size="md">
        <div className="space-y-4">
          <Input label="Campaign Name" value={editCampaignForm.name} onChange={(v) => setEditCampaignForm({ ...editCampaignForm, name: v })} required />
          <Textarea label="Description" value={editCampaignForm.description} onChange={(v) => setEditCampaignForm({ ...editCampaignForm, description: v })} />
          <div className="grid grid-cols-2 gap-4">
            <Input label="Start Date" type="date" value={editCampaignForm.start_date} onChange={(v) => setEditCampaignForm({ ...editCampaignForm, start_date: v })} />
            <Input label="End Date" type="date" value={editCampaignForm.end_date} onChange={(v) => setEditCampaignForm({ ...editCampaignForm, end_date: v })} />
          </div>
          <Select label="Status" value={editCampaignForm.status} onChange={(v) => setEditCampaignForm({ ...editCampaignForm, status: v as Campaign['status'] })} options={STATUS_OPTIONS} />

          {editCampaignMutation.isError && <p className="text-sm text-red-600">{(editCampaignMutation.error as Error).message}</p>}

          <button
            onClick={() => editCampaignMutation.mutate()}
            disabled={editCampaignMutation.isPending || !editCampaignForm.name.trim()}
            className="w-full flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-700 text-white font-medium py-2.5 rounded-lg transition disabled:opacity-50"
          >
            {editCampaignMutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
            {editCampaignMutation.isPending ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </Modal>
    </div>
  );
}
