// Shared math for the PO-aware live survey comparison banner (Section 8).
// Deliberately kept separate from poUtilization.ts: that file drives the
// full budgeted-amount/invoiced/remaining-balance view built on
// v_po_line_item_utilization, which carries `rate` and is now restricted
// (migration 0029) to financial roles only. This file works off
// POLineItemWorkContext (budgeted_qty/budgeted_area, no rate) so it's safe
// to use on the Surveyor's own screen, not just Admin/Owner review.
import type { POLineItemWorkContext } from './types';

export interface POVarianceFigures {
  /** Budgeted qty/area for this line item, in whichever unit its uom uses. Null if unset. */
  budgeted: number | null;
  /** Sum already surveyed against this line item on OTHER work items. */
  surveyedElsewhere: number;
  /** This work item's own (draft or already-saved) measurement. */
  thisMeasurement: number;
  /** surveyedElsewhere + thisMeasurement. */
  runningTotal: number;
  /** runningTotal / budgeted * 100. Null when budget is unset or zero. */
  pct: number | null;
  /** True once runningTotal exceeds budgeted (non-blocking — just a flag). */
  exceeds: boolean;
  /** By how much runningTotal exceeds budgeted. 0 or negative when within budget. */
  exceedsBy: number;
  /** True when this line item is measured in sqft (area) rather than qty/piece. */
  isAreaUom: boolean;
}

export function computePOVariance(
  lineItem: Pick<POLineItemWorkContext, 'uom' | 'budgeted_qty' | 'budgeted_area'>,
  surveyedElsewhere: number,
  thisMeasurement: number
): POVarianceFigures {
  const isAreaUom = lineItem.uom === 'sqft';
  const budgeted = isAreaUom ? lineItem.budgeted_area : lineItem.budgeted_qty;
  const runningTotal = surveyedElsewhere + thisMeasurement;
  const pct = budgeted != null && budgeted > 0 ? (runningTotal / budgeted) * 100 : null;
  const exceedsBy = budgeted != null ? runningTotal - budgeted : 0;
  return {
    budgeted,
    surveyedElsewhere,
    thisMeasurement,
    runningTotal,
    pct,
    exceeds: budgeted != null && runningTotal > budgeted,
    exceedsBy,
    isAreaUom,
  };
}

/** Given a work type id, find the one PO line item on that PO that covers it (or null if none/ambiguous). */
export function findLineItemForWorkType(
  lineItems: POLineItemWorkContext[],
  workTypeId: string | null | undefined
): POLineItemWorkContext | null {
  if (!workTypeId) return null;
  const matches = lineItems.filter((li) => li.work_type_id === workTypeId);
  return matches.length === 1 ? matches[0] : null;
}
