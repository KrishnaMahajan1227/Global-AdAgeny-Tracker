import { useEffect, useMemo, useState } from 'react';
import { fetchAllPages } from '@/lib/paginatedQuery';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { Card, StatusBadge, EmptyState, Modal, Input, Select, Textarea, ConfirmDialog, Combobox } from '@/components/ui';
import { logAudit } from '@/lib/helpers';
import { generateInvoicePDF } from '@/lib/reports';
import { computeUtilization, formatRupees, UtilizationStage, defaultUtilizationStage } from '@/lib/poUtilization';
import { Plus, FileText, Download, Trash2, ChevronRight, ShoppingCart, AlertTriangle, Pencil, Info, Search, MoreHorizontal, RefreshCw } from 'lucide-react';
import type { Organization, Client, Invoice, InvoiceItem, PurchaseOrder, POLineItemUtilization, Project } from '@/lib/types';
import { INDIA_STATES, INDIA_CITIES_BY_STATE, ALL_INDIA_CITIES } from '@/lib/indiaLocations';
import { buildPendingAllocations, consolidateInvoiceLines, isFinalizedShop, billingStageLabel, type BilledRow, type CompletedWorkRow, type RateRow } from '@/lib/poBilling';
import { getShopCompletion } from '@/lib/workCompletion';
import { useRealtimeInvalidate } from '@/lib/useRealtimeInvalidate';

// Every line item bills by EITHER quantity OR area, never both blindly
// multiplied together — 'basis' says which one the rate actually applies
// to. This matters a lot for this business: rate cards are commonly
// "per sqft" (flex boards, hoardings) and PO line items carry a UOM of
// 'sqft'/'piece'/'lot' for exactly this reason. Defaults to 'quantity' for
// a blank manual row; auto-switches to 'area' the moment a PO line item
// with uom='sqft' is picked, or the user explicitly picks Area.
const emptyItem = { description: '', quantity: '1', area: '', rate: '', amount: '0', po_line_item_id: '', hsn_code: '', basis: 'quantity' as 'quantity' | 'area', notes: '', shop_id: '', work_item_id: '' };

