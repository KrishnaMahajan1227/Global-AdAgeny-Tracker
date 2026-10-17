/**
 * Exact ex-GST invoiced value by Work Order. Unlike the utilization SQL view,
 * this includes legacy invoice items linked via the invoice header OR a PO
 * line. Each invoice item is counted once; payments are a separate metric.
 * No billable quantity is inferred from completed shop counts.
 */
import { useQuery } from '@tanstack/react-query';
import { supabase } from './supabase';
import { fetchAllPages } from './paginatedQuery';
import { useRealtimeInvalidate } from './useRealtimeInvalidate';

type InvoiceRef = { id: string; purchase_order_id: string | null };
type ItemRef = { id: string; invoice_id: string; po_line_item_id: string | null; amount: number | null };
type LineRef = { id: string; purchase_order_id: string };
export type FinanceOrder = { id: string; total_amount?: number | null; status?: string | null; assignment_status?: string | null };

export function useAgencyFinancials(orgId: string | undefined, enabled = true) {
  useRealtimeInvalidate(['invoices', 'invoice_items', 'po_line_items', 'purchase_orders'], orgId, [['agency-finance', orgId]], 30000);
  return useQuery({
    queryKey: ['agency-finance', orgId], enabled: !!orgId && enabled, staleTime: 15000,
    queryFn: async () => {
      if (!orgId) throw new Error('Missing agency');
      const [invoices, items, lines] = await Promise.all([
        fetchAllPages<InvoiceRef>((a,b) => supabase.from('invoices').select('id,purchase_order_id').eq('organization_id',orgId).order('id').range(a,b)),
        fetchAllPages<ItemRef>((a,b) => supabase.from('invoice_items').select('id,invoice_id,po_line_item_id,amount').eq('organization_id',orgId).order('id').range(a,b)),
        fetchAllPages<LineRef>((a,b) => supabase.from('po_line_items').select('id,purchase_order_id').eq('organization_id',orgId).order('id').range(a,b)),
      ]);
      const parent = new Map(invoices.map(row => [row.id, row.purchase_order_id]));
      const lineParent = new Map(lines.map(row => [row.id, row.purchase_order_id]));
      const totals = new Map<string, number>();
      for (const item of items) {
        const orderId = parent.get(item.invoice_id) || (item.po_line_item_id ? lineParent.get(item.po_line_item_id) : null);
        if (!orderId) continue;
        const value = Number(item.amount);
        if (!Number.isFinite(value)) continue;
        totals.set(orderId, (totals.get(orderId) || 0) + value);
      }
      return totals;
    },
  });
}
export function financeForOrder(order: FinanceOrder, totals?: Map<string, number>) {
  const planned = order.total_amount != null && Number.isFinite(Number(order.total_amount)) ? Math.max(0, Number(order.total_amount)) : null;
  const invoiced = totals?.get(order.id) || 0;
  return { planned, invoiced, remaining: planned == null ? null : Math.max(0, planned - invoiced),
    percentage: planned && planned > 0 ? Math.max(0, Math.min(100, Math.round(invoiced / planned * 100))) : null };
}
export function financeForOrders(orders: FinanceOrder[], totals?: Map<string,number>) {
  const eligible = orders.filter(row => row.status !== 'cancelled' && row.assignment_status !== 'rejected');
  const parts = eligible.map(order => financeForOrder(order, totals));
  const hasMissing = parts.some(part => part.planned == null);
  const planned = hasMissing ? null : parts.reduce((sum, part) => sum + (part.planned || 0), 0);
  const invoiced = parts.reduce((sum, part) => sum + part.invoiced, 0);
  return { planned, invoiced, remaining: planned == null ? null : Math.max(0, planned-invoiced),
    percentage: planned && planned > 0 ? Math.max(0, Math.min(100, Math.round(invoiced / planned * 100))) : null,
    missingBudgets: hasMissing };
}
