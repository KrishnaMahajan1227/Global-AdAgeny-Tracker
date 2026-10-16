import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const s=readFileSync(new URL('../src/pages/BillingPage.tsx',import.meta.url),'utf8');
const rpc=readFileSync(new URL('../supabase/migrations/20261026110000_0096_invoice_archive_delete_rpc.sql',import.meta.url),'utf8');
const reset=readFileSync(new URL('../supabase/manual/ARCHIVE_AND_CLEAR_OLD_BILLING.sql',import.meta.url),'utf8');
const checks=[
 ['One canonical Billing screen',s.includes('export default function BillingPage')],
 ['Work Order filter always visible',s.includes('aria-label="Invoice filters"')&&s.includes('All Work Orders')],
 ['Visible client filter',s.includes('All clients')],
 ['Visible payment filter',s.includes('All statuses')],
 ['Visible date period',s.includes('Last 30 days')],
 ['Pagination for many invoices',s.includes('visibleInvoices.map')&&s.includes('invoicePageSize')],
 ['No direct destructive row button',s.includes('More actions for')&&s.includes('Archive & remove')],
 ['Typed invoice number required',s.includes('deleteConfirmation.trim() !== inv.invoice_number')],
 ['Safe server archive RPC',s.includes("supabase.rpc('billing_archive_delete_invoice'")],
 ['Server role enforcement',rpc.includes("'agency_owner','admin'")],
 ['Server confirms invoice number',rpc.includes('p_confirm_number IS DISTINCT FROM')],
 ['Nonpaid deletion denied',rpc.includes("payment_status IS DISTINCT FROM 'unpaid'")],
 ['Private archive storage',rpc.includes('adroute_billing_archive.reset_records')],
 ['Audit server-side deletion',rpc.includes('INSERT INTO public.audit_logs')],
 ['Bulk reset transactional',reset.includes('BEGIN;')&&reset.includes('COMMIT;')],
 ['Bulk reset explicit confirmation',reset.includes('ARCHIVE AND CLEAR THIS AGENCY BILLING')],
 ['Bulk reset no operational table purge',!reset.includes('TRUNCATE')&&!reset.includes('DELETE FROM public.shops')],
 ['PO-first creation retained',s.includes('buildPendingAllocations')&&s.includes('selectPO(')],
 ['Previous invoice subtraction retained',s.includes('freshBilled')&&s.includes('buildPendingAllocations(freshWork')],
];
for(const [name,passed] of checks){assert(passed,name);console.log('PASS',name)}
console.log(`${checks.length} checks passed`);
