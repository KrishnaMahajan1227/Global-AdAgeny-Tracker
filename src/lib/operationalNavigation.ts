/**
 * Phase 6: a single, role-appropriate deep-link contract for agency work queues.
 * No mutation or access bypass happens here: destination pages and RLS enforce
 * permissions; the URL only narrows an existing user's authorized work.
 */
import type { OwnerStageFilter } from './ownerOperations';

export function validWorkOrderId(value: string | null | undefined): string {
  return value && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value : '';
}

export type ContextualOrder = {
  id: string;
  fulfillment_type?: string | null;
  assignment_status?: string | null;
  delivery_receipt_required?: boolean | null;
};
export type ContextualNext = { stage: OwnerStageFilter; kind?: 'attention' | 'progress' | 'done' } | null | undefined;

const encode = (id: string) => encodeURIComponent(id);
export const orderDetailsPath = (id: string) => `/purchase-orders?order=${encode(id)}`;
export const orderSitesPath = (id: string, stage?: OwnerStageFilter) =>
  `/shops?po=${encode(id)}${stage ? `&stage=${encodeURIComponent(stage)}` : ''}`;

export function orderNextActionPath(order: ContextualOrder, next?: ContextualNext, hasSites = true): string {
  if (order.assignment_status === 'pending_acceptance' || !hasSites || !next || next.kind === 'done') {
    return orderDetailsPath(order.id);
  }
  // Review must open actual evidence, not an unrelated generic Shops filter.
  if (next.stage === 'review') return `/installation-review?po=${encode(order.id)}`;
  if (next.stage === 'design') return `/design?po=${encode(order.id)}`;
  if (next.stage === 'production') return `/production?po=${encode(order.id)}`;
  if (next.stage === 'dispatch' && order.fulfillment_type === 'supply_only') {
    return `/purchase-orders?type=supply_only&workflow=supply&po=${encode(order.id)}&step=dispatch`;
  }
  return orderSitesPath(order.id, next.stage);
}
