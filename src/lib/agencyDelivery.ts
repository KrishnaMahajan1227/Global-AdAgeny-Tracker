/**
 * One operational definition for Agency Dashboard, Clients, Work Orders and
 * campaign summaries. A shop at a final stage counts as delivered; it does
 * NOT silently create measured work-item quantity or an invoice.
 */
import { getShopCompletion, groupShopCompletion, orderOperationalDone, orderOperationalPercent, shopStage, type ShopProgressRow, type OrderProgressRow } from './workCompletion';

export type DeliveryShop = ShopProgressRow & { id?: string; client_id?: string; purchase_order_id: string | null; status: string };
export type DeliveryOrder = OrderProgressRow & { id: string; client_id?: string | null; project_id?: string | null; campaign_id?: string | null };
export type DeliverySummary = ReturnType<typeof getShopCompletion>;

export function deliveryByOrder(orders: DeliveryOrder[], shops: DeliveryShop[]) {
  return groupShopCompletion(orders, shops);
}

export function deliveryForOrder(order: DeliveryOrder, grouped: Map<string, DeliverySummary>) {
  const summary = grouped.get(order.id);
  const siteBased = !!summary?.total;
  return {
    ...summary,
    total: summary?.total || 0,
    completed: summary?.completed || 0,
    percentage: orderOperationalPercent(order, summary),
    delivered: orderOperationalDone(order, summary),
    siteBased,
  };
}

export function deliveryForOrders(orders: DeliveryOrder[], grouped: Map<string, DeliverySummary>) {
  const validOrders = orders.filter(o => o.status !== 'cancelled' && o.assignment_status !== 'rejected');
  const deliveredOrders = validOrders.filter(o => deliveryForOrder(o, grouped).delivered).length;
  const withShops = validOrders.filter(o => (grouped.get(o.id)?.total || 0) > 0);
  const sites = withShops.reduce((sum, order) => sum + (grouped.get(order.id)?.total || 0), 0);
  const deliveredSites = withShops.reduce((sum, order) => sum + (grouped.get(order.id)?.completed || 0), 0);
  // When site records are available, weight by sites rather than by PO count:
  // a 144-site order must not count the same as a single-site order.
  // Legacy orders without linked shops remain visible in order totals.
  const percent = sites ? Math.round(deliveredSites * 100 / sites)
    : validOrders.length ? Math.round(validOrders.reduce((sum, order) => sum + deliveryForOrder(order, grouped).percentage, 0) / validOrders.length) : 0;
  return { total: validOrders.length, done: deliveredOrders, open: validOrders.length - deliveredOrders, sites, deliveredSites, percentage: percent };
}

/** Stage counts are mutually exclusive: dispatched and installed are not double-counted. */
export function deliveryPipeline(shops: DeliveryShop[], orders: DeliveryOrder[] = []) {
  const byOrder = new Map(orders.map(o => [o.id, o]));
  const counts = { pending: 0, survey: 0, design: 0, production: 0, dispatch: 0, installation: 0, review: 0, complete: 0, excluded: 0 };
  for (const shop of shops) {
    const order = byOrder.get(shop.purchase_order_id || '');
    const excludedOrder = order?.status === 'cancelled' || order?.assignment_status === 'rejected';
    const stage = excludedOrder ? 'excluded' : shopStage(order?.fulfillment_type, shop.status, order?.po_line_items || []);
    counts[stage]++;
  }
  return counts;
}
