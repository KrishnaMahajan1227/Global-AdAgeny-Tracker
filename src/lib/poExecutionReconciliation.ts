/**
 * Read-only Work Order execution reconciliation.
 *
 * The SQL utilization view groups by work_items.po_line_item_id and therefore
 * misses old work_items that were linked to a shop/PO but not to a PO line.
 * Resolve only *unambiguous* associations, exactly as the invoice allocation
 * engine does. A final shop stage never manufactures a measured quantity.
 *
 * This does NOT mutate historical records or certify billing readiness.
 */
import type { POLineItemUtilization } from './types';
import { isShopFinished, type StageRequirements } from './workCompletion';
import { defaultUtilizationStage, getActualForStage, isAreaUom, type UtilizationStage } from './poUtilization';

export interface ExecutionShop {
  id: string;
  status: string | null;
  purchase_order_id?: string | null;
}
export interface ExecutionWorkItem {
  id: string;
  shop_id: string;
  po_line_item_id: string | null;
  work_type_id?: string | null;
  work_type_name?: string | null;
  status?: string | null;
  excluded_from_calculations?: boolean | null;
  survey_area?: number | null;
  survey_quantity?: number | null;
  approved_area?: number | null;
  approved_quantity?: number | null;
  produced_quantity?: number | null;
  installed_area?: number | null;
  installed_quantity?: number | null;
}

export type ExecutionReconciliation = {
  rows: POLineItemUtilization[];
  legacyItemsRecovered: number;
  unmatchedItems: number;
  finalSites: number;
  measuredFinalSites: number;
  missingFinalSites: number;
  verifiedFinalQuantity: number;
  stage: UtilizationStage;
};

/** Final measurement column required by this specific PO line. */
export function finalLineMeasurementStage(fulfillment: string | null | undefined, requirement?: StageRequirements): UtilizationStage {
  if (fulfillment === 'supply_only') return 'produced';
  if (fulfillment !== 'custom') return 'installed';
  if (!requirement || requirement.requires_installation !== false) return 'installed';
  if (requirement.requires_production !== false) return 'produced';
  if (requirement.requires_design !== false) return 'approved';
  return 'surveyed';
}

const positive = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

export function reconcileOrderExecution(
  rows: POLineItemUtilization[],
  shops: ExecutionShop[],
  items: ExecutionWorkItem[],
  fulfillment: string | null | undefined,
  requirements: (StageRequirements & {id?:string})[] = [],
  receiptRequired = false,
): ExecutionReconciliation {
  const byShop = new Map(shops.filter(shop => !['cancelled', 'rejected'].includes(shop.status || '')).map(shop => [shop.id, shop]));
  const byLine = new Map(rows.map(row => [row.po_line_item_id, row]));
  const rowsByWorkType = new Map<string, POLineItemUtilization[]>();
  for (const line of rows) {
    if (!line.work_type_id) continue;
    const group = rowsByWorkType.get(line.work_type_id) || [];
    group.push(line);
    rowsByWorkType.set(line.work_type_id, group);
  }
  const resultRows = rows.map(row => ({...row, surveyed_area:0, surveyed_qty:0,
    approved_area:0, approved_qty:0, produced_qty:0, installed_area:0, installed_qty:0, linked_work_item_count:0 }));
  const totals = new Map(resultRows.map(row => [row.po_line_item_id,row]));
  const seen = new Set<string>();
  const measuredShops = new Set<string>();
  const finalShops = new Set(shops.filter(shop => byShop.has(shop.id) && isShopFinished(fulfillment, shop.status, requirements, receiptRequired)).map(shop => shop.id));
  const stage = defaultUtilizationStage(fulfillment);
  const byRequirements = new Map(requirements.map(row => [row.id, row]));
  let legacyItemsRecovered = 0, unmatchedItems = 0;
  for (const item of items) {
    if (seen.has(item.id) || item.excluded_from_calculations || !byShop.has(item.shop_id)) continue;
    seen.add(item.id);
    // Explicit links take precedence. Never reinterpret an explicit link to
    // another PO or a line outside the currently selected Work Order.
    let line = item.po_line_item_id ? byLine.get(item.po_line_item_id) : undefined;
    if (item.po_line_item_id && !line) { unmatchedItems++; continue; }
    if (!line && item.work_type_id && rowsByWorkType.get(item.work_type_id)?.length === 1) {
      line = rowsByWorkType.get(item.work_type_id)![0];
    }
    if (!line && !item.work_type_id && item.work_type_name) {
      const matches = rows.filter(row => row.description.trim().toLowerCase() === item.work_type_name!.trim().toLowerCase());
      if (matches.length === 1) line = matches[0];
    }
    if (!line && !item.po_line_item_id && rows.length === 1) line = rows[0];
    if (!line) { unmatchedItems++; continue; }
    if (!item.po_line_item_id) legacyItemsRecovered++;
    const target = totals.get(line.po_line_item_id)!;
    target.linked_work_item_count += 1;
    target.surveyed_area += positive(item.survey_area);
    target.surveyed_qty += positive(item.survey_quantity);
    target.approved_area += positive(item.approved_area);
    target.approved_qty += positive(item.approved_quantity);
    target.produced_qty += positive(item.produced_quantity);
    // For installed stage require BOTH a final shop and an explicitly
    // installed item. The billing engine permits approved dimensions as a
    // fallback ONLY for an item already marked installed; mirror that rule.
    const itemWasInstalled = finalShops.has(item.shop_id) && item.status === 'installed';
    if (itemWasInstalled) {
      target.installed_area += positive(item.installed_area) || positive(item.approved_area);
      target.installed_qty += positive(item.installed_quantity) || positive(item.approved_quantity);
    }
    if (finalShops.has(item.shop_id)) {
      const r = byRequirements.get(line.po_line_item_id);
      const lineStage = finalLineMeasurementStage(fulfillment, r);
      const proof = {
        ...target, installed_area: itemWasInstalled ? positive(item.installed_area) || positive(item.approved_area) : 0,
        installed_qty: itemWasInstalled ? positive(item.installed_quantity) || positive(item.approved_quantity) : 0,
        produced_qty: positive(item.produced_quantity),
        approved_area: positive(item.approved_area), approved_qty: positive(item.approved_quantity),
        surveyed_area: positive(item.survey_area), surveyed_qty: positive(item.survey_quantity),
      };
      const comparableFinal = lineStage === 'produced' && isAreaUom(line.uom)
        // Sq.ft production is recorded in pieces. A proportionate area is
        // verifiable only when an approved per-piece area also exists.
        ? positive(item.produced_quantity) > 0 && positive(item.approved_quantity) > 0 && positive(item.approved_area) > 0
        : getActualForStage(proof, lineStage) > 0;
      if (comparableFinal) measuredShops.add(item.shop_id);
    }
  }
  // All rows are reconstructed from actual work items, including items that
  // the database view could not attribute to a line. Invoice totals/rates
  // remain unchanged and are reconciled separately by the billing engine.
  const verifiedFinalQuantity = resultRows.reduce((sum,row) => sum + getActualForStage(row, stage), 0);
  return { rows:resultRows, legacyItemsRecovered, unmatchedItems,
    finalSites:finalShops.size, measuredFinalSites:measuredShops.size,
    missingFinalSites:Math.max(0, finalShops.size - measuredShops.size), verifiedFinalQuantity, stage };
}
