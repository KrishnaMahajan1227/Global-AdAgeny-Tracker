/**
 * Exact invoice readiness for a *single selected* Work Order.
 * Uses the same allocation engine as the Create Invoice form, so percentages
 * cannot be guessed from shop counts, approved scope, or unlinked PO budgets.
 * This query is intentionally lazy: large agency dashboards need not download
 * every work item/invoice line just to show operational KPIs.
 */
import { useQuery } from '@tanstack/react-query';
import { supabase } from './supabase';
import { fetchAllPages } from './paginatedQuery';
import { buildPendingAllocations, isFinalizedShop, money2, type BilledRow, type CompletedWorkRow, type RateRow } from './poBilling';
import { useRealtimeInvalidate } from './useRealtimeInvalidate';
import { fetchOrderInvoiceHistory } from './poBillingHistory';

type Shop = { id: string; status: string; client_id: string; purchase_order_id: string | null };
export interface BillingReadiness {
  readyAmount: number;
  readyItems: number;
  readyShops: number;
  finalizedShops: number;
  needsReviewShops: number;
  billedShops: number;
  issues: string[];
  budgetsMissing: boolean;
  plannedAmount: number | null;
  // Exact unbilled allocations grouped by their contractual PO line.
  // No site-to-quantity approximation and no inferred historical revenue.
  readyLines: {poLineId:string;description:string;uom:string;quantity:number;amount:number;workItems:number;sites:number}[];
}

const chunks = <T,>(values: T[], size: number) => Array.from({ length: Math.ceil(values.length / size) }, (_, i) => values.slice(i * size, (i + 1) * size));

export function summarizeBillingReadiness(
  shops: Shop[], workItems: CompletedWorkRow[], rates: RateRow[], billed: BilledRow[],
  type: string | null | undefined,
): BillingReadiness {
  const eligible = shops.filter(shop => isFinalizedShop(type, shop.status, rates));
  const result = buildPendingAllocations(workItems, rates, billed, eligible.map(shop => shop.id), type, rates);
  const readyShopIds = new Set(result.allocations.map(allocation => allocation.shopId));
  const lineTotals = new Map<string,{quantity:number;amount:number;workItems:Set<string>;sites:Set<string>}>();
  for (const allocation of result.allocations) {
    const entry = lineTotals.get(allocation.poLineId) || {quantity:0,amount:0,workItems:new Set<string>(),sites:new Set<string>()};
    entry.quantity += allocation.pending;
    entry.amount = money2(entry.amount + allocation.amount);
    entry.workItems.add(allocation.workItemId);
    entry.sites.add(allocation.shopId);
    lineTotals.set(allocation.poLineId,entry);
  }
  const readyLines = rates.map(rate=>{
    const entry=lineTotals.get(rate.po_line_item_id);
    return {poLineId:rate.po_line_item_id,description:rate.description||'Work item',uom:rate.uom,
      quantity:entry ? Math.round((entry.quantity+Number.EPSILON)*10000)/10000 : 0,
      amount:entry?.amount||0,workItems:entry?.workItems.size||0,sites:entry?.sites.size||0};
  });
  // A previously invoiced *item ID* does not prove that the *full* actual
  // quantity was invoiced. Rebuild the completed ceiling without invoice
  // history, then compare all old invoices in the correct basis per item.
  const complete = buildPendingAllocations(workItems, rates, [], eligible.map(shop => shop.id), type, rates);
  const completedByItem = new Map(complete.allocations.map(row => [row.workItemId,row]));
  const readyWorkIds = new Set(result.allocations.map(row => row.workItemId));
  const isFullyBilled = (item: CompletedWorkRow) => {
    const allocation = completedByItem.get(item.id);
    if (!allocation) return false;
    const rows = billed.filter(old => old.work_item_id === item.id);
    return rows.length > 0 && rows.every(old => !old.po_line_item_id || old.po_line_item_id === allocation.poLineId)
      && rows.reduce((sum,old) => sum + Math.max(0, Number(allocation.basis === 'area' ? old.area : old.quantity) || 0),0) >= allocation.completed - 0.0001;
  };
  const activeWork = (shop: Shop) => workItems.filter(item => item.shop_id === shop.id && !item.excluded_from_calculations);
  const fullyBilled = eligible.filter(shop => {
    const work = activeWork(shop);
    return work.length > 0 && work.every(isFullyBilled);
  });
  const issues = [...result.issues];
  // A site may be *partially ready* and still need work-item reconciliation:
  // do not erase those warnings just because one of its items is billable.
  const needsReviewShops = eligible.filter(shop => {
    const work = activeWork(shop);
    return !work.length || work.some(item => !readyWorkIds.has(item.id) && !isFullyBilled(item));
  }).length;
  if (needsReviewShops > 0) issues.push(`${needsReviewShops} delivered sites have no currently billable measured work; verify line-item links, recorded quantity/area and prior billing.`);
  const budgetsMissing = !rates.length || rates.some(rate => {
    const area = ['sqft', 'sq.ft', 'sq ft', 'ft2', 'ft²', 'square feet', 'square foot', 'sq. ft.', 'sq feet'].includes(rate.uom.trim().toLowerCase());
    const units = Number(area ? rate.budgeted_area : rate.budgeted_qty);
    return !Number.isFinite(units) || units <= 0 || rate.rate == null || !Number.isFinite(Number(rate.rate)) || Number(rate.rate) <= 0;
  });
  const plannedAmount = budgetsMissing ? null : money2(rates.reduce((sum, rate) => {
    const area = ['sqft', 'sq.ft', 'sq ft', 'ft2', 'ft²', 'square feet', 'square foot', 'sq. ft.', 'sq feet'].includes(rate.uom.trim().toLowerCase());
    return sum + Number(area ? rate.budgeted_area : rate.budgeted_qty) * Number(rate.rate);
  }, 0));
  return {
    readyAmount: money2(result.allocations.reduce((sum, row) => sum + row.amount, 0)),
    readyItems: result.allocations.length,
    readyShops: readyShopIds.size,
    finalizedShops: eligible.length,
    needsReviewShops: Math.max(0, needsReviewShops),
    billedShops: fullyBilled.length,
    issues: Array.from(new Set(issues)),
    budgetsMissing, plannedAmount, readyLines,
  };
}

