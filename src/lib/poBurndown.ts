// Shared math for the PO Burndown chart (ARCHITECTURE doc Section 10,
// Phase I). Turns raw v_po_line_item_burndown_events rows (one per work
// item per stage) into a cumulative-over-time series per stage, ready to
// hand to a line chart — mirroring how poUtilization.ts centralizes the
// budget-vs-actual math so both the PO detail page and Reports can share
// it without re-deriving anything.
import type { POLineItemBurndownEvent } from './types';
import { isAreaUom } from './poUtilization';

export type BurndownStage = 'surveyed' | 'approved' | 'produced' | 'installed';

export const BURNDOWN_STAGES: BurndownStage[] = ['surveyed', 'approved', 'produced', 'installed'];

export interface BurndownPoint {
  date: string; // YYYY-MM-DD
  surveyed: number;
  approved: number;
  produced: number;
  installed: number;
  budgeted: number | null;
}

/**
 * Buckets events by day and returns a cumulative running total per stage,
 * one point per day that had at least one event, sorted oldest first.
 * `budgeted` is repeated on every point (flat reference line) so a chart
 * can draw it as a straight line across the same x-axis without a second
 * dataset.
 */
export function buildBurndownSeries(
  events: POLineItemBurndownEvent[],
  uom: 'sqft' | 'piece' | 'lot',
  budgeted: number | null
): BurndownPoint[] {
  const areaBased = isAreaUom(uom);

  // Sum same-day, same-stage deltas first (multiple work items can hit the
  // same stage on the same day).
  const byDateStage = new Map<string, Map<BurndownStage, number>>();
  for (const ev of events) {
    const value = areaBased ? ev.area_delta : ev.qty_delta;
    if (!value) continue;
    if (!byDateStage.has(ev.event_date)) byDateStage.set(ev.event_date, new Map());
    const stageMap = byDateStage.get(ev.event_date)!;
    stageMap.set(ev.stage, (stageMap.get(ev.stage) || 0) + value);
  }

  const sortedDates = Array.from(byDateStage.keys()).sort();

  const running: Record<BurndownStage, number> = { surveyed: 0, approved: 0, produced: 0, installed: 0 };
  const points: BurndownPoint[] = [];
  for (const date of sortedDates) {
    const stageMap = byDateStage.get(date)!;
    for (const stage of BURNDOWN_STAGES) {
      running[stage] += stageMap.get(stage) || 0;
    }
    points.push({
      date,
      surveyed: round2(running.surveyed),
      approved: round2(running.approved),
      produced: round2(running.produced),
      installed: round2(running.installed),
      budgeted,
    });
  }
  return points;
}

/** Merges burndown events from multiple line items (e.g. a whole PO) into one series. */
export function buildBurndownSeriesForPO(
  events: POLineItemBurndownEvent[],
  lineItems: { id: string; uom: 'sqft' | 'piece' | 'lot'; budgeted_qty: number | null; budgeted_area: number | null }[]
): BurndownPoint[] {
  // Only meaningful when every included line item shares the same uom —
  // callers should filter to one line item, or to line items that share a
  // uom, before calling this. Falls back to the first line item's uom.
  const uom = lineItems[0]?.uom || 'sqft';
  const areaBased = isAreaUom(uom);
  const budgeted = lineItems.reduce((sum, li) => {
    const v = areaBased ? li.budgeted_area : li.budgeted_qty;
    return sum + (v || 0);
  }, 0);
  return buildBurndownSeries(events, uom, lineItems.length ? budgeted : null);
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}