function localDateISO() {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

const emptyForm = {
  client_id: '', project_id: '', purchase_order_id: '', invoice_date: localDateISO(),
  due_date: '', gst_rate: '18', gst_type: 'intra' as 'intra' | 'inter', notes: '', terms: '',
  bill_to_name: '', bill_to_address: '', bill_to_city: '', bill_to_state: '', bill_to_gst: '',
  items: [emptyItem],
};

const GST_RATE_PRESETS = ['0', '5', '12', '18', '28'];
const EMPTY_SHOPS: any[] = [];
const EMPTY_BILLED_WORK: BilledRow[] = [];
const EMPTY_COMPLETED_WORK: CompletedWorkRow[] = [];

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
  const qty = parseFloat(item.quantity);
  return Number.isFinite(qty) && qty > 0 ? qty : 0;
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
  // Work stage changes must refresh the current billing scope without a full reload.
  useRealtimeInvalidate(['shops', 'work_items', 'invoice_items', 'invoices', 'po_line_items'], orgId, [
    ['billing-completed-shops', orgId], ['billing-completed-work-items', orgId],
    ['billing-work-item-history', orgId], ['po-line-rates-for-billing', orgId],
    ['invoices', orgId],
  ]);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingInvoiceId, setEditingInvoiceId] = useState<string | null>(null);
  const [viewInvoice, setViewInvoice] = useState<any | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<any | null>(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState('');
  const [invoicePage, setInvoicePage] = useState(0);
  const [invoicePageSize, setInvoicePageSize] = useState(20);
  const [confirmPost, setConfirmPost] = useState(false);
  const [search, setSearch] = useState('');
  const [clientFilterList, setClientFilterList] = useState('');
  const [statusFilterList, setStatusFilterList] = useState('');
  const [poFilterList, setPoFilterList] = useState('');
  const [dateFilterList, setDateFilterList] = useState('all');
  const [selectedShopIds, setSelectedShopIds] = useState<string[]>([]);
  const [initializedPO, setInitializedPO] = useState('');
  const [shopSearch, setShopSearch] = useState('');
  const [listSortBy, setListSortBy] = useState('date_desc');
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
    queryFn: async () => fetchAllPages<Client>((a,b) => supabase.from('clients')
      .select('*').eq('organization_id', orgId).order('name').range(a,b)),
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

  const { data: invoices, isLoading: invoicesLoading, error: invoicesError } = useQuery({
    queryKey: ['invoices', orgId],
    queryFn: async () => fetchAllPages<any>((a,b) => supabase.from('invoices')
      .select('*, clients(name, address, city, state, gst_number), purchase_orders(po_number, name, payment_terms), invoice_items(*)')
      .eq('organization_id', orgId)
      .order('created_at', { ascending: false }).order('id', { ascending: false }).range(a,b)),
    enabled: !!orgId,
  });

  // Phase 6 — PO reconciliation on the Billing page: let an invoice
  // optionally be raised against a PO (filtered to the invoice's client)
  // so line items can be picked from the PO's budget and the remaining
  // balance is visible before the invoice is created.
  const { data: purchaseOrders } = useQuery({
    queryKey: ['purchase-orders-for-billing', orgId],
    queryFn: async () => fetchAllPages<PurchaseOrder>((a,b) => supabase.from('purchase_orders')
      .select('*, clients(name)').eq('organization_id', orgId).neq('status','cancelled')
      .order('po_date', { ascending: false }).range(a,b)),
    enabled: !!orgId,
  });

  // PO rates are the authoritative source for billing. Do not rely on the
  // aggregate utilization view, which may not be installed/accessible in
  // some older organizations. All pages are loaded (Supabase defaults to 1k).
  const { data: poRateData, isLoading: poRatesLoading, error: poRatesError } = useQuery({
    queryKey: ['po-line-rates-for-billing', orgId, form.purchase_order_id],
    queryFn: async () => {
      const rows = await fetchAllPages<any>((a,b) => supabase.from('po_line_items')
        .select('id,description,uom,rate,hsn_code,work_type_id,budgeted_qty,budgeted_area')
        .eq('organization_id', orgId!).eq('purchase_order_id', form.purchase_order_id)
        .order('id').range(a,b));
      return rows.map(row => ({ ...row, po_line_item_id: row.id })) as RateRow[];
    },
    enabled: !!orgId && !!form.purchase_order_id,
  });
  const poRates = poRateData || [];
  // Utilization view is presentation-only. A missing/stale view cannot block
  // valid completed work or prevent an invoice from being prepared.
  const { data: poUtilization = [] } = useQuery({
    queryKey: ['po-utilization-for-billing', orgId, form.purchase_order_id],
    queryFn: async () => {
      try {
        return await fetchAllPages<POLineItemUtilization>((a,b) => supabase.from('v_po_line_item_utilization')
          .select('*').eq('purchase_order_id', form.purchase_order_id).order('po_line_item_id').range(a,b));
      } catch { return [] as POLineItemUtilization[]; }
    },
    enabled: !!orgId && !!form.purchase_order_id,
  });

  const selectedPO = (purchaseOrders || []).find((po) => po.id === form.purchase_order_id) || null;
  const poStage: UtilizationStage = defaultUtilizationStage(selectedPO?.fulfillment_type);
  const { data: completionShopsData, isLoading: completionShopsLoading, error: completionShopsError } = useQuery({
    queryKey: ['billing-completed-shops', orgId, form.purchase_order_id, poRateData],
    queryFn: async () => {
      const mainShops = await fetchAllPages<any>((a,b) => supabase.from('shops')
        .select('id,name,status,client_id,purchase_order_id')
        .eq('organization_id', orgId!).eq('purchase_order_id', form.purchase_order_id)
        .order('id').range(a,b));
      // Some backfilled/imported work items were linked to the PO line but
      // the shop header was never assigned purchase_order_id. Find those
      // without broadening access to other clients / other work orders.
      const lineIds = (poRateData || []).map(row => row.po_line_item_id);
      const found = new Map(mainShops.map(shop => [shop.id, shop]));
      for (let start = 0; start < lineIds.length; start += 100) {
        const workLinks = await fetchAllPages<{ shop_id: string }>((a,b) => supabase.from('work_items')
          .select('shop_id').eq('organization_id', orgId!).in('po_line_item_id', lineIds.slice(start, start+100))
          .order('id').range(a,b));
        const missing = [...new Set(workLinks.map(row => row.shop_id).filter(id => !found.has(id)))];
        for (let batchStart = 0; batchStart < missing.length; batchStart += 100) {
          const { data, error } = await supabase.from('shops')
            .select('id,name,status,client_id,purchase_order_id')
            .eq('organization_id', orgId!).eq('client_id', selectedPO!.client_id)
            .in('id', missing.slice(batchStart, batchStart + 100));
          if (error) throw error;
          for (const shop of data || []) {
            if (!shop.purchase_order_id || shop.purchase_order_id === form.purchase_order_id) found.set(shop.id, shop);
          }
        }
      }
      return Array.from(found.values());
    },
    enabled: !!orgId && !!form.purchase_order_id && !!selectedPO && !!poRateData && !editingInvoiceId,
  });
  const workOrderCompletion = getShopCompletion(completionShopsData ?? EMPTY_SHOPS, selectedPO?.fulfillment_type);
  const completionShops = (completionShopsData ?? EMPTY_SHOPS).filter((shop: any) =>
    isFinalizedShop(selectedPO?.fulfillment_type, shop.status));
  // The shop is an eligibility filter, not a billing unit. Every completed
  // work-item is reconciled against its own historical invoice quantities.
  const { data: billedWorkData, isLoading: billedWorkLoading, error: billedWorkError } = useQuery({
    queryKey: ['billing-work-item-history', orgId, form.purchase_order_id],
    queryFn: async () => fetchAllPages<BilledRow>((a,b) => supabase.from('invoice_items')
      .select('work_item_id,shop_id,po_line_item_id,quantity,area,rate,amount,invoices!inner(purchase_order_id)')
      .eq('organization_id', orgId!).eq('invoices.purchase_order_id', form.purchase_order_id)
      .order('id').range(a,b)),
    enabled: !!orgId && !!form.purchase_order_id && !editingInvoiceId,
  });
  const billedWork = billedWorkData ?? EMPTY_BILLED_WORK;
  const { data: completedWorkItemsData, isLoading: completedItemsLoading, error: completedItemsError } = useQuery({
    queryKey: ['billing-completed-work-items', orgId, form.purchase_order_id],
    queryFn: async () => {
      const ids = completionShops.map((shop: any) => shop.id);
      const statuses = new Map<string, string>(completionShops.map((shop: any) => [String(shop.id), String(shop.status)] as const));
      const rows: CompletedWorkRow[] = [];
      for (let start = 0; start < ids.length; start += 100) {
        const batch = await fetchAllPages<CompletedWorkRow>((a,b) => supabase.from('work_items')
          .select('id,shop_id,status,work_type_id,work_type_name,po_line_item_id,installed_area,approved_area,approved_quantity,installed_quantity,produced_quantity,excluded_from_calculations')
          .eq('organization_id', orgId!).in('shop_id', ids.slice(start, start + 100))
          .order('id').range(a,b));
        rows.push(...batch.filter(item => {
          const shop = completionShops.find((x:any)=>x.id === item.shop_id);
          return !!shop?.purchase_order_id || !!poRates.find(r => r.po_line_item_id === item.po_line_item_id);
        }).map(item => ({ ...item, shop_status: statuses.get(item.shop_id) as string | undefined })));
      }
      return rows;
    },
    enabled: !!orgId && !!form.purchase_order_id && completionShops.length > 0 && !editingInvoiceId,
  });
  const completedWorkItems = completedWorkItemsData ?? EMPTY_COMPLETED_WORK;
  const canSelectShops = !completionShopsLoading && !completedItemsLoading && !billedWorkLoading && !poRatesLoading
    && !completionShopsError && !completedItemsError && !billedWorkError && !poRatesError;
  const calculatedBatch = useMemo(() => buildPendingAllocations(
    completedWorkItems, poRates, billedWork,
    selectedShopIds, selectedPO?.fulfillment_type,
  ), [completedWorkItems, poRateData, billedWork, selectedShopIds, selectedPO?.fulfillment_type]);
  const eligibleShopIds = useMemo(() => new Set(buildPendingAllocations(
    completedWorkItems, poRates, billedWork,
    completionShops.map((shop: any) => shop.id), selectedPO?.fulfillment_type,
  ).allocations.map((row) => row.shopId)), [completedWorkItems, poRateData, billedWork, completionShops, selectedPO?.fulfillment_type]);
  const eligibleShops = completionShops.filter((shop: any) => eligibleShopIds.has(shop.id));
  // Final-stage shops with no usable work measurement are not silently billed.
  // Surface them separately so an admin can correct the underlying backfill.
  const needsReconciliation = completionShops.filter((shop: any) => !eligibleShopIds.has(shop.id) &&
    !completedWorkItems.some(row => row.shop_id === shop.id &&
      billedWork.some(old => old.work_item_id === row.id)));
  const filteredEligibleShops = eligibleShops.filter((shop: any) => shop.name.toLowerCase().includes(shopSearch.trim().toLowerCase()));

  // First PO load selects its currently unbilled completed scope automatically.
  // Subsequent manual checkbox changes stay respected; no repeated auto-select.
  useEffect(() => {
    if (editingInvoiceId || !modalOpen || !selectedPO || !canSelectShops || !poRateData) return;
    if (initializedPO !== selectedPO.id) {
      setSelectedShopIds(Array.from(eligibleShopIds));
      setInitializedPO(selectedPO.id);
    }
  }, [editingInvoiceId, modalOpen, selectedPO, canSelectShops, poRateData, initializedPO, eligibleShopIds]);

  // Auto-fill actual completed-and-unbilled PO work. Invoice data remains
  // item-linked in the database; only its *presentation* groups by PO line.
  useEffect(() => {
    if (editingInvoiceId || !modalOpen || !selectedPO || !canSelectShops || initializedPO !== selectedPO.id) return;
    const rows = calculatedBatch.allocations.map((allocation) => ({
      ...emptyItem,
      description: allocation.description,
      shop_id: allocation.shopId,
      work_item_id: allocation.workItemId,
      po_line_item_id: allocation.poLineId,
      basis: allocation.basis,
      quantity: allocation.basis === 'area' ? String(allocation.displayQuantity) : String(allocation.pending),
      area: allocation.basis === 'area' ? String(allocation.pending) : '',
      rate: String(allocation.rate),
      hsn_code: allocation.hsn,
      amount: String(allocation.amount),
    }));
    setForm((old) => ({ ...old, items: rows }));
  }, [modalOpen, editingInvoiceId, selectedPO, canSelectShops, initializedPO, calculatedBatch]);
  const isEditing = !!editingInvoiceId;
  const editingSourceInvoice = (invoices || []).find((i: any) => i.id === editingInvoiceId) || null;
  const editHasShopLinks = !!editingSourceInvoice?.invoice_items?.some((item: any) => !!item.shop_id);

  function buildInvoiceItems() {
    return form.items
      .filter((item) => item.description.trim() !== '' || (parseFloat(item.rate) || 0) > 0)
      .map((item) => {
        const quantity = parseFloat(item.quantity) || 0;
        const rate = parseFloat(item.rate) || 0;
        const units = billableUnits(item);
        return {
          description: item.description,
          quantity,
          area: item.area !== '' ? parseFloat(item.area) : null,
          rate,
          amount: round2(units * rate),
          po_line_item_id: item.po_line_item_id || null,
          shop_id: item.shop_id || null,
          work_item_id: item.work_item_id || null,
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
      if (!Number.isFinite(Number(form.gst_rate)) || Number(form.gst_rate) < 0 || Number(form.gst_rate) > 100) throw new Error('Verify the GST rate.');
      if (Number(form.gst_rate) > 0 && (!org?.gst_number || !form.bill_to_name || !form.bill_to_state)) throw new Error('Taxable invoices require the agency GSTIN and client billing name/state.');
      if (!orgId || !form.client_id || !form.purchase_order_id || !selectedPO) throw new Error('Select a client and Work Order before creating an invoice.');
      if (!canSelectShops) throw new Error('Completed-shop records are still loading or failed to load. Retry before billing.');
      if (!selectedShopIds.length) throw new Error('No completed and unbilled work is selected for this Work Order.');
      if (calculatedBatch.issues.length) throw new Error(calculatedBatch.issues.join(' '));
      if (selectedShopIds.some(id => !eligibleShops.some((shop:any) => shop.id === id))) throw new Error('Some selected work is no longer billable. Refresh the Work Order.');
      if (items.some(item => !item.shop_id || !selectedShopIds.includes(item.shop_id))) throw new Error('Every invoice line must belong to a selected completed shop.');
      if (selectedShopIds.some(id => !items.some(item => item.shop_id === id))) throw new Error('Selected scope has no remaining billable work.');
      if (items.some(item => !(item.amount > 0) || !item.description.trim() || !item.po_line_item_id || !item.work_item_id)) throw new Error('A completed Work Order line has an invalid rate, amount or work-item link.');
      if (items.length !== calculatedBatch.allocations.length || items.some(item => !calculatedBatch.allocations.some(a => a.workItemId === item.work_item_id && a.poLineId === item.po_line_item_id && Math.abs(a.amount - item.amount) < 0.01))) throw new Error('Billable scope changed. Refresh the preview.');
      // Recheck under the authenticated user's organization before writing.
      const { data: latestShops, error: verifyShopsError } = await supabase.from('shops').select('id,status,purchase_order_id,client_id')
        .eq('organization_id', orgId).in('id', selectedShopIds);
      if (verifyShopsError) throw verifyShopsError;
      if ((latestShops || []).length !== selectedShopIds.length || (latestShops || []).some(shop =>
        shop.client_id !== form.client_id || (shop.purchase_order_id && shop.purchase_order_id !== form.purchase_order_id) || !isFinalizedShop(selectedPO.fulfillment_type, shop.status))) {
        throw new Error('Shop completion changed while preparing the invoice. Refresh the list. No invoice was created.');
      }
      // Revalidate completed quantity and prior invoice lines just before writing.
      const freshBilled = await fetchAllPages<BilledRow>((a,b) => supabase.from('invoice_items')
        .select('work_item_id,shop_id,po_line_item_id,quantity,area,rate,amount,invoices!inner(purchase_order_id)')
        .eq('organization_id', orgId).eq('invoices.purchase_order_id', form.purchase_order_id)
        .order('id').range(a,b));
      const statuses = new Map<string, string>((latestShops || []).map((shop: any) => [String(shop.id), String(shop.status)] as const));
      const freshWork: CompletedWorkRow[] = [];
      for (let start = 0; start < selectedShopIds.length; start += 100) {
        const batch = await fetchAllPages<CompletedWorkRow>((a,b) => supabase.from('work_items')
          .select('id,shop_id,status,work_type_id,work_type_name,po_line_item_id,installed_area,approved_area,approved_quantity,installed_quantity,produced_quantity,excluded_from_calculations')
          .eq('organization_id', orgId).in('shop_id', selectedShopIds.slice(start, start + 100))
          .order('id').range(a,b));
        freshWork.push(...batch.filter(item => {
          const sh = (latestShops || []).find(shop => shop.id === item.shop_id);
          return !!sh?.purchase_order_id || !!poRates.find(rate => rate.po_line_item_id === item.po_line_item_id);
        }).map(item => ({ ...item, shop_status: statuses.get(item.shop_id) }))); 
      }
      const freshRateRows = await fetchAllPages<any>((a,b) => supabase.from('po_line_items')
        .select('id,description,uom,rate,hsn_code,work_type_id,budgeted_qty,budgeted_area')
        .eq('organization_id', orgId).eq('purchase_order_id', form.purchase_order_id)
        .order('id').range(a,b));
      const freshRates: RateRow[] = freshRateRows.map(row => ({ ...row, po_line_item_id: row.id }));
      const latestBatch = buildPendingAllocations(freshWork, freshRates, freshBilled, selectedShopIds, selectedPO.fulfillment_type);
      if (latestBatch.issues.length || latestBatch.allocations.length !== items.length || items.some(item => !latestBatch.allocations.some(a => a.workItemId === item.work_item_id && Math.abs(a.amount - item.amount) < 0.01))) {
        throw new Error('Completed or invoiced Work Order quantities changed. Refresh before billing; no invoice was created.');
      }
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

      // Insert all invoice lines with their original shop and work-item links.
      // Roll back only this newly-created invoice if the line insert fails.
      const { error: itemError } = await supabase.from('invoice_items').insert(items.map(item => ({
        organization_id: orgId,
        invoice_id: inv.id,
        description: item.description,
        quantity: item.quantity,
        area: item.area,
        rate: item.rate,
        amount: item.amount,
        po_line_item_id: item.po_line_item_id,
        shop_id: item.shop_id,
        work_item_id: item.work_item_id,
        hsn_code: item.hsn_code,
        notes: item.notes,
      })));
      if (itemError) {
        await supabase.from('invoices').delete().eq('id', inv.id).eq('organization_id', orgId);
        throw itemError;
      }
      // Do not change a shop's operational stage to "billed". Installation
      // and dispatch status remain authoritative; invoice_items track billing.
      // Historical shop statuses are left untouched.

      await logAudit('invoices', inv.id, 'insert', null, null, null, `Created invoice ${invNumber} for ${total}`);
      return inv;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['invoices', orgId] });
      setConfirmPost(false);
      queryClient.invalidateQueries({ queryKey: ['po-utilization-for-billing', orgId, form.purchase_order_id] });
      queryClient.invalidateQueries({ queryKey: ['po-utilization', orgId] });
      setModalOpen(false);
      setSelectedShopIds([]);
      queryClient.invalidateQueries({ queryKey: ['billing-completed-shops', orgId] });
      queryClient.invalidateQueries({ queryKey: ['purchase-orders', orgId] });
      queryClient.invalidateQueries({ queryKey: ['work-progress'] });
      queryClient.invalidateQueries({ queryKey: ['billing-work-item-history', orgId] });
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
          shop_id: item.shop_id,
          work_item_id: item.work_item_id,
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

  const canArchiveInvoice = profile?.role === 'agency_owner' || profile?.role === 'admin';
  const deleteInvoiceMutation = useMutation({
    mutationFn: async (inv: any) => {
      if (!canArchiveInvoice || inv.payment_status !== 'unpaid') throw new Error('Only unpaid invoices may be removed by the agency owner/admin.');
      if (deleteConfirmation.trim() !== inv.invoice_number) throw new Error('Type the exact invoice number to confirm.');
      // Atomic server-side operation archives header/items and writes an audit log.
      // Never use a client-side invoice delete that can partially fail.
      const { data, error } = await supabase.rpc('billing_archive_delete_invoice', {
        p_invoice_id: inv.id,
        p_confirm_number: inv.invoice_number,
      });
      if (error) throw new Error(`Unable to archive invoice: ${error.message}. Confirm billing_archive_delete_invoice migration is applied.`);
      if (data !== true) throw new Error('Server did not confirm archival.');
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['invoices', orgId] });
      queryClient.invalidateQueries({ queryKey: ['billing-work-item-history', orgId] });
      queryClient.invalidateQueries({ queryKey: ['po-utilization-for-billing', orgId] });
      queryClient.invalidateQueries({ queryKey: ['po-utilization', orgId] });
      setDeleteTarget(null);
      setDeleteConfirmation('');
      setViewInvoice(null);
    },
  });

  const updatePaymentStatus = useMutation({
    mutationFn: async ({ inv, status }: { inv: Invoice; status: string }) => {
      const { error: paymentError } = await supabase.from('invoices').update({ payment_status: status }).eq('id', inv.id).eq('organization_id', orgId);
      if (paymentError) throw paymentError;
      await logAudit('invoices', inv.id, 'update', 'payment_status', inv.payment_status, status, `Payment status changed to ${status}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['invoices', orgId] });
    },
  });

  async function downloadInvoice(inv: any) {
    const client = (clients || []).find((c) => c.id === inv.client_id);
    await generateInvoicePDF(inv, consolidateInvoiceLines(inv.invoice_items || []) as InvoiceItem[], client || null, org);
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
    if (editHasShopLinks) return; // Preserve original posted PO/shop associations on edits.
    setSelectedShopIds([]);
    setShopSearch('');
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
    if (editHasShopLinks) return;
    setSelectedShopIds([]);
    setInitializedPO('');
    setShopSearch('');
    const po = (purchaseOrders || []).find((p) => p.id === poId);
    const client = (clients || []).find((c) => c.id === po?.client_id);
    setForm(prev => ({
      ...prev,
      purchase_order_id: poId,
      client_id: po?.client_id || '',
      items: [],
      project_id: po?.project_id || '',
      gst_rate: po?.gst_percentage != null ? String(po.gst_percentage) : prev.gst_rate,
      gst_type: prev.gst_type, // Verify place of supply; organization state is not in the current schema.
      terms: po?.payment_terms || prev.terms,
      bill_to_name: client?.name || '',
      bill_to_address: client?.address || '',
      bill_to_city: client?.city || '',
      bill_to_state: client?.state || '',
      bill_to_gst: client?.gst_number || '',
    }));
  }

  // Picking a PO line item autofills description + rate + HSN code from
  // the budget row (owner can still edit all three after) and remembers
  // the link so it's saved on the invoice_item for reconciliation. It also
  // sets the billing basis to match the PO line item's own UOM — a
  // 'sqft' line item bills by area, 'piece'/'lot' bills by quantity — so
  // the invoice amount is computed the same way that line item's budget
  // and utilization already are, instead of always defaulting to qty.
  function pickLineItemForRow(idx: number, lineItemId: string) {
    const row = (poUtilization || []).find((r) => r.po_line_item_id === lineItemId) || poRates.find((r) => r.po_line_item_id === lineItemId);
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
      const available = calculatedBatch.allocations.filter(a => a.poLineId === lineItemId).reduce((sum,a) => sum + a.pending,0);
      const actual = available > 0 ? available.toString() : (basis === 'area' ? it.area : it.quantity);
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
    setConfirmPost(false);
    setSelectedShopIds([]);
    setInitializedPO('');
    setShopSearch('');
    setEditingInvoiceId(null);
    setForm({ ...emptyForm, invoice_date: localDateISO(), items: [{ ...emptyItem }] });
    setModalOpen(true);
  }

  function openEditModal(inv: any) {
    setEditingInvoiceId(inv.id);
    setForm({
      client_id: inv.client_id || '',
      project_id: inv.project_id || '',
      purchase_order_id: inv.purchase_order_id || '',
      invoice_date: inv.invoice_date ? inv.invoice_date.split('T')[0] : localDateISO(),
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
            shop_id: it.shop_id || '',
            work_item_id: it.work_item_id || '',
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
  const groupedInvoiceItems = consolidateInvoiceLines(previewItems);
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
    if (poFilterList && inv.purchase_order_id !== poFilterList) return false;
    if (statusFilterList && inv.payment_status !== statusFilterList) return false;
    if (dateFilterList !== 'all') {
      const today = new Date();
      const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
      if (dateFilterList === 'week') start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
      else if (dateFilterList === 'month') start.setDate(1);
      else if (dateFilterList === 'last30') start.setDate(start.getDate() - 29);
      // Compare invoice date at local noon; parsing YYYY-MM-DD as UTC would
      // incorrectly exclude today's invoices in positive timezones.
      if (new Date(`${inv.invoice_date}T12:00:00`).getTime() < start.getTime()) return false;
    }
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
  const invoicePageCount = Math.max(1, Math.ceil(sortedInvoiceList.length / invoicePageSize));
  const safeInvoicePage = Math.min(invoicePage, invoicePageCount - 1);
  const visibleInvoices = sortedInvoiceList.slice(safeInvoicePage * invoicePageSize, (safeInvoicePage + 1) * invoicePageSize);
  // All filter changes reset to the first page, not a blank out-of-range page.
  useEffect(() => setInvoicePage(0), [search, clientFilterList, poFilterList, statusFilterList, dateFilterList, listSortBy, invoicePageSize]);

  const LIST_SORT_OPTIONS = [
    { value: 'date_desc', label: 'Invoice Date (Newest first)' },
    { value: 'date_asc', label: 'Invoice Date (Oldest first)' },
    { value: 'amount_desc', label: 'Amount (Highest first)' },
    { value: 'client_asc', label: 'Client (A–Z)' },
    { value: 'invoice_number_asc', label: 'Invoice No. (A–Z)' },
  ];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-slate-900">Billing</h1>
          <p className="text-xs text-slate-500">Work Order invoices · completed work only</p>
        </div>
        <button type="button" onClick={openCreateModal} className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-2 text-xs font-semibold text-white transition hover:bg-blue-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600">
          <Plus className="h-3.5 w-3.5" /> New invoice
        </button>
      </div>

      <section aria-label="Invoice filters" className="rounded-xl border border-slate-200 bg-white px-3 py-3">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-[minmax(180px,2fr)_minmax(120px,1fr)_minmax(170px,1.5fr)_minmax(100px,0.85fr)_minmax(100px,0.85fr)]">
          <label className="text-[11px] font-medium text-slate-600">Search
            <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Invoice, PO number or client" className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-2.5 py-2 text-xs focus-visible:ring-2 focus-visible:ring-blue-500" />
          </label>
          <label className="text-[11px] font-medium text-slate-600">Client
            <select value={clientFilterList} onChange={e=>{setClientFilterList(e.target.value);setPoFilterList('');}} className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-2 py-2 text-xs">
              <option value="">All clients</option>
              {(clients || []).map(c=><option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <label className="text-[11px] font-medium text-slate-600">Work Order
            <select value={poFilterList} onChange={e=>setPoFilterList(e.target.value)} className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-2 py-2 text-xs">
              <option value="">All Work Orders</option>
              {(purchaseOrders || []).filter(po=>!clientFilterList || po.client_id===clientFilterList).map(po=><option key={po.id} value={po.id}>{po.name || po.po_number} ({po.po_number})</option>)}
            </select>
          </label>
          <label className="text-[11px] font-medium text-slate-600">Payment
            <select value={statusFilterList} onChange={e=>setStatusFilterList(e.target.value)} className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-2 py-2 text-xs">
              <option value="">All statuses</option><option value="unpaid">Unpaid</option><option value="partial">Partial</option><option value="paid">Paid</option><option value="overdue">Overdue</option>
            </select>
          </label>
          <label className="text-[11px] font-medium text-slate-600">Period
            <select value={dateFilterList} onChange={e=>setDateFilterList(e.target.value)} className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-2 py-2 text-xs">
              <option value="all">All dates</option><option value="week">This week</option><option value="month">This month</option><option value="last30">Last 30 days</option>
            </select>
          </label>
        </div>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-2">
          <p className="text-xs text-slate-500">{sortedInvoiceList.length} invoice{sortedInvoiceList.length === 1 ? '' : 's'}{search || clientFilterList || poFilterList || statusFilterList || dateFilterList !== 'all' ? ' matching filters' : ''}</p>
          <div className="flex flex-wrap items-center gap-2">
            {(search || clientFilterList || poFilterList || statusFilterList || dateFilterList !== 'all') && <button type="button" onClick={()=>{setSearch('');setClientFilterList('');setPoFilterList('');setStatusFilterList('');setDateFilterList('all');}} className="rounded px-2 py-1 text-xs text-blue-700 hover:bg-blue-50">Clear filters</button>}
            <label className="text-xs text-slate-500">Sort <select aria-label="Sort invoices" value={listSortBy} onChange={e=>setListSortBy(e.target.value)} className="ml-1 rounded border border-slate-200 bg-white px-2 py-1 text-xs">{LIST_SORT_OPTIONS.map(o=><option key={o.value} value={o.value}>{o.label}</option>)}</select></label>
            <button type="button" onClick={()=>queryClient.invalidateQueries({queryKey:['invoices',orgId]})} aria-label="Refresh invoices" title="Refresh invoices" className="rounded border border-slate-200 p-1.5 text-slate-500 hover:bg-slate-50"><RefreshCw className="h-3.5 w-3.5" /></button>
          </div>
        </div>
      </section>

      {invoicesLoading && <p role="status" className="rounded-lg border border-slate-200 bg-white py-8 text-center text-sm text-slate-500">Loading invoices…</p>}
      {invoicesError && <div role="alert" className="flex items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">Could not load invoices. Check your connection. <button onClick={()=>queryClient.invalidateQueries({queryKey:['invoices',orgId]})} className="rounded border border-red-300 px-2 py-1 text-xs font-semibold">Retry</button></div>}
      {updatePaymentStatus.error && <p role="alert" className="text-xs text-red-700">Payment status update failed: {(updatePaymentStatus.error as Error).message}</p>}
      {!invoicesLoading && !invoicesError && (
        <section aria-label="Invoices" className="rounded-xl border border-slate-200 bg-white">
          <div className="hidden grid-cols-[minmax(160px,1.1fr)_minmax(150px,1.4fr)_minmax(110px,0.9fr)_minmax(100px,0.7fr)_minmax(100px,0.7fr)_auto] gap-3 border-b border-slate-200 bg-slate-50 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500 lg:grid">
            <span>Invoice</span><span>Work Order / Client</span><span>Date</span><span className="text-right">Amount</span><span>Payment</span><span className="text-right">Actions</span>
          </div>
          {visibleInvoices.map((inv:any) => (
            <div key={inv.id} className="grid grid-cols-1 items-center gap-2 border-b border-slate-100 px-3 py-3 last:border-b-0 hover:bg-slate-50/60 sm:grid-cols-[minmax(150px,1fr)_minmax(180px,1.4fr)_auto] lg:grid-cols-[minmax(160px,1.1fr)_minmax(150px,1.4fr)_minmax(110px,0.9fr)_minmax(100px,0.7fr)_minmax(100px,0.7fr)_auto] lg:gap-3">
              <div className="min-w-0"><button type="button" onClick={()=>setViewInvoice(inv)} className="truncate text-left text-xs font-semibold text-blue-700 hover:underline">{inv.invoice_number}</button><p className="mt-0.5 text-[11px] text-slate-500 lg:hidden">{new Date(inv.invoice_date).toLocaleDateString('en-IN')}</p></div>
              <div className="min-w-0"><p className="truncate text-xs font-medium text-slate-800">{inv.purchase_orders?.name || inv.purchase_orders?.po_number || 'No Work Order'}</p><p className="truncate text-[11px] text-slate-500">{inv.purchase_orders?.po_number && inv.purchase_orders?.name ? `${inv.purchase_orders.po_number} · ` : ''}{inv.bill_to_name || inv.clients?.name || 'Client'}</p></div>
              <span className="hidden text-xs text-slate-500 lg:block">{new Date(inv.invoice_date).toLocaleDateString('en-IN')}</span>
              <span className="text-xs font-semibold tabular-nums text-slate-900 lg:text-right">₹{Number(inv.total || 0).toLocaleString('en-IN')}</span>
              <select aria-label={`Payment status for ${inv.invoice_number}`} value={inv.payment_status} disabled={updatePaymentStatus.isPending} onChange={e=>updatePaymentStatus.mutate({inv,status:e.target.value})} className="w-fit max-w-full rounded-md border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700">
                <option value="unpaid">Unpaid</option><option value="partial">Partial</option><option value="paid">Paid</option><option value="overdue">Overdue</option>
              </select>
              <div className="flex items-center justify-end gap-1.5">
                <button type="button" onClick={()=>setViewInvoice(inv)} className="rounded-md px-2 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100">View</button>
                <button type="button" onClick={()=>void downloadInvoice(inv)} title="Download invoice PDF" aria-label={`Download PDF ${inv.invoice_number}`} className="rounded-md border border-slate-200 p-1.5 text-slate-600 hover:bg-slate-100"><Download className="h-3.5 w-3.5"/></button>
                <details className="relative group open:z-30">
                  <summary className="flex cursor-pointer list-none items-center rounded-md border border-slate-200 p-1.5 text-slate-600 hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-blue-500" aria-label={`More actions for ${inv.invoice_number}`}><MoreHorizontal className="h-3.5 w-3.5" /></summary>
                  <div className="absolute right-0 top-full z-20 mt-1 min-w-[168px] rounded-lg border border-slate-200 bg-white p-1 shadow-lg">
                    <button type="button" disabled={inv.payment_status === 'paid'} onClick={()=>openEditModal(inv)} className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-40"><Pencil className="h-3.5 w-3.5"/> Edit invoice</button>
                    {canArchiveInvoice && inv.payment_status === 'unpaid' && <button type="button" onClick={()=>{setDeleteConfirmation('');deleteInvoiceMutation.reset();setDeleteTarget(inv);}} className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs text-red-700 hover:bg-red-50"><Trash2 className="h-3.5 w-3.5" /> Archive & remove</button>}
                    {inv.payment_status !== 'unpaid' && <p className="px-2.5 py-1 text-[11px] text-slate-500">Issued/settled invoices require accounts review.</p>}
                  </div>
                </details>
              </div>
            </div>
          ))}
          {!sortedInvoiceList.length && <div className="py-12"><EmptyState icon={<FileText className="h-9 w-9"/>} title="No invoices found" subtitle="Choose a different filter or create a Work Order invoice."/></div>}
          {!!sortedInvoiceList.length && <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 bg-slate-50 px-3 py-2 text-xs text-slate-500">
            <span>{safeInvoicePage*invoicePageSize+1}–{Math.min((safeInvoicePage+1)*invoicePageSize,sortedInvoiceList.length)} of {sortedInvoiceList.length}</span>
            <div className="flex items-center gap-2"><label>Rows <select aria-label="Invoice rows per page" value={invoicePageSize} onChange={e=>setInvoicePageSize(Number(e.target.value))} className="rounded border border-slate-200 bg-white px-1 py-1"><option value={20}>20</option><option value={50}>50</option><option value={100}>100</option></select></label><button type="button" disabled={safeInvoicePage===0} onClick={()=>setInvoicePage(safeInvoicePage-1)} className="rounded border border-slate-200 bg-white px-2 py-1 disabled:opacity-40">Previous</button><button type="button" disabled={safeInvoicePage>=invoicePageCount-1} onClick={()=>setInvoicePage(safeInvoicePage+1)} className="rounded border border-slate-200 bg-white px-2 py-1 disabled:opacity-40">Next</button></div>
          </div>}
        </section>
      )}

      {/* Create / Edit Invoice Modal */}
      <Modal open={modalOpen} onClose={() => { setModalOpen(false); setEditingInvoiceId(null); }} title={isEditing ? `Edit Invoice ${editingSourceInvoice?.invoice_number || ''}` : 'Create Invoice'} size="xl">
        <div className="space-y-4">
          {isEditing && editingSourceInvoice?.payment_status === 'paid' && (
            <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-xs text-amber-800">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>This invoice is already marked <strong>Paid</strong>. You can still edit it, but double-check with accounts before changing amounts on a settled invoice.</span>
            </div>
          )}

          {!isEditing ? (
            <div className="space-y-3">
              <label className="block text-xs font-medium text-slate-600">Work Order
                <select value={form.purchase_order_id} onChange={(event) => selectPO(event.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-blue-500">
                  <option value="">Choose Work Order…</option>
                  {(purchaseOrders || []).map((po) => (
                    <option key={po.id} value={po.id}>
                      {po.name || po.po_number} ({po.po_number}) · {(clients || []).find(c => c.id === po.client_id)?.name || 'Client'}
                    </option>
                  ))}
                </select>
              </label>
              {selectedPO && (
                <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="text-sm font-semibold text-slate-900">{form.bill_to_name || 'Client'}</p>
                      <p className="text-xs text-slate-500">Work Order {selectedPO.po_number} · Completed work eligible for billing</p>
                    </div>
                    <span className="rounded-lg bg-white px-2.5 py-1 text-xs font-medium text-slate-700 border border-slate-200">{workOrderCompletion.completed}/{workOrderCompletion.total} shops completed · {selectedShopIds.length} billable selected</span>
                  </div>
                  {canSelectShops && completionShops.length === 0 &&
                    <p className="mt-2 text-xs text-slate-600">No shops have reached the final {billingStageLabel(selectedPO.fulfillment_type).toLowerCase()} stage for this Work Order.</p>}
                  {canSelectShops && needsReconciliation.length > 0 && (
                    <div role="status" className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                      <p className="font-semibold">{needsReconciliation.length} completed shop(s) require measurement / Work Order linkage verification.</p>
                      <p className="mt-1">A completed shop counts toward delivery progress, but its quantity is not invented for billing. Record the finished PO work item and its installed quantity or area before invoicing.</p>
                      <a className="mt-1.5 inline-flex rounded-md px-2 py-1 font-semibold text-blue-700 underline hover:bg-white focus-visible:ring-2 focus-visible:ring-blue-500" href={`/shops?po=${encodeURIComponent(selectedPO.id)}`}>Review these shops in existing Shops screen →</a>
                    </div>
                  )}
                  {!poRatesLoading && !poRatesError && poRates.length === 0 &&
                    <p role="alert" className="mt-2 text-xs text-red-700">This Work Order has no line-item rate records. Add PO line items and rates first.</p>}
                  {!canSelectShops && <p role="status" className="mt-2 text-xs text-amber-700">{completionShopsError || completedItemsError || billedWorkError || poRatesError ? 'Could not fetch completed work or Work Order rates. Check permissions, PO links and connection; then retry.' : 'Loading completion and billing history…'}</p>}
                  {!!calculatedBatch.issues.length && <div role="alert" className="mt-2 text-xs text-red-700 space-y-1">{calculatedBatch.issues.map((issue) => <p key={issue}>{issue}</p>)}</div>}
                  <details className="mt-2 rounded-lg border border-slate-200 bg-white" >
                    <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium text-slate-600">Adjust completed shop scope (internal selection only)</summary>
                    <div className="p-3 border-t border-slate-100">
                      <div className="flex items-center gap-2 mb-2">
                        <div className="relative min-w-0 flex-1">
                          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
                          <input aria-label="Search eligible completed shops" value={shopSearch} onChange={e=>setShopSearch(e.target.value)} placeholder="Search eligible shops…" className="w-full pl-8 pr-3 py-2 text-xs rounded-lg border border-slate-300" />
                        </div>
                        <button type="button" disabled={!canSelectShops} onClick={()=>setSelectedShopIds(prev=>filteredEligibleShops.every((shop:any)=>prev.includes(shop.id))
                          ? prev.filter(id=>!filteredEligibleShops.some((shop:any)=>shop.id===id))
                          : [...new Set([...prev, ...filteredEligibleShops.map((shop:any)=>shop.id)])])}
                          className="shrink-0 text-xs font-medium text-blue-700 hover:underline disabled:opacity-50">Select / clear</button>
                      </div>
                      <div className="max-h-44 overflow-y-auto divide-y divide-slate-100">
                        {filteredEligibleShops.map((shop: any) => <label key={shop.id} className="flex items-center gap-2 py-1.5 text-xs text-slate-700 cursor-pointer">
                          <input type="checkbox" disabled={!canSelectShops} checked={selectedShopIds.includes(shop.id)} onChange={e=>setSelectedShopIds(prev=>e.target.checked ? [...prev,shop.id] : prev.filter(id=>id!==shop.id))} className="h-4 w-4 accent-blue-600" />
                          <span className="min-w-0 flex-1 truncate">{shop.name}</span>
                        </label>)}
                        {canSelectShops && !filteredEligibleShops.length && <p className="text-xs text-slate-500 py-2">No completed unbilled work matches.</p>}
                      </div>
                    </div>
                  </details>
                </div>
              )}
            </div>
          ) : editHasShopLinks ? (
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
              <p className="text-xs text-slate-500">Client / Work Order — existing invoice</p>
              <p>{(clients || []).find(c=>c.id===form.client_id)?.name || 'Client'} · {editingSourceInvoice?.purchase_orders?.name || editingSourceInvoice?.purchase_orders?.po_number || 'Work Order'}</p>
            </div>
          ) : (
            <div className="space-y-3">
              <Select label="Client" value={form.client_id} onChange={selectClient} options={(clients || []).map(c => ({ value: c.id, label: c.name }))} required />
              <Select label="Work Order" value={form.purchase_order_id} onChange={selectPO} options={(purchaseOrders || []).filter(po=>!form.client_id || po.client_id===form.client_id).map(po=>({value:po.id,label:po.name ? `${po.name} (${po.po_number})` : po.po_number}))} />
              {projectsForClient.length > 0 && <Select label="Project (optional)" value={form.project_id} onChange={v=>setForm({...form,project_id:v})} options={projectsForClient.map(p=>({value:p.id,label:p.name}))} />}
            </div>
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
                  {GST_RATE_PRESETS.map((r) => <option key={r} value={r}>{r}%</option>)}
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

          {!isEditing ? (
            <section aria-label="Work Order invoice line items" className="rounded-xl border border-slate-200 bg-white overflow-hidden">
              <div className="flex flex-wrap justify-between gap-2 px-3 py-2.5 border-b border-slate-200 bg-slate-50">
                <div>
                  <p className="text-sm font-semibold text-slate-900">Completed Work Order billing</p>
                  <p className="text-xs text-slate-500">Actual work completed, less quantities already invoiced. Grouped by PO line item.</p>
                </div>
                <span className="text-xs text-slate-500">{groupedInvoiceItems.length} line{groupedInvoiceItems.length===1?'':'s'}</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[920px] text-xs">
                  <thead className="bg-slate-50 text-slate-500">
                    <tr><th className="text-left px-3 py-2 font-medium">PO work item</th><th className="text-right px-3 py-2 font-medium">PO scope</th><th className="text-right px-3 py-2 font-medium">Completed</th><th className="text-right px-3 py-2 font-medium">Billed before</th><th className="text-right px-3 py-2 font-medium">This invoice</th><th className="text-right px-3 py-2 font-medium">Rate</th><th className="text-right px-3 py-2 font-medium">Amount</th></tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {groupedInvoiceItems.map((item, index) => {
                      const poRow = poRates.find(row => row.po_line_item_id === item.po_line_item_id);
                      const isArea = poRow?.uom === 'sqft';
                      const suffix = isArea ? ' sq.ft' : ` ${poRow?.uom || 'qty'}`;
                      const planned = poRow ? (isArea ? poRow.budgeted_area : poRow.budgeted_qty) : null;
                      const completed = calculatedBatch.allocations.filter(a => a.poLineId === item.po_line_item_id).reduce((sum, a) => sum + a.completed, 0);
                      const billed = billedWork.filter(row => row.po_line_item_id === item.po_line_item_id).reduce((sum,row) => sum + Number((isArea ? row.area : row.quantity) || 0),0);
                      const currentUnits = isArea ? Number(item.area || 0) : Number(item.quantity || 0);
                      return <tr key={`${item.po_line_item_id}-${index}`}>
                        <td className="px-3 py-2.5 font-medium text-slate-800">{item.description}<span className="block font-normal text-[11px] text-slate-500">{item.hsn_code ? `HSN/SAC ${item.hsn_code}` : 'HSN/SAC not set on PO'}</span></td>
                        <td className="px-3 py-2.5 text-right tabular-nums whitespace-nowrap">{planned == null ? '—' : Number(planned).toLocaleString('en-IN') + suffix}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums whitespace-nowrap">{Number(completed).toLocaleString('en-IN') + suffix}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums whitespace-nowrap">{Number(billed).toLocaleString('en-IN') + suffix}</td>
                        <td className="px-3 py-2.5 text-right font-medium text-blue-700 tabular-nums whitespace-nowrap">{currentUnits.toLocaleString('en-IN') + suffix}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums whitespace-nowrap">₹{Number(item.rate).toLocaleString('en-IN')}</td>
                        <td className="px-3 py-2.5 text-right font-semibold tabular-nums whitespace-nowrap">₹{Number(item.amount).toLocaleString('en-IN')}</td>
                      </tr>;
                    })}
                    {!groupedInvoiceItems.length && <tr><td colSpan={7} className="px-3 py-5 text-center text-slate-500">{workOrderCompletion.completed > 0 ? `${workOrderCompletion.completed} shops finished, but no recorded unbilled work quantity is ready yet. Review the completion records above.` : 'No shops at the final fulfillment stage yet.'}</td></tr>}
                  </tbody>
                </table>
              </div>
              {selectedPO && calculatedBatch.allocations.length > 0 && <p className="border-t border-slate-100 px-3 py-2 text-[11px] text-slate-500">{calculatedBatch.allocations.length} completed work records linked internally; shop names are not included in the client invoice.</p>}
            </section>
          ) : (
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
                const availableLineItems = poRates.filter(
                  (row) => row.po_line_item_id === item.po_line_item_id || !!item.shop_id || !pickedElsewhere.has(row.po_line_item_id)
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
                    {item.shop_id && <p className="mb-1 text-[11px] font-medium text-blue-700">Linked shop: {completionShops.find((sh:any)=>sh.id===item.shop_id)?.name || 'Recorded shop'}</p>}
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

          )}

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
            onClick={() => (isEditing ? updateInvoiceMutation.mutate() : setConfirmPost(true))}
            disabled={isSaving || !form.client_id || (!isEditing && (!selectedPO || !canSelectShops || !selectedShopIds.length || calculatedBatch.issues.length>0 || !form.items.some(item=>!!item.work_item_id)))}
            className="w-full bg-blue-600 text-white font-medium py-2.5 rounded-lg disabled:opacity-50"
          >
            {isSaving ? 'Saving...' : isEditing ? 'Save Changes' : 'Create Work Order Invoice'}
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
              {consolidateInvoiceLines((viewInvoice?.invoice_items || []) as InvoiceItem[]).map((item: InvoiceItem) => (
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
        open={confirmPost}
        onClose={() => { if (!createInvoiceMutation.isPending) setConfirmPost(false); }}
        title="Confirm Work Order invoice"
        message={`Issue one invoice for ${selectedPO?.name || selectedPO?.po_number || 'this Work Order'}: ${groupedInvoiceItems.length} PO line items, ${selectedShopIds.length} completed shops included internally. Subtotal ₹${subtotal.toLocaleString('en-IN')}, ${form.gst_type === 'intra' ? 'CGST + SGST' : 'IGST'} ₹${gstSplit.taxAmount.toLocaleString('en-IN')}, total ₹${total.toLocaleString('en-IN')}. Verify GST rate and place of supply before confirming.`}
        confirmLabel="Issue invoice"
        loading={createInvoiceMutation.isPending}
        manualClose
        error={createInvoiceMutation.error?.message || null}
        onConfirm={() => createInvoiceMutation.mutate()}
      />
      <Modal open={!!deleteTarget} onClose={() => { if (!deleteInvoiceMutation.isPending) { setDeleteTarget(null); setDeleteConfirmation(''); } }} title="Archive and remove invoice" size="sm">
        {deleteTarget && <div className="space-y-4">
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            <p className="font-semibold">Remove from active Billing?</p>
            <p className="mt-1 text-xs">Invoice <strong>{deleteTarget.invoice_number}</strong> and its line items will be stored in a private audit archive, then removed from active Billing. The archive is not a substitute for the legally required records or your external backup.</p>
          </div>
          <label className="block text-xs font-medium text-slate-700">Type <strong>{deleteTarget.invoice_number}</strong> to confirm
            <input autoFocus value={deleteConfirmation} onChange={e=>setDeleteConfirmation(e.target.value)} autoComplete="off" spellCheck={false} className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-red-500" />
          </label>
          {deleteInvoiceMutation.error && <p role="alert" className="text-xs text-red-700">{(deleteInvoiceMutation.error as Error).message}</p>}
          <div className="flex justify-end gap-2 border-t border-slate-100 pt-3">
            <button type="button" onClick={()=>{setDeleteTarget(null);setDeleteConfirmation('');}} disabled={deleteInvoiceMutation.isPending} className="rounded-md border border-slate-300 px-3 py-2 text-xs font-medium text-slate-700">Cancel</button>
            <button type="button" disabled={deleteInvoiceMutation.isPending || deleteConfirmation.trim()!==deleteTarget.invoice_number} onClick={()=>deleteInvoiceMutation.mutate(deleteTarget)} className="rounded-md bg-red-700 px-3 py-2 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40">{deleteInvoiceMutation.isPending?'Archiving…':'Archive & remove'}</button>
          </div>
        </div>}
      </Modal>
    </div>
  );
}
