import { isShopFinished, type StageRequirements } from './workCompletion';
/** PO-first invoicing: shop IDs are internal evidence, never customer invoice labels. */
export const money2 = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;
export const qty4 = (value: number): number => Math.round((value + Number.EPSILON) * 10000) / 10000;

/** Last stage is fulfillment-specific; a dispatch is NOT final for installation orders. */
export function isFinalizedShop(type: string | null | undefined, status: string | null | undefined, requirements: StageRequirements[] = [], receiptRequired = false): boolean {
  return isShopFinished(type, status, requirements, receiptRequired);
}

export function billingStageLabel(type: string | null | undefined, requirements: StageRequirements[] = [], receiptRequired = false): string {
  if (type === 'supply_only') return receiptRequired ? 'Delivery received' : 'Dispatched';
  if (type === 'custom' && requirements.length && requirements.every(r => r.requires_installation === false)) {
    if (requirements.some(r => r.requires_production !== false)) return 'Production complete';
    if (requirements.some(r => r.requires_design !== false)) return 'Design approved';
    return 'Survey approved';
  }
  return 'Installed';
}


export interface CompletedWorkRow {
  id: string;
  shop_id: string;
  po_line_item_id: string | null;
  work_type_name?: string | null;
  work_type_id?: string | null;
  shop_status?: string | null;
  status?: string | null;
  installed_area?: number | null;
  survey_area?: number | null;
  survey_quantity?: number | null;
  approved_area?: number | null;
  approved_quantity?: number | null;
  installed_quantity?: number | null;
  produced_quantity?: number | null;
  excluded_from_calculations?: boolean | null;
}
export interface RateRow extends StageRequirements {
  po_line_item_id: string;
  description: string;
  uom: string;
  rate: number | null;
  hsn_code?: string | null;
  work_type_id?: string | null;
  budgeted_qty?: number | null;
  budgeted_area?: number | null;
}
export interface BilledRow {
  id?: string;
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
  requirements: StageRequirements[] = rateRows,
  receiptRequired = false,
): { allocations: BillingAllocation[]; issues: string[] } {
  const selected = new Set(selectedShopIds);
  const byPo = new Map(rateRows.map((row) => [row.po_line_item_id, row]));
  // Legacy/backfilled items may lack po_line_item_id. Resolve only an unambiguous
  // work type or exact description within the same PO. Never guess across lines.
  function locateRate(item: CompletedWorkRow): RateRow | undefined {
    if (item.po_line_item_id) return byPo.get(item.po_line_item_id);
    const matches = item.work_type_id
      ? rateRows.filter(row => row.work_type_id && row.work_type_id === item.work_type_id)
      : rateRows.filter(row => row.description.trim().toLowerCase() === (item.work_type_name || '').trim().toLowerCase());
    if (matches.length === 1) return matches[0];
    // Many historical imports omit both work-type and PO-line links.
    // Only a PO with exactly ONE valid line has an unambiguous destination.
    if (!item.po_line_item_id && rateRows.length === 1) return rateRows[0];
    return undefined;
  }
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
    if ((receiptRequired && !item.shop_status) || (item.shop_status && !isFinalizedShop(fulfillmentType, item.shop_status, requirements, receiptRequired))) {
      issues.push('Shop has not reached the final fulfillment stage for this Work Order.');
      continue;
    }
    if (seenIds.has(item.id)) continue;
    seenIds.add(item.id);
    if (ambiguousShops.has(item.shop_id)) {
      issues.push('An earlier invoice has no work-item allocation. Reconcile its linked work before creating another invoice.');
      continue;
    }
    const po = locateRate(item);
    if (po && ambiguousPoLines.has(po.po_line_item_id)) {
      issues.push('A previous PO invoice lacks shop/work-item allocation. Reconcile that line before billing it again.');
      continue;
    }
    if (!po) { issues.push('A completed work item has no uniquely matching PO line/rate. Review its Work Order linkage.'); continue; }
    const uom = (po.uom || '').trim().toLowerCase();
    const basis: 'area' | 'quantity' = ['sqft', 'sq.ft', 'sq ft', 'ft2', 'ft²', 'square feet', 'square foot', 'sq. ft.', 'sq feet'].includes(uom) ? 'area' : 'quantity';
    // Supply-only production records track finished pieces. For sqft POs,
    // derive produced area proportionally from APPROVED measured area/qty.
    // Never use the full approved area when only a subset is produced.
    // Backfilled installed work may carry approved dimensions but missing installed
    // fields. Use them ONLY if the work item is explicitly marked installed;
    // a survey or approval alone is never billable.
    // Custom work can end at production, design or survey according to the
    // *matched PO line's* required stages. Never assume every custom line
    // must be installed, and never treat one completed stage as evidence of a
    // missing quantity on another line.
    const finalStage = fulfillmentType === 'supply_only' ? 'produced'
      : fulfillmentType !== 'custom' || po.requires_installation !== false ? 'installed'
      : po.requires_production !== false ? 'produced'
      : po.requires_design !== false ? 'approved' : 'surveyed';
    // A shop may have multiple Work Items. Do not invoice an item that is
    // explicitly still awaiting/redoing installation review just because a
    // different item has already advanced the enclosing shop's status.
    if (finalStage === 'installed' && item.status &&
        ['installation_review','installation_pending','installing','redo'].includes(item.status)) {
      issues.push('An installation Work Item still requires review or correction before billing.');
      continue;
    }
    const approvedInstalledFallback = finalStage === 'installed' && item.status === 'installed' && isFinalizedShop(fulfillmentType, item.shop_status, requirements, receiptRequired);
    const installedArea = nonNegative(item.installed_area) || (approvedInstalledFallback ? nonNegative(item.approved_area) : 0);
    const installedQuantity = nonNegative(item.installed_quantity) || (approvedInstalledFallback ? nonNegative(item.approved_quantity) : 0);
    const producedArea = nonNegative(item.approved_quantity) && nonNegative(item.approved_area)
      ? qty4(nonNegative(item.approved_area) * nonNegative(item.produced_quantity) / nonNegative(item.approved_quantity)) : 0;
    const completed = basis === 'area'
      ? finalStage === 'produced' ? producedArea : finalStage === 'approved' ? nonNegative(item.approved_area)
        : finalStage === 'surveyed' ? nonNegative(item.survey_area) : installedArea
      : finalStage === 'produced' ? nonNegative(item.produced_quantity)
        : finalStage === 'approved' ? nonNegative(item.approved_quantity)
        : finalStage === 'surveyed' ? nonNegative(item.survey_quantity) : installedQuantity;
    if (completed === 0) {
      if (basis === 'area' && finalStage === 'produced' && nonNegative(item.produced_quantity)) {
        issues.push('A completed production item is missing approved area/quantity needed for sq.ft billing.');
      }
      continue;
    }
    let alreadyBilled = 0;
    let ambiguousHistory = false;
    for (const old of invoicesByWork.get(item.id) || []) {
      if (old.po_line_item_id && old.po_line_item_id !== po.po_line_item_id) {
        issues.push('Historical billing line has a mismatched Work Order item.');
        ambiguousHistory = true;
        continue;
      }
      const oldUnits = basis === 'area' ? old.area : old.quantity;
      if ((oldUnits == null || !Number.isFinite(Number(oldUnits)) || Number(oldUnits) <= 0) && Number(old.amount || 0) > 0) {
        issues.push('A previous invoice item has an amount but no matching billable unit. Reconcile its quantity before billing again.');
        ambiguousHistory = true;
        continue;
      }
      alreadyBilled += nonNegative(oldUnits);
    }
    if (ambiguousHistory) continue;
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
      displayQuantity: nonNegative(finalStage === 'produced' ? item.produced_quantity : finalStage === 'approved' ? item.approved_quantity : finalStage === 'surveyed' ? item.survey_quantity : installedQuantity) || 1,
      alreadyBilled, pending: remaining, rate, amount: money2(remaining * rate),
    });
  }
  return { allocations, issues: Array.from(new Set(issues)) };
}

