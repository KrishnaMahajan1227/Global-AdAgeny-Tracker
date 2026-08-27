import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { Card, StatusBadge, EmptyState, PageHeader, Modal, Input, Select, Textarea, ConfirmDialog, FilterButton, FilterDrawer, FilterSection, Combobox } from '@/components/ui';
import { logAudit } from '@/lib/helpers';
import { generateInvoicePDF } from '@/lib/reports';
import { computeUtilization, formatRupees, UtilizationStage } from '@/lib/poUtilization';
import { Plus, FileText, Download, Trash2, ChevronRight, ShoppingCart, AlertTriangle, Pencil, Info } from 'lucide-react';
import type { Organization, Client, Invoice, InvoiceItem, PurchaseOrder, POLineItemUtilization, Project } from '@/lib/types';
import { INDIA_STATES, INDIA_CITIES_BY_STATE, ALL_INDIA_CITIES } from '@/lib/indiaLocations';

// Every line item bills by EITHER quantity OR area, never both blindly
// multiplied together — 'basis' says which one the rate actually applies
// to. This matters a lot for this business: rate cards are commonly
// "per sqft" (flex boards, hoardings) and PO line items carry a UOM of
// 'sqft'/'piece'/'lot' for exactly this reason. Defaults to 'quantity' for
// a blank manual row; auto-switches to 'area' the moment a PO line item
// with uom='sqft' is picked, or the user explicitly picks Area.
const emptyItem = { description: '', quantity: '1', area: '', rate: '', amount: '0', po_line_item_id: '', hsn_code: '', basis: 'quantity' as 'quantity' | 'area', notes: '' };

const emptyForm = {
  client_id: '', project_id: '', purchase_order_id: '', invoice_date: new Date().toISOString().split('T')[0],
  due_date: '', gst_rate: '18', gst_type: 'intra' as 'intra' | 'inter', notes: '', terms: '',
  bill_to_name: '', bill_to_address: '', bill_to_city: '', bill_to_state: '', bill_to_gst: '',
  items: [emptyItem],
};

const GST_RATE_PRESETS = ['0', '5', '12', '18', '28'];

/** Round to 2 decimals, avoiding classic floating-point drift (e.g. 0.1 + 0.2). */
function round2(n: number) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** The number the rate actually multiplies against — area for 'area'-basis
 *  items (e.g. Rs 500/sqft × 50 sqft), quantity for 'quantity'-basis items
 *  (e.g. Rs 200/piece × 4 pieces). This is the crux of correct billing math
 *  for a business where BOTH units are recorded on every item but only one
 *  of them should ever drive the amount. */
function billableUnits(item: { quantity: string; area: string; basis: 'quantity' | 'area' }) {
  if (item.basis === 'area') {
    const area = parseFloat(item.area);
    return area > 0 ? area : 0;
  }
  return parseFloat(item.quantity) || 1;
}

/** When re-opening a saved invoice for editing, work out which basis it was
 *  originally billed on (the DB doesn't store this explicitly) by checking
 *  which of area×rate or quantity×rate actually reconstructs the saved
 *  amount. Falls back to 'area' when area is present and quantity isn't a
 *  clean match, since that's the far more common case for this business. */
function inferBasis(item: { quantity: number; area: number | null; rate: number; amount: number }): 'quantity' | 'area' {
  if (item.area == null || item.area <= 0) return 'quantity';
  const areaAmount = item.area * item.rate;
  const qtyAmount = item.quantity * item.rate;
  const areaDiff = Math.abs(areaAmount - item.amount);
  const qtyDiff = Math.abs(qtyAmount - item.amount);
  return areaDiff <= qtyDiff ? 'area' : 'quantity';
}

