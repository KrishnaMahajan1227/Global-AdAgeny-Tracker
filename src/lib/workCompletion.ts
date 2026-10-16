/**
 * Canonical operational completion. Status and amount are deliberately separate:
 * a finalized shop is not evidence of recorded financial quantity/area.
 * Do NOT infer billable area or piece count from the number of shops.
 */
export type ShopProgressRow = { purchase_order_id?: string | null; status?: string | null };
export type OrderProgressRow = { id: string; fulfillment_type?: string | null; status?: string | null; assignment_status?: string | null };
export type StageBucket = 'pending' | 'survey' | 'design' | 'production' | 'dispatch' | 'installation' | 'review' | 'complete' | 'excluded';
const excluded = new Set(['cancelled', 'rejected']);
const installedStatuses = new Set(['installed', 'billed']);
const deliveredStatuses = new Set(['dispatched', 'delivered', 'billed']);

export function isShopFinished(type: string | null | undefined, status: string | null | undefined): boolean {
  if (!status || excluded.has(status)) return false;
  return type === 'supply_only' ? deliveredStatuses.has(status) : installedStatuses.has(status);
}

export function shopStage(type: string | null | undefined, status: string | null | undefined): StageBucket {
  if (!status || status === 'pending' || status === 'assigned') return 'pending';
  if (excluded.has(status)) return 'excluded';
  if (isShopFinished(type, status)) return 'complete';
  if (status === 'installation_review') return 'review';
  if (status === 'installation_pending' || status === 'installing') return 'installation';
  if (status === 'dispatched' || status === 'delivered') return 'dispatch';
  if (status.startsWith('production') || status === 'in_production') return 'production';
  if (status.startsWith('design') || status === 'designing' || status === 'in_review') return 'design';
  if (status.startsWith('survey') || ['surveyed','approval_pending','approved'].includes(status)) return 'survey';
  return 'pending';
}

export function getShopCompletion(shops: ShopProgressRow[], type: string | null | undefined) {
  const counts: Record<StageBucket, number> = { pending: 0, survey: 0, design: 0, production: 0, dispatch: 0, installation: 0, review: 0, complete: 0, excluded: 0 };
  for (const shop of shops) counts[shopStage(type, shop.status)]++;
  const total = shops.length - counts.excluded;
  const completed = counts.complete;
  return { total, completed, pending: Math.max(0, total - completed), percentage: total ? Math.min(100, Math.max(0, Math.round(completed * 100 / total))) : 0, stages: counts };
}

export function groupShopCompletion(orders: OrderProgressRow[], shops: ShopProgressRow[]) {
  const byOrder = new Map<string, ShopProgressRow[]>();
  for (const shop of shops) {
    if (!shop.purchase_order_id) continue;
    const list = byOrder.get(shop.purchase_order_id) || [];
    list.push(shop);
    byOrder.set(shop.purchase_order_id, list);
  }
  return new Map(orders.map(order => [order.id, getShopCompletion(byOrder.get(order.id) || [], order.fulfillment_type)]));
}

/** An order with no linked shops is *unknown*, unless explicitly closed. */
export function orderOperationalPercent(order: OrderProgressRow, counts: ReturnType<typeof getShopCompletion> | undefined): number {
  if (counts?.total) return counts.percentage;
  return order.status === 'closed' || order.assignment_status === 'completed' ? 100 : 0;
}

export function orderOperationalDone(order: OrderProgressRow, counts: ReturnType<typeof getShopCompletion> | undefined): boolean {
  if (counts?.total) return counts.completed === counts.total;
  return order.status === 'closed' || order.assignment_status === 'completed';
}

export function ordersOperationalPercent(orders: OrderProgressRow[], progress: Map<string, ReturnType<typeof getShopCompletion>>): number {
  if (!orders.length) return 0;
  return Math.round(orders.reduce((total, order) => total + orderOperationalPercent(order, progress.get(order.id)), 0) / orders.length);
}
