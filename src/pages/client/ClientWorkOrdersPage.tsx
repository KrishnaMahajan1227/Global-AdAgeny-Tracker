import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Loader2, Plus, Search, ShoppingCart, Trash2 } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
import { logAudit, notifyLinkedOrg } from '@/lib/helpers';
import { useClientRealtimeInvalidate } from '@/lib/useClientRealtimeInvalidate';
import { buildClientCampaignRows, CLIENT_PO_WORK_STATUS_COLORS, CLIENT_PO_WORK_STATUS_LABELS } from '@/lib/clientPortal';
import { FULFILLMENT_PRESETS } from '@/lib/fulfillment';
import { Card, EmptyState, Input, Modal, ProgressBar, Select, Textarea, Pagination, PageHeader } from '@/components/ui';
import type { PurchaseOrder, ClientAgencyLink, ClientPOLineItemProgress } from '@/lib/types';

type PoRow = PurchaseOrder & { agency_org: { name: string } | null };
type LinkRow = ClientAgencyLink & { agency_org: { name: string } | null };
const emptyForm = () => ({
  agency_org_id: '', po_number: '', name: '',
  po_date: new Date().toLocaleDateString('en-CA'),
  fulfillment_type: 'survey_install', notes: '', payment_terms: '',
});
const emptyLine = () => ({ description: '', uom: 'sqft', budgeted_qty: '', budgeted_area: '' });
const UOMS = [{ value: 'sqft', label: 'Sq.ft' }, { value: 'piece', label: 'Piece' }, { value: 'lot', label: 'Lot' }];
const PAGE_SIZES = [10, 20, 50, 100];

/** Direct client Work Order flow. Historical campaign_id links are preserved in the database,
 * but neither a new campaign nor an extra navigation level is needed to issue a Work Order. */
