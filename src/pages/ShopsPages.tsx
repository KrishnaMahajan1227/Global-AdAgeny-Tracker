import { useState, useEffect, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import * as XLSX from 'xlsx';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { Link, useSearchParams } from 'react-router-dom';
import {
  Modal, ConfirmDialog, Card, Input, Select, Textarea, StatusBadge, EmptyState, PageHeader,
  FilterButton, FilterDrawer, FilterSection, Combobox,
} from '@/components/ui';
import { Client, Project, Campaign, Shop, WorkType, WorkItem, SurveyPhoto, BoardMarking, Zone, PurchaseOrder, POLineItem, WorkItemComponent } from '@/lib/types';
import { logAudit, createNotification } from '@/lib/helpers';
import { useRealtimeInvalidate } from '@/lib/useRealtimeInvalidate';
import { MarkedPhotoGrid } from '@/components/MarkedPhotoGrid';
import { formatDim, LENGTH_UNIT_OPTIONS, toFeet } from '@/lib/units';
import { fulfillmentTypeLabel } from '@/lib/poUtilization';
import { geocodeAddress, buildAddressQuery } from '@/lib/geocode';
import { findShopHeaderRow, findExtraHeaders, buildShopRows, resolveZoneIds, type ParsedShopRow } from '@/lib/shopBulkUpload';
import { runBackfillPipeline, BACKFILL_INELIGIBLE_STATUSES, type BackfillStage } from '@/lib/backfillPipeline';
import { downloadBulkBackfillTemplate, parseBulkBackfillWorkbook, type BulkBackfillParsedShop, type BulkBackfillShopRow } from '@/lib/bulkBackfillExcel';
import { INDIA_STATES, INDIA_CITIES_BY_STATE, ALL_INDIA_CITIES } from '@/lib/indiaLocations';
import {
  Plus, Pencil, Trash2, Store, MapPin, ArrowLeft, Search, CheckCircle2, UserPlus, CheckSquare, Square,
  Ruler, FileText, Palette, Wrench, Users, AlertCircle, XCircle, Clock, Camera, LocateFixed, Loader2, Layers,
  ListChecks, Building2, Lock, ListOrdered, UploadCloud, ChevronRight, Ban, Phone,
  ChevronLeft, ChevronsLeft, ChevronsRight, X, RotateCcw, FastForward, PlusCircle, Download,
} from 'lucide-react';

// Page sizes offered on the Shops list. Kept modest (not "show all") on
// purpose — this list is expected to grow into the tens of thousands of
// rows, so every fetch is server-paginated + server-filtered instead of
// pulling the whole table into the browser.
const SHOP_PAGE_SIZES = [25, 50, 100, 200] as const;
const DEFAULT_SHOP_PAGE_SIZE = 50;

// Debounce a fast-changing value (typing in the search box) so we don't
// fire a network request on every keystroke against a table that can
// hold 10,000+ rows.
function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

export function ClientsPage() {
  const { profile } = useAuth();
  const orgId = profile?.organization_id;
  const queryClient = useQueryClient();
  const canHardDelete = profile?.role === 'agency_owner' || profile?.role === 'admin';
  const [modalOpen, setModalOpen] = useState(false);
  const [editClient, setEditClient] = useState<Client | null>(null);
  const [deactivateClient, setDeactivateClient] = useState<Client | null>(null);
  const [hardDeleteClient, setHardDeleteClient] = useState<Client | null>(null);
  const [confirmName, setConfirmName] = useState('');
  const [notice, setNotice] = useState<{ kind: 'error' | 'success'; message: string } | null>(null);
  const [form, setForm] = useState({ name: '', contact_person: '', contact_phone: '', contact_email: '', address: '', city: '', state: '', gst_number: '' });

  const { data: clients } = useQuery({
    queryKey: ['clients', orgId],
    queryFn: async () => {
      const { data } = await supabase.from('clients').select('*').eq('organization_id', orgId).order('name');
      return data as Client[];
    },
    enabled: !!orgId,
  });

  // Counts of everything that hangs off this client — fetched only once
  // the hard-delete dialog opens, so the person sees exactly what "delete
  // everything" actually means before they can type the name to confirm.
  const { data: relatedCounts, isLoading: countsLoading } = useQuery({
    queryKey: ['client-related-counts', hardDeleteClient?.id],
    queryFn: async () => {
      const clientId = hardDeleteClient!.id;
      const [campaigns, workOrders, shops, invoices] = await Promise.all([
        supabase.from('projects').select('id', { count: 'exact', head: true }).eq('client_id', clientId),
        supabase.from('purchase_orders').select('id', { count: 'exact', head: true }).eq('client_id', clientId),
        supabase.from('shops').select('id', { count: 'exact', head: true }).eq('client_id', clientId),
        supabase.from('invoices').select('id', { count: 'exact', head: true }).eq('client_id', clientId),
      ]);
      return {
        campaigns: campaigns.count || 0,
        workOrders: workOrders.count || 0,
        shops: shops.count || 0,
        invoices: invoices.count || 0,
      };
    },
    enabled: !!hardDeleteClient,
  });

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (editClient) {
        const { error } = await supabase.from('clients').update({
          name: form.name, contact_person: form.contact_person, contact_phone: form.contact_phone,
          contact_email: form.contact_email, address: form.address, city: form.city, state: form.state, gst_number: form.gst_number,
        }).eq('id', editClient.id);
        if (error) throw error;
        await logAudit('clients', editClient.id, 'update', null, null, null, `Updated client: ${form.name}`);
      } else {
        const { data, error } = await supabase.from('clients').insert({
          organization_id: orgId, name: form.name, contact_person: form.contact_person,
          contact_phone: form.contact_phone, contact_email: form.contact_email, address: form.address,
          city: form.city, state: form.state, gst_number: form.gst_number,
        }).select().single();
        if (error) throw error;
        await logAudit('clients', data.id, 'insert', null, null, null, `Created client: ${form.name}`);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['clients', orgId] });
      setModalOpen(false);
      setNotice({ kind: 'success', message: editClient ? 'Client updated.' : 'Client added.' });
    },
    onError: (err: Error) => {
      setNotice({ kind: 'error', message: err.message || 'Could not save this client. Please try again.' });
    },
  });

  // Soft, reversible: just flips is_active so the client drops out of
  // "active client" pickers elsewhere (Campaigns, Work Orders, Reports)
  // without touching a single row of its history.
  const deactivateMutation = useMutation({
    mutationFn: async ({ client, active }: { client: Client; active: boolean }) => {
      const { error } = await supabase.from('clients').update({ is_active: active }).eq('id', client.id);
      if (error) throw error;
      await logAudit('clients', client.id, 'update', 'is_active', String(!active), String(active), `${active ? 'Reactivated' : 'Deactivated'} client: ${client.name}`);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['clients', orgId] }),
    onSuccess: (_data, { client, active }) => {
      setNotice({ kind: 'success', message: `${client.name} ${active ? 'reactivated' : 'deactivated'}.` });
      setDeactivateClient(null);
    },
    onError: (err: Error) => {
      setNotice({ kind: 'error', message: err.message || 'Could not update this client. Please try again.' });
    },
  });

  // Hard, irreversible: an actual DELETE on `clients`. Every table that
  // hangs off a client — projects/campaigns, purchase_orders + their line
  // items, shops + every survey/design/production/installation record
  // under them, invoices + their line items, zones, rate cards, dispatch
  // and vehicle-load records — is wired with ON DELETE CASCADE all the way
  // down, so this one statement is genuinely enough to clean every table.
  // No client-side loop of manual per-table deletes is needed (or safer,
  // since a partial client-side cascade could leave orphans on failure).
  const hardDeleteMutation = useMutation({
    mutationFn: async (client: Client) => {
      const { error } = await supabase.from('clients').delete().eq('id', client.id);
      if (error) throw error;
      await logAudit('clients', client.id, 'delete', null, null, null, `Permanently deleted client "${client.name}" and all its campaigns, work orders, shops and invoices`);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['clients', orgId] }),
    onSuccess: (_data, client) => {
      setNotice({ kind: 'success', message: `"${client.name}" and everything under it has been permanently deleted.` });
      setHardDeleteClient(null);
      setConfirmName('');
    },
    onError: (err: Error) => {
      setNotice({ kind: 'error', message: err.message || 'Could not delete this client. Please try again.' });
    },
  });

  function openAdd() {
    setEditClient(null);
    setForm({ name: '', contact_person: '', contact_phone: '', contact_email: '', address: '', city: '', state: '', gst_number: '' });
    setNotice(null);
    setModalOpen(true);
  }

  function openEdit(client: Client) {
    setEditClient(client);
    setForm({
      name: client.name, contact_person: client.contact_person || '', contact_phone: client.contact_phone || '',
      contact_email: client.contact_email || '', address: client.address || '', city: client.city || '',
      state: client.state || '', gst_number: client.gst_number || '',
    });
    setNotice(null);
    setModalOpen(true);
  }

  function openHardDelete(client: Client) {
    setConfirmName('');
    hardDeleteMutation.reset();
    setHardDeleteClient(client);
  }

  const hardDeleteReady = confirmName.trim().toLowerCase() === (hardDeleteClient?.name || '').trim().toLowerCase();

  return (
    <div>
      <PageHeader
        title="Clients"
        subtitle="Manage your agency's clients"
        action={
          <button onClick={openAdd} className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg font-medium text-sm transition">
            <Plus className="w-4 h-4" /> Add Client
          </button>
        }
      />

      {notice && (
        <div className={`flex items-start gap-2.5 rounded-lg px-4 py-3 mb-4 text-sm ${notice.kind === 'error' ? 'bg-red-50 text-red-700 border border-red-100' : 'bg-emerald-50 text-emerald-700 border border-emerald-100'}`}>
          {notice.kind === 'error' ? <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" /> : <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />}
          <p className="flex-1">{notice.message}</p>
          <button onClick={() => setNotice(null)} className="text-current opacity-60 hover:opacity-100"><X className="w-4 h-4" /></button>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {clients?.map((client) => (
          <Card key={client.id} className={`p-5 ${!client.is_active ? 'opacity-70' : ''}`}>
            <div className="flex items-start justify-between mb-3">
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="font-semibold text-slate-900">{client.name}</h3>
                  {!client.is_active && (
                    <span className="text-[10px] font-semibold uppercase tracking-wide bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded">Inactive</span>
                  )}
                </div>
                <p className="text-sm text-slate-500">{client.contact_person || 'No contact'}</p>
              </div>
              <div className="flex gap-1 shrink-0">
                <button onClick={() => openEdit(client)} title="Edit" className="p-1.5 text-slate-400 hover:text-blue-600">
                  <Pencil className="w-4 h-4" />
                </button>
                {client.is_active ? (
                  <button onClick={() => setDeactivateClient(client)} title="Deactivate (keeps all data, reversible)" className="p-1.5 text-slate-400 hover:text-amber-600">
                    <Ban className="w-4 h-4" />
                  </button>
                ) : (
                  <button onClick={() => deactivateMutation.mutate({ client, active: true })} title="Reactivate" className="p-1.5 text-slate-400 hover:text-emerald-600">
                    <RotateCcw className="w-4 h-4" />
                  </button>
                )}
                {canHardDelete && (
                  <button onClick={() => openHardDelete(client)} title="Delete permanently — removes all its campaigns, work orders, shops and invoices" className="p-1.5 text-slate-400 hover:text-red-600">
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>
            </div>
            <div className="text-sm text-slate-600 space-y-1">
              {client.city && <p>{client.city}, {client.state}</p>}
              {client.contact_phone && <p>{client.contact_phone}</p>}
              {client.gst_number && <p className="text-xs text-slate-400">GST: {client.gst_number}</p>}
            </div>
            <Link to={`/projects?client=${client.id}`} className="mt-3 inline-block text-sm text-blue-600 hover:underline">
              View Projects →
            </Link>
          </Card>
        ))}
        {clients?.length === 0 && (
          <Card className="col-span-full">
            <EmptyState icon={<Store className="w-12 h-12" />} title="No clients yet" subtitle="Add your first client to get started" />
          </Card>
        )}
      </div>

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={editClient ? 'Edit Client' : 'Add Client'}>
        <div className="space-y-4">
          <Input label="Client Name" value={form.name} onChange={(v) => setForm({ ...form, name: v })} required />
          <div className="grid grid-cols-2 gap-4">
            <Input label="Contact Person" value={form.contact_person} onChange={(v) => setForm({ ...form, contact_person: v })} />
            <Input label="Contact Phone" value={form.contact_phone} onChange={(v) => setForm({ ...form, contact_phone: v })} />
          </div>
          <Input label="Contact Email" type="email" value={form.contact_email} onChange={(v) => setForm({ ...form, contact_email: v })} />
          <Textarea label="Address" value={form.address} onChange={(v) => setForm({ ...form, address: v })} rows={2} />
          <div className="grid grid-cols-2 gap-4">
            <Combobox label="City" value={form.city} onChange={(v) => setForm({ ...form, city: v })} options={form.state && INDIA_CITIES_BY_STATE[form.state] ? INDIA_CITIES_BY_STATE[form.state] : ALL_INDIA_CITIES} />
            <Combobox label="State" value={form.state} onChange={(v) => setForm({ ...form, state: v })} options={INDIA_STATES} />
          </div>
          <Input label="GST Number" value={form.gst_number} onChange={(v) => setForm({ ...form, gst_number: v })} />
          <button
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending || !form.name}
            className="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium py-2.5 rounded-lg transition disabled:opacity-50"
          >
            {saveMutation.isPending ? 'Saving...' : editClient ? 'Update Client' : 'Add Client'}
          </button>
          {saveMutation.isError && (
            <p className="text-sm text-red-600">{(saveMutation.error as Error).message}</p>
          )}
        </div>
      </Modal>

      <ConfirmDialog
        open={!!deactivateClient}
        onClose={() => { setDeactivateClient(null); deactivateMutation.reset(); }}
        onConfirm={() => deactivateClient && deactivateMutation.mutate({ client: deactivateClient, active: false })}
        title="Deactivate Client"
        message={`Deactivate ${deactivateClient?.name}? It disappears from active-client pickers everywhere, but every campaign, work order, shop and invoice stays exactly as-is. You can reactivate it any time.`}
        confirmLabel="Deactivate"
        danger
        manualClose
        loading={deactivateMutation.isPending}
        error={deactivateMutation.isError ? ((deactivateMutation.error as Error).message || 'Could not deactivate this client.') : null}
      />

      {/* Hard delete — a real, cascading DELETE. Kept as its own Modal
         (rather than the plain ConfirmDialog) because it needs to show the
         related-record counts and force typing the client's name before
         the button will even enable — this is irreversible everywhere. */}
      <Modal open={!!hardDeleteClient} onClose={() => { if (!hardDeleteMutation.isPending) { setHardDeleteClient(null); setConfirmName(''); } }} title="Delete Client Permanently">
        {hardDeleteClient && (
          <div className="space-y-4">
            <div className="flex items-start gap-3 bg-red-50 border border-red-100 rounded-lg p-3.5">
              <AlertCircle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
              <div className="text-sm text-red-800">
                <p className="font-semibold mb-1">This cannot be undone.</p>
                <p>Deleting <span className="font-semibold">{hardDeleteClient.name}</span> permanently removes it and everything under it, everywhere in the platform:</p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2.5 text-sm">
              <RelatedCountRow label="Campaigns" count={relatedCounts?.campaigns} loading={countsLoading} />
              <RelatedCountRow label="Work Orders (+ line items)" count={relatedCounts?.workOrders} loading={countsLoading} />
              <RelatedCountRow label="Shops (+ surveys, designs, production, installs)" count={relatedCounts?.shops} loading={countsLoading} />
              <RelatedCountRow label="Invoices (+ line items)" count={relatedCounts?.invoices} loading={countsLoading} />
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">
                Type <span className="font-semibold">{hardDeleteClient.name}</span> to confirm
              </label>
              <input
                value={confirmName}
                onChange={(e) => setConfirmName(e.target.value)}
                placeholder={hardDeleteClient.name}
                disabled={hardDeleteMutation.isPending}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm outline-none focus:ring-2 focus:ring-red-500 disabled:opacity-60"
              />
            </div>

            {hardDeleteMutation.isError && (
              <p className="text-sm text-red-600 flex items-center gap-1.5"><AlertCircle className="w-4 h-4 shrink-0" />{(hardDeleteMutation.error as Error).message}</p>
            )}

            <div className="flex gap-3">
              <button
                onClick={() => { setHardDeleteClient(null); setConfirmName(''); }}
                disabled={hardDeleteMutation.isPending}
                className="flex-1 px-4 py-2.5 text-sm font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={() => hardDeleteClient && hardDeleteMutation.mutate(hardDeleteClient)}
                disabled={!hardDeleteReady || hardDeleteMutation.isPending}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {hardDeleteMutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
                {hardDeleteMutation.isPending ? 'Deleting everything...' : 'Delete Permanently'}
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

function RelatedCountRow({ label, count, loading }: { label: string; count: number | undefined; loading: boolean }) {
  return (
    <div className="flex items-center justify-between bg-slate-50 border border-slate-100 rounded-lg px-3 py-2">
      <span className="text-slate-600">{label}</span>
      <span className="font-semibold text-slate-900">{loading ? '…' : (count ?? 0).toLocaleString('en-IN')}</span>
    </div>
  );
}

// Campaigns — the agency-side grouping level shown above Work Orders (POs).
// Two kinds of rows share this one table:
//  1. "Agency" campaigns — rows in this org's own `projects` table. Full
//     CRUD, only ever visible/owned by this agency (unchanged data model,
//     just relabelled from "Project" to "Campaign" everywhere in the UI).
//  2. "Client" campaigns — rows in the client-owned `campaigns` table,
//     visible here (read-only) because a linked client org assigned at
//     least one Work Order (PO) to this agency under that campaign (RLS:
//     campaigns_select, migration 0051). Never editable from this side —
//     the client owns creation/renaming/status; the agency only ever acts
//     on the Work Orders that arrive under it.
export function CampaignsPage() {
  const { profile } = useAuth();
  const orgId = profile?.organization_id;
  const queryClient = useQueryClient();
  const canDelete = profile?.role === 'agency_owner' || profile?.role === 'admin';
  const [modalOpen, setModalOpen] = useState(false);
  const [editProject, setEditProject] = useState<Project | null>(null);
  const [deleteProject, setDeleteProject] = useState<Project | null>(null);
  const [form, setForm] = useState({ name: '', client_id: '', description: '', start_date: '', status: 'active' });
  const [search, setSearch] = useState('');
  const [clientFilter, setClientFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [sourceFilter, setSourceFilter] = useState('');
  const [sortBy, setSortBy] = useState('created_desc');
  const [filterDrawerOpen, setFilterDrawerOpen] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'error' | 'success'; message: string } | null>(null);

  const { data: clients } = useQuery({
    queryKey: ['clients', orgId],
    queryFn: async () => {
      const { data } = await supabase.from('clients').select('id, name').eq('organization_id', orgId).eq('is_active', true).order('name');
      return data;
    },
    enabled: !!orgId,
  });

  const { data: projects } = useQuery({
    queryKey: ['projects', orgId],
    queryFn: async () => {
      const { data } = await supabase
        .from('projects')
        .select('*, clients(name)')
        .eq('organization_id', orgId)
        .order('created_at', { ascending: false });
      return data as (Project & { clients: { name: string } | null })[];
    },
    enabled: !!orgId,
  });

  // Client-owned campaigns that have at least one Work Order assigned to
  // this agency — RLS (campaigns_select) already restricts the rows that
  // come back to exactly those, so no extra filtering is needed here.
  const { data: clientCampaigns } = useQuery({
    queryKey: ['client-campaigns', orgId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('campaigns')
        .select('*, client_org:organizations!campaigns_client_org_id_fkey(name)')
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data as (Campaign & { client_org: { name: string } | null })[];
    },
    enabled: !!orgId,
  });

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (editProject) {
        const { error } = await supabase.from('projects').update({
          name: form.name, client_id: form.client_id, description: form.description,
          start_date: form.start_date || null, status: form.status,
        }).eq('id', editProject.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from('projects').insert({
          organization_id: orgId, name: form.name, client_id: form.client_id,
          description: form.description, start_date: form.start_date || null, status: form.status,
        });
        if (error) throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects', orgId] });
      setModalOpen(false);
      setNotice({ kind: 'success', message: editProject ? 'Campaign updated.' : 'Campaign created.' });
    },
    onError: (err: Error) => {
      setNotice({ kind: 'error', message: err.message || 'Could not save the campaign. Please try again.' });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      if (!deleteProject) return null;
      const { data, error } = await supabase.rpc('delete_campaign_cascade', { p_project_id: deleteProject.id });
      if (error) throw error;
      return data as { shops: number; purchase_orders: number; invoices: number } | null;
    },
    // Runs whether the delete succeeded or failed — so the list always
    // reflects the true database state instead of quietly going stale if
    // something after the delete (e.g. a notification) throws.
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['projects', orgId] });
      queryClient.invalidateQueries({ queryKey: ['shops', orgId] });
      queryClient.invalidateQueries({ queryKey: ['purchase-orders', orgId] });
      queryClient.invalidateQueries({ queryKey: ['invoices', orgId] });
    },
    onSuccess: (counts) => {
      const parts = [];
      if (counts?.shops) parts.push(`${counts.shops} shop${counts.shops === 1 ? '' : 's'}`);
      if (counts?.purchase_orders) parts.push(`${counts.purchase_orders} Work Order${counts.purchase_orders === 1 ? '' : 's'}`);
      if (counts?.invoices) parts.push(`${counts.invoices} invoice${counts.invoices === 1 ? '' : 's'}`);
      setNotice({ kind: 'success', message: parts.length > 0 ? `"${deleteProject?.name}" deleted, along with ${parts.join(', ')} and all their survey/design/production/installation records.` : `"${deleteProject?.name}" deleted.` });
      setDeleteProject(null);
    },
    onError: (err: Error) => {
      setNotice({ kind: 'error', message: err.message || 'Could not delete the campaign. Please try again.' });
    },
  });

  function openAdd() {
    setEditProject(null);
    setForm({ name: '', client_id: '', description: '', start_date: '', status: 'active' });
    setNotice(null);
    setModalOpen(true);
  }

  function openEdit(project: Project) {
    setEditProject(project);
    setForm({
      name: project.name, client_id: project.client_id, description: project.description || '',
      start_date: project.start_date || '', status: project.status,
    });
    setNotice(null);
    setModalOpen(true);
  }

  const totalCount = (projects?.length || 0) + (clientCampaigns?.length || 0);

  // Unify "My Campaign" (projects) and "Client Campaign" rows into one
  // shape so search/filter/sort can work across both at once instead of
  // two separate un-filterable tables.
  type CampaignRow = {
    key: string; kind: 'project' | 'client'; name: string; description: string | null;
    clientName: string; clientId: string | null; status: string; startDate: string | null;
    project?: Project; campaign?: Campaign & { client_org: { name: string } | null };
  };
  const allRows: CampaignRow[] = [
    ...(projects || []).map((p): CampaignRow => ({
      key: `p-${p.id}`, kind: 'project', name: p.name, description: p.description,
      clientName: p.clients?.name || 'No client', clientId: p.client_id, status: p.status,
      startDate: p.start_date, project: p,
    })),
    ...(clientCampaigns || []).map((c): CampaignRow => ({
      key: `c-${c.id}`, kind: 'client', name: c.name, description: c.description,
      clientName: c.client_org?.name || 'Linked client', clientId: null, status: c.status,
      startDate: c.start_date, campaign: c,
    })),
  ];

  const filteredRows = allRows.filter((r) => {
    if (search) {
      const term = search.toLowerCase();
      if (!r.name.toLowerCase().includes(term) && !r.clientName.toLowerCase().includes(term)) return false;
    }
    if (clientFilter && r.clientId !== clientFilter) return false;
    if (statusFilter && r.status !== statusFilter) return false;
    if (sourceFilter && r.kind !== sourceFilter) return false;
    return true;
  });

  const sortedRows = [...filteredRows].sort((a, b) => {
    switch (sortBy) {
      case 'name_asc':
        return a.name.localeCompare(b.name);
      case 'client_asc':
        return a.clientName.localeCompare(b.clientName);
      case 'status_asc':
        return a.status.localeCompare(b.status);
      case 'date_asc':
        return new Date(a.startDate || 0).getTime() - new Date(b.startDate || 0).getTime();
      case 'date_desc':
        return new Date(b.startDate || 0).getTime() - new Date(a.startDate || 0).getTime();
      case 'created_desc':
      default:
        // Both source arrays already come back newest-first from their
        // own queries; preserve that relative order (projects first).
        return 0;
    }
  });

  const activeFilterCount = [clientFilter, statusFilter, sourceFilter].filter(Boolean).length;
  const SORT_OPTIONS = [
    { value: 'created_desc', label: 'Newest first' },
    { value: 'name_asc', label: 'Name (A–Z)' },
    { value: 'client_asc', label: 'Client (A–Z)' },
    { value: 'status_asc', label: 'Status' },
    { value: 'date_desc', label: 'Start Date (Newest first)' },
    { value: 'date_asc', label: 'Start Date (Oldest first)' },
  ];

  return (
    <div>
      <PageHeader
        title="Campaigns"
        subtitle="Your own campaigns, plus every client campaign a Work Order has been assigned to you under"
        action={
          <button onClick={openAdd} className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg font-medium text-sm transition">
            <Plus className="w-4 h-4" /> Add Campaign
          </button>
        }
      />

      {notice && (
        <div className={`flex items-start gap-2.5 rounded-lg px-4 py-3 mb-4 text-sm ${notice.kind === 'error' ? 'bg-red-50 text-red-700 border border-red-100' : 'bg-emerald-50 text-emerald-700 border border-emerald-100'}`}>
          {notice.kind === 'error' ? <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" /> : <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />}
          <p className="flex-1">{notice.message}</p>
          <button onClick={() => setNotice(null)} className="text-current opacity-60 hover:opacity-100"><X className="w-4 h-4" /></button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 mb-4">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by campaign or client name..."
            className="w-full pl-9 pr-3 py-2 border border-slate-300 rounded-lg text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <select value={sortBy} onChange={(e) => setSortBy(e.target.value)} className="px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500">
          {SORT_OPTIONS.map((o) => <option key={o.value} value={o.value}>Sort: {o.label}</option>)}
        </select>
        <FilterButton activeCount={activeFilterCount} onClick={() => setFilterDrawerOpen(true)} />
        {(search || activeFilterCount > 0) && <span className="text-xs text-slate-400">{filteredRows.length} of {allRows.length} shown</span>}
      </div>

      <FilterDrawer
        open={filterDrawerOpen}
        onClose={() => setFilterDrawerOpen(false)}
        onClear={() => { setClientFilter(''); setStatusFilter(''); setSourceFilter(''); }}
        activeCount={activeFilterCount}
        resultCount={filteredRows.length}
        resultLabel="campaigns"
      >
        <FilterSection label="Source">
          <select value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500">
            <option value="">All Sources</option>
            <option value="project">My Campaigns</option>
            <option value="client">Client Campaigns</option>
          </select>
        </FilterSection>
        <FilterSection label="Client (My Campaigns)">
          <select value={clientFilter} onChange={(e) => setClientFilter(e.target.value)} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500">
            <option value="">All Clients</option>
            {(clients || []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </FilterSection>
        <FilterSection label="Status">
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500">
            <option value="">All Statuses</option>
            <option value="active">Active</option>
            <option value="on_hold">On Hold</option>
            <option value="completed">Completed</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </FilterSection>
      </FilterDrawer>

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-600">
              <tr>
                <th className="text-left px-4 py-3 font-medium">Campaign</th>
                <th className="text-left px-4 py-3 font-medium">Client</th>
                <th className="text-left px-4 py-3 font-medium">Source</th>
                <th className="text-left px-4 py-3 font-medium">Status</th>
                <th className="text-left px-4 py-3 font-medium">Start Date</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {sortedRows.map((r) => r.kind === 'project' && r.project ? (
                <tr key={r.key} className="hover:bg-slate-50">
                  <td className="px-4 py-3">
                    <p className="font-medium text-slate-900">{r.project.name}</p>
                    {r.project.description && <p className="text-xs text-slate-500">{r.project.description}</p>}
                  </td>
                  <td className="px-4 py-3 text-slate-600">{r.clientName}</td>
                  <td className="px-4 py-3">
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-700">
                      <Layers className="w-3 h-3" /> My Campaign
                    </span>
                  </td>
                  <td className="px-4 py-3"><StatusBadge status={r.project.status} /></td>
                  <td className="px-4 py-3 text-slate-500 text-xs">{r.project.start_date ? new Date(r.project.start_date).toLocaleDateString('en-IN') : '—'}</td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <Link to={`/purchase-orders?project=${r.project.id}`} className="text-xs text-blue-600 hover:underline flex items-center gap-1">
                        <ListOrdered className="w-3.5 h-3.5" /> Work Orders
                      </Link>
                      <button onClick={() => openEdit(r.project!)} className="p-1 text-slate-400 hover:text-blue-600">
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      {canDelete && (
                        <button onClick={() => setDeleteProject(r.project!)} className="p-1 text-slate-400 hover:text-red-600">
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ) : r.campaign ? (
                <tr key={r.key} className="hover:bg-slate-50">
                  <td className="px-4 py-3">
                    <p className="font-medium text-slate-900">{r.campaign.name}</p>
                    {r.campaign.description && <p className="text-xs text-slate-500">{r.campaign.description}</p>}
                  </td>
                  <td className="px-4 py-3 text-slate-600 flex items-center gap-1.5">
                    <Building2 className="w-3.5 h-3.5 text-slate-400" /> {r.clientName}
                  </td>
                  <td className="px-4 py-3">
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-purple-100 text-purple-700">
                      <Lock className="w-3 h-3" /> Client Campaign
                    </span>
                  </td>
                  <td className="px-4 py-3"><StatusBadge status={r.campaign.status} /></td>
                  <td className="px-4 py-3 text-slate-500 text-xs">{r.campaign.start_date ? new Date(r.campaign.start_date).toLocaleDateString('en-IN') : '—'}</td>
                  <td className="px-4 py-3 text-right">
                    <Link to={`/purchase-orders?campaign=${r.campaign.id}`} className="text-xs text-blue-600 hover:underline flex items-center justify-end gap-1">
                      <ListOrdered className="w-3.5 h-3.5" /> Work Orders
                    </Link>
                  </td>
                </tr>
              ) : null)}
              {totalCount === 0 && (
                <tr><td colSpan={6} className="text-center py-10 text-slate-400">No campaigns yet</td></tr>
              )}
              {totalCount > 0 && sortedRows.length === 0 && (
                <tr><td colSpan={6} className="text-center py-10 text-slate-400">No campaigns match these filters</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <p className="text-xs text-slate-400 mt-2">Client campaigns are read-only here — they're managed by the client and only appear once a Work Order under them is assigned to you.</p>

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={editProject ? 'Edit Campaign' : 'Add Campaign'}>
        <div className="space-y-4">
          <Input label="Campaign Name" value={form.name} onChange={(v) => setForm({ ...form, name: v })} required />
          <Select
            label="Client"
            value={form.client_id}
            onChange={(v) => setForm({ ...form, client_id: v })}
            options={(clients || []).map((c) => ({ value: c.id, label: c.name }))}
            required
          />
          <Textarea label="Description" value={form.description} onChange={(v) => setForm({ ...form, description: v })} />
          <div className="grid grid-cols-2 gap-4">
            <Input label="Start Date" type="date" value={form.start_date} onChange={(v) => setForm({ ...form, start_date: v })} />
            <Select
              label="Status"
              value={form.status}
              onChange={(v) => setForm({ ...form, status: v })}
              options={[
                { value: 'active', label: 'Active' },
                { value: 'on_hold', label: 'On Hold' },
                { value: 'completed', label: 'Completed' },
                { value: 'cancelled', label: 'Cancelled' },
              ]}
            />
          </div>
          {saveMutation.isError && (
            <p className="text-sm text-red-600 flex items-center gap-1.5"><AlertCircle className="w-4 h-4 shrink-0" />{(saveMutation.error as Error).message}</p>
          )}
          <button
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending || !form.name || !form.client_id}
            className="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium py-2.5 rounded-lg transition disabled:opacity-50"
          >
            {saveMutation.isPending ? 'Saving...' : editProject ? 'Update Campaign' : 'Add Campaign'}
          </button>
        </div>
      </Modal>

      <ConfirmDialog
        open={!!deleteProject}
        onClose={() => { setDeleteProject(null); deleteMutation.reset(); }}
        onConfirm={() => deleteMutation.mutate()}
        title="Delete Campaign"
        message={`This permanently deletes "${deleteProject?.name}" AND every shop under it — including their surveys, designs, production records, installation history and any invoices raised under this campaign. This cannot be undone.`}
        confirmLabel="Delete Everything"
        danger
        manualClose
        loading={deleteMutation.isPending}
        error={deleteMutation.isError ? ((deleteMutation.error as Error).message || 'Could not delete this campaign.') : null}
      />
    </div>
  );
}

export function ShopsPage() {
  const { profile } = useAuth();
  const orgId = profile?.organization_id;
  const queryClient = useQueryClient();
  const [modalOpen, setModalOpen] = useState(false);
  const [editShop, setEditShop] = useState<Shop | null>(null);
  const [deleteShop, setDeleteShop] = useState<Shop | null>(null);

  // /shops?po=<work order id> — landed on from the Work Orders page's
  // "View Shops" link, so this list opens pre-filtered to just that
  // Work Order's shops instead of the whole (potentially 10,000+ row)
  // org-wide list. The filter also stays selectable from the Filters
  // bar below and is kept in the URL both ways, so the page is
  // shareable/bookmarkable and survives a refresh.
  const [searchParams, setSearchParams] = useSearchParams();
  const poFilter = searchParams.get('po') || '';

  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search.trim(), 350);
  const [statusFilter, setStatusFilter] = useState('');
  const [cityFilter, setCityFilter] = useState('');
  const debouncedCityFilter = useDebouncedValue(cityFilter.trim(), 350);
  const [districtFilter, setDistrictFilter] = useState('');
  const debouncedDistrictFilter = useDebouncedValue(districtFilter.trim(), 350);
  const [stateFilter, setStateFilter] = useState('');
  const debouncedStateFilter = useDebouncedValue(stateFilter.trim(), 350);
  const [zoneFilter, setZoneFilter] = useState('');
  const [campaignFilter, setCampaignFilter] = useState('');
  const [sortBy, setSortBy] = useState('created_desc');
  const [filterDrawerOpen, setFilterDrawerOpen] = useState(false);
  const [zoneModalOpen, setZoneModalOpen] = useState(false);
  const [newZoneName, setNewZoneName] = useState('');

  // Server-side pagination — this list is built to comfortably hold
  // 10,000+ shops. We never fetch the whole table: only the current
  // page (default 50 rows) matching the active filters, with an exact
  // count from Postgres for the "X–Y of Z" indicator and page controls.
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<number>(DEFAULT_SHOP_PAGE_SIZE);

  function setPoFilter(id: string) {
    const next = new URLSearchParams(searchParams);
    if (id) next.set('po', id); else next.delete('po');
    setSearchParams(next, { replace: true });
  }

  const [form, setForm] = useState({
    name: '', client_id: '', project_id: '', owner_name: '', contact_phone: '',
    address: '', city: '', district: '', zone_id: '', state: '', latitude: '', longitude: '', purchase_order_id: '',
    signage_language: '',
  });

  // Auto-locate: most shops only ever come in with a text address (typed
  // by a surveyor today, or from a bulk CSV upload later) — nobody hands
  // us lat/long directly. So instead of forcing that field in by hand,
  // "Locate on Map" geocodes whatever address/city/district/state we have
  // and fills latitude/longitude for us. Save falls back to the same
  // lookup automatically if those fields were left empty.
  const [geocoding, setGeocoding] = useState(false);
  const [geocodeStatus, setGeocodeStatus] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const handleLocateOnMap = async () => {
    const query = buildAddressQuery(form);
    setGeocoding(true);
    setGeocodeStatus(null);
    try {
      const result = await geocodeAddress(query);
      setForm((f) => ({ ...f, latitude: result.lat.toFixed(6), longitude: result.lng.toFixed(6) }));
      setGeocodeStatus({ type: 'success', message: `Marked at: ${result.formattedAddress}` });
    } catch (err) {
      setGeocodeStatus({ type: 'error', message: (err as Error).message });
    } finally {
      setGeocoding(false);
    }
  };

  // Bulk selection — lets an Admin/Owner assign a surveyor, installer, or
  // designer to several shops in one go instead of opening each shop one
  // at a time. Selection is a Set (not an array) so toggling a shop by id
  // is a single lookup, and re-clicking the same shop twice always ends
  // up correctly selected/deselected regardless of click order.
  const [selectMode, setSelectMode] = useState(false);
  const [selectedShopIds, setSelectedShopIds] = useState<Set<string>>(new Set());

  // Any filter change (including arriving on a new ?po= link) should land
  // back on page 1 and drop any in-progress bulk selection, since the
  // previously-selected rows may no longer even be in the result set.
  useEffect(() => {
    setPage(0);
    setSelectedShopIds(new Set());
  }, [poFilter, statusFilter, debouncedCityFilter, debouncedDistrictFilter, debouncedStateFilter, zoneFilter, campaignFilter, debouncedSearch, pageSize]);
  const [bulkAssignOpen, setBulkAssignOpen] = useState(false);
  const [bulkRole, setBulkRole] = useState<'surveyor' | 'installer' | 'designer'>('surveyor');
  const [bulkUserId, setBulkUserId] = useState('');
  const [bulkResult, setBulkResult] = useState<string | null>(null);
  const canBulkAssign = profile?.role === 'agency_owner' || profile?.role === 'admin' || profile?.role === 'demo';
  const canBulkRemove = profile?.role === 'agency_owner' || profile?.role === 'admin' || profile?.role === 'demo';
  const [bulkRemoveConfirmOpen, setBulkRemoveConfirmOpen] = useState(false);
  const [statusChangeShops, setStatusChangeShops] = useState<Shop[] | null>(null);
  const [nextShopStatus, setNextShopStatus] = useState('');

  // Bulk Upload (Excel) — every client hands over their shop list in a
  // different layout (different column order/names, a title row above
  // the header, extra client-specific columns). shopBulkUpload.ts finds
  // the real header row and maps recognized columns onto the fixed
  // field set; anything it doesn't recognize is offered back here so
  // it can be kept as extra_details instead of silently dropped.
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkClientId, setBulkClientId] = useState('');
  const [bulkProjectId, setBulkProjectId] = useState('');
  const [bulkPurchaseOrderId, setBulkPurchaseOrderId] = useState('');
  const [bulkAoa, setBulkAoa] = useState<unknown[][] | null>(null);
  const [bulkHeaders, setBulkHeaders] = useState<string[]>([]);
  const [bulkHeaderRowIndex, setBulkHeaderRowIndex] = useState(0);
  const [bulkExtraHeaders, setBulkExtraHeaders] = useState<string[]>([]);
  const [bulkIncludedExtra, setBulkIncludedExtra] = useState<Record<string, boolean>>({});
  const [bulkFileName, setBulkFileName] = useState('');
  const [bulkError, setBulkError] = useState('');
  const [bulkUploadResult, setBulkUploadResult] = useState<string | null>(null);

  const { data: clients } = useQuery({
    queryKey: ['clients', orgId],
    queryFn: async () => {
      const { data } = await supabase.from('clients').select('id, name').eq('organization_id', orgId).eq('is_active', true).order('name');
      return data;
    },
    enabled: !!orgId,
  });

  const { data: projects } = useQuery({
    queryKey: ['projects', orgId],
    queryFn: async () => {
      const { data } = await supabase.from('projects').select('id, name, client_id').eq('organization_id', orgId).order('name');
      return data;
    },
    enabled: !!orgId,
  });

  const { data: zones } = useQuery({
    queryKey: ['zones', orgId],
    queryFn: async () => {
      const { data, error } = await supabase.from('zones').select('*').eq('organization_id', orgId).order('name');
      if (error) throw error;
      return data as Zone[];
    },
    enabled: !!orgId,
  });

  // direct_install Work Orders are excluded here — their shops/sites are
  // created by the ground crew from the Installer app's own "Direct
  // Install" flow (with GPS + on-site photos), not by hand from this
  // office-side form (see InstallerPage.tsx and migration 0077).
  const { data: purchaseOrders } = useQuery({
    queryKey: ['purchase_orders', orgId],
    queryFn: async () => {
      const { data, error } = await supabase.from('purchase_orders').select('id, po_number, client_id, fulfillment_type, status').eq('organization_id', orgId).eq('status', 'active').neq('fulfillment_type', 'direct_install').order('po_number');
      if (error) throw error;
      return data as Pick<PurchaseOrder, 'id' | 'po_number' | 'client_id' | 'fulfillment_type' | 'status'>[];
    },
    enabled: !!orgId,
  });

  // ---- ADD SHOP (Already In Progress) — for shops whose survey/design/
  // production already happened outside the app entirely (nothing here
  // yet, not even the shop row). Creates the shop, then runs the exact
  // same backfill pipeline the existing-shop panel on Shop Detail uses,
  // so it ends up in exactly the same state either way. ----
  const [fastTrackOpen, setFastTrackOpen] = useState(false);
  const [ftForm, setFtForm] = useState({
    name: '', client_id: '', project_id: '', owner_name: '', contact_phone: '',
    address: '', city: '', district: '', zone_id: '', state: '', purchase_order_id: '',
  });
  const [ftStage, setFtStage] = useState<BackfillStage>('production_done');
  type FtItem = { key: string; workTypeId: string; workTypeName: string; material: string; width: string; height: string; unit: string; quantity: string };
  const [ftItems, setFtItems] = useState<FtItem[]>([
    { key: crypto.randomUUID(), workTypeId: '', workTypeName: '', material: '', width: '', height: '', unit: 'ft', quantity: '1' },
  ]);
  const [ftSurveyorId, setFtSurveyorId] = useState('');
  const [ftDesignerId, setFtDesignerId] = useState('');
  const [ftProductionId, setFtProductionId] = useState('');
  const [ftInstallerId, setFtInstallerId] = useState('');
  const [ftNote, setFtNote] = useState('');
  const [ftSurveyPhotos, setFtSurveyPhotos] = useState<File[]>([]);
  const [ftDesignFiles, setFtDesignFiles] = useState<File[]>([]);
  const [bulkBackfillOpen, setBulkBackfillOpen] = useState(false);

  const { data: ftPeople } = useQuery({
    queryKey: ['org-people-all-roles', orgId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, full_name, role')
        .eq('organization_id', orgId)
        .in('role', ['surveyor', 'designer', 'printing', 'installer'])
        .eq('is_active', true)
        .order('full_name');
      if (error) throw new Error(`Could not load team members: ${error.message}`);
      return data as { id: string; full_name: string; role: string }[];
    },
    enabled: !!orgId && (fastTrackOpen || bulkBackfillOpen),
  });
  const { data: ftWorkTypes } = useQuery({
    queryKey: ['org-work-types', orgId],
    queryFn: async () => {
      const { data, error } = await supabase.from('work_types').select('id, name').eq('organization_id', orgId).eq('is_active', true).order('name');
      if (error) throw new Error(`Could not load work types: ${error.message}`);
      return data as { id: string; name: string }[];
    },
    enabled: !!orgId && fastTrackOpen,
  });

  function resetFastTrack() {
    setFtForm({ name: '', client_id: '', project_id: '', owner_name: '', contact_phone: '', address: '', city: '', district: '', zone_id: '', state: '', purchase_order_id: '' });
    setFtStage('production_done');
    setFtItems([{ key: crypto.randomUUID(), workTypeId: '', workTypeName: '', material: '', width: '', height: '', unit: 'ft', quantity: '1' }]);
    setFtSurveyorId(''); setFtDesignerId(''); setFtProductionId(''); setFtInstallerId(''); setFtNote('');
    setFtSurveyPhotos([]); setFtDesignFiles([]);
  }

  const fastTrackMutation = useMutation({
    mutationFn: async () => {
      if (!orgId || !profile) throw new Error('Not signed in — try again in a moment.');
      if (!ftForm.name.trim()) throw new Error('Shop name is required.');
      if (!ftForm.client_id) throw new Error('Pick a client first.');

      let latitude: number | null = null;
      let longitude: number | null = null;
      const addrQuery = buildAddressQuery(ftForm);
      if (addrQuery) {
        try {
          const result = await geocodeAddress(addrQuery);
          latitude = result.lat;
          longitude = result.lng;
        } catch {
          // Couldn't auto-locate — save without coordinates, same as the
          // normal Add Shop form; can be located later from Edit Shop.
        }
      }

      const { data: newShop, error: shopError } = await supabase.from('shops').insert({
        organization_id: orgId,
        name: ftForm.name.trim(), client_id: ftForm.client_id, project_id: ftForm.project_id || null,
        owner_name: ftForm.owner_name.trim(), contact_phone: ftForm.contact_phone.trim(),
        address: ftForm.address.trim(), city: ftForm.city.trim(), district: ftForm.district.trim(),
        zone_id: ftForm.zone_id || null, state: ftForm.state.trim(), latitude, longitude,
        purchase_order_id: ftForm.purchase_order_id || null,
        status: 'pending',
      }).select('id, name, status').single();
      if (shopError) throw new Error(`Could not create shop: ${shopError.message}`);

      await logAudit('shops', newShop.id, 'insert', null, null, null, `Created shop: ${newShop.name} (Already In Progress)`);

      try {
        await runBackfillPipeline({
          orgId, shopId: newShop.id, shopName: newShop.name, shopStatusBefore: newShop.status, actorId: profile.id,
          stage: ftStage, items: ftItems, surveyorId: ftSurveyorId, designerId: ftDesignerId,
          productionId: ftProductionId, installerId: ftInstallerId, note: ftNote,
          workTypes: ftWorkTypes || [], existingAssignments: [],
          surveyPhotos: ftSurveyPhotos, designFiles: ftDesignFiles,
        });
      } catch (err) {
        // The shop itself was created successfully even if the backfill
        // half fails partway (e.g. a bad item row) — say so clearly
        // rather than leaving the person thinking nothing happened, so
        // they know to go finish it from the shop's own Backfill panel
        // instead of re-submitting this form and creating a duplicate shop.
        throw new Error(`Shop "${newShop.name}" was created, but backfilling its data failed: ${(err as Error).message}. Open the shop and use its Backfill panel to finish.`);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['shops', orgId] });
      queryClient.invalidateQueries({ queryKey: ['shops-locations', orgId] });
      setFastTrackOpen(false);
      resetFastTrack();
    },
  });

  // ---- BULK BACKFILL — the multi-shop version, for shops that already
  // exist in the app (added earlier, or via a normal bulk shop upload)
  // but have no survey/design/production data yet. Every shop can be at
  // a different real stage with different boards, so this works off an
  // Excel round-trip (download → fill → upload) instead of one shared
  // form, then runs the exact same runBackfillPipeline used everywhere
  // else, once per shop. ----
  const [bbFile, setBbFile] = useState<File | null>(null);
  const [bbParseError, setBbParseError] = useState('');
  const [bbParsedShops, setBbParsedShops] = useState<BulkBackfillParsedShop[] | null>(null);
  const [bbResults, setBbResults] = useState<{ shopId: string; shopName: string; ok: boolean; message: string }[] | null>(null);

  const { data: eligibleShops } = useQuery({
    queryKey: ['shops-eligible-for-backfill', orgId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('shops')
        .select('id, name, contact_phone, city, status')
        .eq('organization_id', orgId)
        .not('status', 'in', `(${BACKFILL_INELIGIBLE_STATUSES.join(',')})`)
        .order('name')
        .limit(2000);
      if (error) throw new Error(`Could not load shops: ${error.message}`);
      return data as BulkBackfillShopRow[];
    },
    enabled: !!orgId && bulkBackfillOpen,
  });

  function resetBulkBackfill() {
    setBbFile(null); setBbParseError(''); setBbParsedShops(null); setBbResults(null);
  }

  function handleBulkBackfillFile(file: File) {
    setBbFile(file); setBbParseError(''); setBbParsedShops(null); setBbResults(null);
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const wb = XLSX.read(e.target?.result, { type: 'binary' });
        const parsed = parseBulkBackfillWorkbook(wb);
        if ('error' in parsed) { setBbParseError(parsed.error); return; }
        if (parsed.shops.length === 0) { setBbParseError('No shop rows found — did you fill in the downloaded template?'); return; }
        setBbParsedShops(parsed.shops);
      } catch (err) {
        setBbParseError(`Could not read this file: ${(err as Error).message}`);
      }
    };
    reader.onerror = () => setBbParseError('Could not read this file.');
    reader.readAsBinaryString(file);
  }

  function downloadBulkBackfillTemplateFile() {
    const people = ftPeople || [];
    downloadBulkBackfillTemplate({
      shops: eligibleShops || [],
      surveyors: people.filter((p) => p.role === 'surveyor').map((p) => p.full_name),
      designers: people.filter((p) => p.role === 'designer').map((p) => p.full_name),
      productionPeople: people.filter((p) => p.role === 'printing').map((p) => p.full_name),
      installers: people.filter((p) => p.role === 'installer').map((p) => p.full_name),
      clients: (clients || []).map((c) => c.name),
      purchaseOrders: (purchaseOrders || []).map((p) => ({ id: p.id, po_number: p.po_number, client_id: p.client_id })),
    });
  }

  const bulkBackfillMutation = useMutation({
    mutationFn: async () => {
      if (!orgId || !profile) throw new Error('Not signed in — try again in a moment.');
      const rows = bbParsedShops || [];
      if (rows.length === 0) throw new Error('No rows to process.');

      // Resolve each "existing shop" row to a real shop — by Shop ID
      // first, falling back to matching Shop Name if the ID cell was
      // left blank or edited by mistake (this is what used to silently
      // turn into "create a duplicate shop" instead).
      const resolvedExisting = new Map<string, BulkBackfillShopRow>(); // row key -> shop
      for (const s of rows) {
        if (s.isNew) continue;
        const byId = s.shopId ? (eligibleShops || []).find((sh) => sh.id === s.shopId) : undefined;
        const byName = !byId && s.shopName ? (eligibleShops || []).find((sh) => sh.name.toLowerCase() === s.shopName.toLowerCase()) : undefined;
        const match = byId || byName;
        if (match) resolvedExisting.set(s.key, match);
      }
      const existingShopIds = Array.from(resolvedExisting.values()).map((sh) => sh.id);

      const [{ data: existingAssignRows }, { data: existingSurveys }, { data: existingDesignTasks }, { data: existingProdOrders }] = existingShopIds.length > 0
        ? await Promise.all([
            supabase.from('shop_assignments').select('shop_id, role, status').in('shop_id', existingShopIds),
            supabase.from('surveys').select('shop_id').in('shop_id', existingShopIds),
            supabase.from('design_tasks').select('shop_id').in('shop_id', existingShopIds),
            supabase.from('production_orders').select('shop_id').in('shop_id', existingShopIds),
          ])
        : [{ data: [] }, { data: [] }, { data: [] }, { data: [] }] as any;
      const assignByShop = new Map<string, { role: string; status: string }[]>();
      for (const a of existingAssignRows || []) {
        const arr = assignByShop.get(a.shop_id) || [];
        arr.push(a);
        assignByShop.set(a.shop_id, arr);
      }
      const shopsWithRealData = new Set<string>([
        ...(existingSurveys || []).map((r: { shop_id: string }) => r.shop_id),
        ...(existingDesignTasks || []).map((r: { shop_id: string }) => r.shop_id),
        ...(existingProdOrders || []).map((r: { shop_id: string }) => r.shop_id),
      ]);

      const people = ftPeople || [];
      // '' = not specified (fine — pipeline falls back sensibly);
      // '__NOTFOUND__' = a name was typed but doesn't match anyone, which
      // should stop that shop rather than silently guess who was meant.
      const resolveId = (name: string, role: string): string => {
        if (!name) return '';
        const match = people.find((p) => p.role === role && p.full_name.toLowerCase() === name.toLowerCase());
        return match ? match.id : '__NOTFOUND__';
      };
      const resolvePo = (poNumber: string) => {
        if (!poNumber) return undefined;
        return (purchaseOrders || []).find((p) => p.po_number.toLowerCase() === poNumber.toLowerCase());
      };

      const results: { shopId: string; shopName: string; ok: boolean; message: string }[] = [];
      for (const s of rows) {
        const existingMeta = s.isNew ? null : resolvedExisting.get(s.key) || null;
        const displayName = s.shopName || existingMeta?.name || s.shopId || '(unnamed)';
        if (s.isNewAmbiguous) { results.push({ shopId: s.key, shopName: displayName, ok: false, message: 'Set "New Shop?" to Yes or No for this row — could not tell which it should be' }); continue; }
        if (!s.stage) { results.push({ shopId: s.key, shopName: displayName, ok: false, message: s.stageRaw ? `Stage "${s.stageRaw}" not recognized` : 'Stage left blank' }); continue; }
        if (s.items.length === 0) { results.push({ shopId: s.key, shopName: displayName, ok: false, message: 'No item rows with Width, Height and Qty filled in' }); continue; }
        if (!s.isNew && !existingMeta) { results.push({ shopId: s.key, shopName: displayName, ok: false, message: 'Shop not found in this org — check Shop ID / Shop Name, or it may already be past Production Done' }); continue; }
        if (s.isNew && !s.shopName) { results.push({ shopId: s.key, shopName: displayName, ok: false, message: 'New shop needs a Shop Name' }); continue; }
        if (!s.isNew && existingMeta && shopsWithRealData.has(existingMeta.id)) {
          results.push({ shopId: s.key, shopName: displayName, ok: false, message: 'This shop already has survey/design/production data in the app — backfilling it here would create duplicates. Use its own Backfill panel on Shop Detail instead if you\'re sure.' });
          continue;
        }

        try {
          const surveyorId = resolveId(s.surveyor, 'surveyor');
          if (surveyorId === '__NOTFOUND__') throw new Error(`Surveyor "${s.surveyor}" doesn't match any active surveyor`);
          const designerId = resolveId(s.designer, 'designer');
          if (designerId === '__NOTFOUND__') throw new Error(`Designer "${s.designer}" doesn't match any active designer`);
          const productionId = resolveId(s.production, 'printing');
          if (productionId === '__NOTFOUND__') throw new Error(`Production person "${s.production}" doesn't match any active production team member`);
          const installerId = resolveId(s.installer, 'installer');
          if (installerId === '__NOTFOUND__') throw new Error(`Installer "${s.installer}" doesn't match any active installer`);

          let targetShopId: string;
          let targetShopName: string;
          let targetShopStatus: string;
          let existingAssignments: { role: string; status: string }[];

          if (s.isNew) {
            // A Work Order, if given, is authoritative for which client
            // this shop belongs to — one less thing that has to match
            // by typed name. Client is only needed when no Work Order
            // is given at all.
            const po = resolvePo(s.workOrderNumber);
            if (s.workOrderNumber && !po) throw new Error(`Work Order "${s.workOrderNumber}" doesn't match any Work Order in this org`);
            const clientId = po ? po.client_id : (clients || []).find((c) => c.name.toLowerCase() === s.clientName.toLowerCase())?.id;
            if (!clientId) throw new Error(s.clientName ? `Client "${s.clientName}" doesn't match any client in this org` : 'New shop needs a Work Order or a Client');

            // Idempotent import: re-uploading the same workbook must update/use
            // the same logical shop, never create another shop for every board.
            // A shop is matched inside the same client + Work Order by normalized
            // name, with city/address as tie-breakers when present.
            const normalizedName = s.shopName.trim().toLowerCase().replace(/\s+/g, ' ');
            let existingQuery = supabase.from('shops')
              .select('id, name, status, purchase_order_id, city, address')
              .eq('organization_id', orgId)
              .eq('client_id', clientId);
            if (po?.id) existingQuery = existingQuery.eq('purchase_order_id', po.id);
            const { data: possibleExisting, error: existingLookupError } = await existingQuery;
            if (existingLookupError) throw new Error(`Could not check existing shops: ${existingLookupError.message}`);
            const existingNatural = (possibleExisting || []).find((sh) => {
              const sameName = (sh.name || '').trim().toLowerCase().replace(/\s+/g, ' ') === normalizedName;
              if (!sameName) return false;
              const sameCity = !s.city || !sh.city || sh.city.trim().toLowerCase() === s.city.trim().toLowerCase();
              const sameAddress = !s.address || !sh.address || sh.address.trim().toLowerCase() === s.address.trim().toLowerCase();
              return sameCity && sameAddress;
            });

            if (existingNatural) {
              targetShopId = existingNatural.id;
              targetShopName = existingNatural.name;
              targetShopStatus = existingNatural.status;
              const { data: a } = await supabase.from('shop_assignments').select('role, status').eq('shop_id', existingNatural.id);
              existingAssignments = a || [];
              // If the shop already has pipeline rows, don't duplicate the
              // workflow. The import remains safe to run repeatedly.
              const [{ count: surveyCount }, { count: itemCount }] = await Promise.all([
                supabase.from('surveys').select('id', { count: 'exact', head: true }).eq('shop_id', existingNatural.id),
                supabase.from('work_items').select('id', { count: 'exact', head: true }).eq('shop_id', existingNatural.id),
              ]);
              if ((surveyCount || 0) > 0 || (itemCount || 0) > 0) {
                results.push({ shopId: s.key, shopName: targetShopName, ok: true, message: 'Existing shop matched — skipped duplicate import' });
                continue;
              }
            } else {
            const { data: newShop, error: shopError } = await supabase.from('shops').insert({
              organization_id: orgId, name: s.shopName, client_id: clientId, purchase_order_id: po?.id || null,
              owner_name: s.ownerName, contact_phone: s.phone, address: s.address,
              city: s.city, district: s.district, state: s.state, status: 'pending',
            }).select('id, name, status').single();
            if (shopError) throw new Error(`Could not create shop: ${shopError.message}`);
            await logAudit('shops', newShop.id, 'insert', null, null, null, `Created shop: ${newShop.name} (Bulk Backfill)`);
            targetShopId = newShop.id; targetShopName = newShop.name; targetShopStatus = newShop.status;
            existingAssignments = [];
            }
          } else {
            targetShopId = existingMeta!.id; targetShopName = existingMeta!.name; targetShopStatus = existingMeta!.status;
            existingAssignments = assignByShop.get(existingMeta!.id) || [];
            // A Work Order given on an existing-shop row re-links it —
            // useful when the shop was added before its PO existed.
            const po = resolvePo(s.workOrderNumber);
            if (s.workOrderNumber && !po) throw new Error(`Work Order "${s.workOrderNumber}" doesn't match any Work Order in this org`);
            if (po) {
              const { error: poLinkError } = await supabase.from('shops').update({ purchase_order_id: po.id }).eq('id', targetShopId).select('id');
              if (poLinkError) throw new Error(`Could not link Work Order: ${poLinkError.message}`);
            }
          }

          await runBackfillPipeline({
            orgId, shopId: targetShopId, shopName: targetShopName, shopStatusBefore: targetShopStatus, actorId: profile.id,
            stage: s.stage, note: s.note,
            items: s.items.map((it) => ({ workTypeId: '', workTypeName: it.workType, material: it.material, width: it.width, height: it.height, unit: it.unit, quantity: it.quantity })),
            surveyorId, designerId, productionId, installerId,
            workTypes: [], existingAssignments,
          });
          results.push({ shopId: s.key, shopName: targetShopName, ok: true, message: s.isNew ? 'Shop created + backfilled' : 'Backfilled' });
        } catch (err) {
          results.push({ shopId: s.key, shopName: displayName, ok: false, message: (err as Error).message });
        }
      }
      return results;
    },
    onSuccess: (results) => {
      setBbResults(results);
      queryClient.invalidateQueries({ queryKey: ['shops', orgId] });
      queryClient.invalidateQueries({ queryKey: ['shops-locations', orgId] });
      queryClient.invalidateQueries({ queryKey: ['shops-eligible-for-backfill', orgId] });
      queryClient.invalidateQueries({ queryKey: ['installer-assignments'] });
      queryClient.invalidateQueries({ queryKey: ['installer-work'] });
    },
  });

  // Campaigns — client-owned, but any campaign with at least one Work
  // Order assigned to this agency is visible here (RLS already scopes
  // this the same way the Campaigns/Projects page's client-campaigns
  // query does) so shops can be filtered by which campaign their Work
  // Order belongs to.
  const { data: campaignsForFilter } = useQuery({
    queryKey: ['campaigns-for-shops-filter', orgId],
    queryFn: async () => {
      const { data, error } = await supabase.from('campaigns').select('id, name').order('name');
      if (error) throw error;
      return data as { id: string; name: string }[];
    },
    enabled: !!orgId,
  });

  // The Work Order this list is filtered to may be cancelled (so it
  // won't be in the "active" purchaseOrders list above) — fetched
  // separately, by id, just to label the filter banner correctly.
  const { data: poFilterInfo } = useQuery({
    queryKey: ['purchase_order_by_id', poFilter],
    queryFn: async () => {
      const { data, error } = await supabase.from('purchase_orders').select('id, po_number, status').eq('id', poFilter).maybeSingle();
      if (error) throw error;
      return data as Pick<PurchaseOrder, 'id' | 'po_number' | 'status'> | null;
    },
    enabled: !!poFilter,
  });

  // City/District/State — a narrow single-column-ish projection (not the
  // full shop row), so it stays cheap even once the shops table itself is
  // 10,000+ rows. Used to populate the location filter dropdowns with
  // real, in-use values (not the full India master list — filtering to a
  // state/city that has zero shops in it isn't useful).
  const { data: locationRows } = useQuery({
    queryKey: ['shops-locations', orgId],
    queryFn: async () => {
      const { data, error } = await supabase.from('shops').select('city, district, state').eq('organization_id', orgId);
      if (error) throw error;
      return data as { city: string | null; district: string | null; state: string | null }[];
    },
    enabled: !!orgId,
    staleTime: 5 * 60 * 1000,
  });

  // ---- SHOPS — server-side filtered, sorted, and paginated ----
  // This is the list that has to work at 10,000+ rows, so nothing here
  // ever fetches the whole table: every filter (search, status, city,
  // zone, campaign, Work Order) is applied in the query itself, and only
  // one page (pageSize rows) comes back, alongside an exact total count
  // from Postgres for the "X–Y of Z" indicator and page controls below.
  const shopsQueryKey = ['shops', orgId, { poFilter, statusFilter, zoneFilter, campaignFilter, city: debouncedCityFilter, district: debouncedDistrictFilter, state: debouncedStateFilter, q: debouncedSearch, sortBy, page, pageSize }];
  const { data: shopsPage, isFetching: shopsLoading } = useQuery({
    queryKey: shopsQueryKey,
    queryFn: async () => {
      // Campaign lives on purchase_orders, not shops directly, so filtering
      // by it needs an INNER join hint (!inner) on purchase_orders — a
      // plain embedded select only shapes the joined object, it doesn't
      // restrict which top-level shop rows come back.
      const poEmbed = campaignFilter ? 'purchase_orders!inner(po_number, campaign_id)' : 'purchase_orders(po_number)';
      let query = supabase
        .from('shops')
        .select(`*, clients(name), projects(name), zones(name), ${poEmbed}`, { count: 'exact' })
        .eq('organization_id', orgId);

      if (poFilter) query = query.eq('purchase_order_id', poFilter);
      if (statusFilter) query = query.eq('status', statusFilter);
      if (zoneFilter) query = query.eq('zone_id', zoneFilter);
      if (campaignFilter) query = query.eq('purchase_orders.campaign_id', campaignFilter);
      if (debouncedCityFilter) query = query.ilike('city', `%${debouncedCityFilter}%`);
      if (debouncedDistrictFilter) query = query.ilike('district', `%${debouncedDistrictFilter}%`);
      if (debouncedStateFilter) query = query.ilike('state', `%${debouncedStateFilter}%`);
      if (debouncedSearch) {
        const term = debouncedSearch.replace(/[%,]/g, '');
        query = query.or(`name.ilike.%${term}%,city.ilike.%${term}%,address.ilike.%${term}%,owner_name.ilike.%${term}%`);
      }

      const [sortColumn, sortDir] = (
        {
          created_desc: ['created_at', false],
          created_asc: ['created_at', true],
          name_asc: ['name', true],
          city_asc: ['city', true],
          status_asc: ['status', true],
        }[sortBy] || ['created_at', false]
      ) as [string, boolean];

      const from = page * pageSize;
      const to = from + pageSize - 1;
      const { data, error, count } = await query.order(sortColumn, { ascending: sortDir }).range(from, to);
      if (error) throw error;
      return { rows: data || [], total: count || 0 };
    },
    enabled: !!orgId,
    placeholderData: (prev) => prev,
  });

  const shops = shopsPage?.rows;
  const totalShops = shopsPage?.total || 0;
  const totalPages = Math.max(1, Math.ceil(totalShops / pageSize));
  const rangeStart = totalShops === 0 ? 0 : page * pageSize + 1;
  const rangeEnd = Math.min(totalShops, page * pageSize + pageSize);

  // Per-shop "who's on it right now" — surveyor/installer come from
  // shop_assignments, designer comes from design_tasks (it only exists
  // once a shop's survey is approved). Scoped to just the shop ids on
  // the CURRENT PAGE (not the whole org) — with a 10,000+ shop table an
  // org-wide fetch here would be just as unbounded as fetching every
  // shop row, so it's kept to exactly what's rendered.
  const pageShopIds = useMemo(() => (shops || []).map((s) => s.id), [shops]);

  const { data: assignmentRows } = useQuery({
    queryKey: ['shops-assignments-summary', orgId, pageShopIds],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('shop_assignments')
        .select('shop_id, role, status, profiles(full_name)')
        .in('shop_id', pageShopIds)
        .neq('status', 'declined');
      if (error) throw error;
      return data as unknown as { shop_id: string; role: string; status: string; profiles: { full_name: string } | null }[];
    },
    enabled: !!orgId && pageShopIds.length > 0,
  });

  const { data: designTaskRows } = useQuery({
    queryKey: ['shops-design-tasks-summary', orgId, pageShopIds],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('design_tasks')
        .select('shop_id, status, profiles:designer_id(full_name)')
        .in('shop_id', pageShopIds);
      if (error) throw error;
      return data as unknown as { shop_id: string; status: string; profiles: { full_name: string } | null }[];
    },
    enabled: !!orgId && pageShopIds.length > 0,
  });

  type AssignmentSummary = { role: string; name: string; status: string };
  const assignmentsByShop = useMemo(() => {
    const map = new Map<string, AssignmentSummary[]>();
    for (const a of assignmentRows || []) {
      const list = map.get(a.shop_id) || [];
      list.push({ role: a.role, name: a.profiles?.full_name || 'Unknown', status: a.status });
      map.set(a.shop_id, list);
    }
    for (const d of designTaskRows || []) {
      if (!d.profiles) continue;
      const list = map.get(d.shop_id) || [];
      list.push({ role: 'designer', name: d.profiles.full_name, status: d.status });
      map.set(d.shop_id, list);
    }
    return map;
  }, [assignmentRows, designTaskRows]);

  useRealtimeInvalidate(['zones'], orgId, [['zones', orgId]]);

  // So a shop's status badge/filter updates live as it moves through the
  // pipeline (surveyed -> approved -> design_approved -> ...), not just
  // whatever it was when this list first loaded. Also keeps the City/
  // District/State filter dropdowns (`shops-locations`) live for shops
  // created from ANYWHERE else — another admin's session, a surveyor's
  // "Add Shop on the spot", or the installer's Direct Install flow — not
  // just the two create paths on this page itself.
  useRealtimeInvalidate(['shops'], orgId, [['shops', orgId], ['shops-locations', orgId]]);
  useRealtimeInvalidate(
    ['shop_assignments', 'design_tasks'],
    orgId,
    [['shops-assignments-summary', orgId], ['shops-design-tasks-summary', orgId]]
  );

  const saveMutation = useMutation({
    mutationFn: async () => {
      // Nobody hand-types lat/long in practice — if it wasn't filled in
      // (or found via the "Locate on Map" button), geocode the address
      // right before saving so every shop still ends up with an accurate
      // map position for navigation/routing, without blocking on it.
      let latitude = form.latitude ? parseFloat(form.latitude) : null;
      let longitude = form.longitude ? parseFloat(form.longitude) : null;
      if ((latitude === null || longitude === null) && buildAddressQuery(form)) {
        try {
          const result = await geocodeAddress(buildAddressQuery(form));
          latitude = result.lat;
          longitude = result.lng;
        } catch {
          // Address couldn't be located automatically — save without
          // coordinates rather than blocking the shop from being added;
          // it can be located later from the shop's edit screen.
        }
      }

      const payload = {
        name: form.name, client_id: form.client_id,
        project_id: form.project_id || null,
        owner_name: form.owner_name, contact_phone: form.contact_phone,
        address: form.address, city: form.city, district: form.district,
        zone_id: form.zone_id || null, state: form.state,
        latitude, longitude, purchase_order_id: form.purchase_order_id || null,
        signage_language: form.signage_language || null,
      };
      if (editShop) {
        const { error } = await supabase.from('shops').update(payload).eq('id', editShop.id);
        if (error) throw error;
        await logAudit('shops', editShop.id, 'update', null, null, null, `Updated shop: ${form.name}`);
      } else {
        const { data, error } = await supabase.from('shops').insert({
          organization_id: orgId, ...payload, status: 'pending',
        }).select().single();
        if (error) throw error;
        await logAudit('shops', data.id, 'insert', null, null, null, `Created shop: ${form.name}`);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['shops', orgId] });
      // Zone already refreshes its filter dropdown immediately because
      // addZoneMutation invalidates ['zones', orgId] the moment a new one
      // is created — but City/District/State are plain free-text columns
      // on `shops` itself (no master table), and their filter dropdowns
      // (`shop-city-options`/`shop-district-options`/`shop-state-options`
      // datalists) are populated from a separate `shops-locations` query.
      // Without this, a brand-new city/district/state typed here wouldn't
      // show up in those dropdowns until that query's 5-minute staleTime
      // happened to lapse.
      queryClient.invalidateQueries({ queryKey: ['shops-locations', orgId] });
      setModalOpen(false);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (shop: Shop) => {
      if (profile?.role === 'agency_owner' || profile?.role === 'admin') {
        await supabase.from('shops').delete().eq('id', shop.id);
      } else {
        await supabase.from('shops').update({ status: 'cancelled' }).eq('id', shop.id);
      }
      await logAudit('shops', shop.id, 'delete', null, null, null, `Deleted/cancelled shop: ${shop.name}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['shops', orgId] });
    },
  });

  // Candidates for the currently-picked bulk role. Fetched lazily, same
  // pattern as ShopDetailPage's fieldWorkers/designers queries.
  const { data: bulkPeople } = useQuery({
    queryKey: ['org-people-by-role', orgId, bulkRole],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, full_name')
        .eq('organization_id', orgId)
        .eq('role', bulkRole)
        .eq('is_active', true)
        .order('full_name');
      if (error) throw new Error(`Could not load ${bulkRole}s: ${error.message}`);
      return data as { id: string; full_name: string }[];
    },
    enabled: !!orgId && bulkAssignOpen,
  });

  const bulkAssignMutation = useMutation({
    mutationFn: async () => {
      if (!bulkUserId || selectedShopIds.size === 0) throw new Error('Pick a person and at least one shop first.');
      const targetShops = (shops || []).filter((s) => selectedShopIds.has(s.id));
      const person = (bulkPeople || []).find((p) => p.id === bulkUserId);
      let assigned = 0, skipped = 0, failed = 0;

      if (bulkRole === 'designer') {
        // Designer lives on design_tasks.designer_id, which only exists
        // once a shop's survey has been approved — so a shop with no
        // design_tasks row yet is skipped rather than erroring the whole
        // batch out.
        const { data: existingTasks, error: tasksError } = await supabase
          .from('design_tasks')
          .select('id, shop_id')
          .in('shop_id', targetShops.map((s) => s.id));
        if (tasksError) throw new Error(`Could not check existing design tasks: ${tasksError.message}`);
        for (const shop of targetShops) {
          const task = (existingTasks || []).find((t) => t.shop_id === shop.id);
          if (!task) { skipped++; continue; }
          const { error } = await supabase.from('design_tasks').update({ designer_id: bulkUserId }).eq('id', task.id).select('id');
          if (error) { failed++; continue; }
          assigned++;
          await createNotification(bulkUserId, 'New Design Task', `You've been assigned to design ${shop.name}`, 'info', '/design');
        }
      } else {
        // Surveyor/installer live on shop_assignments — dedupe against
        // whatever's already assigned, same rule as ShopDetailPage's
        // single-shop assign flow (avoids the duplicate-row bug that flow
        // was built to fix, just across many shops at once).
        const { data: existing, error: existingError } = await supabase
          .from('shop_assignments')
          .select('id, shop_id, user_id, role, status')
          .in('shop_id', targetShops.map((s) => s.id))
          .eq('role', bulkRole);
        if (existingError) throw new Error(`Could not check existing assignments: ${existingError.message}`);
        for (const shop of targetShops) {
          const dup = (existing || []).find((a) => a.shop_id === shop.id && a.user_id === bulkUserId && a.status !== 'declined');
          if (dup) { skipped++; continue; }

          // Reassigning this shop's role to a NEW person — whoever was
          // actively holding it before (status 'assigned', i.e. not yet
          // completed) must be taken off it here, or they keep seeing the
          // shop in their own queue/workload forever even though someone
          // else now owns it. This is what made a reassign look like it
          // "didn't reflect" for the new person: the old assignee's copy
          // never went away, and dashboards summing open assignments kept
          // counting both.
          const previousHolders = (existing || []).filter(
            (a) => a.shop_id === shop.id && a.user_id !== bulkUserId && a.status === 'assigned'
          );
          for (const prev of previousHolders) {
            const { error: supersedeError } = await supabase
              .from('shop_assignments')
              .update({ status: 'declined' })
              .eq('id', prev.id);
            if (supersedeError) { failed++; continue; }
            await createNotification(
              prev.user_id,
              'Reassigned',
              `You've been reassigned off ${shop.name} — it now belongs to someone else.`,
              'info'
            );
          }

          const { error } = await supabase.from('shop_assignments').insert({
            organization_id: orgId,
            shop_id: shop.id,
            user_id: bulkUserId,
            role: bulkRole,
            status: 'assigned',
          });
          if (error) { failed++; continue; }
          assigned++;
          if (bulkRole === 'surveyor' && shop.status === 'pending') {
            await supabase.from('shops').update({ status: 'assigned' }).eq('id', shop.id);
          }
          await createNotification(bulkUserId, 'New Assignment', `You've been assigned as ${bulkRole} for ${shop.name}`, 'info', bulkRole === 'surveyor' ? '/survey' : undefined);
        }
      }

      await logAudit('shops', null, 'bulk_assign', 'role', null, bulkRole, `Bulk-assigned ${person?.full_name || 'user'} as ${bulkRole} to ${assigned} shop(s)`);
      setBulkResult(`Assigned to ${assigned} shop(s).${skipped ? ` Skipped ${skipped} (already assigned${bulkRole === 'designer' ? ' or no design task yet' : ''}).` : ''}${failed ? ` Failed for ${failed}.` : ''}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['shops', orgId] });
      queryClient.invalidateQueries({ queryKey: ['nav-pending-counts', orgId] });
    },
  });

  const addZoneMutation = useMutation({
    mutationFn: async () => {
      if (!newZoneName.trim()) throw new Error('Enter a zone name.');
      const { data, error } = await supabase.from('zones').insert({
        organization_id: orgId, project_id: form.project_id || null, name: newZoneName.trim(),
      }).select().single();
      if (error) throw error;
      return data as Zone;
    },
    onSuccess: (zone) => {
      queryClient.invalidateQueries({ queryKey: ['zones', orgId] });
      setForm((f) => ({ ...f, zone_id: zone.id }));
      setNewZoneName('');
      setZoneModalOpen(false);
    },
  });

  // ---- BULK UPLOAD (Excel/CSV) ----
  const bulkIncludedExtraKeys = useMemo(
    () => new Set(bulkExtraHeaders.filter((h) => bulkIncludedExtra[h])),
    [bulkExtraHeaders, bulkIncludedExtra]
  );
  const bulkParsedRows: ParsedShopRow[] = useMemo(
    () => (bulkAoa ? buildShopRows(bulkAoa, bulkHeaderRowIndex, bulkHeaders, bulkIncludedExtraKeys) : []),
    [bulkAoa, bulkHeaderRowIndex, bulkHeaders, bulkIncludedExtraKeys]
  );

  const bulkUploadMutation = useMutation({
    mutationFn: async () => {
      if (!bulkClientId) throw new Error('Pick a client first.');
      if (bulkParsedRows.length === 0) throw new Error('No valid rows found — every row needs at least a Name.');
      // Resolve every distinct "Zone" text in the sheet to a real zone_id
      // (reusing an existing zone or creating one) so these shops are
      // actually zone-filterable, not just zone-labeled.
      const zoneIds = await resolveZoneIds(orgId!, bulkProjectId || null, bulkParsedRows.map((r) => r.known.zone));
      const rows = bulkParsedRows.map(({ known, extra }) => ({
        organization_id: orgId,
        client_id: bulkClientId,
        project_id: bulkProjectId || null,
        purchase_order_id: bulkPurchaseOrderId || null,
        name: known.name,
        owner_name: known.owner_name || null,
        contact_phone: known.contact_phone || null,
        address: known.address || null,
        village: known.village || null,
        city: known.city || null,
        district: known.district || null,
        zone: known.zone || null,
        zone_id: known.zone ? zoneIds.get(known.zone.trim().toLowerCase()) || null : null,
        state: known.state || null,
        status: 'pending',
        extra_details: extra,
      }));
      const { error } = await supabase.from('shops').insert(rows);
      if (error) throw error;
      await logAudit('shops', null, 'insert', null, null, null, `Bulk-uploaded ${rows.length} shop(s) from Excel/CSV`);
      return rows.length;
    },
    onSuccess: (count) => {
      queryClient.invalidateQueries({ queryKey: ['shops', orgId] });
      queryClient.invalidateQueries({ queryKey: ['zones', orgId] });
      // Same reasoning as the single-shop save above — a bulk upload is
      // exactly where a brand-new city/district/state is most likely to
      // show up for the first time (a fresh area added to a campaign),
      // so this needs to refresh immediately, not on a 5-minute delay.
      queryClient.invalidateQueries({ queryKey: ['shops-locations', orgId] });
      setBulkUploadResult(`${count} shop${count === 1 ? '' : 's'} added successfully.`);
      resetBulkState(false);
    },
  });

  function resetBulkState(closeModal = true) {
    setBulkAoa(null);
    setBulkHeaders([]);
    setBulkHeaderRowIndex(0);
    setBulkExtraHeaders([]);
    setBulkIncludedExtra({});
    setBulkFileName('');
    setBulkError('');
    if (closeModal) {
      setBulkOpen(false);
      setBulkClientId('');
      setBulkProjectId('');
      setBulkPurchaseOrderId('');
      setBulkUploadResult(null);
    }
  }

  function handleBulkFile(file: File) {
    setBulkError('');
    setBulkUploadResult(null);
    setBulkFileName(file.name);
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const wb = XLSX.read(e.target?.result, { type: 'binary' });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1 });
        const found = findShopHeaderRow(aoa);
        if (!found) {
          setBulkError('Could not find a "Name" column in this file — check that it has a header row with at least a Name/Shop Name column.');
          setBulkAoa(null);
          return;
        }
        const extras = findExtraHeaders(found.headers);
        setBulkAoa(aoa);
        setBulkHeaders(found.headers);
        setBulkHeaderRowIndex(found.headerRowIndex);
        setBulkExtraHeaders(extras);
        setBulkIncludedExtra(Object.fromEntries(extras.map((h) => [h, true])));
      } catch {
        setBulkError("Could not read this file. Make sure it's a valid .xlsx, .xls, or .csv file.");
        setBulkAoa(null);
      }
    };
    reader.readAsBinaryString(file);
  }

  // ---- BULK REMOVE / CANCEL (select mode) ----
  // Clients frequently ask, after a job's underway, to drop a handful of
  // shops from the list or mark them cancelled. Same rule as the
  // single-shop delete: Owner/Admin hard-deletes untouched shops,
  // everyone else (and any shop already in progress) gets soft-cancelled
  // instead, just done across the whole selection in one go.
  const bulkRemoveMutation = useMutation({
    mutationFn: async () => {
      const targetShops = (shops || []).filter((s) => selectedShopIds.has(s.id));
      const canHardDelete = profile?.role === 'agency_owner' || profile?.role === 'admin';
      let removed = 0, cancelled = 0;
      for (const shop of targetShops) {
        if (canHardDelete) {
          await supabase.from('shops').delete().eq('id', shop.id);
          removed++;
        } else {
          await supabase.from('shops').update({ status: 'cancelled' }).eq('id', shop.id);
          cancelled++;
        }
      }
      await logAudit('shops', null, 'delete', null, null, null, `Bulk ${canHardDelete ? 'deleted' : 'cancelled'} ${targetShops.length} shop(s)`);
      return { removed, cancelled };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['shops', orgId] });
      // If the removed shop(s) were the only ones using a given city/
      // district/state, that value should stop showing up as a filter
      // option too — same reasoning as the two invalidations above.
      queryClient.invalidateQueries({ queryKey: ['shops-locations', orgId] });
      setSelectedShopIds(new Set());
      setBulkRemoveConfirmOpen(false);
    },
  });

  function openAdd() {
    setEditShop(null);
    setForm({ name: '', client_id: '', project_id: '', owner_name: '', contact_phone: '', address: '', city: '', district: '', zone_id: '', state: '', latitude: '', longitude: '', purchase_order_id: '', signage_language: '' });
    setGeocodeStatus(null);
    setModalOpen(true);
  }

  function openEdit(shop: Shop) {
    setEditShop(shop);
    setForm({
      name: shop.name, client_id: shop.client_id, project_id: shop.project_id || '',
      owner_name: shop.owner_name || '', contact_phone: shop.contact_phone || '',
      address: shop.address || '', city: shop.city || '', district: shop.district || '',
      zone_id: shop.zone_id || '', state: shop.state || '',
      latitude: shop.latitude?.toString() || '', longitude: shop.longitude?.toString() || '',
      purchase_order_id: shop.purchase_order_id || '',
      signage_language: shop.signage_language || '',
    });
    setGeocodeStatus(null);
    setModalOpen(true);
  }

  function toggleShopSelected(id: string) {
    setSelectedShopIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  const shopStageMutation = useMutation({
    mutationFn: async ({ targets, status }: { targets: Shop[]; status: string }) => {
      if (!targets.length || !status) throw new Error('Select shop(s) and a stage.');
      const ids = targets.map((s) => s.id);
      const { error } = await supabase.from('shops').update({ status }).in('id', ids).select('id');
      if (error) throw new Error(error.message);
      for (const shop of targets) {
        await logAudit('shops', shop.id, 'update', 'status', shop.status, status, `Shop stage manually changed from ${shop.status} to ${status}`);
      }
      return ids.length;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['shops'] });
      queryClient.invalidateQueries({ queryKey: ['shop'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard-stats', orgId] });
      queryClient.invalidateQueries({ queryKey: ['nav-pending-counts', orgId] });
      // Stage is authoritative across the whole app. 0086 reconciles stale
      // child/redo state in DB; invalidate every role queue immediately so the
      // same change is visible without logout, tab switching or hard refresh.
      queryClient.invalidateQueries({ queryKey: ['installation-review'] });
      queryClient.invalidateQueries({ queryKey: ['installer-assignments'] });
      queryClient.invalidateQueries({ queryKey: ['installer-work'] });
      queryClient.invalidateQueries({ queryKey: ['installer-open-corrections'] });
      queryClient.invalidateQueries({ queryKey: ['surveyor-assignments'] });
      queryClient.invalidateQueries({ queryKey: ['surveyor-work'] });
      queryClient.invalidateQueries({ queryKey: ['surveyor-open-corrections'] });
      queryClient.invalidateQueries({ queryKey: ['designer'] });
      queryClient.invalidateQueries({ queryKey: ['production'] });
      queryClient.invalidateQueries({ queryKey: ['design'] });
      queryClient.invalidateQueries({ queryKey: ['reports'] });
      setStatusChangeShops(null);
      setNextShopStatus('');
      setSelectedShopIds(new Set());
      setSelectMode(false);
    },
  });

  function openStatusChange(targets: Shop[]) {
    if (!targets.length) return;
    setStatusChangeShops(targets);
    setNextShopStatus(targets.length === 1 ? targets[0].status : '');
  }

  function openBulkAssign() {
    setBulkRole('surveyor');
    setBulkUserId('');
    setBulkResult(null);
    setBulkAssignOpen(true);
  }

  // Filtering (search/status/city/zone/Work Order) all happens server-side
  // in the shopsPage query above, so the page's rows are already the
  // filtered set — no client-side re-filtering of a full list here.
  const filteredShops = shops || [];

  const cities = useMemo(() => [...new Set((locationRows || []).map((r) => r.city).filter(Boolean))].sort() as string[], [locationRows]);
  const districts = useMemo(() => [...new Set((locationRows || []).map((r) => r.district).filter(Boolean))].sort() as string[], [locationRows]);
  const states = useMemo(() => [...new Set((locationRows || []).map((r) => r.state).filter(Boolean))].sort() as string[], [locationRows]);
  const hasActiveFilters = !!(search || statusFilter || cityFilter || districtFilter || stateFilter || zoneFilter || campaignFilter || poFilter);
  const activeFilterCount = [statusFilter, cityFilter, districtFilter, stateFilter, zoneFilter, campaignFilter, poFilter].filter(Boolean).length;
  const SORT_OPTIONS = [
    { value: 'created_desc', label: 'Newest first' },
    { value: 'created_asc', label: 'Oldest first' },
    { value: 'name_asc', label: 'Name (A–Z)' },
    { value: 'city_asc', label: 'City (A–Z)' },
    { value: 'status_asc', label: 'Status' },
  ];
  const SHOP_STATUS_OPTIONS: Record<string, string> = { pending:'Pending', assigned:'Assigned', survey_started:'Survey Started', surveyed:'Surveyed', approval_pending:'Survey Approval Pending', approved:'Survey Approved', design_pending:'Design Pending', designing:'Designing', design_ready:'Design Ready', in_review:'Design Review', design_approved:'Design Approved', production_pending:'Production Pending', in_production:'In Production', production_ready:'Production Ready', production_hold:'Production Hold', production_done:'Production Done', dispatched:'Dispatched', installation_pending:'Installation Pending', installing:'Installing', installation_review:'Installation Review', installed:'Installed', billed:'Billed', cancelled:'Cancelled' };

  return (
    <div>
      <PageHeader
        title="Shops"
        subtitle="Manage all shop locations"
        action={
          <div className="flex items-center gap-2">
            {canBulkAssign && (
              <button
                onClick={() => { setSelectMode((v) => !v); setSelectedShopIds(new Set()); }}
                className={`flex items-center gap-2 px-3.5 py-2 rounded-lg font-medium text-sm transition border ${
                  selectMode ? 'bg-blue-50 text-blue-700 border-blue-200' : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'
                }`}
              >
                {selectMode ? <CheckSquare className="w-4 h-4" /> : <Square className="w-4 h-4" />} Select
              </button>
            )}
            <button
              onClick={() => { setBulkOpen(true); setBulkUploadResult(null); }}
              className="flex items-center gap-2 bg-white text-slate-600 border border-slate-300 hover:bg-slate-50 px-3.5 py-2 rounded-lg font-medium text-sm transition"
            >
              <UploadCloud className="w-4 h-4" /> Bulk Upload
            </button>
            {canBulkAssign && (
              <button
                onClick={() => { resetFastTrack(); setFastTrackOpen(true); }}
                className="flex items-center gap-2 bg-white text-amber-700 border border-amber-300 hover:bg-amber-50 px-3.5 py-2 rounded-lg font-medium text-sm transition"
                title="For shops already surveyed/designed/produced outside the app"
              >
                <FastForward className="w-4 h-4" /> Add Shop (In Progress)
              </button>
            )}
            {canBulkAssign && (
              <button
                onClick={() => { resetBulkBackfill(); setBulkBackfillOpen(true); }}
                className="flex items-center gap-2 bg-white text-amber-700 border border-amber-300 hover:bg-amber-50 px-3.5 py-2 rounded-lg font-medium text-sm transition"
                title="Backfill many already-added shops at once via Excel"
              >
                <ListOrdered className="w-4 h-4" /> Bulk Backfill
              </button>
            )}
            <button onClick={openAdd} className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg font-medium text-sm transition">
              <Plus className="w-4 h-4" /> Add Shop
            </button>
          </div>
        }
      />

      {/* Landed here from a Work Order's "View Shops" link — scoped to
          just that Work Order's shops so they never mix with the rest of
          the (potentially thousands of rows) shop list. */}
      {poFilter && (
        <div className="mb-4 flex items-center gap-2 text-sm text-blue-700 bg-blue-50 border border-blue-200 rounded-lg px-3 py-2">
          <FileText className="w-4 h-4 shrink-0" />
          Showing shops for Work Order <span className="font-semibold">{poFilterInfo?.po_number || '…'}</span> only.
          <button onClick={() => setPoFilter('')} className="ml-1 underline hover:no-underline">Clear filter</button>
        </div>
      )}

      {selectMode && (
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4 bg-blue-50 border border-blue-200 rounded-lg px-4 py-2.5">
          <p className="text-sm text-blue-800 font-medium">
            {selectedShopIds.size} shop{selectedShopIds.size === 1 ? '' : 's'} selected
            {totalShops > pageSize && <span className="font-normal text-blue-600"> (this page only)</span>}
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setSelectedShopIds(new Set(filteredShops.map((s) => s.id)))}
              className="text-xs font-medium text-blue-700 hover:underline"
            >
              Select all on this page
            </button>
            <button
              onClick={() => openStatusChange(filteredShops.filter((s) => selectedShopIds.has(s.id)))}
              disabled={selectedShopIds.size === 0}
              className="flex items-center gap-1.5 bg-white text-violet-700 border border-violet-200 hover:bg-violet-50 px-3 py-1.5 rounded-lg text-xs font-medium disabled:opacity-50"
            >
              <Layers className="w-3.5 h-3.5" /> Change Stage
            </button>
            <button
              onClick={openBulkAssign}
              disabled={selectedShopIds.size === 0}
              className="flex items-center gap-1.5 bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded-lg text-xs font-medium disabled:opacity-50"
            >
              <UserPlus className="w-3.5 h-3.5" /> Bulk Assign
            </button>
            {canBulkRemove && (
              <button
                onClick={() => setBulkRemoveConfirmOpen(true)}
                disabled={selectedShopIds.size === 0}
                className="flex items-center gap-1.5 bg-white text-red-600 border border-red-200 hover:bg-red-50 px-3 py-1.5 rounded-lg text-xs font-medium disabled:opacity-50"
              >
                <Ban className="w-3.5 h-3.5" /> Cancel / Remove
              </button>
            )}
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 mb-3">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            placeholder="Name, city, address, owner..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-9 pr-3 py-2 border border-slate-300 rounded-lg text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <select value={sortBy} onChange={(e) => setSortBy(e.target.value)} className="px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500">
          {SORT_OPTIONS.map((o) => <option key={o.value} value={o.value}>Sort: {o.label}</option>)}
        </select>
        <FilterButton activeCount={activeFilterCount} onClick={() => setFilterDrawerOpen(true)} />
        <p className="text-xs text-slate-400 shrink-0">
          {totalShops === 0 ? '0 shops' : `${rangeStart}–${rangeEnd} of ${totalShops.toLocaleString('en-IN')}`}
          {shopsLoading && <Loader2 className="inline w-3 h-3 ml-1.5 animate-spin align-[-1px]" />}
        </p>
      </div>

      <FilterDrawer
        open={filterDrawerOpen}
        onClose={() => setFilterDrawerOpen(false)}
        onClear={() => { setStatusFilter(''); setCityFilter(''); setDistrictFilter(''); setStateFilter(''); setZoneFilter(''); setCampaignFilter(''); setPoFilter(''); }}
        activeCount={activeFilterCount}
        resultCount={totalShops}
        resultLabel="shops"
      >
        <FilterSection label="Work Order">
          <select
            value={poFilter}
            onChange={(e) => setPoFilter(e.target.value)}
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">All Work Orders</option>
            {poFilter && poFilterInfo && !(purchaseOrders || []).some((po) => po.id === poFilter) && (
              <option value={poFilterInfo.id}>{poFilterInfo.po_number} (cancelled)</option>
            )}
            {(purchaseOrders || []).map((po) => <option key={po.id} value={po.id}>{po.po_number}</option>)}
          </select>
        </FilterSection>
        {(campaignsForFilter || []).length > 0 && (
          <FilterSection label="Campaign">
            <select value={campaignFilter} onChange={(e) => setCampaignFilter(e.target.value)} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500">
              <option value="">All Campaigns</option>
              {(campaignsForFilter || []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </FilterSection>
        )}
        <FilterSection label="Zone">
          <select value={zoneFilter} onChange={(e) => setZoneFilter(e.target.value)} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500">
            <option value="">All Zones</option>
            {(zones || []).map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
          </select>
        </FilterSection>
        <FilterSection label="Status">
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500">
            <option value="">All Statuses</option>
            {Object.entries(SHOP_STATUS_OPTIONS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </FilterSection>
        <FilterSection label="City">
          <input
            list="shop-city-options"
            placeholder="Any city"
            value={cityFilter}
            onChange={(e) => setCityFilter(e.target.value)}
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500"
          />
          <datalist id="shop-city-options">
            {cities.map((c) => <option key={c} value={c} />)}
          </datalist>
        </FilterSection>
        <FilterSection label="District">
          <input
            list="shop-district-options"
            placeholder="Any district"
            value={districtFilter}
            onChange={(e) => setDistrictFilter(e.target.value)}
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500"
          />
          <datalist id="shop-district-options">
            {districts.map((d) => <option key={d} value={d} />)}
          </datalist>
        </FilterSection>
        <FilterSection label="State">
          <input
            list="shop-state-options"
            placeholder="Any state"
            value={stateFilter}
            onChange={(e) => setStateFilter(e.target.value)}
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500"
          />
          <datalist id="shop-state-options">
            {states.map((s) => <option key={s} value={s} />)}
          </datalist>
        </FilterSection>
      </FilterDrawer>

      {/* LISTING — a proper table, not cards: every shop's location, contact,
          who's currently working it (and their status), and pipeline status
          all readable at a glance without opening each one. */}
      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-500 text-xs uppercase tracking-wide border-b border-slate-200">
              <tr>
                {selectMode && <th className="w-10 px-3 py-2.5"></th>}
                <th className="text-left px-3 py-2.5 font-medium">Shop</th>
                <th className="text-left px-3 py-2.5 font-medium">Location</th>
                <th className="text-left px-3 py-2.5 font-medium">Contact</th>
                <th className="text-left px-3 py-2.5 font-medium">Assigned</th>
                <th className="text-left px-3 py-2.5 font-medium">Status</th>
                <th className="text-right px-3 py-2.5 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredShops.map((shop) => {
                const shopAssignments = assignmentsByShop.get(shop.id) || [];
                const locationLine = [shop.city, shop.district].filter(Boolean).join(', ');
                const zoneLabel = shop.zones?.name || shop.zone;
                return (
                  <tr
                    key={shop.id}
                    className={`hover:bg-slate-50 transition ${selectedShopIds.has(shop.id) ? 'bg-blue-50/60' : ''}`}
                    onClick={selectMode ? () => toggleShopSelected(shop.id) : undefined}
                  >
                    {selectMode && (
                      <td className="px-3 py-3 align-top cursor-pointer" onClick={(e) => { e.stopPropagation(); toggleShopSelected(shop.id); }}>
                        <input
                          type="checkbox"
                          checked={selectedShopIds.has(shop.id)}
                          onChange={() => toggleShopSelected(shop.id)}
                          onClick={(e) => e.stopPropagation()}
                          className="w-4 h-4 accent-blue-600"
                        />
                      </td>
                    )}
                    <td className="px-3 py-3 align-top max-w-[220px]">
                      {selectMode ? (
                        <div>
                          <p className="font-medium text-slate-900 truncate">{shop.name}</p>
                          <p className="text-xs text-slate-500 truncate">{shop.clients?.name || 'No client'}</p>
                        </div>
                      ) : (
                        <Link to={`/shops/${shop.id}`} className="block">
                          <p className="font-medium text-slate-900 hover:text-blue-600 truncate">{shop.name}</p>
                          <p className="text-xs text-slate-500 truncate">{shop.clients?.name || 'No client'}</p>
                        </Link>
                      )}
                      {shop.purchase_orders?.po_number && (
                        <span className="inline-flex items-center gap-1 mt-1 text-[10px] font-medium text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded">
                          <FileText className="w-3 h-3" /> {shop.purchase_orders.po_number}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-3 align-top max-w-[200px]">
                      {locationLine && (
                        <p className="text-slate-700 flex items-center gap-1 truncate"><MapPin className="w-3.5 h-3.5 text-slate-400 shrink-0" /> {locationLine}</p>
                      )}
                      {zoneLabel && <p className="text-xs text-slate-400 truncate mt-0.5">Zone: {zoneLabel}</p>}
                      {!locationLine && !zoneLabel && <span className="text-slate-300">—</span>}
                    </td>
                    <td className="px-3 py-3 align-top max-w-[180px]">
                      {(shop.owner_name || shop.contact_phone) ? (
                        <div>
                          {shop.owner_name && <p className="text-slate-700 truncate">{shop.owner_name}</p>}
                          {shop.contact_phone && <p className="text-xs text-slate-400 flex items-center gap-1"><Phone className="w-3 h-3" /> {shop.contact_phone}</p>}
                        </div>
                      ) : <span className="text-slate-300">—</span>}
                    </td>
                    <td className="px-3 py-3 align-top max-w-[220px]">
                      {shopAssignments.length > 0 ? (
                        <div className="flex flex-col gap-1">
                          {shopAssignments.map((a, i) => (
                            <span key={i} className="inline-flex items-center gap-1 text-xs">
                              <span className="capitalize text-slate-500 shrink-0">{a.role}:</span>
                              <span className="text-slate-700 truncate">{a.name}</span>
                              <span className="text-[10px] text-slate-400 capitalize shrink-0">({a.status.replace(/_/g, ' ')})</span>
                            </span>
                          ))}
                        </div>
                      ) : <span className="text-xs text-slate-300">Unassigned</span>}
                    </td>
                    <td className="px-3 py-3 align-top">
                      {canBulkAssign && !selectMode ? (
                        <button onClick={(e) => { e.stopPropagation(); openStatusChange([shop]); }} className="rounded-md hover:ring-2 hover:ring-violet-100 transition" title="Change shop stage">
                          <StatusBadge status={shop.status} />
                        </button>
                      ) : <StatusBadge status={shop.status} />}
                    </td>
                    <td className="px-3 py-3 align-top">
                      <div className="flex items-center justify-end gap-3">
                        <Link to={`/shops/${shop.id}`} onClick={(e) => e.stopPropagation()} className="text-slate-400 hover:text-blue-600" title="View details">
                          <ChevronRight className="w-4 h-4" />
                        </Link>
                        {!selectMode && (
                          <>
                            <button onClick={(e) => { e.stopPropagation(); openEdit(shop); }} className="text-slate-400 hover:text-blue-600" title="Edit">
                              <Pencil className="w-4 h-4" />
                            </button>
                            <button onClick={(e) => { e.stopPropagation(); setDeleteShop(shop); }} className="text-slate-400 hover:text-red-600" title={profile?.role === 'agency_owner' || profile?.role === 'admin' ? 'Delete' : 'Cancel'}>
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {filteredShops.length === 0 && (
          <EmptyState icon={<Store className="w-12 h-12" />} title="No shops found" subtitle={totalShops === 0 && !hasActiveFilters ? 'Add a shop, or bulk upload via Excel' : 'Adjust filters or add a new shop'} />
        )}

        {/* Pagination — this list is designed to hold 10,000+ shops, so
            it's always server-paginated rather than "load everything and
            scroll". Page-size is adjustable; Prev/Next plus jump-to-
            first/last make it fast to work through a large filtered set. */}
        {totalShops > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-t border-slate-100 bg-slate-50/60">
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <span>Rows per page</span>
              <select
                value={pageSize}
                onChange={(e) => setPageSize(Number(e.target.value))}
                className="px-2 py-1 border border-slate-300 rounded-md text-xs bg-white outline-none focus:ring-2 focus:ring-blue-500"
              >
                {SHOP_PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
              <span className="ml-2 hidden sm:inline">{rangeStart}–{rangeEnd} of {totalShops.toLocaleString('en-IN')}</span>
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={() => setPage(0)}
                disabled={page === 0}
                title="First page"
                className="p-1.5 rounded-md text-slate-500 hover:bg-white hover:text-blue-600 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-slate-500 border border-transparent hover:border-slate-200"
              >
                <ChevronsLeft className="w-4 h-4" />
              </button>
              <button
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={page === 0}
                title="Previous page"
                className="p-1.5 rounded-md text-slate-500 hover:bg-white hover:text-blue-600 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-slate-500 border border-transparent hover:border-slate-200"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <span className="text-xs text-slate-600 font-medium px-2 whitespace-nowrap">
                Page {page + 1} of {totalPages.toLocaleString('en-IN')}
              </span>
              <button
                onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                disabled={page >= totalPages - 1}
                title="Next page"
                className="p-1.5 rounded-md text-slate-500 hover:bg-white hover:text-blue-600 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-slate-500 border border-transparent hover:border-slate-200"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
              <button
                onClick={() => setPage(totalPages - 1)}
                disabled={page >= totalPages - 1}
                title="Last page"
                className="p-1.5 rounded-md text-slate-500 hover:bg-white hover:text-blue-600 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-slate-500 border border-transparent hover:border-slate-200"
              >
                <ChevronsRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}
      </Card>

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={editShop ? 'Edit Shop' : 'Add Shop'} size="lg">
        <div className="space-y-4">
          <Input label="Shop Name" value={form.name} onChange={(v) => setForm({ ...form, name: v })} required />
          <div className="grid grid-cols-2 gap-4">
            <Select label="Client" value={form.client_id} onChange={(v) => setForm({ ...form, client_id: v, purchase_order_id: '' })} options={(clients || []).map((c) => ({ value: c.id, label: c.name }))} required />
            <Select label="Project" value={form.project_id} onChange={(v) => setForm({ ...form, project_id: v })} options={(projects || []).filter((p) => !form.client_id || p.client_id === form.client_id).map((p) => ({ value: p.id, label: p.name }))} />
          </div>
          <Select
            label="Purchase Order (optional)"
            value={form.purchase_order_id}
            onChange={(v) => setForm({ ...form, purchase_order_id: v })}
            options={(purchaseOrders || [])
              .filter((po) => !form.client_id || po.client_id === form.client_id)
              .map((po) => ({ value: po.id, label: `${po.po_number} · ${fulfillmentTypeLabel(po.fulfillment_type)}` }))}
          />
          <div className="grid grid-cols-2 gap-4">
            <Input label="Owner Name" value={form.owner_name} onChange={(v) => setForm({ ...form, owner_name: v })} />
            <Input label="Contact Phone" value={form.contact_phone} onChange={(v) => setForm({ ...form, contact_phone: v })} />
          </div>
          {(purchaseOrders || []).find((po) => po.id === form.purchase_order_id)?.fulfillment_type !== 'supply_only' && (
            <Input
              label="Signage Language (optional)"
              value={form.signage_language}
              onChange={(v) => setForm({ ...form, signage_language: v })}
              placeholder="e.g. Hindi, Marathi, English"
            />
          )}
          <Textarea label="Address" value={form.address} onChange={(v) => setForm({ ...form, address: v })} rows={2} />
          <div className="grid grid-cols-2 gap-4">
            <Combobox label="City" value={form.city} onChange={(v) => setForm({ ...form, city: v })} options={form.state && INDIA_CITIES_BY_STATE[form.state] ? INDIA_CITIES_BY_STATE[form.state] : ALL_INDIA_CITIES} />
            <Input label="District" value={form.district} onChange={(v) => setForm({ ...form, district: v })} />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Zone</label>
            <div className="flex gap-2">
              <select
                value={form.zone_id}
                onChange={(e) => setForm({ ...form, zone_id: e.target.value })}
                className="flex-1 px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition text-slate-900 bg-white"
              >
                <option value="">Select...</option>
                {(zones || [])
                  .filter((z) => !form.project_id || !z.project_id || z.project_id === form.project_id)
                  .map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
              </select>
              <button
                type="button"
                onClick={() => setZoneModalOpen(true)}
                className="shrink-0 px-3 py-2 text-sm font-medium bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg transition"
              >
                <Plus className="w-4 h-4" />
              </button>
            </div>
          </div>
          <Combobox label="State" value={form.state} onChange={(v) => setForm({ ...form, state: v })} options={INDIA_STATES} />

          <div className="border border-slate-200 rounded-lg p-3 space-y-2">
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-slate-500">
                We'll pin the shop on the map from the address above — no need to type coordinates by hand.
              </p>
              <button
                type="button"
                onClick={handleLocateOnMap}
                disabled={geocoding}
                className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg transition disabled:opacity-50"
              >
                {geocoding ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <LocateFixed className="w-3.5 h-3.5" />}
                {geocoding ? 'Locating...' : 'Locate on Map'}
              </button>
            </div>

            {geocodeStatus && (
              <p className={`text-xs ${geocodeStatus.type === 'success' ? 'text-green-700' : 'text-red-600'}`}>
                {geocodeStatus.message}
              </p>
            )}

            <details className="text-xs text-slate-400">
              <summary className="cursor-pointer select-none">Enter coordinates manually instead</summary>
              <div className="grid grid-cols-2 gap-4 mt-2">
                <Input label="Latitude" type="number" value={form.latitude} onChange={(v) => setForm({ ...form, latitude: v })} step="any" />
                <Input label="Longitude" type="number" value={form.longitude} onChange={(v) => setForm({ ...form, longitude: v })} step="any" />
              </div>
            </details>
          </div>

          <button
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending}
            className="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium py-2.5 rounded-lg transition disabled:opacity-50"
          >
            {saveMutation.isPending ? 'Saving...' : editShop ? 'Update Shop' : 'Add Shop'}
          </button>
          {saveMutation.isError && <p className="text-sm text-red-600">{(saveMutation.error as Error).message}</p>}
        </div>
      </Modal>

      <ConfirmDialog
        open={!!deleteShop}
        onClose={() => setDeleteShop(null)}
        onConfirm={() => deleteShop && deleteMutation.mutate(deleteShop)}
        title={profile?.role === 'agency_owner' || profile?.role === 'admin' ? 'Delete Shop' : 'Cancel Shop'}
        message={`Are you sure you want to ${profile?.role === 'agency_owner' || profile?.role === 'admin' ? 'permanently delete' : 'cancel'} ${deleteShop?.name}?`}
        confirmLabel={profile?.role === 'agency_owner' || profile?.role === 'admin' ? 'Delete' : 'Cancel'}
        danger
      />

      <Modal open={!!statusChangeShops} onClose={() => { setStatusChangeShops(null); setNextShopStatus(''); }} title={statusChangeShops?.length === 1 ? 'Change Shop Stage' : `Change Stage — ${statusChangeShops?.length || 0} Shops`} size="md">
        <div className="space-y-4">
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">Selected shops</p>
            <div className="max-h-36 overflow-y-auto space-y-1.5">
              {(statusChangeShops || []).map((shop) => <div key={shop.id} className="flex items-center justify-between gap-3 text-sm"><span className="font-medium text-slate-800 truncate">{shop.name}</span><StatusBadge status={shop.status} /></div>)}
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1.5">Move selected shop{(statusChangeShops?.length || 0) === 1 ? '' : 's'} to</label>
            <select value={nextShopStatus} onChange={(e) => setNextShopStatus(e.target.value)} className="w-full px-3 py-2.5 border border-slate-300 rounded-lg text-sm bg-white outline-none focus:ring-2 focus:ring-violet-500">
              <option value="">Choose stage…</option>
              {Object.entries(SHOP_STATUS_OPTIONS).map(([value,label]) => <option key={value} value={value}>{label}</option>)}
            </select>
            <p className="mt-2 text-xs text-slate-500">This is an Owner/Admin stage override. Existing approval gates still apply — for example, a shop cannot be forced to Installed until its installation review is actually approved.</p>
          </div>
          {shopStageMutation.isError && <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-2">{(shopStageMutation.error as Error).message}</p>}
          <button onClick={() => statusChangeShops && shopStageMutation.mutate({ targets: statusChangeShops, status: nextShopStatus })} disabled={!nextShopStatus || shopStageMutation.isPending} className="w-full rounded-lg bg-violet-600 hover:bg-violet-700 text-white font-medium py-2.5 disabled:opacity-50">
            {shopStageMutation.isPending ? 'Updating…' : `Update ${(statusChangeShops?.length || 0)} Shop${(statusChangeShops?.length || 0) === 1 ? '' : 's'}`}
          </button>
        </div>
      </Modal>

      <Modal open={bulkAssignOpen} onClose={() => setBulkAssignOpen(false)} title="Bulk Assign">
        <div className="space-y-4">
          <p className="text-sm text-slate-600">
            {selectedShopIds.size} shop{selectedShopIds.size === 1 ? '' : 's'} selected:{' '}
            <span className="text-slate-900">
              {(shops || []).filter((s) => selectedShopIds.has(s.id)).slice(0, 4).map((s) => s.name).join(', ')}
              {selectedShopIds.size > 4 ? ` +${selectedShopIds.size - 4} more` : ''}
            </span>
          </p>

          <div className="flex gap-2">
            {(['surveyor', 'designer', 'installer'] as const).map((role) => (
              <button
                key={role}
                onClick={() => { setBulkRole(role); setBulkUserId(''); setBulkResult(null); }}
                className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium border capitalize ${
                  bulkRole === role ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'
                }`}
              >
                {role}
              </button>
            ))}
          </div>

          {bulkRole === 'designer' && (
            <p className="text-xs text-amber-600">
              Only applies to shops whose survey has already been approved (i.e. a design task already exists). Others will be skipped.
            </p>
          )}

          <Select
            label={`Assign ${bulkRole}`}
            value={bulkUserId}
            onChange={setBulkUserId}
            options={[
              { value: '', label: 'Select a person...' },
              ...(bulkPeople || []).map((p) => ({ value: p.id, label: p.full_name })),
            ]}
          />
          {bulkPeople && bulkPeople.length === 0 && (
            <p className="text-xs text-amber-600">
              No active {bulkRole}s found in your organization. Add one from Owner Console → Users first.
            </p>
          )}

          {bulkResult && (
            <p className="text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg p-2">{bulkResult}</p>
          )}
          {bulkAssignMutation.isError && (
            <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-2">
              {(bulkAssignMutation.error as Error).message}
            </p>
          )}

          <button
            onClick={() => bulkAssignMutation.mutate()}
            disabled={bulkAssignMutation.isPending || !bulkUserId || selectedShopIds.size === 0}
            className="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium py-2.5 rounded-lg disabled:opacity-50"
          >
            {bulkAssignMutation.isPending ? 'Assigning...' : `Assign to ${selectedShopIds.size} shop${selectedShopIds.size === 1 ? '' : 's'}`}
          </button>
          {bulkResult && (
            <button
              onClick={() => { setBulkAssignOpen(false); setSelectMode(false); setSelectedShopIds(new Set()); }}
              className="w-full bg-slate-100 hover:bg-slate-200 text-slate-700 font-medium py-2 rounded-lg text-sm"
            >
              Done
            </button>
          )}
        </div>
      </Modal>

      <Modal open={zoneModalOpen} onClose={() => setZoneModalOpen(false)} title="Add Zone" size="sm">
        <div className="space-y-4">
          <p className="text-xs text-slate-500">
            {form.project_id ? 'This zone will be tied to the selected project.' : 'No project selected — this zone will be available org-wide.'}
          </p>
          <Input label="Zone Name" value={newZoneName} onChange={setNewZoneName} placeholder="e.g. Rajkot" required />
          {addZoneMutation.isError && <p className="text-sm text-red-600">{(addZoneMutation.error as Error).message}</p>}
          <button
            onClick={() => addZoneMutation.mutate()}
            disabled={addZoneMutation.isPending || !newZoneName.trim()}
            className="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium py-2.5 rounded-lg transition disabled:opacity-50"
          >
            {addZoneMutation.isPending ? 'Adding...' : 'Add Zone'}
          </button>
        </div>
      </Modal>

      {/* BULK UPLOAD */}
      <Modal open={bulkOpen} onClose={() => resetBulkState()} title="Bulk Upload Shops" size="lg">
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <Select
              label="Client"
              value={bulkClientId}
              onChange={(v) => { setBulkClientId(v); setBulkPurchaseOrderId(''); }}
              options={(clients || []).map((c) => ({ value: c.id, label: c.name }))}
              required
            />
            <Select
              label="Project (optional)"
              value={bulkProjectId}
              onChange={setBulkProjectId}
              options={(projects || []).filter((p) => !bulkClientId || p.client_id === bulkClientId).map((p) => ({ value: p.id, label: p.name }))}
            />
          </div>
          <Select
            label="Purchase Order (optional)"
            value={bulkPurchaseOrderId}
            onChange={setBulkPurchaseOrderId}
            options={(purchaseOrders || [])
              .filter((po) => !bulkClientId || po.client_id === bulkClientId)
              .map((po) => ({ value: po.id, label: `${po.po_number} · ${fulfillmentTypeLabel(po.fulfillment_type)}` }))}
          />

          <div className="bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5">
            <p className="text-xs text-slate-500">
              Upload a .xlsx, .xls, or .csv file with one row per shop — any column order, any position in the file.
              Every client sends their list a little differently, so recognized columns can be named any of these:{' '}
              <span className="font-medium text-slate-700">Name</span> (required), Owner Name / Contact Person, Contact Phone,
              Address, City, District, Zone, State, Village (optional). Any other column in the file will be shown below so
              you can choose to keep it as an extra detail on each shop.
            </p>
          </div>

          <label className="flex flex-col items-center justify-center gap-2 border-2 border-dashed border-slate-300 hover:border-blue-400 rounded-lg py-8 cursor-pointer transition">
            <UploadCloud className="w-8 h-8 text-slate-400" />
            <span className="text-sm text-slate-600 font-medium">{bulkFileName || 'Click to choose a file'}</span>
            <span className="text-xs text-slate-400">.xlsx, .xls, or .csv</span>
            <input type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={(e) => e.target.files?.[0] && handleBulkFile(e.target.files[0])} />
          </label>
          {bulkError && <p className="text-sm text-red-600">{bulkError}</p>}

          {bulkExtraHeaders.length > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-3">
              <p className="text-xs font-medium text-amber-800 mb-2">
                Found {bulkExtraHeaders.length} extra column{bulkExtraHeaders.length === 1 ? '' : 's'} in this file that aren't part of the standard fields. Keep them as additional details on each shop?
              </p>
              <div className="space-y-1.5">
                {bulkExtraHeaders.map((h) => (
                  <label key={h} className="flex items-center gap-2 text-sm text-amber-900">
                    <input
                      type="checkbox"
                      checked={!!bulkIncludedExtra[h]}
                      onChange={(e) => setBulkIncludedExtra({ ...bulkIncludedExtra, [h]: e.target.checked })}
                      className="rounded border-amber-300"
                    />
                    {h}
                  </label>
                ))}
              </div>
            </div>
          )}

          {bulkParsedRows.length > 0 && (
            <div className="border border-slate-200 rounded-lg overflow-x-auto max-h-56 overflow-y-auto">
              <table className="w-full text-xs min-w-[480px]">
                <thead className="bg-slate-50 text-slate-500 uppercase sticky top-0">
                  <tr>
                    <th className="text-left px-2 py-1.5">Name</th>
                    <th className="text-left px-2 py-1.5">City</th>
                    <th className="text-left px-2 py-1.5">District</th>
                    <th className="text-left px-2 py-1.5">Zone</th>
                    <th className="text-left px-2 py-1.5">Contact</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {bulkParsedRows.slice(0, 50).map((r, i) => (
                    <tr key={i}>
                      <td className="px-2 py-1.5 text-slate-800">{r.known.name}</td>
                      <td className="px-2 py-1.5 text-slate-600">{r.known.city}</td>
                      <td className="px-2 py-1.5 text-slate-600">{r.known.district}</td>
                      <td className="px-2 py-1.5 text-slate-600">{r.known.zone}</td>
                      <td className="px-2 py-1.5 text-slate-600">{r.known.contact_phone}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {bulkParsedRows.length > 50 && <p className="text-xs text-slate-400 px-2 py-1.5">...and {bulkParsedRows.length - 50} more rows</p>}
            </div>
          )}

          {bulkUploadResult && <p className="text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg p-2">{bulkUploadResult}</p>}
          {bulkUploadMutation.isError && <p className="text-sm text-red-600">{(bulkUploadMutation.error as Error).message}</p>}

          <button
            onClick={() => bulkUploadMutation.mutate()}
            disabled={bulkUploadMutation.isPending || bulkParsedRows.length === 0 || !bulkClientId}
            className="w-full flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-700 text-white font-medium py-2.5 rounded-lg transition disabled:opacity-50"
          >
            {bulkUploadMutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
            {bulkUploadMutation.isPending ? 'Uploading...' : `Add ${bulkParsedRows.length || ''} Shop${bulkParsedRows.length === 1 ? '' : 's'}`}
          </button>
        </div>
      </Modal>

      <ConfirmDialog
        open={bulkRemoveConfirmOpen}
        onClose={() => setBulkRemoveConfirmOpen(false)}
        onConfirm={() => bulkRemoveMutation.mutate()}
        title={profile?.role === 'agency_owner' || profile?.role === 'admin' ? 'Delete selected shops?' : 'Cancel selected shops?'}
        message={`This will ${profile?.role === 'agency_owner' || profile?.role === 'admin' ? 'permanently delete' : 'cancel'} ${selectedShopIds.size} shop${selectedShopIds.size === 1 ? '' : 's'}. This can't be undone.`}
        confirmLabel={bulkRemoveMutation.isPending ? 'Working...' : (profile?.role === 'agency_owner' || profile?.role === 'admin' ? 'Delete' : 'Cancel Shops')}
        danger
      />

      <Modal open={fastTrackOpen} onClose={() => setFastTrackOpen(false)} title="Add Shop — Already In Progress" size="lg">
        <div className="space-y-5">
          <p className="text-sm text-slate-600">
            For a shop that doesn't exist in the app at all yet, but has already been surveyed / designed /
            produced elsewhere. This creates the shop and its history in one go, so only Installation
            is left to run through the normal app flow.
          </p>

          <div>
            <h3 className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-2">Shop Details</h3>
            <div className="grid grid-cols-2 gap-3">
              <Input label="Shop Name" value={ftForm.name} onChange={(v) => setFtForm((f) => ({ ...f, name: v }))} required />
              <Select label="Client" value={ftForm.client_id} onChange={(v) => setFtForm((f) => ({ ...f, client_id: v, project_id: '' }))} options={[{ value: '', label: 'Select client...' }, ...(clients || []).map((c) => ({ value: c.id, label: c.name }))]} required />
              <Select label="Project (optional)" value={ftForm.project_id} onChange={(v) => setFtForm((f) => ({ ...f, project_id: v }))} options={[{ value: '', label: 'None' }, ...(projects || []).filter((p) => !ftForm.client_id || p.client_id === ftForm.client_id).map((p) => ({ value: p.id, label: p.name }))]} />
              <Select label="Purchase Order (optional)" value={ftForm.purchase_order_id} onChange={(v) => setFtForm((f) => ({ ...f, purchase_order_id: v }))} options={[{ value: '', label: 'None' }, ...(purchaseOrders || []).filter((p) => !ftForm.client_id || p.client_id === ftForm.client_id).map((p) => ({ value: p.id, label: p.po_number }))]} />
              <Input label="Owner Name" value={ftForm.owner_name} onChange={(v) => setFtForm((f) => ({ ...f, owner_name: v }))} />
              <Input label="Contact Phone" value={ftForm.contact_phone} onChange={(v) => setFtForm((f) => ({ ...f, contact_phone: v }))} />
              <Input label="Address" value={ftForm.address} onChange={(v) => setFtForm((f) => ({ ...f, address: v }))} />
              <Input label="City" value={ftForm.city} onChange={(v) => setFtForm((f) => ({ ...f, city: v }))} />
              <Input label="District" value={ftForm.district} onChange={(v) => setFtForm((f) => ({ ...f, district: v }))} />
              <Combobox label="State" value={ftForm.state} onChange={(v) => setFtForm((f) => ({ ...f, state: v }))} options={INDIA_STATES} />
              <Select label="Zone (optional)" value={ftForm.zone_id} onChange={(v) => setFtForm((f) => ({ ...f, zone_id: v }))} options={[{ value: '', label: 'None' }, ...(zones || []).map((z) => ({ value: z.id, label: z.name }))]} />
            </div>
          </div>

          <div>
            <label className="text-xs font-medium text-slate-500 uppercase tracking-wide">How far has this shop already progressed?</label>
            <div className="mt-2 grid grid-cols-2 gap-2">
              {([
                { value: 'design_pending', label: 'Survey done', hint: 'Design still to happen in-app' },
                { value: 'production_pending', label: 'Survey + Design done', hint: 'Production still to happen in-app' },
                { value: 'production_done', label: 'Survey + Design + Production done', hint: 'Ready for Installation' },
                { value: 'dispatched', label: '...and vehicle already left', hint: 'Same as above, marked Dispatched' },
              ] as { value: BackfillStage; label: string; hint: string }[]).map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setFtStage(opt.value)}
                  className={`text-left border rounded-lg p-2.5 text-xs transition ${
                    ftStage === opt.value ? 'border-amber-500 bg-amber-50 ring-1 ring-amber-500' : 'border-slate-200 hover:bg-slate-50'
                  }`}
                >
                  <p className="font-medium text-slate-900">{opt.label}</p>
                  <p className="text-slate-500 mt-0.5">{opt.hint}</p>
                </button>
              ))}
            </div>
          </div>

          <Select
            label="Surveyed by (optional — defaults to you)"
            value={ftSurveyorId}
            onChange={setFtSurveyorId}
            options={[{ value: '', label: 'Me (entering this data)' }, ...(ftPeople || []).filter((p) => p.role === 'surveyor').map((p) => ({ value: p.id, label: p.full_name }))]}
          />

          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-medium text-slate-500 uppercase tracking-wide">Boards / Items</label>
              <button
                type="button"
                onClick={() => setFtItems((prev) => [...prev, { key: crypto.randomUUID(), workTypeId: '', workTypeName: '', material: '', width: '', height: '', unit: 'ft', quantity: '1' }])}
                className="flex items-center gap-1 text-xs font-medium text-blue-600"
              >
                <PlusCircle className="w-3.5 h-3.5" /> Add item
              </button>
            </div>
            <div className="space-y-3">
              {ftItems.map((item, idx) => (
                <div key={item.key} className="border border-slate-200 rounded-lg p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-slate-500">Item {idx + 1}</span>
                    {ftItems.length > 1 && (
                      <button type="button" onClick={() => setFtItems((prev) => prev.filter((_, i) => i !== idx))} className="text-slate-400 hover:text-red-600">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <Select
                      label="Work type"
                      value={item.workTypeId}
                      onChange={(v) => setFtItems((prev) => prev.map((it, i) => (i === idx ? { ...it, workTypeId: v } : it)))}
                      options={[{ value: '', label: 'Custom / not listed' }, ...(ftWorkTypes || []).map((w) => ({ value: w.id, label: w.name }))]}
                    />
                    <Input label="Or type a name" value={item.workTypeName} onChange={(v) => setFtItems((prev) => prev.map((it, i) => (i === idx ? { ...it, workTypeName: v } : it)))} />
                  </div>
                  <div className="grid grid-cols-4 gap-2">
                    <Input label="Width" type="number" value={item.width} onChange={(v) => setFtItems((prev) => prev.map((it, i) => (i === idx ? { ...it, width: v } : it)))} />
                    <Input label="Height" type="number" value={item.height} onChange={(v) => setFtItems((prev) => prev.map((it, i) => (i === idx ? { ...it, height: v } : it)))} />
                    <Select label="Unit" value={item.unit} onChange={(v) => setFtItems((prev) => prev.map((it, i) => (i === idx ? { ...it, unit: v } : it)))} options={LENGTH_UNIT_OPTIONS} />
                    <Input label="Qty" type="number" value={item.quantity} onChange={(v) => setFtItems((prev) => prev.map((it, i) => (i === idx ? { ...it, quantity: v } : it)))} />
                  </div>
                  <Input label="Material (optional)" value={item.material} onChange={(v) => setFtItems((prev) => prev.map((it, i) => (i === idx ? { ...it, material: v } : it)))} />
                </div>
              ))}
            </div>
          </div>

          <div>
            <label className="text-xs font-medium text-slate-500 uppercase tracking-wide">Survey Photos (optional)</label>
            <input
              type="file" accept="image/*" multiple
              onChange={(e) => setFtSurveyPhotos((prev) => [...prev, ...Array.from(e.target.files || [])])}
              className="mt-1 block w-full text-xs text-slate-600 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border file:border-slate-300 file:bg-white file:text-xs file:font-medium"
            />
            {ftSurveyPhotos.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2">
                {ftSurveyPhotos.map((f, i) => (
                  <span key={`${f.name}-${i}`} className="flex items-center gap-1 text-xs bg-slate-100 border border-slate-200 rounded-full px-2 py-1">
                    {f.name}
                    <button type="button" onClick={() => setFtSurveyPhotos((prev) => prev.filter((_, j) => j !== i))}><X className="w-3 h-3" /></button>
                  </span>
                ))}
              </div>
            )}
          </div>

          {ftStage !== 'design_pending' && (
            <Select
              label="Designed by (optional)"
              value={ftDesignerId}
              onChange={setFtDesignerId}
              options={[{ value: '', label: 'Not specified' }, ...(ftPeople || []).filter((p) => p.role === 'designer').map((p) => ({ value: p.id, label: p.full_name }))]}
            />
          )}

          {ftStage !== 'design_pending' && (
            <div>
              <label className="text-xs font-medium text-slate-500 uppercase tracking-wide">Design File(s) (optional)</label>
              <input
                type="file" accept="image/*,application/pdf" multiple
                onChange={(e) => setFtDesignFiles((prev) => [...prev, ...Array.from(e.target.files || [])])}
                className="mt-1 block w-full text-xs text-slate-600 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border file:border-slate-300 file:bg-white file:text-xs file:font-medium"
              />
              {ftDesignFiles.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {ftDesignFiles.map((f, i) => (
                    <span key={`${f.name}-${i}`} className="flex items-center gap-1 text-xs bg-slate-100 border border-slate-200 rounded-full px-2 py-1">
                      {f.name}
                      <button type="button" onClick={() => setFtDesignFiles((prev) => prev.filter((_, j) => j !== i))}><X className="w-3 h-3" /></button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}

          {(ftStage === 'production_done' || ftStage === 'dispatched') && (
            <>
              <Select
                label="Produced by (optional)"
                value={ftProductionId}
                onChange={setFtProductionId}
                options={[{ value: '', label: 'Not specified' }, ...(ftPeople || []).filter((p) => p.role === 'printing').map((p) => ({ value: p.id, label: p.full_name }))]}
              />
              <Select
                label="Assign installer now (optional)"
                value={ftInstallerId}
                onChange={setFtInstallerId}
                options={[{ value: '', label: "Don't assign yet" }, ...(ftPeople || []).filter((p) => p.role === 'installer').map((p) => ({ value: p.id, label: p.full_name }))]}
              />
            </>
          )}

          <Textarea label="Note (optional)" value={ftNote} onChange={(v) => setFtNote(v)} placeholder="e.g. Completed in March before this shop was added to the system" />

          {fastTrackMutation.isError && (
            <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-2">
              {(fastTrackMutation.error as Error).message}
            </p>
          )}

          <button
            onClick={() => fastTrackMutation.mutate()}
            disabled={fastTrackMutation.isPending}
            className="w-full bg-amber-600 hover:bg-amber-700 text-white font-medium py-2.5 rounded-lg disabled:opacity-50"
          >
            {fastTrackMutation.isPending ? 'Saving...' : 'Create Shop with Backfilled Data'}
          </button>
        </div>
      </Modal>

      <Modal open={bulkBackfillOpen} onClose={() => setBulkBackfillOpen(false)} title="Bulk Backfill" size="lg">
        <div className="space-y-5">
          <p className="text-sm text-slate-600">
            Fill in an Excel file (one row per board, grouped by shop) and upload it back here — for shops
            already in the app with no survey/design/production data yet, and for shops that don't exist
            in the app at all (leave Shop ID blank and fill in the shop's details, and it gets created
            first). Each shop is written through exactly the same logic as the single-shop Backfill panel.
          </p>

          <div className="border border-slate-200 rounded-lg p-4 space-y-2">
            <p className="text-sm font-medium text-slate-900">Step 1 — Download the template</p>
            <p className="text-xs text-slate-500">{eligibleShops ? `${eligibleShops.length} existing shop${eligibleShops.length === 1 ? '' : 's'} need backfilling, plus blank rows for brand-new shops.` : 'Loading shops...'}</p>
            <button
              type="button"
              onClick={downloadBulkBackfillTemplateFile}
              disabled={!eligibleShops || !ftPeople || !clients}
              className="flex items-center gap-2 text-sm font-medium text-blue-600 border border-blue-200 bg-blue-50 px-3 py-1.5 rounded-lg disabled:opacity-50"
            >
              <Download className="w-4 h-4" /> Download Template ({eligibleShops?.length ?? 0} existing shops)
            </button>
          </div>

          <div className="border border-slate-200 rounded-lg p-4 space-y-2">
            <p className="text-sm font-medium text-slate-900">Step 2 — Upload the filled file</p>
            <input
              type="file" accept=".xlsx,.xls"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) handleBulkBackfillFile(f); }}
              className="block w-full text-xs text-slate-600 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border file:border-slate-300 file:bg-white file:text-xs file:font-medium"
            />
            {bbFile && <p className="text-xs text-slate-500">{bbFile.name}</p>}
            {bbParseError && <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-2">{bbParseError}</p>}
          </div>

          {bbParsedShops && !bbResults && (
            <div className="border border-slate-200 rounded-lg p-4 space-y-3">
              <p className="text-sm font-medium text-slate-900">Step 3 — Review &amp; run</p>
              <div className="max-h-56 overflow-y-auto space-y-1">
                {bbParsedShops.map((s) => {
                  const meta = s.isNew ? null : ((s.shopId ? (eligibleShops || []).find((sh) => sh.id === s.shopId) : undefined) || (eligibleShops || []).find((sh) => sh.name.toLowerCase() === s.shopName.toLowerCase()));
                  const po = s.workOrderNumber ? (purchaseOrders || []).find((p) => p.po_number.toLowerCase() === s.workOrderNumber.toLowerCase()) : undefined;
                  const client = s.isNew ? (po ? { id: po.client_id } : (clients || []).find((c) => c.name.toLowerCase() === s.clientName.toLowerCase())) : null;
                  const valid = !s.isNewAmbiguous && !!s.stage && s.items.length > 0 && (s.isNew ? !!s.shopName && !!client : !!meta);
                  const reason = s.isNewAmbiguous ? 'Set "New Shop?" to Yes or No'
                    : !s.stage ? `Bad stage: "${s.stageRaw}"`
                    : s.items.length === 0 ? 'No items'
                    : s.isNew && !s.shopName ? 'New shop needs a name'
                    : s.isNew && s.workOrderNumber && !po ? `Work Order "${s.workOrderNumber}" not found`
                    : s.isNew && !client ? (s.clientName ? `Client "${s.clientName}" not found` : 'Needs a Work Order or Client')
                    : !s.isNew && !meta ? 'Shop not found' : '';
                  return (
                    <div key={s.key} className="flex items-center justify-between text-xs py-1 border-b border-slate-100 last:border-0">
                      <span className="text-slate-700">
                        {meta?.name || s.shopName || s.shopId}
                        {s.isNew && <span className="ml-1 text-emerald-600 font-medium">(new)</span>}
                      </span>
                      <span className={valid ? 'text-slate-500' : 'text-red-600 font-medium'}>
                        {valid ? `${s.items.length} item${s.items.length === 1 ? '' : 's'} · ${s.stageRaw}` : reason}
                      </span>
                    </div>
                  );
                })}
              </div>
              {bulkBackfillMutation.isError && (
                <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-2">
                  {(bulkBackfillMutation.error as Error).message}
                </p>
              )}
              <button
                onClick={() => bulkBackfillMutation.mutate()}
                disabled={bulkBackfillMutation.isPending}
                className="w-full bg-amber-600 hover:bg-amber-700 text-white font-medium py-2.5 rounded-lg disabled:opacity-50"
              >
                {bulkBackfillMutation.isPending ? `Processing ${bbParsedShops.length} shops...` : `Run Backfill for ${bbParsedShops.length} Shops`}
              </button>
            </div>
          )}

          {bbResults && (
            <div className="border border-slate-200 rounded-lg p-4 space-y-2">
              <p className="text-sm font-medium text-slate-900">
                {bbResults.filter((r) => r.ok).length} succeeded, {bbResults.filter((r) => !r.ok).length} failed
              </p>
              <div className="max-h-56 overflow-y-auto space-y-1">
                {bbResults.map((r) => (
                  <div key={r.shopId} className="flex items-center justify-between text-xs py-1 border-b border-slate-100 last:border-0">
                    <span className="text-slate-700">{r.shopName}</span>
                    <span className={r.ok ? 'text-emerald-600' : 'text-red-600'}>{r.message}</span>
                  </div>
                ))}
              </div>
              <button onClick={() => { resetBulkBackfill(); }} className="text-xs font-medium text-blue-600">
                Upload another file
              </button>
            </div>
          )}
        </div>
      </Modal>
    </div>
  );
}

export function ShopDetailPage({ shopId }: { shopId: string }) {
  const { profile } = useAuth();
  const orgId = profile?.organization_id;
  const queryClient = useQueryClient();
  const [assignModal, setAssignModal] = useState<'surveyor' | 'installer' | 'designer' | null>(null);
  const [assignUserId, setAssignUserId] = useState('');
  const canAssign = profile?.role === 'agency_owner' || profile?.role === 'admin' || profile?.role === 'demo';
  const canCrudShop = profile?.role === 'agency_owner' || profile?.role === 'admin' || profile?.role === 'demo';
  const [detailEditOpen, setDetailEditOpen] = useState(false);
  const [detailForm, setDetailForm] = useState({ name: '', owner_name: '', contact_phone: '', address: '', city: '', district: '', state: '', signage_language: '' });
  const [editWorkItem, setEditWorkItem] = useState<WorkItem | null>(null);
  const [workItemForm, setWorkItemForm] = useState({ work_type_name: '', material: '', width: '', height: '', unit: 'ft', quantity: '1' });
  const [photoUploading, setPhotoUploading] = useState(false);
  const [evidencePreview, setEvidencePreview] = useState<{ src: string; label: string } | null>(null);
  const [surveyPhotoUploadOpen, setSurveyPhotoUploadOpen] = useState(false);
  const [surveyPhotoUploadFiles, setSurveyPhotoUploadFiles] = useState<File[]>([]);
  const [surveyPhotoItemIds, setSurveyPhotoItemIds] = useState<Set<string>>(new Set());
  // Per-file mapping preserves the exact order selected by the user: Photo 1 -> Board X, Photo 2 -> Board Y.
  const [surveyPhotoFileMap, setSurveyPhotoFileMap] = useState<Record<number, string>>({});
  const [surveyPhotoCaption, setSurveyPhotoCaption] = useState('');
  const [surveyPhotoType, setSurveyPhotoType] = useState('survey');
  const [surveyPhotoSurveyId, setSurveyPhotoSurveyId] = useState('');
  // When upload is launched from a Work Item, lock every selected file to that item. Bulk upload leaves this null.
  const [surveyPhotoTargetItemId, setSurveyPhotoTargetItemId] = useState<string | null>(null);
  const [designUploadOpen, setDesignUploadOpen] = useState(false);
  const [designUploadFiles, setDesignUploadFiles] = useState<File[]>([]);
  const [designUploadItemIds, setDesignUploadItemIds] = useState<Set<string>>(new Set());
  // Exact per-file mapping. A multi-file selection is never collapsed into one upload.
  const [designUploadFileMap, setDesignUploadFileMap] = useState<Record<number, string>>({});
  const [designUploadNotes, setDesignUploadNotes] = useState('');
  const [designUploadTargetItemId, setDesignUploadTargetItemId] = useState<string | null>(null);

  // ---- BACKFILL (Owner/Admin entering work already completed outside
  // the app — survey/design/production done on paper or another system,
  // only Installation is left to actually run in-app). See
  // backfillMutation below for exactly what this writes. ----
  const [backfillOpen, setBackfillOpen] = useState(false);
  const [backfillStage, setBackfillStage] = useState<BackfillStage>('production_done');
  type BackfillItem = { key: string; workTypeId: string; workTypeName: string; material: string; width: string; height: string; unit: string; quantity: string };
  const [backfillItems, setBackfillItems] = useState<BackfillItem[]>([
    { key: crypto.randomUUID(), workTypeId: '', workTypeName: '', material: '', width: '', height: '', unit: 'ft', quantity: '1' },
  ]);
  const [backfillSurveyorId, setBackfillSurveyorId] = useState('');
  const [backfillDesignerId, setBackfillDesignerId] = useState('');
  const [backfillProductionId, setBackfillProductionId] = useState('');
  const [backfillInstallerId, setBackfillInstallerId] = useState('');
  const [backfillNote, setBackfillNote] = useState('');
  const [backfillConfirmDuplicate, setBackfillConfirmDuplicate] = useState(false);
  const [backfillSurveyPhotos, setBackfillSurveyPhotos] = useState<File[]>([]);
  const [backfillDesignFiles, setBackfillDesignFiles] = useState<File[]>([]);

  const { data: shop } = useQuery({
    queryKey: ['shop', shopId],
    queryFn: async () => {
      const { data } = await supabase
        .from('shops')
        .select('*, clients(name), projects(name), zones(name), purchase_orders(po_number, fulfillment_type)')
        .eq('id', shopId)
        .maybeSingle();
      return data;
    },
    enabled: !!shopId,
  });

  useEffect(() => {
    if (!shop) return;
    setDetailForm({
      name: shop.name || '', owner_name: shop.owner_name || '', contact_phone: shop.contact_phone || '',
      address: shop.address || '', city: shop.city || '', district: shop.district || '', state: shop.state || '',
      signage_language: shop.signage_language || '',
    });
  }, [shop?.id, shop?.updated_at]);

  const detailUpdateMutation = useMutation({
    mutationFn: async () => {
      if (!detailForm.name.trim()) throw new Error('Shop name is required.');
      const { error } = await supabase.from('shops').update({ ...detailForm, name: detailForm.name.trim() }).eq('id', shopId);
      if (error) throw error;
      await logAudit('shops', shopId, 'update', null, null, null, `Updated shop details: ${detailForm.name}`);
    },
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['shop', shopId] }); queryClient.invalidateQueries({ queryKey: ['shops', orgId] }); setDetailEditOpen(false); },
  });

  const { data: workItems } = useQuery({
    queryKey: ['shop-work-items', shopId],
    queryFn: async () => {
      const { data } = await supabase.from('work_items').select('*').eq('shop_id', shopId).order('created_at');
      return data as WorkItem[];
    },
    enabled: !!shopId,
  });

  // PO line items available for assignment — only fetched once the shop
  // actually has a linked PO, so shops with no PO don't show an empty
  // picker with nothing useful in it.
  const { data: poLineItems } = useQuery({
    queryKey: ['po_line_items', shop?.purchase_order_id],
    queryFn: async () => {
      const { data, error } = await supabase.from('po_line_items').select('*').eq('purchase_order_id', shop!.purchase_order_id).order('created_at');
      if (error) throw error;
      return data as POLineItem[];
    },
    enabled: !!shop?.purchase_order_id,
  });

  const assignLineItemMutation = useMutation({
    mutationFn: async ({ workItemId, poLineItemId }: { workItemId: string; poLineItemId: string | null }) => {
      const { error } = await supabase.from('work_items').update({ po_line_item_id: poLineItemId }).eq('id', workItemId);
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['shop-work-items', shopId] }),
  });

  const saveWorkItemMutation = useMutation({
    mutationFn: async () => {
      if (!editWorkItem) return;
      const width = Number(workItemForm.width), height = Number(workItemForm.height), quantity = Math.max(1, Number(workItemForm.quantity) || 1);
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new Error('Enter valid width and height.');
      const widthFt = toFeet(width, workItemForm.unit), heightFt = toFeet(height, workItemForm.unit);
      const area = Math.round(widthFt * heightFt * quantity * 100) / 100;
      const payload = {
        work_type_name: workItemForm.work_type_name.trim() || null, material: workItemForm.material.trim() || null,
        survey_width: widthFt, survey_height: heightFt, survey_unit: 'ft', survey_quantity: quantity, survey_area: area,
        approved_width: widthFt, approved_height: heightFt, approved_unit: 'ft', approved_quantity: quantity, approved_area: area,
      };
      if (editWorkItem.id === '__new__') {
        const { error } = await supabase.from('work_items').insert({ organization_id: orgId, shop_id: shopId, ...payload, status: 'approved' });
        if (error) throw error;
        await logAudit('work_items', null, 'insert', null, null, null, `Added board/item for ${shop?.name || 'shop'}`);
      } else {
        const { error } = await supabase.from('work_items').update(payload).eq('id', editWorkItem.id);
        if (error) throw error;
        await logAudit('work_items', editWorkItem.id, 'update', null, null, null, `Updated board/item for ${shop?.name || 'shop'}`);
      }
    },
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['shop-work-items', shopId] }); setEditWorkItem(null); },
  });
  const deleteWorkItemMutation = useMutation({
    mutationFn: async (id: string) => { const { error } = await supabase.from('work_items').delete().eq('id', id); if (error) throw error; },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['shop-work-items', shopId] }),
  });

  // BOM / components readiness (Phase 4) — read-only summary here; the
  // checklist itself is edited from Production Studio where the
  // produced-status gate actually lives.
  const workItemIds = (workItems || []).map((w) => w.id);
  const { data: workItemComponents } = useQuery({
    queryKey: ['shop-work-item-components', shopId, workItemIds.join(',')],
    queryFn: async () => {
      if (workItemIds.length === 0) return [] as WorkItemComponent[];
      const { data, error } = await supabase.from('work_item_components').select('*').in('work_item_id', workItemIds).order('created_at');
      if (error) throw error;
      return (data || []) as WorkItemComponent[];
    },
    enabled: workItemIds.length > 0,
  });

  // Survey photos + their marked-board polygons, so the shop page can show
  // exactly what the surveyor drew — same data the exports use.
  const { data: surveyPhotos } = useQuery({
    queryKey: ['shop-survey-photos', shopId],
    queryFn: async () => {
      const { data } = await supabase.from('survey_photos').select('*').eq('shop_id', shopId).order('created_at');
      return data as SurveyPhoto[];
    },
    enabled: !!shopId,
  });

  const uploadDetailPhotos = async () => {
    if (!surveyPhotoUploadFiles.length || !orgId || !profile?.id) return;
    if ((workItems?.length || 0) > 0) {
      const missing = surveyPhotoUploadFiles.findIndex((_, i) => !surveyPhotoFileMap[i]);
      if (missing >= 0) throw new Error(`Map Photo ${missing + 1} to its exact work item before uploading.`);
    }
    setPhotoUploading(true);
    const failures: string[] = [];
    let successCount = 0;
    try {
      let surveyId = surveyPhotoSurveyId || (surveys?.[0]?.id as string | undefined);
      if (!surveyId) {
        const { data: sr, error } = await supabase.from('surveys').insert({ organization_id: orgId, shop_id: shopId, surveyor_id: profile.id, status: 'draft', notes: 'Created from Shop Detail photo manager', submitted_at: null }).select('id').single();
        if (error) throw error; surveyId = sr.id;
      }
      // Intentionally process every selected file independently. One failed file must not stop the remaining queue.
      for (let i = 0; i < surveyPhotoUploadFiles.length; i++) {
        const file = surveyPhotoUploadFiles[i];
        try {
          const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
          const path = `${orgId}/${surveyId}/${Date.now()}-${crypto.randomUUID()}-${i + 1}-${safeName}`;
          const { error: upErr } = await supabase.storage.from('survey-photos').upload(path, file);
          if (upErr) throw upErr;
          const { data: u } = supabase.storage.from('survey-photos').getPublicUrl(path);
          const { data: photo, error: dbErr } = await supabase.from('survey_photos').insert({ organization_id: orgId, survey_id: surveyId, shop_id: shopId, storage_path: path, photo_url: u.publicUrl, photo_type: surveyPhotoType, caption: surveyPhotoCaption.trim() || `Survey photo ${i + 1}` }).select('id').single();
          if (dbErr) { await supabase.storage.from('survey-photos').remove([path]); throw dbErr; }
          const mappedWorkItemId = surveyPhotoFileMap[i];
          if (mappedWorkItemId) {
            // Prefer the semantic link table when the migration is deployed. For older deployments,
            // gracefully fall back to an empty board_marking link so uploads never fail just because
            // PostgREST has not refreshed / the migration has not been applied yet.
            const { error: linkErr } = await supabase.from('survey_photo_items').insert({ organization_id: orgId, survey_photo_id: photo.id, work_item_id: mappedWorkItemId });
            if (linkErr) {
              const missingRelation = /survey_photo_items|schema cache|could not find the table/i.test(linkErr.message || '');
              if (!missingRelation) throw linkErr;
              const { error: fallbackErr } = await supabase.from('board_markings').insert({ organization_id: orgId, survey_photo_id: photo.id, work_item_id: mappedWorkItemId, points: [] });
              if (fallbackErr) throw fallbackErr;
            }
          }
          successCount++;
        } catch (err: any) { failures.push(`Photo ${i + 1} (${file.name}): ${err?.message || 'upload failed'}`); }
      }
      await logAudit('survey_photos', null, 'upload', null, null, null, `Survey photo batch: ${successCount}/${surveyPhotoUploadFiles.length} uploaded for ${shop?.name || 'shop'}`);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['shop-survey-photos', shopId] }),
        queryClient.invalidateQueries({ queryKey: ['shop-survey-photo-items', shopId] }),
        queryClient.invalidateQueries({ queryKey: ['shop-surveys', shopId] }),
      ]);
      if (failures.length) throw new Error(`${successCount} of ${surveyPhotoUploadFiles.length} uploaded. ${failures.join(' | ')}`);
      setSurveyPhotoUploadFiles([]); setSurveyPhotoItemIds(new Set()); setSurveyPhotoFileMap({}); setSurveyPhotoCaption(''); setSurveyPhotoSurveyId(''); setSurveyPhotoTargetItemId(null); setSurveyPhotoUploadOpen(false);
    } finally { setPhotoUploading(false); }
  };
  const deleteDetailPhoto = async (photo: SurveyPhoto) => {
    if (!window.confirm('Delete this survey photo permanently? This cannot be undone.')) return;
    // Remove mapping rows first so this also works on deployments without cascade FKs.
    const { error: linkErr } = await supabase.from('survey_photo_items').delete().eq('survey_photo_id', photo.id);
    if (linkErr && !/survey_photo_items|schema cache|could not find the table/i.test(linkErr.message || '')) throw linkErr;
    await supabase.from('board_markings').delete().eq('survey_photo_id', photo.id);
    const { error } = await supabase.from('survey_photos').delete().eq('id', photo.id);
    if (error) throw error;
    if (photo.storage_path) await supabase.storage.from('survey-photos').remove([photo.storage_path]);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['shop-survey-photos', shopId] }),
      queryClient.invalidateQueries({ queryKey: ['shop-survey-photo-items', shopId] }),
      queryClient.invalidateQueries({ queryKey: ['shop-board-markings', shopId] }),
    ]);
  };

  const deleteInstallationProof = async (proof: any) => {
    if (!window.confirm('Delete this installation photo permanently? This cannot be undone.')) return;
    const { error } = await supabase.from('installation_proofs').delete().eq('id', proof.id);
    if (error) throw error;
    if (proof.storage_path) await supabase.storage.from('installation-proof').remove([proof.storage_path]);
    await queryClient.invalidateQueries({ queryKey: ['shop-installations', shopId] });
  };

  const { data: surveyPhotoItems } = useQuery({
    queryKey: ['shop-survey-photo-items', shopId, (surveyPhotos || []).map((p) => p.id).join(',')],
    queryFn: async () => {
      const photoIds = (surveyPhotos || []).map((p) => p.id);
      if (!photoIds.length) return [] as { survey_photo_id: string; work_item_id: string }[];
      const { data, error } = await supabase.from('survey_photo_items').select('survey_photo_id,work_item_id').in('survey_photo_id', photoIds);
      if (error) {
        if (/survey_photo_items|schema cache|could not find the table/i.test(error.message || '')) return [] as { survey_photo_id: string; work_item_id: string }[];
        throw error;
      }
      return (data || []) as { survey_photo_id: string; work_item_id: string }[];
    },
    enabled: !!surveyPhotos,
  });

  const { data: boardMarkings } = useQuery({
    queryKey: ['shop-board-markings', shopId, surveyPhotos],
    queryFn: async () => {
      const photoIds = (surveyPhotos || []).map((p) => p.id);
      if (photoIds.length === 0) return [] as BoardMarking[];
      const { data } = await supabase.from('board_markings').select('*').in('survey_photo_id', photoIds);
      return data as BoardMarking[];
    },
    enabled: !!surveyPhotos,
  });

  const { data: surveys } = useQuery({
    queryKey: ['shop-surveys', shopId],
    queryFn: async () => {
      const { data } = await supabase
        .from('surveys')
        .select('*, profiles(full_name)')
        .eq('shop_id', shopId)
        .order('created_at', { ascending: false });
      return data;
    },
    enabled: !!shopId,
  });

  const { data: designTasks } = useQuery({
    queryKey: ['shop-design-tasks', shopId],
    queryFn: async () => {
      const { data } = await supabase
        .from('design_tasks')
        .select('*, profiles(full_name), design_versions(*, design_version_items(work_item_id))')
        .eq('shop_id', shopId)
        .order('created_at', { ascending: false });
      return data;
    },
    enabled: !!shopId,
  });

  const { data: productionOrders } = useQuery({
    queryKey: ['shop-production', shopId],
    queryFn: async () => {
      const { data } = await supabase.from('production_orders').select('*').eq('shop_id', shopId).order('created_at', { ascending: false });
      return data;
    },
    enabled: !!shopId,
  });

  const { data: installations } = useQuery({
    queryKey: ['shop-installations', shopId],
    queryFn: async () => {
      const { data } = await supabase
        .from('installation_jobs')
        .select('*, profiles(full_name), installation_proofs(*)')
        .eq('shop_id', shopId)
        .order('created_at', { ascending: false });
      return data;
    },
    enabled: !!shopId,
  });

  const { data: assignments } = useQuery({
    queryKey: ['shop-assignments', shopId],
    queryFn: async () => {
      const { data } = await supabase
        .from('shop_assignments')
        .select('*, profiles(full_name, role)')
        .eq('shop_id', shopId)
        .order('assigned_at', { ascending: false });
      return data;
    },
    enabled: !!shopId,
  });

  // Backfill is an EDIT/RECOVERY form as well as a create form. When an
  // existing shop opens it, hydrate every field we can from the database
  // instead of presenting a blank form that makes admins retype known data.
  useEffect(() => {
    if (!backfillOpen || !shop) return;
    if (workItems && workItems.length > 0) {
      setBackfillItems(workItems.map((w) => ({
        key: w.id || crypto.randomUUID(),
        workTypeId: w.work_type_id || '', workTypeName: w.work_type_name || '', material: w.material || '',
        width: String(w.approved_width ?? w.survey_width ?? ''),
        height: String(w.approved_height ?? w.survey_height ?? ''),
        unit: w.approved_unit || w.survey_unit || 'ft',
        quantity: String(w.approved_quantity ?? w.survey_quantity ?? 1),
      })));
    }
    const st = String(shop.status || '');
    setBackfillStage(st === 'dispatched' ? 'dispatched' :
      ['production_ready','production_done','installation_pending','installing','installation_review','installed','billed'].includes(st) ? 'production_done' :
      ['design_ready','in_review','design_approved','production_pending','in_production'].includes(st) ? 'production_pending' : 'design_pending');
    const surveyor = (assignments || []).find((a) => a.role === 'surveyor' && a.status !== 'declined');
    const installer = (assignments || []).find((a) => a.role === 'installer' && a.status !== 'declined');
    setBackfillSurveyorId(surveyor?.user_id || surveys?.[0]?.surveyor_id || '');
    setBackfillInstallerId(installer?.user_id || installations?.[0]?.installer_id || '');
    setBackfillDesignerId(designTasks?.[0]?.designer_id || '');
    setBackfillProductionId(productionOrders?.[0]?.assigned_to || '');
    setBackfillNote(surveys?.[0]?.notes || designTasks?.[0]?.notes || productionOrders?.[0]?.notes || '');
  }, [backfillOpen, shopId]);

  // People-pickers + work types for the Backfill form — one query per
  // role, only fetched once the panel is actually open.
  const { data: backfillPeople } = useQuery({
    queryKey: ['org-people-all-roles', orgId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, full_name, role')
        .eq('organization_id', orgId)
        .in('role', ['surveyor', 'designer', 'printing', 'installer'])
        .eq('is_active', true)
        .order('full_name');
      if (error) throw new Error(`Could not load team members: ${error.message}`);
      return data as { id: string; full_name: string; role: string }[];
    },
    enabled: !!orgId && backfillOpen,
  });
  const { data: backfillWorkTypes } = useQuery({
    queryKey: ['org-work-types', orgId],
    queryFn: async () => {
      const { data, error } = await supabase.from('work_types').select('id, name').eq('organization_id', orgId).eq('is_active', true).order('name');
      if (error) throw new Error(`Could not load work types: ${error.message}`);
      return data as { id: string; name: string }[];
    },
    enabled: !!orgId && backfillOpen,
  });

  // Guardrail: this tool inserts a brand-new survey/design_task/
  // production_order — it's built for shops that have NOTHING in the app
  // yet. If any of those already exist (survey done through the real
  // Survey Review flow, say), running it again would create a second,
  // duplicate set of pipeline records rather than filling a gap. Detected
  // here so the form can warn instead of silently doubling things up.
  const shopHasExistingPipelineData = (surveys && surveys.length > 0) || (designTasks && designTasks.length > 0) || (productionOrders && productionOrders.length > 0);

  const backfillMutation = useMutation({
    mutationFn: async () => {
      if (!shop || !profile || !orgId) throw new Error('Shop not loaded yet — try again in a moment.');
      if (shopHasExistingPipelineData) {
        // Existing pipeline = EDIT mode. Never create a second survey/design/
        // production chain. Update the already-known boards in place and add
        // only genuinely new board rows.
        const desiredStatus = backfillStage === 'dispatched' ? 'dispatched' : backfillStage === 'production_done' ? 'production_ready' : backfillStage === 'production_pending' ? 'production_pending' : 'design_pending';
        for (const it of backfillItems) {
          if (!it.width.trim() || !it.height.trim() || !it.quantity.trim()) continue;
          const width = Number(it.width), height = Number(it.height), quantity = Math.max(1, Number(it.quantity) || 1);
          const widthFt = toFeet(width, it.unit), heightFt = toFeet(height, (it as any).heightUnit || it.unit); const area = Math.round(widthFt * heightFt * quantity * 100) / 100;
          const payload: any = { work_type_id: it.workTypeId || null, work_type_name: it.workTypeName.trim() || null, material: it.material.trim() || null, survey_width: widthFt, survey_height: heightFt, survey_unit: 'ft', survey_quantity: quantity, survey_area: area, approved_width: widthFt, approved_height: heightFt, approved_unit: 'ft', approved_quantity: quantity, approved_area: area };
          if (backfillStage === 'production_done' || backfillStage === 'dispatched') { payload.produced_quantity = quantity; payload.produced_at = new Date().toISOString(); }
          const exists = (workItems || []).some((w) => w.id === it.key);
          const q = exists ? supabase.from('work_items').update(payload).eq('id', it.key) : supabase.from('work_items').insert({ organization_id: orgId, shop_id: shopId, status: backfillStage === 'design_pending' ? 'approved' : backfillStage === 'production_pending' ? 'design_approved' : 'production_done', ...payload });
          const { error } = await q; if (error) throw error;
        }
        const { error: shopUpdateError } = await supabase.from('shops').update({ status: desiredStatus }).eq('id', shopId); if (shopUpdateError) throw shopUpdateError;
        await logAudit('shops', shopId, 'update', 'backfill', null, backfillStage, `Updated existing backfill data for ${shop.name}`);
        return;
      }
      await runBackfillPipeline({
        orgId, shopId, shopName: shop.name, shopStatusBefore: shop.status, actorId: profile.id,
        stage: backfillStage, items: backfillItems, surveyorId: backfillSurveyorId, designerId: backfillDesignerId,
        productionId: backfillProductionId, installerId: backfillInstallerId, note: backfillNote,
        workTypes: backfillWorkTypes || [], existingAssignments: assignments || [],
        surveyPhotos: backfillSurveyPhotos, designFiles: backfillDesignFiles,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['shop', shopId] });
      queryClient.invalidateQueries({ queryKey: ['shop-work-items', shopId] });
      queryClient.invalidateQueries({ queryKey: ['shop-surveys', shopId] });
      queryClient.invalidateQueries({ queryKey: ['shop-survey-photos', shopId] });
      queryClient.invalidateQueries({ queryKey: ['shop-design-tasks', shopId] });
      queryClient.invalidateQueries({ queryKey: ['shop-production', shopId] });
      queryClient.invalidateQueries({ queryKey: ['shop-assignments', shopId] });
      queryClient.invalidateQueries({ queryKey: ['shop-design-tasks', shopId] });
      queryClient.invalidateQueries({ queryKey: ['shops', orgId] });
      queryClient.invalidateQueries({ queryKey: ['installer-assignments'] });
      queryClient.invalidateQueries({ queryKey: ['installer-work'] });
      setBackfillOpen(false);
      setBackfillItems([{ key: crypto.randomUUID(), workTypeId: '', workTypeName: '', material: '', width: '', height: '', unit: 'ft', quantity: '1' }]);
      setBackfillSurveyorId(''); setBackfillDesignerId(''); setBackfillProductionId(''); setBackfillInstallerId('');
      setBackfillNote(''); setBackfillConfirmDuplicate(false); setBackfillStage('production_done');
      setBackfillSurveyPhotos([]); setBackfillDesignFiles([]);
    },
  });

  // Surveyors/installers to assign — previously there was no screen
  // anywhere in the app to create a `shop_assignments` row, so a new shop
  // could never actually get a surveyor or installer without someone
  // inserting a row directly in the database (easy to fat-finger, e.g.
  // assigning the same person twice, which is exactly what shows up as
  // duplicate rows here). This is the one place it now happens in-app.
  const { data: fieldWorkers } = useQuery({
    queryKey: ['org-field-workers', orgId],
    queryFn: async () => {
      const { data } = await supabase
        .from('profiles')
        .select('id, full_name, role')
        .eq('organization_id', orgId)
        .in('role', ['surveyor', 'installer', 'designer'])
        .eq('is_active', true)
        .order('full_name');
      return data as { id: string; full_name: string; role: string }[];
    },
    enabled: !!orgId && !!assignModal,
  });

  const assignMutation = useMutation({
    mutationFn: async () => {
      if (!assignUserId || !assignModal || !shop) throw new Error('Pick a person to assign first.');

      // Designers are owned by design_tasks rather than shop_assignments.
      // Keep one canonical task per shop and update/reassign it here so the
      // Shop Detail page can manage the complete workflow without a detour.
      if (assignModal === 'designer') {
        const existingTask = designTasks?.[0];
        if (existingTask) {
          const { error } = await supabase.from('design_tasks').update({ designer_id: assignUserId }).eq('id', existingTask.id).select('id');
          if (error) throw new Error(`Could not assign designer: ${error.message}`);
        } else {
          const { error } = await supabase.from('design_tasks').insert({
            organization_id: orgId, shop_id: shopId, designer_id: assignUserId, status: 'assigned'
          });
          if (error) throw new Error(`Could not create design task: ${error.message}`);
        }
        const worker = (fieldWorkers || []).find((w) => w.id === assignUserId);
        await logAudit('design_tasks', existingTask?.id || null, existingTask ? 'reassign' : 'insert', 'designer_id', existingTask?.designer_id || null, assignUserId, `Assigned ${worker?.full_name || 'designer'} to ${shop.name}`);
        await createNotification(assignUserId, 'New Design Task', `You've been assigned to design ${shop.name}`, 'info', '/design');
        return;
      }

      // Guard against assigning the same person to the same role on this
      // shop twice (the exact "Rahul Patil listed twice" symptom) — if an
      // active (non-declined) assignment already exists for this
      // shop+user+role, just tell the person instead of inserting a
      // duplicate row.
      const dup = (assignments || []).find(
        (a) => a.user_id === assignUserId && a.role === assignModal && a.status !== 'declined'
      );
      if (dup) throw new Error('This person is already assigned to this role on this shop.');

      // This button doubles as "Reassign" — clicking it again with a
      // different person is how an Admin/Owner hands the shop's surveyor
      // or installer over to someone else. Whoever was actively holding
      // that role before (status 'assigned', not yet completed) needs to
      // be taken off it now, otherwise the old person keeps this shop in
      // their own queue and workload count forever, and this exact
      // Assignments list keeps showing both of them — which is what made
      // a reassign look like it wasn't reflecting for the new person.
      const previousHolders = (assignments || []).filter(
        (a) => a.role === assignModal && a.user_id !== assignUserId && a.status === 'assigned'
      );
      for (const prev of previousHolders) {
        const { error: supersedeError } = await supabase
          .from('shop_assignments')
          .update({ status: 'declined' })
          .eq('id', prev.id);
        if (supersedeError) throw new Error(`Could not remove previous ${assignModal}: ${supersedeError.message}`);
      }

      const { error: insertError } = await supabase.from('shop_assignments').insert({
        organization_id: orgId,
        shop_id: shopId,
        user_id: assignUserId,
        role: assignModal,
        status: 'assigned',
      });
      if (insertError) throw new Error(`Could not assign: ${insertError.message}`);

      // A fresh surveyor assignment on a shop that hasn't been surveyed yet
      // moves it out of 'pending' so it shows up on the surveyor's queue.
      if (assignModal === 'surveyor' && shop.status === 'pending') {
        const { error: shopError } = await supabase.from('shops').update({ status: 'assigned' }).eq('id', shopId).select('id');
        if (shopError) throw new Error(`Assigned, but could not update shop status: ${shopError.message}`);
      }

      const worker = (fieldWorkers || []).find((w) => w.id === assignUserId);
      const action = previousHolders.length > 0 ? 'reassign' : 'insert';
      const logMessage = previousHolders.length > 0
        ? `Reassigned ${assignModal} for ${shop.name} to ${worker?.full_name || 'user'}`
        : `Assigned ${worker?.full_name || 'user'} as ${assignModal} for ${shop.name}`;
      await logAudit('shop_assignments', null, action, 'role', null, assignModal, logMessage);
      await createNotification(assignUserId, 'New Assignment', `You've been assigned as ${assignModal} for ${shop.name}`, 'info', assignModal === 'surveyor' ? '/survey' : undefined);
      for (const prev of previousHolders) {
        await createNotification(
          prev.user_id,
          'Reassigned',
          `You've been reassigned off ${shop.name} as ${assignModal} — it now belongs to ${worker?.full_name || 'someone else'}.`,
          'info'
        );
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['shop-assignments', shopId] });
      queryClient.invalidateQueries({ queryKey: ['shop', shopId] });
      // The person who just got reassigned off this shop is on a
      // completely different screen (their own Surveyor/Installer
      // dashboard), so their query cache needs invalidating from here —
      // otherwise Realtime/polling eventually catches it, but not
      // instantly, and it can look like the reassignment "didn't take".
      queryClient.invalidateQueries({ queryKey: ['surveyor-assignments'] });
      queryClient.invalidateQueries({ queryKey: ['installer-assignments'] });
      queryClient.invalidateQueries({ queryKey: ['installer-work'] });
      queryClient.invalidateQueries({ queryKey: ['team-workload-drilldown'] });
      setAssignModal(null);
      setAssignUserId('');
    },
  });

  const uploadDesignMutation = useMutation({
    mutationFn: async () => {
      if (!profile?.id || !orgId) throw new Error('You must be signed in.');
      if (designUploadFiles.length === 0) throw new Error('Choose at least one design file.');
      if ((workItems?.length || 0) > 0) {
        const missing = designUploadFiles.findIndex((_, i) => !designUploadFileMap[i]);
        if (missing >= 0) throw new Error(`Map Design ${missing + 1} to its exact work item before uploading.`);
      }
      let task = designTasks?.[0];
      if (!task) {
        const { data, error } = await supabase.from('design_tasks').insert({ organization_id: orgId, shop_id: shopId, status: 'designing' }).select('*').single();
        if (error) throw new Error(`Could not create design task: ${error.message}`); task = data;
      }
      const startVersion = task.design_versions?.length || 0;
      const failures: string[] = []; let successCount = 0;
      for (let i = 0; i < designUploadFiles.length; i++) {
        const file = designUploadFiles[i];
        try {
          const versionNumber = startVersion + i + 1;
          const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
          const path = `${orgId}/${task.id}/v${versionNumber}-${crypto.randomUUID()}-${safeName}`;
          const { error: storageError } = await supabase.storage.from('design-files').upload(path, file);
          if (storageError) throw storageError;
          const { data: urlData } = supabase.storage.from('design-files').getPublicUrl(path);
          const { data: version, error: versionError } = await supabase.from('design_versions').insert({ organization_id: orgId, design_task_id: task.id, version_number: versionNumber, storage_path: path, file_url: urlData.publicUrl, file_name: file.name, uploaded_by: profile.id, notes: designUploadNotes || null, status: 'uploaded', source: 'admin' }).select('id').single();
          if (versionError) { await supabase.storage.from('design-files').remove([path]); throw versionError; }
          const workItemId = designUploadFileMap[i];
          if (workItemId) {
            const { error: linkError } = await supabase.from('design_version_items').insert({ organization_id: orgId, design_version_id: version.id, work_item_id: workItemId });
            if (linkError) throw linkError;
            await supabase.from('work_items').update({ status: 'designed' }).eq('id', workItemId).in('status', ['approved', 'designing']);
          }
          successCount++;
        } catch (err: any) { failures.push(`Design ${i + 1} (${file.name}): ${err?.message || 'upload failed'}`); }
      }
      if (successCount) await supabase.from('design_tasks').update({ status: 'design_ready' }).eq('id', task.id);
      await logAudit('design_versions', null, 'upload', null, null, null, `Design batch: ${successCount}/${designUploadFiles.length} uploaded for ${shop?.name || 'shop'}`);
      if (failures.length) throw new Error(`${successCount} of ${designUploadFiles.length} uploaded. ${failures.join(' | ')}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['shop-design-tasks', shopId] });
      queryClient.invalidateQueries({ queryKey: ['shop-work-items', shopId] });
      setDesignUploadOpen(false); setDesignUploadTargetItemId(null); setDesignUploadFiles([]); setDesignUploadItemIds(new Set()); setDesignUploadFileMap({}); setDesignUploadNotes('');
    },
  });

  // The Shop Detail page pulls from 7+ tables (survey, design, production,
  // installation, assignments...) — without this, an Admin sitting on this
  // exact page while a designer approves or a production order completes
  // elsewhere would see a stale Timeline until they refreshed.
  useRealtimeInvalidate(
    ['shops', 'surveys', 'work_items', 'design_tasks', 'design_versions', 'production_orders', 'installation_jobs', 'shop_assignments'],
    orgId,
    [
      ['shop', shopId], ['shop-work-items', shopId], ['shop-survey-photos', shopId],
      ['shop-surveys', shopId], ['shop-design-tasks', shopId], ['shop-production', shopId],
      ['shop-installations', shopId], ['shop-assignments', shopId],
    ]
  );

  // Timeline model — instead of a flat done/not-done boolean per step, each
  // step carries a real status (done / current / issue / pending) so a
  // rejected survey, a correction request, an installation exception, or a
  // redo-rejection actually shows up as a problem on the timeline instead
  // of just sitting there unmarked and looking identical to "not reached
  // yet". Dates are pulled from the specific record that earned that step
  // (falling back to `updated_at` where the app never sets a dedicated
  // `completed_at`, e.g. design_tasks).
  //
  // IMPORTANT: a step's "done" state is never decided from the detail
  // tables (surveys / installation_jobs / ...) alone. Those rows can be
  // missing or incomplete for reasons that have nothing to do with the
  // shop's real progress — legacy/seeded data, a review column added by a
  // later migration that never got backfilled onto older rows, etc. — and
  // when that happens the shop is genuinely done (work items fully
  // installed, `shops.status` already at 'installed') while the Timeline
  // still shows early steps as "pending" forever. `shops.status` is the
  // one field every approval gate in the DB actually enforces (see the
  // trigger functions in the 0011/0013/0014 migrations), so it's used
  // here as the source of truth for whether a step has been reached; the
  // detail tables are only used to fill in the exact date/note, and to
  // surface problems (rejections, exceptions) that the status alone
  // wouldn't show.
  const SHOP_STATUS_ORDER = [
    'pending', 'assigned', 'survey_started', 'surveyed', 'approval_pending', 'approved',
    'design_pending', 'designing', 'design_ready', 'in_review', 'design_approved',
    'production_pending', 'in_production', 'production_ready', 'production_hold', 'production_done',
    'dispatched', 'installation_pending', 'installing', 'installation_review', 'installed', 'billed',
  ];
  const shopStatusIdx = shop ? SHOP_STATUS_ORDER.indexOf(shop.status) : -1;
  // Once a shop is reached (or passed) a given pipeline status, every step
  // gated at or before that status counts as done — regardless of whether
  // the detail-table row that would normally prove it is present.
  const reached = (status: string) => shopStatusIdx >= 0 && shopStatusIdx >= SHOP_STATUS_ORDER.indexOf(status);

  const activeAssignment = assignments?.find((a) => a.status !== 'declined');
  const latestSurvey = surveys?.[0]; // surveys query is ordered created_at desc; one row per shop
  const approvedSurvey = surveys?.find((s) => s.status === 'approved');
  // An issue only still counts as "blocking" if the shop hasn't since moved
  // past it (e.g. a rejected survey that was later corrected and approved,
  // or seed/legacy data where the shop is already further along).
  const surveyHasIssue = !!latestSurvey && !approvedSurvey && !reached('approved')
    && (latestSurvey.status === 'rejected' || latestSurvey.status === 'correction_requested');

  const designDone = designTasks?.find((d) => d.status === 'approved' || d.status === 'ready_for_production');
  const productionDone = productionOrders?.find((p) => p.status === 'completed');

  // Same gap as the Timeline: the Survey and Installation cards below read
  // straight from `surveys` / `installation_jobs`, so a shop whose survey
  // or install genuinely happened but never got its own row there (see
  // note above `reached`) shows "No surveys/installation jobs yet" even
  // though the work items and assignment history prove otherwise. These
  // give the cards something real to fall back to instead of a blank
  // "not done" state.
  const surveyorAssignment = assignments?.find((a) => a.role === 'surveyor' && a.status !== 'declined');
  const installerAssignment = assignments?.find((a) => a.role === 'installer' && a.status !== 'declined');
  const workItemsSurveyed = (workItems || []).some((w) => w.survey_width != null);
  const workItemsApproved = (workItems || []).some((w) => w.approved_width != null);
  const workItemsInstalled = (workItems || []).some((w) => w.installed_width != null);

  const installedApproved = installations?.find((i) => i.review_status === 'approved');
  const installationRejected = installations?.find((i) => i.review_status === 'rejected') && !reached('installed');
  const installationException = installations?.find((i) => i.status === 'exception') && !reached('installation_review');
  const installationSubmitted = installations?.find((i) => i.status === 'completed');

  type StepStatus = 'done' | 'current' | 'issue' | 'pending';
  interface TimelineStep { label: string; date?: string | null; status: StepStatus; note?: string | null }

  const assignedDone = !!activeAssignment || reached('assigned');
  const surveySubmittedDone = !!latestSurvey?.submitted_at || reached('surveyed');
  const surveyApprovedDone = !!approvedSurvey || reached('approved');
  const designReadyDone = !!designDone || reached('design_ready');
  const productionDoneDone = !!productionDone || reached('production_done');
  const installationSubmittedDone = !!installationSubmitted || reached('installation_review');
  const installedApprovedDone = !!installedApproved || shop?.status === 'installed' || shop?.status === 'billed';

  const timeline: TimelineStep[] = [
    { label: 'Created', date: shop?.created_at, status: 'done' },
    {
      label: 'Assigned',
      date: activeAssignment?.assigned_at,
      status: assignedDone ? 'done' : 'pending',
    },
    {
      label: 'Survey Submitted',
      date: latestSurvey?.submitted_at,
      status: surveySubmittedDone ? (surveyHasIssue ? 'issue' : 'done') : 'pending',
      note: surveyHasIssue ? (latestSurvey!.status === 'rejected' ? 'Survey rejected' : 'Correction requested') : null,
    },
    {
      label: 'Survey Approved',
      date: approvedSurvey?.reviewed_at,
      status: surveyApprovedDone ? 'done' : surveyHasIssue ? 'issue' : 'pending',
    },
    {
      label: 'Design Ready',
      date: designDone?.completed_at || designDone?.updated_at,
      status: designReadyDone ? 'done' : 'pending',
    },
    {
      label: 'Production Done',
      date: productionDone?.updated_at,
      status: productionDoneDone ? 'done' : 'pending',
    },
    {
      label: 'Installation Submitted',
      date: installationSubmitted?.completed_at,
      status: installationSubmittedDone ? 'done' : installationException ? 'issue' : 'pending',
      note: installationException ? `Exception: ${installations?.find((i) => i.status === 'exception')?.exception_reason || 'reported'}` : null,
    },
    {
      label: 'Installed (Approved)',
      date: installedApproved?.reviewed_at,
      status: installedApprovedDone ? 'done' : installationRejected ? 'issue' : 'pending',
      note: installationRejected ? 'Sent back for redo' : null,
    },
  ];

  // Highlight the first not-yet-reached step as the shop's "current" stage
  // — but only if nothing upstream is blocked on an issue, since a step
  // after a rejection isn't really "in progress" yet.
  const firstIssueIdx = timeline.findIndex((s) => s.status === 'issue');
  const firstPendingIdx = timeline.findIndex((s) => s.status === 'pending');
  if (firstPendingIdx !== -1 && (firstIssueIdx === -1 || firstPendingIdx < firstIssueIdx)) {
    timeline[firstPendingIdx] = { ...timeline[firstPendingIdx], status: 'current' };
  }

  if (!shop) return <div className="p-8 text-center text-slate-400">Loading shop...</div>;

  return (
    <div>
      <Link to="/shops" className="inline-flex items-center gap-2 text-sm text-slate-500 hover:text-slate-700 mb-4">
        <ArrowLeft className="w-4 h-4" /> Back to Shops
      </Link>

      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">{shop.name}</h1>
          <p className="text-sm text-slate-500 mt-1">{shop.clients?.name} - {shop.projects?.name || 'No project'}</p>
        </div>
        <div className="flex items-center gap-2">
          {canCrudShop && <button onClick={() => setDetailEditOpen(true)} className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium border border-slate-200 rounded-lg bg-white hover:bg-slate-50"><Pencil className="w-4 h-4" /> Edit Shop</button>}
          <StatusBadge status={shop.status} />
        </div>
      </div>

      {/* Timeline */}
      <Card className="p-4 mb-4">
        <h2 className="text-sm font-semibold text-slate-900 mb-3">Workflow Timeline</h2>
        <div className="flex items-start overflow-x-auto pb-2">
          {timeline.map((step, i) => (
            <div key={i} className="flex items-start flex-shrink-0">
              <div className="flex flex-col items-center w-24">
                <div
                  className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 ${
                    step.status === 'done'
                      ? 'bg-green-500 text-white'
                      : step.status === 'issue'
                      ? 'bg-red-500 text-white'
                      : step.status === 'current'
                      ? 'bg-white text-blue-600 border-2 border-blue-500 ring-4 ring-blue-100'
                      : 'bg-slate-200 text-slate-400'
                  }`}
                >
                  {step.status === 'done' && <CheckCircle2 className="w-5 h-5" />}
                  {step.status === 'issue' && <XCircle className="w-5 h-5" />}
                  {step.status === 'current' && <Clock className="w-4 h-4" />}
                  {step.status === 'pending' && i + 1}
                </div>
                <p
                  className={`text-xs mt-2 text-center ${
                    step.status === 'done'
                      ? 'text-slate-700 font-medium'
                      : step.status === 'issue'
                      ? 'text-red-600 font-medium'
                      : step.status === 'current'
                      ? 'text-blue-600 font-medium'
                      : 'text-slate-400'
                  }`}
                >
                  {step.label}
                </p>
                {step.date && (step.status === 'done' || step.status === 'issue') && (
                  <p className="text-[11px] text-slate-400">{new Date(step.date).toLocaleDateString('en-IN')}</p>
                )}
                {step.note && (
                  <p className={`text-[11px] mt-0.5 text-center leading-tight ${step.status === 'issue' ? 'text-red-500' : 'text-amber-600'}`}>
                    {step.note}
                  </p>
                )}
              </div>
              {i < timeline.length - 1 && (
                <div className={`h-0.5 w-8 mt-5 shrink-0 ${step.status === 'done' ? 'bg-green-500' : step.status === 'issue' ? 'bg-red-300' : 'bg-slate-200'}`} />
              )}
            </div>
          ))}
        </div>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Shop Info */}
        <Card className="p-4">
          <h2 className="text-lg font-semibold text-slate-900 mb-4 flex items-center gap-2">
            <Store className="w-5 h-5 text-blue-600" /> Shop Information
          </h2>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between"><span className="text-slate-500">Owner:</span><span className="text-slate-900">{shop.owner_name || 'N/A'}</span></div>
            {shop.signage_language && (
              <div className="flex justify-between"><span className="text-slate-500">Signage Language:</span><span className="text-slate-900">{shop.signage_language}</span></div>
            )}
            <div className="flex justify-between"><span className="text-slate-500">Phone:</span><span className="text-slate-900">{shop.contact_phone || 'N/A'}</span></div>
            <div className="flex justify-between"><span className="text-slate-500">Address:</span><span className="text-slate-900 text-right">{shop.address || 'N/A'}</span></div>
            <div className="flex justify-between"><span className="text-slate-500">City:</span><span className="text-slate-900">{shop.city || 'N/A'}</span></div>
            <div className="flex justify-between"><span className="text-slate-500">District:</span><span className="text-slate-900">{shop.district || 'N/A'}</span></div>
            <div className="flex justify-between"><span className="text-slate-500">Zone:</span><span className="text-slate-900">{shop.zones?.name || shop.zone || 'N/A'}</span></div>
            <div className="flex justify-between"><span className="text-slate-500">Purchase Order:</span><span className="text-slate-900">{shop.purchase_orders?.po_number || 'Not linked'}</span></div>
            <div className="flex justify-between"><span className="text-slate-500">State:</span><span className="text-slate-900">{shop.state || 'N/A'}</span></div>
            <div className="flex justify-between"><span className="text-slate-500">GPS:</span><span className="text-slate-900">{shop.latitude ? `${shop.latitude.toFixed(4)}, ${shop.longitude?.toFixed(4)}` : 'N/A'}</span></div>
          </div>

          {shop.extra_details && Object.keys(shop.extra_details).length > 0 && (
            <div className="mt-5 pt-4 border-t border-slate-100">
              <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Additional Details</h3>
              <div className="space-y-2 text-sm">
                {Object.entries(shop.extra_details).map(([k, v]) => (
                  <div key={k} className="flex justify-between gap-3">
                    <span className="text-slate-500 shrink-0">{k}:</span>
                    <span className="text-slate-900 text-right">{String(v)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </Card>

        {/* Assignments */}
        <Card className="p-4">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-slate-900 flex items-center gap-2">
              <Users className="w-5 h-5 text-blue-600" /> Assignments
            </h2>
            {canAssign && (
              <div className="flex gap-2">
                <button
                  onClick={() => { setAssignModal('surveyor'); setAssignUserId(''); }}
                  className="flex items-center gap-1 text-xs font-medium text-blue-600 border border-blue-200 bg-blue-50 px-2.5 py-1 rounded-lg"
                >
                  <UserPlus className="w-3.5 h-3.5" /> Surveyor
                </button>
                <button
                  onClick={() => { setAssignModal('installer'); setAssignUserId(''); }}
                  className="flex items-center gap-1 text-xs font-medium text-teal-600 border border-teal-200 bg-teal-50 px-2.5 py-1 rounded-lg"
                >
                  <UserPlus className="w-3.5 h-3.5" /> Installer
                </button>
                <button
                  onClick={() => { setAssignModal('designer'); setAssignUserId(designTasks?.[0]?.designer_id || ''); }}
                  className="flex items-center gap-1 text-xs font-medium text-violet-600 border border-violet-200 bg-violet-50 px-2.5 py-1 rounded-lg"
                >
                  <Palette className="w-3.5 h-3.5" /> Designer
                </button>
              </div>
            )}
          </div>
          {assignments && assignments.length > 0 ? (
            <div className="space-y-3">
              {assignments.map((a) => (
                <div key={a.id} className="flex items-center justify-between text-sm">
                  <div>
                    <p className="text-slate-900 font-medium">{a.profiles?.full_name}</p>
                    <p className="text-xs text-slate-500 capitalize">{a.role}</p>
                  </div>
                  <StatusBadge status={a.status} />
                </div>
              ))}
            </div>
          ) : <p className="text-sm text-slate-400">No surveyor / installer assignments yet</p>}
          {designTasks?.[0] && (
            <div className="mt-3 pt-3 border-t border-slate-100 flex items-center justify-between text-sm">
              <div><p className="text-slate-900 font-medium">{designTasks[0].profiles?.full_name || 'Unassigned'}</p><p className="text-xs text-slate-500">Designer</p></div>
              <StatusBadge status={designTasks[0].status} />
            </div>
          )}
        </Card>

        {/* Backfill — Owner/Admin entering work that's already done
            outside the app (survey/design/production happened on paper
            or another system before this shop existed here). Only
            offered up to the point production actually finishes —
            Installation itself always runs through the real
            Installer flow, never backfilled, since that's the step
            that's actually left to do. */}
        {canAssign && shop && !BACKFILL_INELIGIBLE_STATUSES.includes(shop.status) && (
          <Card className="p-6 border-amber-200 bg-amber-50/40">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold text-slate-900 flex items-center gap-2">
                  <FastForward className="w-5 h-5 text-amber-600" /> Backfill Completed Work
                </h2>
                <p className="text-xs text-slate-500 mt-1 max-w-md">
                  Already surveyed / designed / produced outside the app? Fill in what's already
                  done here — the shop lands at the right stage and only Installation is left to run normally.
                </p>
              </div>
              <button
                onClick={() => setBackfillOpen(true)}
                className="shrink-0 flex items-center gap-1 text-xs font-medium text-amber-700 border border-amber-300 bg-white px-2.5 py-1.5 rounded-lg"
              >
                <FastForward className="w-3.5 h-3.5" /> Backfill
              </button>
            </div>
          </Card>
        )}

        {/* Work Items */}
        <Card className="p-4 lg:col-span-2">
          <div className="flex items-center justify-between mb-3"><h2 className="text-base font-semibold text-slate-900 flex items-center gap-2">
            <Ruler className="w-5 h-5 text-blue-600" /> Work Items ({workItems?.length || 0})
          </h2>{canCrudShop && <div className="flex flex-wrap items-center gap-2"><button onClick={() => { setSurveyPhotoTargetItemId(null); setSurveyPhotoUploadFiles([]); setSurveyPhotoFileMap({}); setSurveyPhotoSurveyId(surveys?.[0]?.id || ''); setSurveyPhotoUploadOpen(true); }} className="inline-flex items-center gap-1 text-xs font-medium text-blue-700 border border-blue-200 bg-blue-50 px-2.5 py-1.5 rounded-lg"><UploadCloud className="w-3.5 h-3.5" /> Bulk survey</button><button onClick={() => { setDesignUploadTargetItemId(null); setDesignUploadFiles([]); setDesignUploadFileMap({}); setDesignUploadItemIds(new Set()); setDesignUploadOpen(true); }} className="inline-flex items-center gap-1 text-xs font-medium text-violet-700 border border-violet-200 bg-violet-50 px-2.5 py-1.5 rounded-lg"><Palette className="w-3.5 h-3.5" /> Bulk designs</button><button onClick={() => { setEditWorkItem({ id: '__new__' } as WorkItem); setWorkItemForm({ work_type_name: '', material: '', width: '', height: '', unit: 'ft', quantity: '1' }); }} className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 border border-blue-200 bg-blue-50 px-2.5 py-1.5 rounded-lg"><Plus className="w-3.5 h-3.5" /> Add item</button></div>}</div>
          {workItems && workItems.length > 0 ? (
            <div className="space-y-3">
              {workItems.map((item) => (
                <div key={item.id} className="border border-slate-200 rounded-lg p-3">
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-medium text-slate-900 text-sm">{item.work_type_name || 'Work Item'}</span>
                    <div className="flex items-center gap-2">
                      {canCrudShop && <button title="Edit item" onClick={() => { setEditWorkItem(item); setWorkItemForm({ work_type_name: item.work_type_name || '', material: item.material || '', width: String(item.approved_width ?? item.survey_width ?? ''), height: String(item.approved_height ?? item.survey_height ?? ''), unit: item.approved_unit || item.survey_unit || 'ft', quantity: String(item.approved_quantity ?? item.survey_quantity ?? 1) }); }} className="text-slate-400 hover:text-blue-600"><Pencil className="w-4 h-4" /></button>}
                      {canCrudShop && <button title="Delete item" onClick={() => { if (window.confirm('Delete this work item and its dependent links?')) deleteWorkItemMutation.mutate(item.id); }} className="text-slate-400 hover:text-red-600"><Trash2 className="w-4 h-4" /></button>}
                      <StatusBadge status={item.status} />
                    </div>
                  </div>
                  <div className="space-y-1 text-xs">
                    <WorkItemStageRow label="Survey" width={item.survey_width} height={item.survey_height} unit={item.survey_unit} quantity={item.survey_quantity} area={item.survey_area} />
                    <WorkItemStageRow label="Approved" width={item.approved_width} height={item.approved_height} unit={item.approved_unit} quantity={item.approved_quantity} area={item.approved_area} />
                    <div className="flex justify-between">
                      <span className="text-slate-500">Produced</span>
                      <span className="text-slate-900">{item.produced_quantity != null ? `Qty ${item.produced_quantity}${item.produced_at ? ` · ${new Date(item.produced_at).toLocaleDateString('en-IN')}` : ''}` : '—'}</span>
                    </div>
                    <WorkItemStageRow label="Installed" width={item.installed_width} height={item.installed_height} unit={item.installed_unit} quantity={item.installed_quantity} area={item.installed_area} />
                  </div>
                  {(() => {
                    const surveyForItem = (surveyPhotos || []).filter((p) => (surveyPhotoItems || []).some((x) => x.survey_photo_id === p.id && x.work_item_id === item.id) || (boardMarkings || []).some((m) => m.survey_photo_id === p.id && m.work_item_id === item.id));
                    const designForItem = (designTasks || []).flatMap((d: any) => (d.design_versions || []).filter((v: any) => (v.design_version_items || []).some((x: any) => x.work_item_id === item.id)));
                    const installForItem = (installations || []).flatMap((inst: any) => (inst.installation_proofs || []).filter((proof: any) => proof.work_item_id === item.id));
                    const Thumb = ({ src, label, onDelete }: { src: string; label: string; onDelete?: () => void }) => <div className="relative shrink-0"><button type="button" onClick={() => setEvidencePreview({ src, label })} className="block rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" title="Click to preview"><img src={src} className="w-16 h-16 rounded-lg object-cover border border-slate-200 shadow-sm"/><span className="absolute bottom-1 left-1 bg-black/65 text-white text-[9px] px-1.5 py-0.5 rounded pointer-events-none">{label}</span></button>{canCrudShop && onDelete && <button type="button" onClick={(e) => { e.stopPropagation(); onDelete(); }} title="Delete photo" className="absolute -top-1.5 -right-1.5 w-6 h-6 rounded-full bg-white border border-red-200 text-red-600 shadow flex items-center justify-center hover:bg-red-50"><Trash2 className="w-3.5 h-3.5"/></button>}</div>;
                    return <div className="mt-4 pt-4 border-t border-slate-200">
                      <div className="flex items-center justify-between mb-3"><p className="text-xs font-semibold uppercase tracking-wide text-slate-600">Complete evidence · this work item</p><div className="flex gap-2">{canCrudShop && <><button onClick={() => { setSurveyPhotoTargetItemId(item.id); setSurveyPhotoUploadFiles([]); setSurveyPhotoFileMap({}); setSurveyPhotoSurveyId(surveys?.[0]?.id || ''); setSurveyPhotoUploadOpen(true); }} className="text-[11px] px-2 py-1 rounded border border-blue-200 bg-blue-50 text-blue-700">+ Survey photos</button><button onClick={() => { setDesignUploadTargetItemId(item.id); setDesignUploadFiles([]); setDesignUploadFileMap({}); setDesignUploadItemIds(new Set([item.id])); setDesignUploadOpen(true); }} className="text-[11px] px-2 py-1 rounded border border-violet-200 bg-violet-50 text-violet-700">+ Designs</button></>}</div></div>
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                        <div className="rounded-lg bg-blue-50/50 border border-blue-100 p-2.5"><div className="flex justify-between mb-2"><p className="text-[11px] font-semibold text-blue-800">SURVEY / BEFORE</p><span className="text-[10px] text-blue-600">{surveyForItem.length} photo(s)</span></div><div className="flex gap-2 overflow-x-auto pb-1">{surveyForItem.length ? surveyForItem.map((p:any, i:number)=><Thumb key={p.id} src={p.photo_url} label={`S${i+1}`} onDelete={() => void deleteDetailPhoto(p)} />) : <span className="text-xs text-slate-400 py-5">No mapped survey photo</span>}</div></div>
                        <div className="rounded-lg bg-violet-50/50 border border-violet-100 p-2.5"><div className="flex justify-between mb-2"><p className="text-[11px] font-semibold text-violet-800">DESIGN / ARTWORK</p><span className="text-[10px] text-violet-600">{designForItem.length} file(s)</span></div><div className="flex gap-2 overflow-x-auto pb-1">{designForItem.length ? designForItem.map((v:any)=> v.file_url?.match(/\.(png|jpe?g|webp|gif)(\?|$)/i) ? <Thumb key={v.id} src={v.file_url} label={`v${v.version_number}`} /> : <a key={v.id} href={v.file_url} target="_blank" rel="noreferrer" className="w-16 h-16 rounded-lg border border-violet-200 bg-white text-violet-700 flex flex-col items-center justify-center text-[10px] font-semibold shrink-0"><Palette className="w-4 h-4 mb-1"/>v{v.version_number}</a>) : <span className="text-xs text-slate-400 py-5">No mapped design</span>}</div></div>
                        <div className="rounded-lg bg-emerald-50/50 border border-emerald-100 p-2.5"><div className="flex justify-between mb-2"><p className="text-[11px] font-semibold text-emerald-800">INSTALLATION / AFTER</p><span className="text-[10px] text-emerald-600">{installForItem.length} photo(s)</span></div><div className="flex gap-2 overflow-x-auto pb-1">{installForItem.length ? installForItem.map((p:any, i:number)=><Thumb key={p.id} src={p.photo_url} label={`I${i+1}`} onDelete={() => void deleteInstallationProof(p)} />) : <span className="text-xs text-slate-400 py-5">No mapped installation proof</span>}</div></div>
                      </div>
                    </div>;
                  })()}
                  {item.material && <p className="text-xs text-slate-500 mt-2 pt-2 border-t border-slate-100">Material: {item.material}</p>}
                  {(item.approved_notes || item.survey_notes) && (
                    <p className="text-xs text-slate-400 mt-1">Note: {item.approved_notes || item.survey_notes}</p>
                  )}
                  {item.po_variance_note && (
                    <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1 mt-2">
                      PO variance adjustment: {item.po_variance_note}
                    </p>
                  )}
                  {(() => {
                    const comps = (workItemComponents || []).filter((c) => c.work_item_id === item.id);
                    if (comps.length === 0) return null;
                    const readyCount = comps.filter((c) => c.status === 'ready').length;
                    const allReady = readyCount === comps.length;
                    return (
                      <div
                        className={`mt-2 pt-2 border-t border-slate-100 flex items-center gap-1.5 text-xs ${
                          allReady ? 'text-green-700' : 'text-amber-700'
                        }`}
                      >
                        <ListChecks className="w-3.5 h-3.5 shrink-0" />
                        <span>
                          BOM: {readyCount}/{comps.length} components ready
                          {!allReady && ' — manage from Production Studio'}
                        </span>
                      </div>
                    );
                  })()}
                  {shop?.purchase_order_id && (
                    <div className="mt-2 pt-2 border-t border-slate-100">
                      <label className="block text-[11px] font-medium text-slate-500 mb-1">PO Line Item (budget tracking)</label>
                      <select
                        value={item.po_line_item_id || ''}
                        onChange={(e) => assignLineItemMutation.mutate({ workItemId: item.id, poLineItemId: e.target.value || null })}
                        className="w-full px-2 py-1.5 text-xs border border-slate-300 rounded-lg bg-white outline-none focus:ring-2 focus:ring-blue-500"
                      >
                        <option value="">Unassigned</option>
                        {(poLineItems || []).map((li) => (
                          <option key={li.id} value={li.id}>{li.description} ({li.uom})</option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : <p className="text-sm text-slate-400">No work items yet</p>}
        </Card>

      </div>

      <Modal open={!!evidencePreview} onClose={() => setEvidencePreview(null)} title={evidencePreview?.label ? `Photo preview · ${evidencePreview.label}` : 'Photo preview'} size="lg">
        {evidencePreview && <div className="bg-slate-950 rounded-xl min-h-[60vh] flex items-center justify-center p-3"><img src={evidencePreview.src} alt={evidencePreview.label} className="max-w-full max-h-[75vh] object-contain rounded-lg" /></div>}
      </Modal>

      <Modal open={!!assignModal} onClose={() => setAssignModal(null)} title={`Assign ${assignModal === 'installer' ? 'Installer' : assignModal === 'designer' ? 'Designer' : 'Surveyor'}`}>
        <div className="space-y-4">
          <p className="text-sm text-slate-600">Shop: <span className="font-medium text-slate-900">{shop.name}</span></p>
          <Select
            label={assignModal === 'installer' ? 'Installer' : assignModal === 'designer' ? 'Designer' : 'Surveyor'}
            value={assignUserId}
            onChange={setAssignUserId}
            options={[
              { value: '', label: 'Select a person...' },
              ...(fieldWorkers || [])
                .filter((w) => w.role === assignModal)
                .map((w) => ({ value: w.id, label: w.full_name })),
            ]}
          />
          {fieldWorkers && fieldWorkers.filter((w) => w.role === assignModal).length === 0 && (
            <p className="text-xs text-amber-600">
              No active {assignModal}s found in your organization. Add one from Owner Console → Users first.
            </p>
          )}
          {assignMutation.isError && (
            <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-2">
              {(assignMutation.error as Error).message}
            </p>
          )}
          <button
            onClick={() => assignMutation.mutate()}
            disabled={assignMutation.isPending || !assignUserId}
            className="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium py-2.5 rounded-lg disabled:opacity-50"
          >
            {assignMutation.isPending ? 'Assigning...' : 'Assign'}
          </button>
        </div>
      </Modal>

      <Modal open={surveyPhotoUploadOpen} onClose={() => setSurveyPhotoUploadOpen(false)} title="Upload Survey Photos · Link to Board" size="lg">
        <div className="space-y-4">
          <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900">
            {surveyPhotoTargetItemId ? <>These photos will be attached directly to <b>{(() => { const x=(workItems||[]).find(w=>w.id===surveyPhotoTargetItemId); return `${x?.work_type_name || 'this work item'} · ${x?.approved_width ?? x?.survey_width ?? '—'} × ${x?.approved_height ?? x?.survey_height ?? '—'} ${x?.approved_unit || x?.survey_unit || ''}`; })()}</b>. No re-selection is required.</> : <>Bulk mode: map each uploaded survey photo to the exact work item / measurement it documents.</>}
          </div>
          <label className="flex cursor-pointer items-center justify-center gap-2 border-2 border-dashed border-slate-300 rounded-lg py-5 text-sm text-slate-600 hover:border-blue-400">
            <UploadCloud className="w-5 h-5" /> {surveyPhotoUploadFiles.length ? `${surveyPhotoUploadFiles.length} photo(s) selected` : 'Choose survey photos'}
            <input type="file" multiple className="hidden" accept="image/*" onChange={(e) => { const files = Array.from(e.target.files || []); setSurveyPhotoUploadFiles(files); setSurveyPhotoFileMap(surveyPhotoTargetItemId ? Object.fromEntries(files.map((_, i) => [i, surveyPhotoTargetItemId])) : {}); }} />
          </label>
          {(surveys || []).length > 0 && <div><label className="text-xs font-medium text-slate-500 uppercase tracking-wide">Survey record</label><select value={surveyPhotoSurveyId} onChange={(e) => setSurveyPhotoSurveyId(e.target.value)} className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"><option value="">Latest survey</option>{(surveys || []).map((sr: any) => <option key={sr.id} value={sr.id}>{sr.profiles?.full_name || 'Survey'} · {sr.submitted_at ? new Date(sr.submitted_at).toLocaleDateString('en-IN') : 'Draft'}</option>)}</select></div>}
          <div className="grid grid-cols-2 gap-3"><div><label className="text-xs font-medium text-slate-500 uppercase tracking-wide">Photo type</label><select value={surveyPhotoType} onChange={(e) => setSurveyPhotoType(e.target.value)} className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"><option value="survey">Survey / Board</option><option value="shop_front">Shop Front</option><option value="interior">Interior</option><option value="other">Other</option><option value="marked">Marked</option></select></div><Input label="Caption / reference" value={surveyPhotoCaption} onChange={setSurveyPhotoCaption} /></div>
          {surveyPhotoUploadFiles.length > 0 && <div>
            <div className="flex items-center justify-between mb-2"><p className="text-sm font-semibold text-slate-900">Map each photo in upload order</p><span className="text-xs text-slate-500">{Object.keys(surveyPhotoFileMap).length}/{surveyPhotoUploadFiles.length} mapped</span></div>
            <p className="text-xs text-slate-500 mb-3">File names do not matter. The sequence below is exactly the sequence selected from your device. Choose the board visible in each photo one-by-one.</p>
            <div className="max-h-[420px] overflow-y-auto border border-slate-200 rounded-xl divide-y divide-slate-100">
              {surveyPhotoUploadFiles.map((file, photoIndex) => <div key={`${file.name}-${photoIndex}`} className="p-3 grid grid-cols-[56px_1fr] gap-3 items-center">
                <div className="w-14 h-14 rounded-lg bg-slate-100 overflow-hidden flex items-center justify-center text-xs font-bold text-slate-500">{file.type.startsWith('image/') ? <img src={URL.createObjectURL(file)} className="w-full h-full object-cover" /> : `#${photoIndex + 1}`}</div>
                <div className="min-w-0"><div className="flex items-center gap-2 mb-1"><span className="text-xs font-bold text-blue-700 bg-blue-50 px-1.5 py-0.5 rounded">Photo {photoIndex + 1}</span><span className="text-xs text-slate-500 truncate">{file.name}</span></div>
                  {surveyPhotoTargetItemId ? <div className="w-full border border-blue-200 bg-blue-50 rounded-lg px-2.5 py-2 text-sm text-blue-800 font-medium">Automatically linked to this Work Item</div> : <select value={surveyPhotoFileMap[photoIndex] || ''} onChange={(e) => setSurveyPhotoFileMap((prev) => ({ ...prev, [photoIndex]: e.target.value }))} className="w-full border border-slate-300 rounded-lg px-2.5 py-2 text-sm bg-white">
                    <option value="">Select exact board / measurement...</option>
                    {(workItems || []).map((item, index) => <option key={item.id} value={item.id}>Board {index + 1} · {item.work_type_name || 'Work Item'} · {item.approved_width ?? item.survey_width ?? '—'} × {item.approved_height ?? item.survey_height ?? '—'} {item.approved_unit || item.survey_unit || ''} · Qty {item.approved_quantity ?? item.survey_quantity ?? 1}</option>)}
                  </select>}
                </div>
              </div>)}
            </div>
          </div>}
          <button onClick={() => uploadDetailPhotos()} disabled={photoUploading || surveyPhotoUploadFiles.length === 0 || ((workItems?.length || 0) > 0 && surveyPhotoUploadFiles.some((_, i) => !surveyPhotoFileMap[i]))} className="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium py-2.5 rounded-lg disabled:opacity-50">{photoUploading ? 'Uploading & linking in sequence...' : `Upload ${surveyPhotoUploadFiles.length} Mapped Photo${surveyPhotoUploadFiles.length === 1 ? '' : 's'}`}</button>
        </div>
      </Modal>

      <Modal open={designUploadOpen} onClose={() => setDesignUploadOpen(false)} title="Upload Designs · Map Every File" size="lg">
        <div className="space-y-4">
          <div className="rounded-lg border border-violet-200 bg-violet-50 p-3 text-sm text-violet-900">{designUploadTargetItemId ? <>Every selected design will be attached directly to <b>{(() => { const x=(workItems||[]).find(w=>w.id===designUploadTargetItemId); return `${x?.work_type_name || 'this work item'} · ${x?.approved_width ?? x?.survey_width ?? '—'} × ${x?.approved_height ?? x?.survey_height ?? '—'} ${x?.approved_unit || x?.survey_unit || ''}`; })()}</b>. No board selection is required.</> : <>Bulk mode: select all files once and map each design to its exact Work Item / measurement.</>}</div>
          <label className="flex cursor-pointer items-center justify-center gap-2 border-2 border-dashed border-slate-300 rounded-lg py-5 text-sm text-slate-600 hover:border-violet-400"><UploadCloud className="w-5 h-5" /> {designUploadFiles.length ? `${designUploadFiles.length} file(s) selected` : 'Choose multiple design files'}<input type="file" multiple className="hidden" accept="image/*,.pdf,.ai,.eps,.svg,.cdr" onChange={(e) => { const files=Array.from(e.target.files || []); setDesignUploadFiles(files); const preset=designUploadTargetItemId || Array.from(designUploadItemIds)[0]; setDesignUploadFileMap(Object.fromEntries(files.map((_,i)=>[i,preset || '']))); }} /></label>
          {designUploadFiles.length > 0 && <div className="space-y-2 max-h-[420px] overflow-y-auto pr-1">{designUploadFiles.map((file,i)=><div key={`${file.name}-${i}`} className="grid grid-cols-[44px_1fr] sm:grid-cols-[44px_1fr_1.3fr] gap-2 items-center border rounded-lg p-2 bg-white"><div className="w-10 h-10 rounded bg-violet-100 text-violet-700 flex items-center justify-center font-bold text-xs">D{i+1}</div><div className="min-w-0"><p className="text-xs font-medium truncate">{file.name}</p><p className="text-[10px] text-slate-400">{(file.size/1024/1024).toFixed(1)} MB</p></div>{designUploadTargetItemId ? <div className="col-span-2 sm:col-span-1 w-full px-2 py-2 text-xs border border-violet-200 rounded-lg bg-violet-50 text-violet-800 font-medium">Automatically linked to this Work Item</div> : <select value={designUploadFileMap[i] || ''} onChange={(e)=>setDesignUploadFileMap(prev=>({...prev,[i]:e.target.value}))} className="col-span-2 sm:col-span-1 w-full px-2 py-2 text-xs border rounded-lg bg-white"><option value="">Select exact work item...</option>{(workItems||[]).map((item,index)=><option key={item.id} value={item.id}>#{index+1} · {item.work_type_name || 'Work Item'} · {item.approved_width ?? item.survey_width ?? '—'} × {item.approved_height ?? item.survey_height ?? '—'} {item.approved_unit || item.survey_unit || ''}</option>)}</select>}</div>)}</div>}
          <Textarea label="Design notes (optional)" value={designUploadNotes} onChange={setDesignUploadNotes} rows={2} />
          {uploadDesignMutation.isError && <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-2">{(uploadDesignMutation.error as Error).message}</p>}
          <button onClick={() => uploadDesignMutation.mutate()} disabled={uploadDesignMutation.isPending || !designUploadFiles.length || ((workItems?.length || 0)>0 && designUploadFiles.some((_,i)=>!designUploadFileMap[i]))} className="w-full bg-violet-600 hover:bg-violet-700 text-white font-medium py-2.5 rounded-lg disabled:opacity-50">{uploadDesignMutation.isPending ? `Uploading all ${designUploadFiles.length} files...` : `Upload all ${designUploadFiles.length} mapped design${designUploadFiles.length===1?'':'s'}`}</button>
        </div>
      </Modal>

      <Modal open={detailEditOpen} onClose={() => setDetailEditOpen(false)} title="Edit Shop Details" size="lg">
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3"><Input label="Shop / Site Name" value={detailForm.name} onChange={(v) => setDetailForm({ ...detailForm, name: v })} required /><Input label="Owner Name" value={detailForm.owner_name} onChange={(v) => setDetailForm({ ...detailForm, owner_name: v })} /></div>
          <div className="grid grid-cols-2 gap-3"><Input label="Phone" value={detailForm.contact_phone} onChange={(v) => setDetailForm({ ...detailForm, contact_phone: v })} /><Input label="Signage Language" value={detailForm.signage_language} onChange={(v) => setDetailForm({ ...detailForm, signage_language: v })} /></div>
          <Textarea label="Address" value={detailForm.address} onChange={(v) => setDetailForm({ ...detailForm, address: v })} rows={2} />
          <div className="grid grid-cols-3 gap-3"><Input label="City" value={detailForm.city} onChange={(v) => setDetailForm({ ...detailForm, city: v })} /><Input label="District" value={detailForm.district} onChange={(v) => setDetailForm({ ...detailForm, district: v })} /><Input label="State" value={detailForm.state} onChange={(v) => setDetailForm({ ...detailForm, state: v })} /></div>
          {detailUpdateMutation.isError && <p className="text-sm text-red-600">{(detailUpdateMutation.error as Error).message}</p>}
          <button onClick={() => detailUpdateMutation.mutate()} disabled={detailUpdateMutation.isPending || !detailForm.name.trim()} className="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium py-2.5 rounded-lg disabled:opacity-50">{detailUpdateMutation.isPending ? 'Saving...' : 'Save Shop Changes'}</button>
        </div>
      </Modal>

      <Modal open={!!editWorkItem} onClose={() => setEditWorkItem(null)} title="Edit Work Item">
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3"><Input label="Work Type" value={workItemForm.work_type_name} onChange={(v) => setWorkItemForm({ ...workItemForm, work_type_name: v })} /><Input label="Material" value={workItemForm.material} onChange={(v) => setWorkItemForm({ ...workItemForm, material: v })} /></div>
          <div className="grid grid-cols-4 gap-2"><Input label="Width" type="number" value={workItemForm.width} onChange={(v) => setWorkItemForm({ ...workItemForm, width: v })} /><Input label="Height" type="number" value={workItemForm.height} onChange={(v) => setWorkItemForm({ ...workItemForm, height: v })} /><Select label="Unit" value={workItemForm.unit} onChange={(v) => setWorkItemForm({ ...workItemForm, unit: v })} options={LENGTH_UNIT_OPTIONS} /><Input label="Qty" type="number" value={workItemForm.quantity} onChange={(v) => setWorkItemForm({ ...workItemForm, quantity: v })} /></div>
          {saveWorkItemMutation.isError && <p className="text-sm text-red-600">{(saveWorkItemMutation.error as Error).message}</p>}
          <button onClick={() => saveWorkItemMutation.mutate()} disabled={saveWorkItemMutation.isPending} className="w-full bg-blue-600 text-white font-medium py-2.5 rounded-lg disabled:opacity-50">{saveWorkItemMutation.isPending ? 'Saving...' : 'Save Work Item'}</button>
        </div>
      </Modal>

      <Modal open={backfillOpen} onClose={() => setBackfillOpen(false)} title="Backfill Completed Work" size="lg">
        <div className="space-y-5">
          <p className="text-sm text-slate-600">
            Shop: <span className="font-medium text-slate-900">{shop.name}</span> — enter what's already
            been done outside the app. Everything here gets recorded exactly as if it went through
            the normal Survey Review / Design / Production screens.
          </p>

          {shopHasExistingPipelineData && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700 space-y-2">
              <p className="font-medium">This shop already has survey/design/production data in the app.</p>
              <p className="text-xs">Running this will add a second, separate set of records rather than filling anything in — check the Work Items / Timeline below first. Only continue if you're sure.</p>
              <label className="flex items-center gap-2 text-xs font-medium">
                <input type="checkbox" checked={backfillConfirmDuplicate} onChange={(e) => setBackfillConfirmDuplicate(e.target.checked)} />
                I understand this may create duplicate records — continue anyway
              </label>
            </div>
          )}

          <div>
            <label className="text-xs font-medium text-slate-500 uppercase tracking-wide">How far has this shop already progressed?</label>
            <div className="mt-2 grid grid-cols-2 gap-2">
              {([
                { value: 'design_pending', label: 'Survey done', hint: 'Design still to happen in-app' },
                { value: 'production_pending', label: 'Survey + Design done', hint: 'Production still to happen in-app' },
                { value: 'production_done', label: 'Survey + Design + Production done', hint: 'Ready for Installation' },
                { value: 'dispatched', label: '...and vehicle already left', hint: 'Same as above, marked Dispatched' },
              ] as { value: BackfillStage; label: string; hint: string }[]).map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setBackfillStage(opt.value)}
                  className={`text-left border rounded-lg p-2.5 text-xs transition ${
                    backfillStage === opt.value ? 'border-amber-500 bg-amber-50 ring-1 ring-amber-500' : 'border-slate-200 hover:bg-slate-50'
                  }`}
                >
                  <p className="font-medium text-slate-900">{opt.label}</p>
                  <p className="text-slate-500 mt-0.5">{opt.hint}</p>
                </button>
              ))}
            </div>
          </div>

          <Select
            label="Surveyed by (optional — defaults to you)"
            value={backfillSurveyorId}
            onChange={setBackfillSurveyorId}
            options={[{ value: '', label: 'Me (entering this data)' }, ...(backfillPeople || []).filter((p) => p.role === 'surveyor').map((p) => ({ value: p.id, label: p.full_name }))]}
          />

          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-medium text-slate-500 uppercase tracking-wide">Boards / Items</label>
              <button
                type="button"
                onClick={() => setBackfillItems((prev) => [...prev, { key: crypto.randomUUID(), workTypeId: '', workTypeName: '', material: '', width: '', height: '', unit: 'ft', quantity: '1' }])}
                className="flex items-center gap-1 text-xs font-medium text-blue-600"
              >
                <PlusCircle className="w-3.5 h-3.5" /> Add item
              </button>
            </div>
            <div className="space-y-3">
              {backfillItems.map((item, idx) => (
                <div key={item.key} className="border border-slate-200 rounded-lg p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-slate-500">Item {idx + 1}</span>
                    {backfillItems.length > 1 && (
                      <button type="button" onClick={() => setBackfillItems((prev) => prev.filter((_, i) => i !== idx))} className="text-slate-400 hover:text-red-600">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <Select
                      label="Work type"
                      value={item.workTypeId}
                      onChange={(v) => setBackfillItems((prev) => prev.map((it, i) => (i === idx ? { ...it, workTypeId: v } : it)))}
                      options={[{ value: '', label: 'Custom / not listed' }, ...(backfillWorkTypes || []).map((w) => ({ value: w.id, label: w.name }))]}
                    />
                    <Input label="Or type a name" value={item.workTypeName} onChange={(v) => setBackfillItems((prev) => prev.map((it, i) => (i === idx ? { ...it, workTypeName: v } : it)))} />
                  </div>
                  <div className="grid grid-cols-4 gap-2">
                    <Input label="Width" type="number" value={item.width} onChange={(v) => setBackfillItems((prev) => prev.map((it, i) => (i === idx ? { ...it, width: v } : it)))} />
                    <Input label="Height" type="number" value={item.height} onChange={(v) => setBackfillItems((prev) => prev.map((it, i) => (i === idx ? { ...it, height: v } : it)))} />
                    <Select label="Unit" value={item.unit} onChange={(v) => setBackfillItems((prev) => prev.map((it, i) => (i === idx ? { ...it, unit: v } : it)))} options={LENGTH_UNIT_OPTIONS} />
                    <Input label="Qty" type="number" value={item.quantity} onChange={(v) => setBackfillItems((prev) => prev.map((it, i) => (i === idx ? { ...it, quantity: v } : it)))} />
                  </div>
                  <Input label="Material (optional)" value={item.material} onChange={(v) => setBackfillItems((prev) => prev.map((it, i) => (i === idx ? { ...it, material: v } : it)))} />
                </div>
              ))}
            </div>
          </div>

          <div>
            <label className="text-xs font-medium text-slate-500 uppercase tracking-wide">Survey Photos (optional)</label>
            <input
              type="file" accept="image/*" multiple
              onChange={(e) => setBackfillSurveyPhotos((prev) => [...prev, ...Array.from(e.target.files || [])])}
              className="mt-1 block w-full text-xs text-slate-600 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border file:border-slate-300 file:bg-white file:text-xs file:font-medium"
            />
            {backfillSurveyPhotos.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2">
                {backfillSurveyPhotos.map((f, i) => (
                  <span key={`${f.name}-${i}`} className="flex items-center gap-1 text-xs bg-slate-100 border border-slate-200 rounded-full px-2 py-1">
                    {f.name}
                    <button type="button" onClick={() => setBackfillSurveyPhotos((prev) => prev.filter((_, j) => j !== i))}><X className="w-3 h-3" /></button>
                  </span>
                ))}
              </div>
            )}
          </div>

          {backfillStage !== 'design_pending' && (
            <Select
              label="Designed by (optional)"
              value={backfillDesignerId}
              onChange={setBackfillDesignerId}
              options={[{ value: '', label: 'Not specified' }, ...(backfillPeople || []).filter((p) => p.role === 'designer').map((p) => ({ value: p.id, label: p.full_name }))]}
            />
          )}

          {backfillStage !== 'design_pending' && (
            <div>
              <label className="text-xs font-medium text-slate-500 uppercase tracking-wide">Design File(s) (optional)</label>
              <input
                type="file" accept="image/*,application/pdf" multiple
                onChange={(e) => setBackfillDesignFiles((prev) => [...prev, ...Array.from(e.target.files || [])])}
                className="mt-1 block w-full text-xs text-slate-600 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border file:border-slate-300 file:bg-white file:text-xs file:font-medium"
              />
              {backfillDesignFiles.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {backfillDesignFiles.map((f, i) => (
                    <span key={`${f.name}-${i}`} className="flex items-center gap-1 text-xs bg-slate-100 border border-slate-200 rounded-full px-2 py-1">
                      {f.name}
                      <button type="button" onClick={() => setBackfillDesignFiles((prev) => prev.filter((_, j) => j !== i))}><X className="w-3 h-3" /></button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}

          {(backfillStage === 'production_done' || backfillStage === 'dispatched') && (
            <>
              <Select
                label="Produced by (optional)"
                value={backfillProductionId}
                onChange={setBackfillProductionId}
                options={[{ value: '', label: 'Not specified' }, ...(backfillPeople || []).filter((p) => p.role === 'printing').map((p) => ({ value: p.id, label: p.full_name }))]}
              />
              <Select
                label="Assign installer now (optional)"
                value={backfillInstallerId}
                onChange={setBackfillInstallerId}
                options={[{ value: '', label: "Don't assign yet" }, ...(backfillPeople || []).filter((p) => p.role === 'installer').map((p) => ({ value: p.id, label: p.full_name }))]}
              />
            </>
          )}

          <Textarea label="Note (optional)" value={backfillNote} onChange={(v) => setBackfillNote(v)} placeholder="e.g. Completed in March before this shop was added to the system" />

          {backfillMutation.isError && (
            <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-2">
              {(backfillMutation.error as Error).message}
            </p>
          )}

          <button
            onClick={() => backfillMutation.mutate()}
            disabled={backfillMutation.isPending}
            className="w-full bg-amber-600 hover:bg-amber-700 text-white font-medium py-2.5 rounded-lg disabled:opacity-50"
          >
            {backfillMutation.isPending ? 'Saving...' : 'Save Backfilled Data'}
          </button>
        </div>
      </Modal>
    </div>
  );
}

// Renders each survey photo with its marked polygon burned in (same
// composite the PDF/PPT exports use), tagged with which board/work item it
// belongs to. Click to view full-size.
// One row of a work item's stage breakdown (Survey / Approved / Installed) —
// shown with its *actual* recorded unit instead of a hardcoded "sq ft",
// which previously mislabeled areas recorded in meters/inches/cm.
function WorkItemStageRow({
  label, width, height, unit, quantity, area,
}: {
  label: string; width: number | null; height: number | null; unit: string | null; quantity: number | null; area: number | null;
}) {
  if (width == null || height == null) {
    return (
      <div className="flex justify-between">
        <span className="text-slate-500">{label}</span>
        <span className="text-slate-400">—</span>
      </div>
    );
  }
  const u = unit || '';
  const w = formatDim(width);
  const h = formatDim(height);
  const a = area != null ? Math.round(area) : null;
  return (
    <div className="flex justify-between">
      <span className="text-slate-500">{label}</span>
      <span className="text-slate-900">
        {w}×{h} {u} · Qty {quantity ?? 1}{a != null ? ` · ${a} sq ${u}` : ''}
      </span>
    </div>
  );
}