export default function BillingPage() {
  const { profile } = useAuth();
  const orgId = profile?.organization_id;
  const queryClient = useQueryClient();
  const [modalOpen, setModalOpen] = useState(false);
  const [editingInvoiceId, setEditingInvoiceId] = useState<string | null>(null);
  const [viewInvoice, setViewInvoice] = useState<any | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<any | null>(null);
  const [search, setSearch] = useState('');
  const [clientFilterList, setClientFilterList] = useState('');
  const [statusFilterList, setStatusFilterList] = useState('');
  const [listSortBy, setListSortBy] = useState('date_desc');
  const [filterDrawerOpen, setFilterDrawerOpen] = useState(false);
  const [form, setForm] = useState({ ...emptyForm, items: [{ ...emptyItem }] });

  const { data: org } = useQuery({
    queryKey: ['organization', orgId],
    queryFn: async () => {
      const { data } = await supabase.from('organizations').select('*').eq('id', orgId).maybeSingle();
      return data as Organization | null;
    },
    enabled: !!orgId,
  });

  const { data: clients } = useQuery({
    queryKey: ['clients', orgId],
    queryFn: async () => {
      const { data } = await supabase.from('clients').select('*').eq('organization_id', orgId).eq('is_active', true).order('name');
      return data as Client[];
    },
    enabled: !!orgId,
  });

  // Every project for the org, filtered client-side to the selected client —
  // same pattern the Purchase Orders page already uses. Lets the invoice
  // auto-fill (or let the owner manually pick) which project it belongs to,
  // instead of that field silently sitting unused.
  const { data: allProjects } = useQuery({
    queryKey: ['projects-for-billing', orgId],
    queryFn: async () => {
      const { data, error } = await supabase.from('projects').select('id, organization_id, client_id, name, description, start_date, end_date, status, is_demo, created_at').eq('organization_id', orgId).order('name');
      if (error) throw error;
      return data as Project[];
    },
    enabled: !!orgId,
  });
  const projectsForClient = (allProjects || []).filter((p) => !form.client_id || p.client_id === form.client_id);

  const { data: invoices } = useQuery({
    queryKey: ['invoices', orgId],
    queryFn: async () => {
      const { data } = await supabase
        .from('invoices')
        .select('*, clients(name, address, city, state, gst_number), purchase_orders(po_number, name, payment_terms), invoice_items(*)')
        .eq('organization_id', orgId)
        .order('created_at', { ascending: false });
      return data;
    },
    enabled: !!orgId,
  });

  // Phase 6 — PO reconciliation on the Billing page: let an invoice
  // optionally be raised against a PO (filtered to the invoice's client)
  // so line items can be picked from the PO's budget and the remaining
  // balance is visible before the invoice is created.
  const { data: purchaseOrders } = useQuery({
    queryKey: ['purchase-orders-for-billing', orgId, form.client_id],
    queryFn: async () => {
      let q = supabase.from('purchase_orders').select('*').eq('organization_id', orgId).eq('status', 'active');
      if (form.client_id) q = q.eq('client_id', form.client_id);
      const { data, error } = await q.order('po_date', { ascending: false });
      if (error) throw error;
      return data as PurchaseOrder[];
    },
    enabled: !!orgId && !!form.client_id,
  });

  const { data: poUtilization } = useQuery({
    queryKey: ['po-utilization-for-billing', orgId, form.purchase_order_id],
    queryFn: async () => {
      const { data, error } = await supabase.from('v_po_line_item_utilization').select('*').eq('purchase_order_id', form.purchase_order_id);
      if (error) throw error;
      return data as POLineItemUtilization[];
    },
    enabled: !!orgId && !!form.purchase_order_id,
  });

  const selectedPO = (purchaseOrders || []).find((po) => po.id === form.purchase_order_id) || null;
  const poStage: UtilizationStage = selectedPO?.fulfillment_type === 'supply_only' ? 'produced' : 'installed';
  const isEditing = !!editingInvoiceId;
  const editingSourceInvoice = (invoices || []).find((i: any) => i.id === editingInvoiceId) || null;

  function buildInvoiceItems() {
    return form.items
      .filter((item) => item.description.trim() !== '' || (parseFloat(item.rate) || 0) > 0)
      .map((item) => {
        const quantity = parseFloat(item.quantity) || 1;
        const rate = parseFloat(item.rate) || 0;
        const units = billableUnits(item);
        return {
          description: item.description,
          quantity,
          area: item.area !== '' ? parseFloat(item.area) : null,
          rate,
          amount: round2(units * rate),
          po_line_item_id: item.po_line_item_id || null,
          hsn_code: item.hsn_code || null,
          notes: item.notes || null,
        };
      });
  }

  // Splits the single GST rate the owner picked into CGST+SGST (intra-
  // state) or IGST (inter-state) — this is the actual breakdown a GST-
  // compliant invoice has to show, computed off the current subtotal so
  // it stays live as line items change.
  function computeGstSplit(subtotal: number) {
    const rate = parseFloat(form.gst_rate) || 0;
    if (form.gst_type === 'intra') {
      const cgstRate = round2(rate / 2);
      const sgstRate = round2(rate / 2);
      return {
        cgstRate, sgstRate, igstRate: 0,
        cgstAmount: round2((subtotal * cgstRate) / 100),
        sgstAmount: round2((subtotal * sgstRate) / 100),
        igstAmount: 0,
      };
    }
    return {
      cgstRate: 0, sgstRate: 0, igstRate: rate,
      cgstAmount: 0, sgstAmount: 0,
      igstAmount: round2((subtotal * rate) / 100),
    };
  }

  function computeTotals(items: ReturnType<typeof buildInvoiceItems>) {
    const subtotal = round2(items.reduce((sum, i) => sum + i.amount, 0));
    const split = computeGstSplit(subtotal);
    const taxRate = round2(split.cgstRate + split.sgstRate + split.igstRate);
    const taxAmount = round2(split.cgstAmount + split.sgstAmount + split.igstAmount);
    const total = round2(subtotal + taxAmount);
    return { subtotal, taxRate, taxAmount, total, ...split };
  }

  const createInvoiceMutation = useMutation({
    mutationFn: async () => {
      const items = buildInvoiceItems();
      if (items.length === 0) throw new Error('Add at least one line item with a description and rate.');
      const { subtotal, taxRate, taxAmount, total, cgstRate, cgstAmount, sgstRate, sgstAmount, igstRate, igstAmount } = computeTotals(items);

      const invNumber = `INV-${Date.now().toString().slice(-6)}`;

      const { data: inv, error } = await supabase.from('invoices').insert({
        organization_id: orgId,
        client_id: form.client_id,
        project_id: form.project_id || null,
        purchase_order_id: form.purchase_order_id || null,
        invoice_number: invNumber,
        invoice_date: form.invoice_date,
        due_date: form.due_date || null,
        subtotal,
        tax_rate: taxRate,
        tax_amount: taxAmount,
        cgst_rate: cgstRate,
        cgst_amount: cgstAmount,
        sgst_rate: sgstRate,
        sgst_amount: sgstAmount,
        igst_rate: igstRate,
        igst_amount: igstAmount,
        total,
        payment_status: 'unpaid',
        notes: form.notes || null,
        terms: form.terms || null,
        bill_to_name: form.bill_to_name || null,
        bill_to_address: form.bill_to_address || null,
        bill_to_city: form.bill_to_city || null,
        bill_to_state: form.bill_to_state || null,
        bill_to_gst: form.bill_to_gst || null,
      }).select().single();

      if (error) throw error;

      for (const item of items) {
        const { error: itemError } = await supabase.from('invoice_items').insert({
          organization_id: orgId,
          invoice_id: inv.id,
          description: item.description,
          quantity: item.quantity,
          area: item.area,
          rate: item.rate,
          amount: item.amount,
          po_line_item_id: item.po_line_item_id,
          hsn_code: item.hsn_code,
          notes: item.notes,
        });
        if (itemError) throw itemError;
      }

      // Update shop statuses to billed — installed (survey_install flow) or
      // dispatched (Supply Only flow, Phase 5) are both billing-eligible.
      await supabase.from('shops').update({ status: 'billed' }).eq('client_id', form.client_id).in('status', ['installed', 'dispatched']);

      await logAudit('invoices', inv.id, 'insert', null, null, null, `Created invoice ${invNumber} for ${total}`);
      return inv;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['invoices', orgId] });
      queryClient.invalidateQueries({ queryKey: ['po-utilization-for-billing', orgId, form.purchase_order_id] });
      queryClient.invalidateQueries({ queryKey: ['po-utilization', orgId] });
      setModalOpen(false);
    },
  });

  // Owner/admin/accounts can revise an existing invoice — fixes a wrong
  // rate, adds a missed item, updates the Bill To details, etc — instead of
  // the only option being delete-and-recreate. Line items are replaced
  // wholesale (delete all, re-insert) since that's simplest and safest way
  // to keep them in sync with the edited form; the invoice row itself keeps
  // its id/invoice_number/created_at, so PO reconciliation and any existing
  // references to this invoice stay intact.
  const updateInvoiceMutation = useMutation({
    mutationFn: async () => {
      if (!editingInvoiceId) throw new Error('No invoice selected for edit.');
      const items = buildInvoiceItems();
      if (items.length === 0) throw new Error('Add at least one line item with a description and rate.');
      const { subtotal, taxRate, taxAmount, total, cgstRate, cgstAmount, sgstRate, sgstAmount, igstRate, igstAmount } = computeTotals(items);

      const { error: updateError } = await supabase.from('invoices').update({
        client_id: form.client_id,
        project_id: form.project_id || null,
        purchase_order_id: form.purchase_order_id || null,
        invoice_date: form.invoice_date,
        due_date: form.due_date || null,
        subtotal,
        tax_rate: taxRate,
        tax_amount: taxAmount,
        cgst_rate: cgstRate,
        cgst_amount: cgstAmount,
        sgst_rate: sgstRate,
        sgst_amount: sgstAmount,
        igst_rate: igstRate,
        igst_amount: igstAmount,
        total,
        notes: form.notes || null,
        terms: form.terms || null,
        bill_to_name: form.bill_to_name || null,
        bill_to_address: form.bill_to_address || null,
        bill_to_city: form.bill_to_city || null,
        bill_to_state: form.bill_to_state || null,
        bill_to_gst: form.bill_to_gst || null,
      }).eq('id', editingInvoiceId);
      if (updateError) throw updateError;

      const { error: deleteError } = await supabase.from('invoice_items').delete().eq('invoice_id', editingInvoiceId);
      if (deleteError) throw deleteError;

      for (const item of items) {
        const { error: itemError } = await supabase.from('invoice_items').insert({
          organization_id: orgId,
          invoice_id: editingInvoiceId,
          description: item.description,
          quantity: item.quantity,
          area: item.area,
          rate: item.rate,
          amount: item.amount,
          po_line_item_id: item.po_line_item_id,
          hsn_code: item.hsn_code,
          notes: item.notes,
        });
        if (itemError) throw itemError;
      }

      await logAudit('invoices', editingInvoiceId, 'update', null, null, null, `Edited invoice — new total ${total}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['invoices', orgId] });
      queryClient.invalidateQueries({ queryKey: ['po-utilization-for-billing', orgId, form.purchase_order_id] });
      queryClient.invalidateQueries({ queryKey: ['po-utilization', orgId] });
      setModalOpen(false);
      setEditingInvoiceId(null);
    },
  });

  const deleteInvoiceMutation = useMutation({
    mutationFn: async (inv: any) => {
      await supabase.from('invoices').delete().eq('id', inv.id);
      await logAudit('invoices', inv.id, 'delete', null, null, null, `Deleted invoice ${inv.invoice_number}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['invoices', orgId] });
      queryClient.invalidateQueries({ queryKey: ['po-utilization-for-billing', orgId] });
      queryClient.invalidateQueries({ queryKey: ['po-utilization', orgId] });
      setDeleteTarget(null);
      setViewInvoice(null);
    },
  });

  const updatePaymentStatus = useMutation({
    mutationFn: async ({ inv, status }: { inv: Invoice; status: string }) => {
      await supabase.from('invoices').update({ payment_status: status }).eq('id', inv.id);
      await logAudit('invoices', inv.id, 'update', 'payment_status', inv.payment_status, status, `Payment status changed to ${status}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['invoices', orgId] });
    },
  });

  async function downloadInvoice(inv: any) {
    const client = (clients || []).find((c) => c.id === inv.client_id);
    await generateInvoicePDF(inv, inv.invoice_items || [], client || null, org);
  }

  function addItem() {
    setForm({ ...form, items: [...form.items, { ...emptyItem }] });
  }

  function removeItem(idx: number) {
    setForm({ ...form, items: form.items.filter((_, i) => i !== idx) });
  }

  function updateItem(idx: number, field: string, value: string) {
    const items = form.items.map((it, i) => {
      if (i !== idx) return it;
      const updated = { ...it, [field]: value } as typeof it;
      const rate = parseFloat(updated.rate) || 0;
      updated.amount = round2(billableUnits(updated) * rate).toString();
      return updated;
    });
    setForm({ ...form, items });
  }

  /** Explicitly switch what a line item bills against (Qty vs Area) —
   *  recomputes the amount immediately so the change is never silent. */
  function setItemBasis(idx: number, basis: 'quantity' | 'area') {
    updateItem(idx, 'basis', basis);
  }

  // Selecting a client auto-fills the Bill To block from that client's
  // master record (address/GST/city/state) — still fully editable by the
  // owner afterwards, since it's saved onto the invoice itself, not read
  // live from `clients` at PDF time.
  function selectClient(clientId: string) {
    const client = (clients || []).find((c) => c.id === clientId);
    setForm({
      ...form,
      client_id: clientId,
      purchase_order_id: '',
      project_id: '',
      bill_to_name: client?.name || '',
      bill_to_address: client?.address || '',
      bill_to_city: client?.city || '',
      bill_to_state: client?.state || '',
      bill_to_gst: client?.gst_number || '',
    });
  }

  // Picking a PO auto-fills the project it belongs to, the tax rate it
  // declares (Section 3.1 sanity check), and carries its payment terms
  // onto the invoice — so an invoice raised against a PO starts in
  // agreement with that PO's own paperwork instead of blank defaults.
  function selectPO(poId: string) {
    const po = (purchaseOrders || []).find((p) => p.id === poId);
    setForm({
      ...form,
      purchase_order_id: poId,
      project_id: po?.project_id || form.project_id,
      gst_rate: po?.gst_percentage != null ? String(po.gst_percentage) : form.gst_rate,
      terms: po?.payment_terms ? po.payment_terms : form.terms,
    });
  }

  // Picking a PO line item autofills description + rate + HSN code from
  // the budget row (owner can still edit all three after) and remembers
  // the link so it's saved on the invoice_item for reconciliation. It also
  // sets the billing basis to match the PO line item's own UOM — a
  // 'sqft' line item bills by area, 'piece'/'lot' bills by quantity — so
  // the invoice amount is computed the same way that line item's budget
  // and utilization already are, instead of always defaulting to qty.
  function pickLineItemForRow(idx: number, lineItemId: string) {
    const row = (poUtilization || []).find((r) => r.po_line_item_id === lineItemId);
    const items = form.items.map((it, i) => {
      if (i !== idx) return it;
      if (!row) return { ...it, po_line_item_id: '' };
      const rate = row.rate != null ? row.rate.toString() : it.rate;
      const basis: 'quantity' | 'area' = row.uom === 'sqft' ? 'area' : 'quantity';
      // Qty/Area auto-fills from the ACTUAL completed work for this line
      // item (installed for Survey+Install POs, produced for Supply Only)
      // — not the budgeted figure — so the invoice starts out matching
      // what's really been done on the ground. Still fully editable
      // afterwards for partial billing.
      const fig = computeUtilization(row, poStage);
      const actual = fig.actualPrimary > 0 ? fig.actualPrimary.toString() : (basis === 'area' ? it.area : it.quantity);
      const updated = {
        ...it, po_line_item_id: lineItemId, description: row.description, rate, hsn_code: row.hsn_code || it.hsn_code, basis,
        quantity: basis === 'quantity' ? actual : it.quantity,
        area: basis === 'area' ? actual : it.area,
      };
      updated.amount = round2(billableUnits(updated) * (parseFloat(updated.rate) || 0)).toString();
      return updated;
    });
    setForm({ ...form, items });
  }

  function openCreateModal() {
    setEditingInvoiceId(null);
    setForm({ ...emptyForm, items: [{ ...emptyItem }] });
    setModalOpen(true);
  }

  function openEditModal(inv: any) {
    setEditingInvoiceId(inv.id);
    setForm({
      client_id: inv.client_id || '',
      project_id: inv.project_id || '',
      purchase_order_id: inv.purchase_order_id || '',
      invoice_date: inv.invoice_date ? inv.invoice_date.split('T')[0] : new Date().toISOString().split('T')[0],
      due_date: inv.due_date ? inv.due_date.split('T')[0] : '',
      // Reconstruct GST type + combined rate from whichever breakdown the
      // invoice actually has. Invoices from before this split existed
      // have cgst/sgst/igst all at 0 with only tax_rate set — treated as
      // intra-state by default so editing one still shows a sensible
      // starting point instead of 0%.
      gst_type: (inv.igst_rate ?? 0) > 0 ? 'inter' as const : 'intra' as const,
      gst_rate: (inv.igst_rate ?? 0) > 0
        ? String(inv.igst_rate)
        : ((inv.cgst_rate ?? 0) > 0 || (inv.sgst_rate ?? 0) > 0)
          ? String((inv.cgst_rate ?? 0) + (inv.sgst_rate ?? 0))
          : String(inv.tax_rate ?? '18'),
      notes: inv.notes || '',
      terms: inv.terms || '',
      bill_to_name: inv.bill_to_name || inv.clients?.name || '',
      bill_to_address: inv.bill_to_address || inv.clients?.address || '',
      bill_to_city: inv.bill_to_city || inv.clients?.city || '',
      bill_to_state: inv.bill_to_state || inv.clients?.state || '',
      bill_to_gst: inv.bill_to_gst || inv.clients?.gst_number || '',
      items: (inv.invoice_items && inv.invoice_items.length > 0
        ? inv.invoice_items.map((it: InvoiceItem) => ({
            description: it.description,
            quantity: String(it.quantity ?? 1),
            area: it.area != null ? String(it.area) : '',
            rate: String(it.rate ?? 0),
            amount: String(it.amount ?? 0),
            po_line_item_id: it.po_line_item_id || '',
            hsn_code: it.hsn_code || '',
            basis: inferBasis(it),
            notes: it.notes || '',
          }))
        : [{ ...emptyItem }]),
    });
    setViewInvoice(null);
    setModalOpen(true);
  }

  const previewItems = buildInvoiceItems();
  const gstSplit = computeTotals(previewItems);
  const { subtotal, total } = gstSplit;
  const isSaving = createInvoiceMutation.isPending || updateInvoiceMutation.isPending;
  const saveError = (createInvoiceMutation.error || updateInvoiceMutation.error) as Error | undefined;

  const filteredInvoiceList = (invoices || []).filter((inv: any) => {
    if (search) {
      const term = search.toLowerCase();
      const matches = inv.invoice_number.toLowerCase().includes(term) || (inv.bill_to_name || inv.clients?.name || '').toLowerCase().includes(term) || (inv.purchase_orders?.po_number || '').toLowerCase().includes(term) || (inv.purchase_orders?.name || '').toLowerCase().includes(term);
      if (!matches) return false;
    }
    if (clientFilterList && inv.client_id !== clientFilterList) return false;
    if (statusFilterList && inv.payment_status !== statusFilterList) return false;
    return true;
  });

  const sortedInvoiceList = [...filteredInvoiceList].sort((a: any, b: any) => {
    switch (listSortBy) {
      case 'date_asc':
        return new Date(a.invoice_date).getTime() - new Date(b.invoice_date).getTime();
      case 'amount_desc':
        return (b.total || 0) - (a.total || 0);
      case 'client_asc':
        return (a.bill_to_name || a.clients?.name || '').localeCompare(b.bill_to_name || b.clients?.name || '');
      case 'invoice_number_asc':
        return a.invoice_number.localeCompare(b.invoice_number);
      case 'date_desc':
      default:
        return new Date(b.invoice_date).getTime() - new Date(a.invoice_date).getTime();
    }
  });
  const listActiveFilterCount = [clientFilterList, statusFilterList].filter(Boolean).length;
  const LIST_SORT_OPTIONS = [
    { value: 'date_desc', label: 'Invoice Date (Newest first)' },
    { value: 'date_asc', label: 'Invoice Date (Oldest first)' },
    { value: 'amount_desc', label: 'Amount (Highest first)' },
    { value: 'client_asc', label: 'Client (A–Z)' },
    { value: 'invoice_number_asc', label: 'Invoice No. (A–Z)' },
  ];

  return (
    <div>
      <PageHeader
        title="Billing & Invoices"
        subtitle="Create and manage invoices"
        action={
          <button onClick={openCreateModal} className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg font-medium text-sm transition">
            <Plus className="w-4 h-4" /> Create Invoice
          </button>
        }
      />

      <div className="flex flex-wrap items-center gap-2 mb-5">
        <div className="relative flex-1 min-w-[220px]">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search invoice no., client, or PO..."
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <select value={listSortBy} onChange={(e) => setListSortBy(e.target.value)} className="px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500">
          {LIST_SORT_OPTIONS.map((o) => <option key={o.value} value={o.value}>Sort: {o.label}</option>)}
        </select>
        <FilterButton activeCount={listActiveFilterCount} onClick={() => setFilterDrawerOpen(true)} />
        {(search || listActiveFilterCount > 0) && <span className="text-xs text-slate-400">{filteredInvoiceList.length} of {(invoices || []).length} shown</span>}
      </div>

      <FilterDrawer
        open={filterDrawerOpen}
        onClose={() => setFilterDrawerOpen(false)}
        onClear={() => { setClientFilterList(''); setStatusFilterList(''); }}
        activeCount={listActiveFilterCount}
        resultCount={filteredInvoiceList.length}
        resultLabel="invoices"
      >
        <FilterSection label="Client">
          <select value={clientFilterList} onChange={(e) => setClientFilterList(e.target.value)} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500">
            <option value="">All Clients</option>
            {(clients || []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </FilterSection>
        <FilterSection label="Payment Status">
          <select value={statusFilterList} onChange={(e) => setStatusFilterList(e.target.value)} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500">
            <option value="">All Statuses</option>
            <option value="unpaid">Unpaid</option>
            <option value="partial">Partial</option>
            <option value="paid">Paid</option>
            <option value="overdue">Overdue</option>
          </select>
        </FilterSection>
      </FilterDrawer>

      <div className="space-y-3">
        {sortedInvoiceList.map((inv: any) => (
          <Card key={inv.id} className="p-4">
            <div className="flex items-start justify-between mb-3">
              <div>
                <p className="font-semibold text-slate-900">{inv.invoice_number}</p>
                <p className="text-sm text-slate-500">{inv.bill_to_name || inv.clients?.name}</p>
                <p className="text-xs text-slate-400">Date: {new Date(inv.invoice_date).toLocaleDateString('en-IN')}</p>
                {inv.purchase_orders?.po_number && (
                  <span className="inline-flex items-center gap-1 mt-1 px-2 py-0.5 rounded-full text-xs font-medium bg-slate-100 text-slate-600">
                    <ShoppingCart className="w-3 h-3" /> {inv.purchase_orders.name ? `${inv.purchase_orders.name} (${inv.purchase_orders.po_number})` : `PO ${inv.purchase_orders.po_number}`}
                  </span>
                )}
              </div>
              <div className="text-right">
                <p className="text-lg font-bold text-slate-900">Rs {inv.total.toLocaleString('en-IN')}</p>
                <StatusBadge status={inv.payment_status} />
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <button onClick={() => setViewInvoice(inv)} className="text-sm text-blue-600 hover:underline mr-auto flex items-center gap-1">
                View Items <ChevronRight className="w-4 h-4" />
              </button>
              <select
                value={inv.payment_status}
                onChange={(e) => updatePaymentStatus.mutate({ inv, status: e.target.value })}
                className="text-xs border border-slate-300 rounded px-2 py-1 bg-white"
              >
                <option value="unpaid">Unpaid</option>
                <option value="partial">Partial</option>
                <option value="paid">Paid</option>
                <option value="overdue">Overdue</option>
              </select>
              <button onClick={() => openEditModal(inv)} className="flex items-center gap-1 bg-slate-100 hover:bg-slate-200 text-slate-700 px-3 py-1.5 rounded-lg text-sm font-medium">
                <Pencil className="w-4 h-4" /> Edit
              </button>
              <button onClick={() => downloadInvoice(inv)} className="flex items-center gap-1 bg-slate-100 hover:bg-slate-200 text-slate-700 px-3 py-1.5 rounded-lg text-sm font-medium">
                <Download className="w-4 h-4" /> PDF
              </button>
              <button onClick={() => setDeleteTarget(inv)} className="flex items-center gap-1 text-red-600 hover:bg-red-50 px-3 py-1.5 rounded-lg text-sm font-medium">
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          </Card>
        ))}
        {(!invoices || invoices.length === 0) && (
          <Card><EmptyState icon={<FileText className="w-12 h-12" />} title="No invoices yet" subtitle="Create your first invoice" /></Card>
        )}
      </div>

      {/* Create / Edit Invoice Modal */}
      <Modal open={modalOpen} onClose={() => { setModalOpen(false); setEditingInvoiceId(null); }} title={isEditing ? `Edit Invoice ${editingSourceInvoice?.invoice_number || ''}` : 'Create Invoice'} size="xl">
        <div className="space-y-4">
          {isEditing && editingSourceInvoice?.payment_status === 'paid' && (
            <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-xs text-amber-800">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>This invoice is already marked <strong>Paid</strong>. You can still edit it, but double-check with accounts before changing amounts on a settled invoice.</span>
            </div>
          )}

          <Select label="Client" value={form.client_id} onChange={selectClient} options={(clients || []).map((c) => ({ value: c.id, label: c.name }))} required />

          {projectsForClient.length > 0 && (
            <Select
              label="Project (optional)"
              value={form.project_id}
              onChange={(v) => setForm({ ...form, project_id: v })}
              options={projectsForClient.map((p) => ({ value: p.id, label: p.name }))}
            />
          )}

          <Select
            label="Purchase Order (optional)"
            value={form.purchase_order_id}
            onChange={selectPO}
            options={(purchaseOrders || []).map((po) => ({ value: po.id, label: po.name ? `${po.name} (${po.po_number})` : po.po_number }))}
          />
          {form.client_id && (purchaseOrders || []).length === 0 && (
            <p className="text-xs text-slate-400 -mt-2">No active POs for this client — invoice can still be created without one.</p>
          )}

          {selectedPO?.gst_percentage != null && parseFloat(form.gst_rate) !== selectedPO.gst_percentage && (
            <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-xs text-amber-800">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>
                {selectedPO.name ? `${selectedPO.name} (${selectedPO.po_number})` : `PO ${selectedPO.po_number}`} says <strong>{selectedPO.gst_percentage}% GST</strong>, this invoice is charging{' '}
                <strong>{form.gst_rate || 0}%</strong>. Double-check before sending — this is just a flag, not a block.
              </span>
            </div>
          )}

          {selectedPO && (
            <div className="border border-slate-200 rounded-lg p-3 bg-slate-50 space-y-2">
              <p className="text-xs font-medium text-slate-600 flex items-center gap-1"><ShoppingCart className="w-3.5 h-3.5" /> PO line items — pick one per invoice item below to track balance</p>
              {(poUtilization || []).map((row) => {
                const fig = computeUtilization(row, poStage);
                return (
                  <div key={row.po_line_item_id} className="flex items-center justify-between text-xs gap-2">
                    <span className="text-slate-700 truncate">{row.description}{row.hsn_code ? ` (HSN ${row.hsn_code})` : ''}</span>
                    <span className={`font-medium whitespace-nowrap ${fig.remainingBalance != null && fig.remainingBalance < 0 ? 'text-red-600' : 'text-slate-600'}`}>
                      Balance: {formatRupees(fig.remainingBalance)}
                    </span>
                  </div>
                );
              })}
              {(poUtilization || []).length === 0 && <p className="text-xs text-slate-400">This PO has no line items yet.</p>}
            </div>
          )}

          {/* Bill To — auto-filled from the client above, but the owner can adjust anything here before saving; it's saved onto the invoice itself so this document stays frozen even if the client master record changes later. */}
          <div className="border border-slate-200 rounded-lg p-3 space-y-3">
            <p className="text-xs font-medium text-slate-600 flex items-center gap-1"><Info className="w-3.5 h-3.5" /> Bill To (auto-filled from client — edit if needed)</p>
            <div className="grid grid-cols-2 gap-3">
              <Input label="Billing Name" value={form.bill_to_name} onChange={(v) => setForm({ ...form, bill_to_name: v })} />
              <Input label="GST Number" value={form.bill_to_gst} onChange={(v) => setForm({ ...form, bill_to_gst: v })} />
              <Combobox label="City" value={form.bill_to_city} onChange={(v) => setForm({ ...form, bill_to_city: v })} options={form.bill_to_state && INDIA_CITIES_BY_STATE[form.bill_to_state] ? INDIA_CITIES_BY_STATE[form.bill_to_state] : ALL_INDIA_CITIES} />
              <Combobox label="State" value={form.bill_to_state} onChange={(v) => setForm({ ...form, bill_to_state: v })} options={INDIA_STATES} />
            </div>
            <Textarea label="Billing Address" value={form.bill_to_address} onChange={(v) => setForm({ ...form, bill_to_address: v })} rows={2} />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Input label="Invoice Date" type="date" value={form.invoice_date} onChange={(v) => setForm({ ...form, invoice_date: v })} />
            <Input label="Due Date" type="date" value={form.due_date} onChange={(v) => setForm({ ...form, due_date: v })} />
          </div>

          <div className="border border-slate-200 rounded-lg p-3 space-y-3">
            <p className="text-xs font-medium text-slate-600 flex items-center gap-1"><Info className="w-3.5 h-3.5" /> GST</p>
            <div className="flex items-center gap-1 bg-slate-100 rounded-lg p-1 w-fit">
              <button
                type="button"
                onClick={() => setForm({ ...form, gst_type: 'intra' })}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition ${form.gst_type === 'intra' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
              >
                Intra-state (CGST + SGST)
              </button>
              <button
                type="button"
                onClick={() => setForm({ ...form, gst_type: 'inter' })}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition ${form.gst_type === 'inter' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
              >
                Inter-state (IGST)
              </button>
            </div>
            <div className="grid grid-cols-2 gap-3 items-end">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">GST Rate</label>
                <select
                  value={GST_RATE_PRESETS.includes(form.gst_rate) ? form.gst_rate : 'custom'}
                  onChange={(e) => e.target.value !== 'custom' && setForm({ ...form, gst_rate: e.target.value })}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition text-slate-900 bg-white"
                >
                  {GST_RATE_PRESETS.map((r) => <option key={r} value={r}>{r}%{r === '18' ? ' (standard)' : ''}</option>)}
                  <option value="custom">Custom...</option>
                </select>
              </div>
              <Input label="Rate (%)" type="number" step="0.01" min="0" value={form.gst_rate} onChange={(v) => setForm({ ...form, gst_rate: v })} />
            </div>
            <div className="flex justify-between text-xs text-slate-500 bg-slate-50 rounded-md px-3 py-2">
              {form.gst_type === 'intra' ? (
                <>
                  <span>CGST ({(gstSplit.cgstRate).toFixed(2)}%): <b className="text-slate-800">Rs {gstSplit.cgstAmount.toLocaleString('en-IN')}</b></span>
                  <span>SGST ({(gstSplit.sgstRate).toFixed(2)}%): <b className="text-slate-800">Rs {gstSplit.sgstAmount.toLocaleString('en-IN')}</b></span>
                </>
              ) : (
                <span>IGST ({(gstSplit.igstRate).toFixed(2)}%): <b className="text-slate-800">Rs {gstSplit.igstAmount.toLocaleString('en-IN')}</b></span>
              )}
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-sm font-medium text-slate-700">Line Items</label>
              <button onClick={addItem} className="text-sm text-blue-600 font-medium">+ Add Item</button>
            </div>
            <div className="space-y-3">
              {form.items.map((item, idx) => {
                const linkedRow = (poUtilization || []).find((r) => r.po_line_item_id === item.po_line_item_id);
                const fig = linkedRow ? computeUtilization(linkedRow, poStage) : null;
                const units = billableUnits(item);
                const rateNum = parseFloat(item.rate) || 0;
                const amount = round2(units * rateNum);
                const overBudget = fig?.remainingBalance != null && amount > fig.remainingBalance;
                // Once a PO line item has been picked for one row, it drops
                // out of every OTHER row's dropdown — the same line item
                // can't be billed twice on one invoice by accident. The row
                // that already has it selected keeps seeing it (and stays
                // fully editable), it's only removed as an option elsewhere.
                const pickedElsewhere = new Set(
                  form.items.filter((_, i) => i !== idx).map((it) => it.po_line_item_id).filter(Boolean)
                );
                const availableLineItems = (poUtilization || []).filter(
                  (row) => row.po_line_item_id === item.po_line_item_id || !pickedElsewhere.has(row.po_line_item_id)
                );
                return (
                  <div key={idx} className="border border-slate-100 rounded-lg p-2">
                    {selectedPO && (
                      <select
                        value={item.po_line_item_id}
                        onChange={(e) => pickLineItemForRow(idx, e.target.value)}
                        className="w-full mb-1 px-2 py-1 border border-slate-200 rounded text-xs text-slate-600 bg-white"
                      >
                        <option value="">No PO line item (manual entry)</option>
                        {availableLineItems.map((row) => (
                          <option key={row.po_line_item_id} value={row.po_line_item_id}>{row.description}</option>
                        ))}
                      </select>
                    )}
                    {linkedRow && fig && fig.actualPrimary > 0 && (
                      <p className="text-[11px] text-emerald-600 mb-1.5">
                        Qty/Area auto-filled with actual completed work ({fig.actualPrimary.toLocaleString('en-IN')} {linkedRow.uom === 'sqft' ? 'sq ft' : linkedRow.uom} {poStage}) — edit if you're billing only part of it.
                      </p>
                    )}
                    <div className="mb-2">
                      <input placeholder="Description" value={item.description} onChange={(e) => updateItem(idx, 'description', e.target.value)} className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm" />
                    </div>
                    <div className="grid grid-cols-12 gap-2 items-end">
                      <div className="col-span-2">
                        <label className="block text-[10px] text-slate-400 mb-0.5">Bill By</label>
                        <div className="flex rounded-md overflow-hidden border border-slate-300 text-xs">
                          <button
                            type="button"
                            onClick={() => setItemBasis(idx, 'quantity')}
                            className={`flex-1 px-1.5 py-1.5 font-medium transition ${item.basis === 'quantity' ? 'bg-blue-600 text-white' : 'bg-white text-slate-500 hover:bg-slate-50'}`}
                          >
                            Qty
                          </button>
                          <button
                            type="button"
                            onClick={() => setItemBasis(idx, 'area')}
                            className={`flex-1 px-1.5 py-1.5 font-medium border-l border-slate-300 transition ${item.basis === 'area' ? 'bg-blue-600 text-white' : 'bg-white text-slate-500 hover:bg-slate-50'}`}
                          >
                            Area
                          </button>
                        </div>
                      </div>
                      <div className="col-span-2">
                        <label className="block text-[10px] text-slate-400 mb-0.5">Qty{item.basis === 'quantity' && ' ✓'}</label>
                        <input placeholder="Qty" type="number" step="0.01" min="0" value={item.quantity} onChange={(e) => updateItem(idx, 'quantity', e.target.value)} className={`w-full px-2 py-1.5 border rounded text-sm ${item.basis === 'quantity' ? 'border-blue-300 bg-blue-50/40' : 'border-slate-300'}`} />
                      </div>
                      <div className="col-span-2">
                        <label className="block text-[10px] text-slate-400 mb-0.5">Area (sq ft){item.basis === 'area' && ' ✓'}</label>
                        <input placeholder="Area" type="number" step="0.01" min="0" value={item.area} onChange={(e) => updateItem(idx, 'area', e.target.value)} className={`w-full px-2 py-1.5 border rounded text-sm ${item.basis === 'area' ? 'border-blue-300 bg-blue-50/40' : 'border-slate-300'}`} />
                      </div>
                      <div className="col-span-2">
                        <label className="block text-[10px] text-slate-400 mb-0.5">Rate</label>
                        <input placeholder="Rate" type="number" step="0.01" min="0" value={item.rate} onChange={(e) => updateItem(idx, 'rate', e.target.value)} className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm" />
                      </div>
                      <div className="col-span-2">
                        <label className="block text-[10px] text-slate-400 mb-0.5">HSN</label>
                        <input placeholder="HSN" value={item.hsn_code} onChange={(e) => updateItem(idx, 'hsn_code', e.target.value)} className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm" />
                      </div>
                      <div className="col-span-2 flex items-end justify-between gap-1">
                        <p className="px-1 py-1.5 text-sm font-semibold text-slate-800 truncate">Rs {amount.toLocaleString('en-IN')}</p>
                        {form.items.length > 1 && (
                          <button onClick={() => removeItem(idx)} className="text-slate-400 hover:text-red-600 shrink-0 pb-1.5">
                            <Trash2 className="w-4 h-4" />
                          </button>
                        )}
                      </div>
                    </div>
                    <p className="text-[11px] text-slate-400 mt-1">
                      Rs {rateNum.toLocaleString('en-IN')} × {units.toLocaleString('en-IN')} {item.basis === 'area' ? 'sq ft' : 'qty'} = Rs {amount.toLocaleString('en-IN')}
                    </p>
                    <input
                      placeholder="Note for this item (optional) — e.g. 3 shops excluded after client review"
                      value={item.notes}
                      onChange={(e) => updateItem(idx, 'notes', e.target.value)}
                      className="w-full mt-1.5 px-2 py-1.5 border border-slate-200 rounded text-xs text-slate-600 placeholder:text-slate-400"
                    />
                    {overBudget && (
                      <p className="text-xs text-amber-600 flex items-center gap-1 mt-1">
                        <AlertTriangle className="w-3 h-3" /> This amount exceeds the remaining PO balance ({formatRupees(fig!.remainingBalance)}) for this line item.
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="bg-slate-50 rounded-lg p-4 space-y-1 text-sm">
            <div className="flex justify-between"><span className="text-slate-600">Subtotal:</span><span className="font-medium">Rs {subtotal.toLocaleString('en-IN')}</span></div>
            {form.gst_type === 'intra' ? (
              <>
                <div className="flex justify-between"><span className="text-slate-600">CGST ({gstSplit.cgstRate.toFixed(2)}%):</span><span className="font-medium">Rs {gstSplit.cgstAmount.toLocaleString('en-IN')}</span></div>
                <div className="flex justify-between"><span className="text-slate-600">SGST ({gstSplit.sgstRate.toFixed(2)}%):</span><span className="font-medium">Rs {gstSplit.sgstAmount.toLocaleString('en-IN')}</span></div>
              </>
            ) : (
              <div className="flex justify-between"><span className="text-slate-600">IGST ({gstSplit.igstRate.toFixed(2)}%):</span><span className="font-medium">Rs {gstSplit.igstAmount.toLocaleString('en-IN')}</span></div>
            )}
            <div className="flex justify-between text-base"><span className="font-bold text-slate-900">Total:</span><span className="font-bold text-slate-900">Rs {total.toLocaleString('en-IN')}</span></div>
          </div>

          <Textarea label="Payment Terms (optional, shown on PDF)" value={form.terms} onChange={(v) => setForm({ ...form, terms: v })} rows={2} placeholder="e.g. 100% advance, or Net 30 days from invoice date" />
          <Textarea label="Notes" value={form.notes} onChange={(v) => setForm({ ...form, notes: v })} rows={2} />

          <button
            onClick={() => (isEditing ? updateInvoiceMutation.mutate() : createInvoiceMutation.mutate())}
            disabled={isSaving || !form.client_id}
            className="w-full bg-blue-600 text-white font-medium py-2.5 rounded-lg disabled:opacity-50"
          >
            {isSaving ? 'Saving...' : isEditing ? 'Save Changes' : 'Create Invoice'}
          </button>
          {saveError && <p className="text-sm text-red-600">{saveError.message}</p>}
        </div>
      </Modal>

      {/* View Invoice Modal */}
      <Modal open={!!viewInvoice} onClose={() => setViewInvoice(null)} title={`Invoice ${viewInvoice?.invoice_number}`} size="lg">
        <div className="space-y-3">
          <div className="flex justify-between text-sm">
            <span className="text-slate-500">Bill To:</span>
            <span className="font-medium text-slate-900 text-right">{viewInvoice?.bill_to_name || viewInvoice?.clients?.name}</span>
          </div>
          {(viewInvoice?.bill_to_gst || viewInvoice?.clients?.gst_number) && (
            <div className="flex justify-between text-sm">
              <span className="text-slate-500">GST:</span>
              <span className="font-medium text-slate-900">{viewInvoice?.bill_to_gst || viewInvoice?.clients?.gst_number}</span>
            </div>
          )}
          {viewInvoice?.purchase_orders?.po_number && (
            <div className="flex justify-between text-sm">
              <span className="text-slate-500">Purchase Order:</span>
              <span className="font-medium text-slate-900">{viewInvoice.purchase_orders.name ? `${viewInvoice.purchase_orders.name} (${viewInvoice.purchase_orders.po_number})` : viewInvoice.purchase_orders.po_number}</span>
            </div>
          )}
          <table className="w-full text-sm">
            <thead className="bg-slate-50">
              <tr>
                <th className="text-left px-3 py-2 font-medium">Description</th>
                <th className="text-left px-3 py-2 font-medium">HSN</th>
                <th className="text-right px-3 py-2 font-medium">Qty</th>
                <th className="text-right px-3 py-2 font-medium">Rate</th>
                <th className="text-right px-3 py-2 font-medium">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {viewInvoice?.invoice_items?.map((item: InvoiceItem) => (
                <tr key={item.id}>
                  <td className="px-3 py-2 text-slate-900">
                    {item.description}
                    {item.notes && <span className="block text-xs text-slate-400 italic mt-0.5">Note: {item.notes}</span>}
                  </td>
                  <td className="px-3 py-2 text-slate-500">{item.hsn_code || '-'}</td>
                  <td className="px-3 py-2 text-right">{item.quantity}</td>
                  <td className="px-3 py-2 text-right">Rs {item.rate}</td>
                  <td className="px-3 py-2 text-right font-medium">Rs {item.amount.toLocaleString('en-IN')}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex justify-end gap-8 text-sm">
            <div>
              <p className="text-slate-500">Subtotal: <span className="font-medium text-slate-900">Rs {viewInvoice?.subtotal.toLocaleString('en-IN')}</span></p>
              {(viewInvoice?.igst_rate ?? 0) > 0 ? (
                <p className="text-slate-500">IGST ({viewInvoice?.igst_rate}%): <span className="font-medium text-slate-900">Rs {viewInvoice?.igst_amount.toLocaleString('en-IN')}</span></p>
              ) : (viewInvoice?.cgst_rate ?? 0) > 0 || (viewInvoice?.sgst_rate ?? 0) > 0 ? (
                <>
                  <p className="text-slate-500">CGST ({viewInvoice?.cgst_rate}%): <span className="font-medium text-slate-900">Rs {viewInvoice?.cgst_amount.toLocaleString('en-IN')}</span></p>
                  <p className="text-slate-500">SGST ({viewInvoice?.sgst_rate}%): <span className="font-medium text-slate-900">Rs {viewInvoice?.sgst_amount.toLocaleString('en-IN')}</span></p>
                </>
              ) : (
                <p className="text-slate-500">Tax: <span className="font-medium text-slate-900">Rs {viewInvoice?.tax_amount.toLocaleString('en-IN')}</span></p>
              )}
              <p className="font-bold text-slate-900">Total: Rs {viewInvoice?.total.toLocaleString('en-IN')}</p>
            </div>
          </div>
          {viewInvoice?.terms && (
            <div className="text-xs text-slate-500 border-t border-slate-100 pt-2">
              <span className="font-medium text-slate-700">Payment Terms: </span>{viewInvoice.terms}
            </div>
          )}
          {viewInvoice?.updated_at && (
            <p className="text-xs text-slate-400">Last edited: {new Date(viewInvoice.updated_at).toLocaleString('en-IN')}</p>
          )}
          {viewInvoice && (
            <div className="flex gap-2">
              <button onClick={() => openEditModal(viewInvoice)} className="flex-1 flex items-center justify-center gap-2 bg-slate-100 hover:bg-slate-200 text-slate-700 font-medium py-2.5 rounded-lg">
                <Pencil className="w-4 h-4" /> Edit
              </button>
              <button onClick={() => downloadInvoice(viewInvoice)} className="flex-1 flex items-center justify-center gap-2 bg-slate-900 text-white font-medium py-2.5 rounded-lg">
                <Download className="w-4 h-4" /> Download PDF
              </button>
            </div>
          )}
        </div>
      </Modal>

      <ConfirmDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => deleteTarget && deleteInvoiceMutation.mutate(deleteTarget)}
        title="Delete Invoice"
        message={`Delete invoice ${deleteTarget?.invoice_number}? This removes it and its line items permanently and cannot be undone.`}
        confirmLabel="Delete"
        danger
      />
    </div>
  );
}
