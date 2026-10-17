/**
 * Invoice-item history for one Work Order. Include both invoices linked by
 * their PO header and legacy lines directly linked to PO line items.
 * De-duplicate by invoice item ID; never infer an old line's work quantities.
 */
import { supabase } from './supabase';
import { fetchAllPages } from './paginatedQuery';
import type { BilledRow } from './poBilling';
const groups = <T,>(xs: T[], size = 100) => Array.from({ length: Math.ceil(xs.length / size) }, (_,n) => xs.slice(n * size,(n+1)*size));
export async function fetchOrderInvoiceHistory(orgId: string, orderId: string, lineIds: string[]): Promise<BilledRow[]> {
  const invoices = await fetchAllPages<{id:string}>((a,b) => supabase.from('invoices').select('id')
    .eq('organization_id',orgId).eq('purchase_order_id',orderId).order('id').range(a,b));
  const rows = new Map<string,BilledRow>();
  const select = 'id,work_item_id,shop_id,po_line_item_id,quantity,area,rate,amount';
  for (const ids of groups(invoices.map(row => row.id))) {
    const items = await fetchAllPages<BilledRow>((a,b) => supabase.from('invoice_items').select(select)
      .eq('organization_id',orgId).in('invoice_id',ids).order('id').range(a,b));
    for (const item of items) if (item.id) rows.set(item.id,item);
  }
  for (const ids of groups(lineIds)) {
    const items = await fetchAllPages<BilledRow>((a,b) => supabase.from('invoice_items').select(select)
      .eq('organization_id',orgId).in('po_line_item_id',ids).order('id').range(a,b));
    for (const item of items) if (item.id) rows.set(item.id,item);
  }
  return Array.from(rows.values());
}
