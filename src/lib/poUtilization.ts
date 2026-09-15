// Shared math for PO Utilization / reconciliation (Phase 6).
// Pulled out into one place because both the Purchase Orders page and the
// Billing page need the same "budgeted amount / remaining balance /
// variance" numbers derived from a v_po_line_item_utilization row.
import type { FulfillmentType, POLineItemUtilization } from './types';

/** The one place that decides how a Work Order's fulfillment type reads
 *  as a human label — list badges, filters, report columns, PDF exports.
 *  Every screen that used to write its own `=== 'supply_only' ? 'Supply
 *  Only' : 'Survey + Install'` ternary should call this instead, since
 *  that ternary silently mislabels every 'custom'/'direct_install' PO as
 *  "Survey + Install" (the `else` branch) rather than actually reading
 *  what type the PO is. */
export function fulfillmentTypeLabel(type: FulfillmentType | string | null | undefined): string {
  switch (type) {
    case 'supply_only': return 'Supply Only';
    case 'direct_install': return 'Direct Installation';
    case 'custom': return 'Custom';
    case 'survey_install':
    default:
      return 'Survey + Install';
  }
}

export interface UtilizationFigures {
  /** Budgeted qty/area, whichever the line item's UOM uses. */
  budgetedPrimary: number | null;
  /** Actual so-far, whichever stage is passed as `stage`. */
  actualPrimary: number;
  /** budgeted amount = budgeted qty/area * rate (null if either is missing). */
  budgetedAmount: number | null;
  /** How much has already been invoiced against this line item. */
  invoicedAmount: number;
  /** budgetedAmount - invoicedAmount, floored at null when budgetedAmount is unknown. */
  remainingBalance: number | null;
  /** actualPrimary / budgetedPrimary * 100, null when budget is unset or zero. */
  utilizationPct: number | null;
  /** surveyed - budgeted (area/qty units), for the variance flag. Null when budget unset. */
  variance: number | null;
  /** true when variance is meaningfully non-zero (>1% of budget or >0 with no budget). */
  hasVariance: boolean;
}

export type UtilizationStage = 'surveyed' | 'approved' | 'produced' | 'installed';

/** Which utilization stage counts as "actual progress" for a given PO
 *  type — supply_only never reaches installed (nothing is ever field-
 *  installed), everything else (survey_install, custom, direct_install)
 *  is measured by installed_area/qty. direct_install POs write straight
 *  to installed_* with no survey/design/production in between (see
 *  migration 0077), but the stage that represents "done" is still
 *  'installed' — same column, same meaning ("this much is on the wall"). */
export function defaultUtilizationStage(type: FulfillmentType | string | null | undefined): UtilizationStage {
  return type === 'supply_only' ? 'produced' : 'installed';
}

export function isAreaUom(uom: POLineItemUtilization['uom']) {
  return uom === 'sqft';
}

export function getActualForStage(row: POLineItemUtilization, stage: UtilizationStage): number {
  const areaBased = isAreaUom(row.uom);
  switch (stage) {
    case 'surveyed':
      return areaBased ? row.surveyed_area : row.surveyed_qty;
    case 'approved':
      return areaBased ? row.approved_area : row.approved_qty;
    case 'produced':
      // produced is only tracked as a quantity, even for sqft-uom items
      // (work_items.produced_quantity), so always use the qty column here.
      return row.produced_qty;
    case 'installed':
      return areaBased ? row.installed_area : row.installed_qty;
  }
}

export function computeUtilization(row: POLineItemUtilization, stage: UtilizationStage = 'installed'): UtilizationFigures {
  const areaBased = isAreaUom(row.uom);
  const budgetedPrimary = areaBased ? row.budgeted_area : row.budgeted_qty;
  const actualPrimary = getActualForStage(row, stage);
  const budgetedAmount = budgetedPrimary != null && row.rate != null ? budgetedPrimary * row.rate : null;
  const invoicedAmount = row.invoiced_amount || 0;
  const remainingBalance = budgetedAmount != null ? budgetedAmount - invoicedAmount : null;

  const utilizationPct = budgetedPrimary && budgetedPrimary > 0 ? (actualPrimary / budgetedPrimary) * 100 : null;

  // Variance is measured against the surveyed stage specifically, per the
  // architecture doc ("Surveyed - Budgeted -> flag if non-zero").
  const surveyedPrimary = areaBased ? row.surveyed_area : row.surveyed_qty;
  const variance = budgetedPrimary != null ? surveyedPrimary - budgetedPrimary : null;
  const hasVariance = variance != null && Math.abs(variance) > (budgetedPrimary ? budgetedPrimary * 0.01 : 0.01);

  return { budgetedPrimary, actualPrimary, budgetedAmount, invoicedAmount, remainingBalance, utilizationPct, variance, hasVariance };
}

export function formatQty(n: number | null | undefined, uom: string) {
  if (n == null) return '—';
  const rounded = Math.round(n * 100) / 100;
  return `${rounded.toLocaleString('en-IN')} ${uom === 'sqft' ? 'sqft' : uom}`;
}

export function formatRupees(n: number | null | undefined) {
  if (n == null) return '—';
  return `Rs ${Math.round(n).toLocaleString('en-IN')}`;
}

/** The one place that decides how a Work Order shows itself everywhere —
 *  list rows, detail headers, dropdown options, report filenames. With a
 *  name set: "Q3 Andheri Dealer Boards · PO-2026-0417". Without one: just
 *  the number, exactly as before this field existed. Every screen should
 *  call this instead of reading `po.po_number` directly, so a Work Order
 *  Name actually shows up everywhere it's supposed to, not just on the
 *  screen someone remembered to update. */
export function poDisplayLabel(po: { name?: string | null; po_number: string } | null | undefined): string {
  if (!po) return '—';
  return po.name && po.name.trim() ? `${po.name.trim()} · ${po.po_number}` : po.po_number;
}