export default function ClientWorkOrdersPage() {
  const { profile } = useAuth();
  const orgId = profile?.organization_id;
  const qc = useQueryClient();
  const canCreate = profile?.role === 'client_admin';
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [agency, setAgency] = useState('');
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(20);
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [lines, setLines] = useState([emptyLine()]);
  const [notice, setNotice] = useState('');

  const { data: pos, isLoading, error: posError, refetch } = useQuery({
    queryKey: ['client-work-orders', orgId],
    queryFn: async () => {
      const rows: PoRow[] = [];
      // The Supabase REST default limit is 1,000 rows. Read all pages so
      // older Work Orders do not silently disappear from the list.
      for (let from = 0; ; from += 500) {
        const { data, error } = await supabase.from('purchase_orders')
          .select('id, po_number, name, po_date, status, assignment_status, fulfillment_type, delivery_receipt_required, assigned_agency_id, agency_org:organizations!purchase_orders_assigned_agency_id_fkey(name)')
          .eq('client_org_id', orgId).order('created_at', { ascending: false }).range(from, from + 499);
        if (error) throw error;
        rows.push(...(data as unknown as PoRow[] || []));
        if (!data || data.length < 500) break;
      }
      return rows;
    },
    enabled: !!orgId,
    staleTime: 15000,
  });
  // SQL-side aggregation avoids fetching thousands of shop rows just to count sites.
  const { data: shopCounts } = useQuery({
    queryKey: ['client-work-orders-site-counts', orgId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('client_shop_status_counts');
      if (error) throw error;
      return data as { purchase_order_id: string | null; status: string; shop_count: number }[];
    },
    enabled: !!orgId,
  });
  const { data: progress } = useQuery({
    queryKey: ['client-work-orders-progress', orgId],
    queryFn: async () => {
      const rows: ClientPOLineItemProgress[] = [];
      for (let from = 0; ; from += 500) {
        const { data, error } = await supabase.from('v_client_po_line_item_progress').select('*')
          .eq('client_org_id', orgId).order('purchase_order_id').order('po_line_item_id').range(from, from + 499);
        if (error) throw error;
        rows.push(...(data || []) as ClientPOLineItemProgress[]);
        if (!data || data.length < 500) break;
      }
      return rows;
    },
    enabled: !!orgId,
  });
  const { data: links } = useQuery({
    queryKey: ['client-work-orders-agencies', orgId],
    queryFn: async () => {
      const { data, error } = await supabase.from('client_agency_links')
        .select('*, agency_org:organizations!client_agency_links_agency_org_id_fkey(name)')
        .eq('client_org_id', orgId).eq('status', 'active');
      if (error) throw error;
      return data as LinkRow[];
    },
    enabled: !!orgId,
  });
  const assignable = (links || []).filter(l => !!l.agency_client_id);
  useClientRealtimeInvalidate(orgId, [
    ['client-work-orders', orgId],
    ['client-work-orders-site-counts', orgId],
    ['client-work-orders-progress', orgId],
  ]);

  const rows = useMemo(() => buildClientCampaignRows(pos || [], [], progress || [], shopCounts || []), [pos, shopCounts, progress]);
  const filtered = useMemo(() => rows.filter(r => {
    const term = search.trim().toLowerCase();
    return (!term || `${r.po_number} ${r.name || ''} ${r.agency_name}`.toLowerCase().includes(term))
      && (!status || r.work_status === status)
      && (!agency || r.agency_org_id === agency);
  }), [rows, search, status, agency]);
  const actualPage = Math.min(page, Math.max(0, Math.ceil(filtered.length / pageSize) - 1));
  const paged = filtered.slice(actualPage * pageSize, (actualPage + 1) * pageSize);
  const agencyOptions = useMemo(() => Array.from(new Map(rows.map(r => [r.agency_org_id, r.agency_name]).filter(([id]) => !!id)).entries()), [rows]);

  const createMutation = useMutation({
    mutationFn: async () => {
      if (!canCreate || !orgId) throw new Error('Only a client admin can create a Work Order.');
      const link = assignable.find(l => l.agency_org_id === form.agency_org_id);
      if (!link?.agency_client_id) throw new Error('Select an active, linked agency.');
      const orderNumber = form.po_number.trim();
      if (!orderNumber || !form.po_date || !lines.some(l => l.description.trim())) {
        throw new Error('PO number, date and at least one work item are required.');
      }
      for (const line of lines.filter(l => l.description.trim())) {
        const quantity = line.uom === 'sqft' ? line.budgeted_area : line.budgeted_qty;
        if (quantity && (!Number.isFinite(Number(quantity)) || Number(quantity) <= 0)) {
          throw new Error('Work item quantity/area must be a positive number.');
        }
      }
      const { data: po, error } = await supabase.from('purchase_orders').insert({
        organization_id: link.agency_org_id,
        client_id: link.agency_client_id,
        client_org_id: orgId,
        assigned_agency_id: link.agency_org_id,
        // Deliberately null: grouping is legacy, not a mandatory step.
        campaign_id: null,
        origin: 'client_created',
        assignment_status: 'pending_acceptance',
        po_number: orderNumber,
        name: form.name.trim() || null,
        po_date: form.po_date,
        fulfillment_type: form.fulfillment_type,
        notes: form.notes.trim() || null,
        payment_terms: form.payment_terms.trim() || null,
        created_by: profile?.id,
      }).select('id, po_number').single();
      if (error) throw error;
      const items = lines.filter(l => l.description.trim()).map(l => ({
        organization_id: link.agency_org_id,
        purchase_order_id: po.id,
        description: l.description.trim(),
        uom: l.uom,
        budgeted_qty: l.uom !== 'sqft' && l.budgeted_qty ? Number(l.budgeted_qty) : null,
        budgeted_area: l.uom === 'sqft' && l.budgeted_area ? Number(l.budgeted_area) : null,
      }));
      const { error: itemError } = await supabase.from('po_line_items').insert(items);
      if (itemError) {
        // A partially created order must not be reported as successfully submitted.
        const { error: cleanupError } = await supabase.from('purchase_orders').delete().eq('id', po.id);
        throw new Error(cleanupError
          ? `Work items failed: ${itemError.message}. The draft order could not be rolled back; contact an admin with PO ${orderNumber}.`
          : `Work items failed: ${itemError.message}. No order was submitted.`);
      }
      // Audit/notification are best effort; they must not trigger a retry that duplicates a committed PO.
      try {
        await logAudit('purchase_orders', po.id, 'insert', null, null, null, `Client created Work Order ${orderNumber}`);
        await notifyLinkedOrg(link.agency_org_id, 'New Work Order from a client', `${orderNumber} is waiting for Accept/Reject.`, 'info', '/purchase-orders');
      } catch (err) {
        console.warn('Work Order created, but notification/audit side effect failed', err);
      }
      return po.id as string;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['client-work-orders', orgId] });
      qc.invalidateQueries({ queryKey: ['client-overview-pos', orgId] });
      qc.invalidateQueries({ queryKey: ['client-reports-pos', orgId] });
      setCreateOpen(false);
      setForm(emptyForm());
      setLines([emptyLine()]);
      setNotice('Work Order sent to your agency for acceptance.');
    },
  });

  return (
    <div className="space-y-4">
      <PageHeader title="Work Orders" subtitle="Open, create and track all agency work directly — no extra grouping step."
        action={canCreate ? <button type="button" onClick={() => { setForm(emptyForm()); setLines([emptyLine()]); createMutation.reset(); setCreateOpen(true); }}
          disabled={assignable.length === 0} title={assignable.length === 0 ? 'Link an agency first' : undefined}
          className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"><Plus size={16} /> New Work Order</button> : undefined} />
      {notice && <div role="status" className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">{notice}</div>}
      {canCreate && assignable.length === 0 && <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">To send a Work Order, first <Link className="font-medium underline" to="/client/agencies">link an agency</Link>.</div>}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1"><Search size={16} className="absolute left-3 top-3 text-slate-400" />
          <input aria-label="Search work orders" value={search} onChange={e => { setSearch(e.target.value); setPage(0); }} placeholder="Search PO number, name or agency..." className="w-full rounded-lg border border-slate-300 py-2.5 pl-9 pr-3 text-sm focus-visible:outline-blue-600" /></div>
        <select aria-label="Filter Work Orders by status" value={status} onChange={e => { setStatus(e.target.value); setPage(0); }} className="rounded-lg border border-slate-300 p-2.5 text-sm"><option value="">All statuses</option>{Object.entries(CLIENT_PO_WORK_STATUS_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        {agencyOptions.length > 1 && <select aria-label="Filter by agency" value={agency} onChange={e => { setAgency(e.target.value); setPage(0); }} className="rounded-lg border border-slate-300 p-2.5 text-sm"><option value="">All agencies</option>{agencyOptions.map(([id, name]) => <option key={id} value={id!}>{name}</option>)}</select>}
        <span role="status" className="text-xs text-slate-500">{filtered.length} Work Orders</span>
      </div>
      {posError && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">Unable to load Work Orders: {(posError as Error).message} <button className="underline" onClick={() => refetch()}>Retry</button></div>}
      {isLoading && <div className="flex gap-2 p-6 text-sm text-slate-500"><Loader2 className="animate-spin" size={18}/> Loading Work Orders...</div>}
      {!isLoading && filtered.length === 0 && <Card className="p-8"><EmptyState icon={<ShoppingCart size={36}/>} title={rows.length ? 'No matching Work Orders' : 'No Work Orders yet'} subtitle={rows.length ? 'Try clearing the filters.' : 'Create a Work Order and send it directly to a linked agency.'}/></Card>}
      <div className="space-y-2">
        {paged.map(r => <Link to={`/client/work-orders/${r.po_id}`} key={r.po_id} className="block rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition hover:border-blue-300 hover:bg-blue-50/30 focus-visible:outline-blue-600">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0 flex-1"><p className="font-semibold text-slate-900">{r.name || r.po_number}</p><p className="text-xs text-slate-500">{r.po_number} · {r.agency_name} · {new Date(r.po_date).toLocaleDateString('en-IN')}</p></div>
            <div className="flex flex-wrap items-center gap-3"><span className={`rounded-full px-2 py-1 text-xs font-medium ${CLIENT_PO_WORK_STATUS_COLORS[r.work_status]}`}>{CLIENT_PO_WORK_STATUS_LABELS[r.work_status]}</span>
              <span className="text-xs tabular-nums text-slate-500">{r.sites_total} sites</span>
              <div className="w-24 text-xs text-slate-500"><ProgressBar pct={r.work_status === 'completed' ? 100 : r.completion_pct}/></div><ArrowRight size={16} className="text-slate-400" /></div>
          </div>
        </Link>)}
      </div>
      {filtered.length > pageSize && <Pagination page={actualPage} pageSize={pageSize} totalItems={filtered.length} onPageChange={setPage} onPageSizeChange={s => { setPageSize(s); setPage(0); }} pageSizeOptions={PAGE_SIZES} itemLabel="Work Orders" />}
      <Modal open={createOpen} onClose={() => { if (!createMutation.isPending) setCreateOpen(false); }} title="New Work Order" size="lg">
        <form onSubmit={e => { e.preventDefault(); if (!createMutation.isPending) createMutation.mutate(); }} className="space-y-4">
          <Select label="Assign Agency" required value={form.agency_org_id} onChange={v => setForm(f => ({ ...f, agency_org_id: v }))} options={assignable.map(a => ({ value: a.agency_org_id, label: a.agency_org?.name || 'Agency' }))} />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2"><Input label="PO Number" required value={form.po_number} onChange={v => setForm(f => ({ ...f, po_number: v }))} /><Input label="PO Date" type="date" required value={form.po_date} onChange={v => setForm(f => ({ ...f, po_date: v }))}/></div>
          <Input label="Work Order Name (optional)" value={form.name} onChange={v => setForm(f => ({...f, name:v}))} />
          <Select label="Fulfillment" value={form.fulfillment_type} onChange={v => setForm(f => ({...f, fulfillment_type:v}))} options={FULFILLMENT_PRESETS}/>
          <div className="space-y-2 rounded-lg border border-slate-200 p-3"><div className="flex items-center justify-between"><h3 className="text-sm font-semibold">Work items</h3><button type="button" onClick={() => setLines(v => [...v, emptyLine()])} className="flex items-center gap-1 text-xs font-semibold text-blue-600"><Plus size={14}/> Add item</button></div>
            {lines.map((line, idx) => <div key={idx} className="grid grid-cols-1 items-end gap-2 border-t border-slate-100 pt-2 sm:grid-cols-[minmax(0,1fr)_100px_120px_30px]">
              <Input label={`Item ${idx + 1}`} value={line.description} onChange={v => setLines(arr => arr.map((l, i) => i === idx ? {...l,description:v}:l))} placeholder="e.g. Dealer signboard" />
              <Select label="Unit" value={line.uom} onChange={v => setLines(arr => arr.map((l, i) => i === idx ? {...l,uom:v}:l))} options={UOMS}/>
              <Input label={line.uom === 'sqft' ? 'Area (sq.ft)' : 'Quantity'} type="number" value={line.uom === 'sqft' ? line.budgeted_area : line.budgeted_qty} onChange={v => setLines(arr => arr.map((l, i) => i === idx ? {...l, [l.uom === 'sqft' ? 'budgeted_area' : 'budgeted_qty']:v}:l))}/>
              <button type="button" title="Remove item" aria-label={`Remove item ${idx+1}`} disabled={lines.length === 1} onClick={() => setLines(arr => arr.filter((_,i) => i !== idx))} className="mb-2 text-slate-400 hover:text-red-600 disabled:opacity-30"><Trash2 size={16}/></button>
            </div>)}
          </div>
          <Textarea label="Notes (optional)" value={form.notes} onChange={v => setForm(f => ({...f,notes:v}))}/>
          {createMutation.isError && <p role="alert" className="text-sm text-red-700">{(createMutation.error as Error).message}</p>}
          <button type="submit" disabled={createMutation.isPending || !form.agency_org_id || !form.po_number.trim() || !lines.some(l => l.description.trim())} className="flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-3 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50">{createMutation.isPending && <Loader2 size={16} className="animate-spin"/>}{createMutation.isPending ? 'Sending...' : 'Create & Send to Agency'}</button>
          <p className="text-xs text-slate-500">The agency receives a Work Order awaiting acceptance. Financial amounts remain agency-only.</p>
        </form>
      </Modal>
    </div>
  );
}
