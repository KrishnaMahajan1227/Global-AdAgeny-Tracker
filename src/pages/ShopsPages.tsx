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
import { renderMarkedImage, buildBoardLabel } from '@/lib/markingUtils';
import { geocodeAddress, buildAddressQuery } from '@/lib/geocode';
import { findShopHeaderRow, findExtraHeaders, buildShopRows, resolveZoneIds, type ParsedShopRow } from '@/lib/shopBulkUpload';
import { INDIA_STATES, INDIA_CITIES_BY_STATE, ALL_INDIA_CITIES } from '@/lib/indiaLocations';
import {
  Plus, Pencil, Trash2, Store, MapPin, ArrowLeft, Search, CheckCircle2, UserPlus, CheckSquare, Square,
  Ruler, FileText, Palette, Wrench, Users, AlertCircle, XCircle, Clock, Camera, LocateFixed, Loader2, Layers,
  ListChecks, Building2, Lock, ListOrdered, UploadCloud, ChevronRight, Ban, Phone,
  ChevronLeft, ChevronsLeft, ChevronsRight, X, RotateCcw,
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
      if (!deleteProject) return;
      const { error } = await supabase.from('projects').delete().eq('id', deleteProject.id);
      if (error) throw error;
    },
    // Runs whether the delete succeeded or failed — so the list always
    // reflects the true database state instead of quietly going stale if
    // something after the delete (e.g. a notification) throws.
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['projects', orgId] });
    },
    onSuccess: () => {
      setNotice({ kind: 'success', message: `"${deleteProject?.name}" deleted.` });
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
        message={`Delete "${deleteProject?.name}"? Work Orders under it will be un-grouped, not deleted.`}
        confirmLabel="Delete"
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

  const { data: purchaseOrders } = useQuery({
    queryKey: ['purchase_orders', orgId],
    queryFn: async () => {
      const { data, error } = await supabase.from('purchase_orders').select('id, po_number, client_id, fulfillment_type, status').eq('organization_id', orgId).eq('status', 'active').order('po_number');
      if (error) throw error;
      return data as Pick<PurchaseOrder, 'id' | 'po_number' | 'client_id' | 'fulfillment_type' | 'status'>[];
    },
    enabled: !!orgId,
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
  // whatever it was when this list first loaded.
  useRealtimeInvalidate(['shops'], orgId, [['shops', orgId], ['shops-cities', orgId]]);
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
          .select('shop_id, user_id, role, status')
          .in('shop_id', targetShops.map((s) => s.id))
          .eq('role', bulkRole);
        if (existingError) throw new Error(`Could not check existing assignments: ${existingError.message}`);
        for (const shop of targetShops) {
          const dup = (existing || []).find((a) => a.shop_id === shop.id && a.user_id === bulkUserId && a.status !== 'declined');
          if (dup) { skipped++; continue; }
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
  const SHOP_STATUS_OPTIONS: Record<string, string> = { pending: 'Pending', assigned: 'Assigned', surveyed: 'Surveyed', approval_pending: 'Approval Pending', approved: 'Approved', design_approved: 'Design Approved', production_done: 'Production Done', installed: 'Installed', billed: 'Billed', cancelled: 'Cancelled' };

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
                      <StatusBadge status={shop.status} />
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
              .map((po) => ({ value: po.id, label: `${po.po_number} · ${po.fulfillment_type === 'supply_only' ? 'Supply Only' : 'Survey + Install'}` }))}
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
              .map((po) => ({ value: po.id, label: `${po.po_number} · ${po.fulfillment_type === 'supply_only' ? 'Supply Only' : 'Survey + Install'}` }))}
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
    </div>
  );
}

