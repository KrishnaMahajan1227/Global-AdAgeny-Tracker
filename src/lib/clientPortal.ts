// Shared math + small helpers for the Client Organization portal (Phase 3
// of GLOBAL_ARCHITECTURE.md). Deliberately kept separate from
// lib/poUtilization.ts: that module's types/functions are built around
// po_line_items.rate (needed for the agency's budgeted-amount / invoiced-
// balance figures), which a Client Organization user must never receive
// (doc section 2.5 / 7 — client-facing fields are qty/area progress and
// billing status only, never agency rate/cost data). Everything below
// works off ClientPOLineItemProgress (mirrors v_client_po_line_item_progress,
// migration 0039), which never carries `rate` in the first place.
import type { ClientPOLineItemProgress } from './types';

export type ClientStage = 'surveyed' | 'approved' | 'produced' | 'installed';

export function isAreaUom(uom: 'sqft' | 'piece' | 'lot') {
  return uom === 'sqft';
}

function budgetedPrimary(row: ClientPOLineItemProgress): number | null {
  return isAreaUom(row.uom) ? row.budgeted_area : row.budgeted_qty;
}

function actualForStage(row: ClientPOLineItemProgress, stage: ClientStage): number {
  const areaBased = isAreaUom(row.uom);
  switch (stage) {
    case 'surveyed':
      return areaBased ? row.surveyed_area : row.surveyed_qty;
    case 'approved':
      return areaBased ? row.approved_area : row.approved_qty;
    case 'produced':
      // produced is only ever tracked as a quantity, even for sqft items
      // (work_items.produced_quantity) — same rule as poUtilization.ts.
      return row.produced_qty;
    case 'installed':
      return areaBased ? row.installed_area : row.installed_qty;
  }
}

/**
 * Budget-weighted % complete for one stage across a set of line items
 * (usually every line item on one PO). Weighted by each item's own
 * budgeted qty/area so a PO mixing sqft and piece-count items still nets
 * out to one meaningful percentage. This mirrors the rupee-weighted
 * version agency screens use (PurchaseOrdersPage.tsx), just weighted by
 * budget qty instead of budget amount, since this view never carries a
 * rate to weight by. Returns null when nothing in the set has a budget yet.
 */
export function stagePct(rows: ClientPOLineItemProgress[], stage: ClientStage): number | null {
  let weightedSum = 0;
  let weightBase = 0;
  for (const row of rows) {
    const budgeted = budgetedPrimary(row);
    if (!budgeted) continue;
    const pct = Math.min((actualForStage(row, stage) / budgeted) * 100, 100);
    weightedSum += pct * budgeted;
    weightBase += budgeted;
  }
  return weightBase > 0 ? weightedSum / weightBase : null;
}

/** Which stage counts as "work done" for a PO's overall completion % — supply_only POs never reach "installed", they dispatch/produce instead. */
export function finalStage(fulfillmentType: 'survey_install' | 'supply_only'): ClientStage {
  return fulfillmentType === 'supply_only' ? 'produced' : 'installed';
}

export function formatQty(n: number | null | undefined, uom: string) {
  if (n == null) return '—';
  const rounded = Math.round(n * 100) / 100;
  return `${rounded.toLocaleString('en-IN')} ${uom === 'sqft' ? 'sqft' : uom}`;
}

// ---- Site (shop) status bucketing, for KPI cards and the site list ----
export type SiteBucket = 'pending' | 'in_progress' | 'completed' | 'cancelled';

const COMPLETED_SHOP_STATUSES = new Set(['installed', 'billed', 'dispatched']);

export function siteBucket(status: string): SiteBucket {
  if (status === 'cancelled') return 'cancelled';
  if (status === 'pending') return 'pending';
  if (COMPLETED_SHOP_STATUSES.has(status)) return 'completed';
  return 'in_progress';
}