export function useOrderBillingReadiness(orgId: string | undefined, orderId: string | undefined, clientId: string | undefined, type: string | null | undefined, enabled = true) {
  useRealtimeInvalidate(['shops', 'work_items', 'po_line_items', 'invoices', 'invoice_items'], orgId,
    [['po-billing-readiness', orgId]], 30000);
  return useQuery({
    queryKey: ['po-billing-readiness', orgId, orderId, clientId, type],
    enabled: !!orgId && !!orderId && !!clientId && enabled,
    staleTime: 15000,
    queryFn: async () => {
      if (!orgId || !orderId || !clientId) throw new Error('Missing Work Order context');
      const [rates, linkedShops] = await Promise.all([
        fetchAllPages<any>((a,b) => supabase.from('po_line_items')
          .select('id,description,uom,rate,hsn_code,work_type_id,budgeted_qty,budgeted_area,requires_survey,requires_design,requires_production,requires_installation')
          .eq('organization_id',orgId).eq('purchase_order_id',orderId).order('id').range(a,b)),
        fetchAllPages<Shop>((a,b) => supabase.from('shops').select('id,status,client_id,purchase_order_id')
          .eq('organization_id',orgId).eq('purchase_order_id',orderId).order('id').range(a,b)),
      ]);
      const rateRows: RateRow[] = rates.map(row => ({...row, po_line_item_id: row.id}));
      const found = new Map(linkedShops.map(row => [row.id,row]));
      // Mirror Billing's legacy recovery: PO-line-linked work on unassigned
      // shops is legitimate only when it matches the client's actual PO.
      for (const slice of chunks(rateRows.map(row => row.po_line_item_id), 100)) {
        const workLinks = await fetchAllPages<{shop_id:string}>((a,b) => supabase.from('work_items')
          .select('shop_id').eq('organization_id',orgId).in('po_line_item_id',slice).order('id').range(a,b));
        const missing = [...new Set(workLinks.map(item => item.shop_id))].filter(id => !found.has(id));
        for (const ids of chunks(missing, 100)) {
          const {data, error} = await supabase.from('shops').select('id,status,client_id,purchase_order_id')
            .eq('organization_id',orgId).eq('client_id',clientId).in('id',ids);
          if (error) throw error;
          for (const shop of data || []) if (!shop.purchase_order_id || shop.purchase_order_id === orderId) found.set(shop.id,shop);
        }
      }
      const shops = Array.from(found.values());
      const completedShops = shops.filter(shop => isFinalizedShop(type, shop.status, rates));
      const workItems: CompletedWorkRow[] = [];
      for (const ids of chunks(completedShops.map(shop => shop.id), 100)) {
        const rows = await fetchAllPages<CompletedWorkRow>((a,b) => supabase.from('work_items')
          .select('id,shop_id,status,work_type_id,work_type_name,po_line_item_id,installed_area,survey_area,survey_quantity,approved_area,approved_quantity,installed_quantity,produced_quantity,excluded_from_calculations')
          .eq('organization_id',orgId).in('shop_id',ids).order('id').range(a,b));
        const statuses = new Map(completedShops.map(shop => [shop.id,shop.status]));
        const parent = new Map(shops.map(shop => [shop.id,shop.purchase_order_id]));
        const lineIds = new Set(rateRows.map(rate => rate.po_line_item_id));
        workItems.push(...rows.filter(row => parent.get(row.shop_id) === orderId || (!!row.po_line_item_id && lineIds.has(row.po_line_item_id)))
          .map(row => ({...row,shop_status: statuses.get(row.shop_id)})));
      }
      const billed = await fetchOrderInvoiceHistory(orgId,orderId,rateRows.map(row => row.po_line_item_id));
      return summarizeBillingReadiness(shops, workItems, rateRows, billed, type);
    },
  });
}