export function ShopDetailPage({ shopId }: { shopId: string }) {
  const { profile } = useAuth();
  const orgId = profile?.organization_id;
  const queryClient = useQueryClient();
  const [assignModal, setAssignModal] = useState<'surveyor' | 'installer' | null>(null);
  const [assignUserId, setAssignUserId] = useState('');
  const canAssign = profile?.role === 'agency_owner' || profile?.role === 'admin' || profile?.role === 'demo';

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
        .select('*, profiles(full_name), design_versions(*)')
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
        .in('role', ['surveyor', 'installer'])
        .eq('is_active', true)
        .order('full_name');
      return data as { id: string; full_name: string; role: string }[];
    },
    enabled: !!orgId && !!assignModal,
  });

  const assignMutation = useMutation({
    mutationFn: async () => {
      if (!assignUserId || !assignModal || !shop) throw new Error('Pick a person to assign first.');

      // Guard against assigning the same person to the same role on this
      // shop twice (the exact "Rahul Patil listed twice" symptom) — if an
      // active (non-declined) assignment already exists for this
      // shop+user+role, just tell the person instead of inserting a
      // duplicate row.
      const dup = (assignments || []).find(
        (a) => a.user_id === assignUserId && a.role === assignModal && a.status !== 'declined'
      );
      if (dup) throw new Error('This person is already assigned to this role on this shop.');

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
      await logAudit('shop_assignments', null, 'insert', 'role', null, assignModal, `Assigned ${worker?.full_name || 'user'} as ${assignModal} for ${shop.name}`);
      await createNotification(assignUserId, 'New Assignment', `You've been assigned as ${assignModal} for ${shop.name}`, 'info', assignModal === 'surveyor' ? '/survey' : undefined);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['shop-assignments', shopId] });
      queryClient.invalidateQueries({ queryKey: ['shop', shopId] });
      setAssignModal(null);
      setAssignUserId('');
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
        <StatusBadge status={shop.status} />
      </div>

      {/* Timeline */}
      <Card className="p-6 mb-6">
        <h2 className="text-lg font-semibold text-slate-900 mb-4">Timeline</h2>
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

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Shop Info */}
        <Card className="p-6">
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
        <Card className="p-6">
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
          ) : <p className="text-sm text-slate-400">No assignments yet</p>}
        </Card>

        {/* Work Items */}
        <Card className="p-6">
          <h2 className="text-lg font-semibold text-slate-900 mb-4 flex items-center gap-2">
            <Ruler className="w-5 h-5 text-blue-600" /> Work Items ({workItems?.length || 0})
          </h2>
          {workItems && workItems.length > 0 ? (
            <div className="space-y-3">
              {workItems.map((item) => (
                <div key={item.id} className="border border-slate-200 rounded-lg p-3">
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-medium text-slate-900 text-sm">{item.work_type_name || 'Work Item'}</span>
                    <StatusBadge status={item.status} />
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

        {/* Surveys */}
        <Card className="p-6">
          <h2 className="text-lg font-semibold text-slate-900 mb-4 flex items-center gap-2">
            <FileText className="w-5 h-5 text-blue-600" /> Surveys
          </h2>
          {surveys && surveys.length > 0 ? (
            <div className="space-y-3">
              {surveys.map((s) => (
                <div key={s.id} className="border border-slate-200 rounded-lg p-3 text-sm">
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-medium text-slate-900">{s.profiles?.full_name || 'Unknown'}</span>
                    <StatusBadge status={s.status} />
                  </div>
                  <p className="text-xs text-slate-500">Submitted: {s.submitted_at ? new Date(s.submitted_at).toLocaleString('en-IN') : 'Draft'}</p>
                  {s.reviewed_at && <p className="text-xs text-slate-500">Reviewed: {new Date(s.reviewed_at).toLocaleString('en-IN')}</p>}
                  {s.gps_lat && <p className="text-xs text-slate-500">GPS: {s.gps_lat.toFixed(4)}, {s.gps_lng?.toFixed(4)}{s.gps_accuracy ? ` (±${Math.round(s.gps_accuracy)}m)` : ''}</p>}
                  {s.notes && <p className="text-xs text-slate-500 mt-1">Notes: {s.notes}</p>}
                  {s.review_note && (
                    <p className={`text-xs mt-1 rounded px-2 py-1 ${s.status === 'rejected' || s.status === 'correction_requested' ? 'text-amber-700 bg-amber-50 border border-amber-100' : 'text-slate-600 bg-slate-50'}`}>
                      Review: {s.review_note}
                    </p>
                  )}
                </div>
              ))}
            </div>
          ) : workItemsSurveyed && surveyorAssignment ? (
            // No `surveys` row exists for this shop, but the work items
            // already carry real survey (and possibly approved) measurements
            // and a surveyor is on record — so the survey did happen, it just
            // isn't tracked as its own row. Show what's actually known
            // instead of claiming nothing was done.
            <div className="border border-slate-200 rounded-lg p-3 text-sm">
              <div className="flex items-center justify-between mb-1">
                <span className="font-medium text-slate-900">{surveyorAssignment.profiles?.full_name || 'Unknown'}</span>
                <StatusBadge status={workItemsApproved ? 'approved' : 'submitted'} />
              </div>
              <p className="text-xs text-slate-500">
                {surveyorAssignment.completed_at
                  ? `Completed: ${new Date(surveyorAssignment.completed_at).toLocaleDateString('en-IN')}`
                  : `Assigned: ${new Date(surveyorAssignment.assigned_at).toLocaleDateString('en-IN')}`}
              </p>
              <p className="text-xs text-amber-600 mt-2 bg-amber-50 border border-amber-100 rounded px-2 py-1">
                No dedicated survey record on file — shown from work item measurements and assignment history.
              </p>
            </div>
          ) : <p className="text-sm text-slate-400">No surveys yet</p>}
        </Card>

        {/* Marked Board Photos — shows exactly what the surveyor drew,
            using the same composite render the PDF/PPT exports use. */}
        <Card className="p-6">
          <h2 className="text-lg font-semibold text-slate-900 mb-4 flex items-center gap-2">
            <Camera className="w-5 h-5 text-blue-600" /> Marked Board Photos
          </h2>
          {surveyPhotos && surveyPhotos.length > 0 ? (
            <MarkedPhotoGrid photos={surveyPhotos} markings={boardMarkings || []} workItems={workItems || []} />
          ) : (
            <p className="text-sm text-slate-400">No survey photos yet</p>
          )}
        </Card>

        {/* Design */}
        <Card className="p-6">
          <h2 className="text-lg font-semibold text-slate-900 mb-4 flex items-center gap-2">
            <Palette className="w-5 h-5 text-blue-600" /> Design Tasks
          </h2>
          {designTasks && designTasks.length > 0 ? (
            <div className="space-y-3">
              {designTasks.map((d) => (
                <div key={d.id} className="border border-slate-200 rounded-lg p-3 text-sm">
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-medium text-slate-900">{d.profiles?.full_name || 'Unassigned'}</span>
                    <StatusBadge status={d.status} />
                  </div>
                  <p className="text-xs text-slate-500">Versions: {d.design_versions?.length || 0}</p>
                  {d.design_versions?.map((v: any) => (
                    <div key={v.id} className="text-xs text-slate-600 mt-1 flex items-center gap-2">
                      <span>v{v.version_number}</span>
                      <a href={v.file_url} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">{v.file_name || 'View file'}</a>
                      <StatusBadge status={v.status} />
                    </div>
                  ))}
                </div>
              ))}
            </div>
          ) : <p className="text-sm text-slate-400">No design tasks yet</p>}
        </Card>

        {/* Installation */}
        <Card className="p-6">
          <h2 className="text-lg font-semibold text-slate-900 mb-4 flex items-center gap-2">
            <Wrench className="w-5 h-5 text-blue-600" /> Installation
          </h2>
          {installations && installations.length > 0 ? (
            <div className="space-y-3">
              {installations.map((inst) => (
                <div key={inst.id} className="border border-slate-200 rounded-lg p-3 text-sm">
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-medium text-slate-900">{inst.profiles?.full_name || 'Unknown'}</span>
                    <div className="flex items-center gap-1.5">
                      <StatusBadge status={inst.status} />
                      {/* Job status alone doesn't say whether Owner/Admin has
                          actually signed off — review_status is the field
                          that flips shops.status to 'installed', so surface
                          it explicitly instead of only showing job.status. */}
                      {inst.status === 'completed' && <StatusBadge status={inst.review_status} label={inst.review_status === 'pending' ? 'Awaiting Approval' : inst.review_status === 'approved' ? 'Approved' : inst.review_status === 'rejected' ? 'Sent Back for Redo' : inst.review_status} />}
                    </div>
                  </div>
                  <p className="text-xs text-slate-500">Started: {inst.started_at ? new Date(inst.started_at).toLocaleDateString('en-IN') : 'Not started'}</p>
                  <p className="text-xs text-slate-500">Completed: {inst.completed_at ? new Date(inst.completed_at).toLocaleDateString('en-IN') : 'Pending'}</p>
                  {inst.gps_lat && <p className="text-xs text-slate-500">GPS: {inst.gps_lat.toFixed(4)}, {inst.gps_lng?.toFixed(4)}{inst.gps_accuracy ? ` (±${Math.round(inst.gps_accuracy)}m)` : ''}</p>}
                  {inst.exception_reason && (
                    <p className="text-xs text-red-600 mt-1 bg-red-50 border border-red-100 rounded px-2 py-1 flex items-center gap-1">
                      <AlertCircle className="w-3.5 h-3.5 shrink-0" /> Exception: {inst.exception_reason}{inst.exception_note ? ` — ${inst.exception_note}` : ''}
                    </p>
                  )}
                  {inst.review_note && (
                    <p className={`text-xs mt-1 rounded px-2 py-1 ${inst.review_status === 'rejected' ? 'text-amber-700 bg-amber-50 border border-amber-100' : 'text-slate-600 bg-slate-50'}`}>
                      Review note: {inst.review_note}
                    </p>
                  )}
                  {inst.installation_proofs && inst.installation_proofs.length > 0 ? (
                    <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 mt-2">
                      {inst.installation_proofs.map((proof: any) => (
                        <a key={proof.id} href={proof.photo_url} target="_blank" rel="noopener noreferrer" className="relative rounded overflow-hidden border border-slate-200 block">
                          <img src={proof.photo_url} alt={proof.photo_type} className="w-full aspect-square object-cover" />
                          <span className="absolute bottom-0 left-0 right-0 bg-black/50 text-white text-[9px] px-1 py-0.5 capitalize">{proof.photo_type}</span>
                        </a>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-slate-500 mt-1">No proof photos yet</p>
                  )}
                </div>
              ))}
            </div>
          ) : workItemsInstalled && installerAssignment ? (
            // No `installation_jobs` row for this shop, but the work items
            // already carry real installed measurements and an installer is
            // on record — the install did happen, just wasn't tracked as its
            // own row. Show what's actually known instead of "not done".
            <div className="border border-slate-200 rounded-lg p-3 text-sm">
              <div className="flex items-center justify-between mb-1">
                <span className="font-medium text-slate-900">{installerAssignment.profiles?.full_name || 'Unknown'}</span>
                <div className="flex items-center gap-1.5">
                  <StatusBadge status="completed" />
                  <StatusBadge
                    status={shop.status === 'installed' || shop.status === 'billed' ? 'approved' : 'pending'}
                    label={shop.status === 'installed' || shop.status === 'billed' ? 'Approved' : 'Awaiting Approval'}
                  />
                </div>
              </div>
              <p className="text-xs text-slate-500">
                {installerAssignment.completed_at
                  ? `Completed: ${new Date(installerAssignment.completed_at).toLocaleDateString('en-IN')}`
                  : `Assigned: ${new Date(installerAssignment.assigned_at).toLocaleDateString('en-IN')}`}
              </p>
              <p className="text-xs text-amber-600 mt-2 bg-amber-50 border border-amber-100 rounded px-2 py-1">
                No dedicated installation record on file — shown from work item measurements and assignment history.
              </p>
            </div>
          ) : <p className="text-sm text-slate-400">No installation jobs yet</p>}
        </Card>
      </div>

      <Modal open={!!assignModal} onClose={() => setAssignModal(null)} title={`Assign ${assignModal === 'installer' ? 'Installer' : 'Surveyor'}`}>
        <div className="space-y-4">
          <p className="text-sm text-slate-600">Shop: <span className="font-medium text-slate-900">{shop.name}</span></p>
          <Select
            label={assignModal === 'installer' ? 'Installer' : 'Surveyor'}
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
  return (
    <div className="flex justify-between">
      <span className="text-slate-500">{label}</span>
      <span className="text-slate-900">
        {width}×{height} {u} · Qty {quantity ?? 1}{area != null ? ` · ${area} sq ${u}` : ''}
      </span>
    </div>
  );
}

function MarkedPhotoGrid({ photos, markings, workItems }: { photos: SurveyPhoto[]; markings: BoardMarking[]; workItems: WorkItem[] }) {
  const [renderedById, setRenderedById] = useState<Record<string, string>>({});
  const [lightbox, setLightbox] = useState<string | null>(null);

  const markingsByPhotoId = new Map<string, BoardMarking[]>();
  for (const m of markings) {
    const list = markingsByPhotoId.get(m.survey_photo_id) || [];
    list.push(m);
    markingsByPhotoId.set(m.survey_photo_id, list);
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const entries: Record<string, string> = {};
      for (const photo of photos) {
        const photoMarkings = markingsByPhotoId.get(photo.id) || [];
        const allPoints = photoMarkings.map((m) => m.points);
        if (allPoints.some((set) => set.length >= 3) && photo.photo_url) {
          try {
            const labels = photoMarkings.map((m) => boardLabelFor(m.work_item_id));
            const { dataUrl } = await renderMarkedImage(photo.photo_url, allPoints, { labels });
            entries[photo.id] = dataUrl;
          } catch {
            // fall back to plain photo below
          }
        }
      }
      if (!cancelled) setRenderedById(entries);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photos, markings]);

  function workItemLabel(workItemId: string | null) {
    if (!workItemId) return null;
    return workItems.find((w) => w.id === workItemId)?.work_type_name || null;
  }

  // Full on-photo caption (work type + dimensions) for a given board — this
  // is what gets burned onto the image itself, not just listed underneath.
  function boardLabelFor(workItemId: string | null) {
    if (!workItemId) return null;
    const item = workItems.find((w) => w.id === workItemId);
    if (!item) return null;
    return buildBoardLabel({ workTypeName: item.work_type_name, width: item.survey_width, height: item.survey_height, unit: item.survey_unit });
  }

  return (
    <div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {photos.map((photo) => {
          const photoMarkings = markingsByPhotoId.get(photo.id) || [];
          const src = renderedById[photo.id] || photo.photo_url;
          const label = photoMarkings.map((m) => workItemLabel(m.work_item_id)).filter(Boolean).join(', ');
          return (
            <button key={photo.id} onClick={() => setLightbox(src)} className="text-left">
              <div className="relative rounded-lg overflow-hidden border border-slate-200">
                <img src={src} alt="Survey" className="w-full aspect-square object-cover" />
                {photoMarkings.length > 0 && (
                  <span className="absolute top-1.5 right-1.5 bg-blue-600 text-white text-[10px] font-medium px-1.5 py-0.5 rounded">
                    Marked
                  </span>
                )}
              </div>
              <p className="text-xs text-slate-500 mt-1 truncate">{label || photo.photo_type}</p>
            </button>
          );
        })}
      </div>

      {lightbox && (
        <div onClick={() => setLightbox(null)} className="fixed inset-0 z-[100] bg-black/80 flex items-center justify-center p-4 cursor-zoom-out">
          <img src={lightbox} alt="Marked board" className="max-w-full max-h-full rounded-lg" />
        </div>
      )}
    </div>
  );
}