export const SITE_BUCKET_LABELS: Record<SiteBucket, string> = {
  pending: 'Pending',
  in_progress: 'In Progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

export const SITE_BUCKET_DOT_COLORS: Record<SiteBucket, string> = {
  pending: 'bg-slate-400',
  in_progress: 'bg-amber-500',
  completed: 'bg-emerald-500',
  cancelled: 'bg-red-400',
};

// ---- Map pin coloring (grey/yellow/green/red) ----
// A slightly different bucketing than SITE_BUCKET above — the map's pin
// legend calls out a fourth, explicit "issue" state (red), which the KPI
// cards' pending/in_progress/completed/cancelled buckets don't carry.
// production_hold is the closest thing this app tracks to "something's
// stuck" for a site that's still otherwise active work.
export type MapPinBucket = 'pending' | 'in_progress' | 'completed' | 'issue';

const COMPLETED_STATUSES = new Set(['installed', 'billed', 'dispatched']);
const ISSUE_STATUSES = new Set(['production_hold', 'cancelled']);

export function mapPinBucket(status: string): MapPinBucket {
  if (ISSUE_STATUSES.has(status)) return 'issue';
  if (status === 'pending') return 'pending';
  if (COMPLETED_STATUSES.has(status)) return 'completed';
  return 'in_progress';
}

export const MAP_PIN_COLORS: Record<MapPinBucket, string> = {
  pending: '#94a3b8',
  in_progress: '#eab308',
  completed: '#16a34a',
  issue: '#dc2626',
};

export const MAP_PIN_LABELS: Record<MapPinBucket, string> = {
  pending: 'Pending',
  in_progress: 'In Progress',
  completed: 'Completed',
  issue: 'Needs Attention',
};

// ---- PO "work status" — a client-friendly collapse of assignment_status + po.status ----
export type ClientPoWorkStatus = 'pending_acceptance' | 'rejected' | 'cancelled' | 'in_progress' | 'completed' | 'on_hold';

export function clientPoWorkStatus(po: { status: string; assignment_status: string }, completionPct: number | null): ClientPoWorkStatus {
  if (po.assignment_status === 'pending_acceptance') return 'pending_acceptance';
  if (po.assignment_status === 'rejected') return 'rejected';
  if (po.status === 'cancelled') return 'cancelled';
  if (po.status === 'closed' || completionPct != null && completionPct >= 100) return 'completed';
  return 'in_progress';
}

export const CLIENT_PO_WORK_STATUS_LABELS: Record<ClientPoWorkStatus, string> = {
  pending_acceptance: 'Pending Acceptance',
  rejected: 'Declined by Agency',
  cancelled: 'Cancelled',
  in_progress: 'In Progress',
  completed: 'Completed',
  on_hold: 'On Hold',
};

export const CLIENT_PO_WORK_STATUS_COLORS: Record<ClientPoWorkStatus, string> = {
  pending_acceptance: 'bg-amber-100 text-amber-700',
  rejected: 'bg-red-100 text-red-700',
  cancelled: 'bg-slate-200 text-slate-700',
  in_progress: 'bg-blue-100 text-blue-700',
  completed: 'bg-emerald-100 text-emerald-700',
  on_hold: 'bg-orange-100 text-orange-700',
};

// ---- Campaign performance rows — shared shape for the Campaigns list and the Reports export ----
// NOTE: this client portal deliberately never reads `invoices`/billing data
// at all — a Client Organization user gets zero pricing/payment visibility
// anywhere in this app (agency rate, PO amounts, and invoice/payment status
// are all agency-internal). See ClientCampaignsPage/ClientPODetailPage's own
// header comments for the same rule applied screen-by-screen.
export interface ClientCampaignRow {
  po_id: string;
  po_number: string;
  name: string | null;
  po_date: string;
  agency_name: string;
  agency_org_id: string | null;
  fulfillment_type: 'survey_install' | 'supply_only';
  sites_total: number;
  completion_pct: number | null;
  work_status: ClientPoWorkStatus;
}

export function buildClientCampaignRows(
  pos: { id: string; po_number: string; name?: string | null; po_date: string; status: string; assignment_status: string; fulfillment_type: 'survey_install' | 'supply_only'; assigned_agency_id: string | null; agency_org?: { name: string } | null }[],
  shops: { purchase_order_id: string | null }[],
  progress: ClientPOLineItemProgress[]
): ClientCampaignRow[] {
  const siteCountByPo = new Map<string, number>();
  for (const s of shops) {
    if (!s.purchase_order_id) continue;
    siteCountByPo.set(s.purchase_order_id, (siteCountByPo.get(s.purchase_order_id) || 0) + 1);
  }
  const progressByPo = new Map<string, ClientPOLineItemProgress[]>();
  for (const row of progress) {
    const arr = progressByPo.get(row.purchase_order_id) || [];
    arr.push(row);
    progressByPo.set(row.purchase_order_id, arr);
  }

  return pos.map((po) => {
    const poProgress = progressByPo.get(po.id) || [];
    const completionPct = stagePct(poProgress, finalStage(po.fulfillment_type));
    return {
      po_id: po.id,
      po_number: po.po_number,
      name: po.name || null,
      po_date: po.po_date,
      agency_name: po.agency_org?.name || 'Unassigned',
      agency_org_id: po.assigned_agency_id,
      fulfillment_type: po.fulfillment_type,
      sites_total: siteCountByPo.get(po.id) || 0,
      completion_pct: completionPct,
      work_status: clientPoWorkStatus(po, completionPct),
    };
  });
}