/**
 * Final invoice-review validator shared by preview and last-moment server
 * recheck. A user may bill a *part* of the available work-item quantity, but
 * cannot change contract line/rate or bill beyond eligible measured units.
 * Only one invoice line per work item is allowed within one new invoice.
 * Amounts are ex-GST and monetary comparisons use the billing engine's
 * two-decimal rounding; quantities are precise to four decimal places.
 */
export function validateInvoiceAllocationSelection(
  items: Array<{work_item_id:string|null;po_line_item_id:string|null;shop_id:string|null;area:number|null;quantity:number;rate:number;amount:number}>,
  allocations: BillingAllocation[],
): {valid:boolean; reason:string} {
  if (!items.length) return {valid:false,reason:'Select at least one measured work item.'};
  const available = new Map(allocations.map(row => [row.workItemId, row]));
  const seen = new Set<string>();
  for (const item of items) {
    if (!item.work_item_id || !item.po_line_item_id || !item.shop_id) return {valid:false,reason:'Each invoice line needs its Work Order, site and work item.'};
    if (seen.has(item.work_item_id)) return {valid:false,reason:'The same work item appears more than once on this invoice.'};
    seen.add(item.work_item_id);
    const allowed = available.get(item.work_item_id);
    if (!allowed || allowed.poLineId !== item.po_line_item_id || allowed.shopId !== item.shop_id) return {valid:false,reason:'A Work Item no longer belongs to the selected billable Work Order scope.'};
    const units = allowed.basis === 'area' ? Number(item.area) : Number(item.quantity);
    if (!Number.isFinite(units) || units <= 0 || units - allowed.pending > 0.0001) return {valid:false,reason:'Invoice quantity/area exceeds the currently eligible unbilled work.'};
    if (!Number.isFinite(item.rate) || Math.abs(item.rate - allowed.rate) > 0.0001 ||
        !Number.isFinite(item.amount) || Math.abs(item.amount - money2(units * allowed.rate)) > 0.01) {
      return {valid:false,reason:'Invoice rate or amount does not match the approved PO rate and quantity.'};
    }
  }
  return {valid:true,reason:''};
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
