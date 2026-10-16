/** PO-first invoicing: shop IDs are internal evidence, never customer invoice labels. */
export const money2 = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;
export const qty4 = (value: number): number => Math.round((value + Number.EPSILON) * 10000) / 10000;

export interface CompletedWorkRow {
  id: string;
  shop_id: string;
  po_line_item_id: string | null;
  work_type_name?: string | null;
  installed_area?: number | null;
  approved_area?: number | null;
  approved_quantity?: number | null;
  installed_quantity?: number | null;
  produced_quantity?: number | null;
  excluded_from_calculations?: boolean | null;
}
export interface RateRow {
  po_line_item_id: string;
  description: string;
  uom: string;
  rate: number | null;
  hsn_code?: string | null;
}
export interface BilledRow {
  work_item_id?: string | null;
  shop_id?: string | null;
  po_line_item_id?: string | null;
  quantity?: number | null;
  area?: number | null;
  rate?: number | null;
  amount?: number | null;
  description?: string;
  hsn_code?: string | null;
}
export interface BillingAllocation {
  workItemId: string;
  shopId: string;
  poLineId: string;
  description: string;
  hsn: string;
  uom: string;
  basis: 'area' | 'quantity';
  completed: number;
  displayQuantity: number;
  alreadyBilled: number;
  pending: number;
  rate: number;
  amount: number;
}

function nonNegative(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Completed measurements, not approved/budget quantities, are the billing ceiling.
 * Existing invoice lines linked to a work-item are subtracted in the same PO UOM.
 * Any ambiguous shop-level legacy invoice is blocked until it is reconciled.
 */
export function buildPendingAllocations(
  items: CompletedWorkRow[],
  rateRows: RateRow[],
  billed: BilledRow[],
  selectedShopIds: string[],
  fulfillmentType: string | null | undefined,
): { allocations: BillingAllocation[]; issues: string[] } {
  const selected = new Set(selectedShopIds);
  const byPo = new Map(rateRows.map((row) => [row.po_line_item_id, row]));
  const invoicesByWork = new Map<string, BilledRow[]>();
  const ambiguousShops = new Set<string>();
  const ambiguousPoLines = new Set<string>();
  for (const invoiceItem of billed) {
    if (invoiceItem.work_item_id) {
      const list = invoicesByWork.get(invoiceItem.work_item_id) || [];
      list.push(invoiceItem);
      invoicesByWork.set(invoiceItem.work_item_id, list);
    } else if (invoiceItem.shop_id) {
      // Historical invoices with no work-item allocation must not be billed again blindly.
      ambiguousShops.add(invoiceItem.shop_id);
    } else if (invoiceItem.po_line_item_id) {
      ambiguousPoLines.add(invoiceItem.po_line_item_id);
    }
  }
  const issues: string[] = [];
  const allocations: BillingAllocation[] = [];
  const seenIds = new Set<string>();
  for (const item of items) {
    if (!selected.has(item.shop_id) || item.excluded_from_calculations) continue;
    if (seenIds.has(item.id)) continue;
    seenIds.add(item.id);
    if (ambiguousShops.has(item.shop_id)) {
      issues.push('An earlier invoice has no work-item allocation. Reconcile its linked work before creating another invoice.');
      continue;
    }
    if (item.po_line_item_id && ambiguousPoLines.has(item.po_line_item_id)) {
      issues.push('A previous PO invoice lacks shop/work-item allocation. Reconcile that line before billing it again.');
      continue;
    }
    const po = item.po_line_item_id ? byPo.get(item.po_line_item_id) : undefined;
    if (!po) { issues.push('A completed work item is not linked to a Work Order line item.'); continue; }
    const uom = (po.uom || '').trim().toLowerCase();
    const basis: 'area' | 'quantity' = ['sqft', 'sq.ft', 'sq ft', 'ft2', 'square feet'].includes(uom) ? 'area' : 'quantity';
    // Supply-only production records track finished pieces. For sqft POs,
    // derive produced area proportionally from APPROVED measured area/qty.
    // Never use the full approved area when only a subset is produced.
    const completed = basis === 'area'
      ? fulfillmentType === 'supply_only'
        ? (nonNegative(item.approved_quantity) && nonNegative(item.approved_area)
          ? qty4(nonNegative(item.approved_area) * nonNegative(item.produced_quantity) / nonNegative(item.approved_quantity))
          : 0)
        : nonNegative(item.installed_area)
      : nonNegative(fulfillmentType === 'supply_only' ? item.produced_quantity : item.installed_quantity);
    if (completed === 0) {
      if (basis === 'area' && fulfillmentType === 'supply_only' && nonNegative(item.produced_quantity)) {
        issues.push('A produced supply-only item is missing approved area/quantity needed for sq.ft billing.');
      }
      continue;
    }
    let alreadyBilled = 0;
    for (const old of invoicesByWork.get(item.id) || []) {
      if (old.po_line_item_id && old.po_line_item_id !== item.po_line_item_id) {
        issues.push('Historical billing line has a mismatched Work Order item.');
        continue;
      }
      alreadyBilled += nonNegative(basis === 'area' ? old.area : old.quantity);
    }
    const remaining = qty4(completed - alreadyBilled);
    if (remaining < -0.0001) { issues.push('Historical invoiced quantity exceeds completed quantity. Review before billing.'); continue; }
    if (remaining <= 0) continue;
    const rate = Number(po.rate);
    if (!Number.isFinite(rate) || rate <= 0) { issues.push(`Missing valid PO rate for ${po.description || 'line item'}.`); continue; }
    allocations.push({
      workItemId: item.id, shopId: item.shop_id, poLineId: po.po_line_item_id,
      description: po.description || item.work_type_name || 'Work item',
      hsn: po.hsn_code || '', uom: po.uom || (basis === 'area' ? 'sqft' : 'piece'),
      basis, completed,
      displayQuantity: nonNegative(fulfillmentType === 'supply_only' ? item.produced_quantity : item.installed_quantity) || 1,
      alreadyBilled, pending: remaining, rate, amount: money2(remaining * rate),
    });
  }
  return { allocations, issues: Array.from(new Set(issues)) };
}

/** Invoice visual grouping only; individual work-item links remain in DB for audit. */
export function consolidateInvoiceLines<T extends BilledRow>(items: T[]): T[] {
  const groups = new Map<string, T>();
  for (const item of items) {
    const key = item.po_line_item_id
      ? [item.po_line_item_id, item.description, item.rate, item.hsn_code].join('||')
      : ['manual', item.description, item.rate, item.hsn_code].join('||');
    const group = groups.get(key);
    if (group) {
      groups.set(key, {
        ...group,
        quantity: qty4(nonNegative(group.quantity) + nonNegative(item.quantity)),
        area: group.area != null || item.area != null ? qty4(nonNegative(group.area) + nonNegative(item.area)) : null,
        amount: money2(Number(group.amount || 0) + Number(item.amount || 0)),
        // Prevent grouping accidentally appearing linked to a single shop/work item.
        shop_id: null, work_item_id: null,
      });
    } else {
      groups.set(key, { ...item, shop_id: null, work_item_id: null });
    }
  }
  return Array.from(groups.values());
}
