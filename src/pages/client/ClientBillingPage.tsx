import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { Card, EmptyState, PageHeader, StatusBadge, FilterButton, FilterDrawer, FilterSection } from '@/components/ui';
import { generateInvoicePDF } from '@/lib/reports';
import type { Client, Organization, Invoice, InvoiceItem } from '@/lib/types';
import { formatRupees } from '@/lib/poUtilization';
import { Search, IndianRupee, Download, FileText, Building2, Loader2 } from 'lucide-react';

type InvoiceRow = {
  id: string;
  organization_id: string;
  client_id: string;
  project_id: string | null;
  invoice_number: string;
  invoice_date: string;
  due_date: string | null;
  subtotal: number;
  tax_rate: number;
  tax_amount: number;
  total: number;
  payment_status: string;
  notes: string | null;
  created_at: string;
  purchase_order_id: string | null;
  purchase_orders: { po_number: string; name: string | null; assigned_agency_id: string | null; agency_org: { name: string } | null } | null;
  invoice_items: InvoiceItem[];
};

const STATUS_OPTIONS = [
  { value: 'unpaid', label: 'Unpaid' },
  { value: 'partial', label: 'Partial' },
  { value: 'paid', label: 'Paid' },
  { value: 'overdue', label: 'Overdue' },
];

// Doc section 4.5 — Billing: client-wide invoice list across every linked
// agency, agency-wise outstanding summary, and PDF downloads. Reuses the
// exact same generateInvoicePDF() the agency's own Billing page uses
// (lib/reports.ts) — the only new plumbing needed was letting a client_admin
// read the ONE `clients` row (migration 0041) and the relevant agency
// `organizations` rows (already readable per migration 0038) that PDF
// needs for its letterhead / "Bill To" block.
export default function ClientBillingPage() {
  const { profile } = useAuth();
  const orgId = profile?.organization_id;

  const [search, setSearch] = useState('');
  const [agencyFilter, setAgencyFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [sortBy, setSortBy] = useState('date_desc');
  const [filterDrawerOpen, setFilterDrawerOpen] = useState(false);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  const { data: invoices, isLoading } = useQuery({
    queryKey: ['client-billing-invoices', orgId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('invoices')
        .select('*, purchase_orders(po_number, name, assigned_agency_id, agency_org:organizations!purchase_orders_assigned_agency_id_fkey(name)), invoice_items(*)')
        .order('invoice_date', { ascending: false });
      if (error) throw error;
      return data as InvoiceRow[];
    },
    enabled: !!orgId,
    refetchInterval: 30000,
  });

  const agencyOrgIds = useMemo(
    () => Array.from(new Set((invoices || []).map((i) => i.organization_id))),
    [invoices]
  );
  const clientIds = useMemo(
    () => Array.from(new Set((invoices || []).map((i) => i.client_id))),
    [invoices]
  );

  // Fetched lazily once invoices are known, and only for the small set of
  // distinct agency orgs / agency-internal client records actually
  // referenced — not one query per invoice. Needed only at PDF-download
  // time, but loading them up front means the Download button never has
  // to show its own separate loading state per row.
  const { data: orgsById } = useQuery({
    queryKey: ['client-billing-orgs', agencyOrgIds.join(',')],
    queryFn: async () => {
      const { data, error } = await supabase.from('organizations').select('*').in('id', agencyOrgIds);
      if (error) throw error;
      return Object.fromEntries((data || []).map((o) => [o.id, o])) as Record<string, Organization>;
    },
    enabled: agencyOrgIds.length > 0,
  });

  const { data: clientsById } = useQuery({
    queryKey: ['client-billing-clients', clientIds.join(',')],
    queryFn: async () => {
      const { data, error } = await supabase.from('clients').select('*').in('id', clientIds);
      if (error) throw error;
      return Object.fromEntries((data || []).map((c) => [c.id, c])) as Record<string, Client>;
    },
    enabled: clientIds.length > 0,
  });

  const agencyOptions = useMemo(
    () => Array.from(
      new Map(
        (invoices || [])
          .filter((i) => i.purchase_orders?.assigned_agency_id)
          .map((i) => [i.purchase_orders!.assigned_agency_id as string, i.purchase_orders!.agency_org?.name || 'Agency'])
      ).entries()
    ),
    [invoices]
  );

  const filteredInvoices = (invoices || []).filter((inv) => {
    if (search) {
      const term = search.toLowerCase();
      const matches = inv.invoice_number.toLowerCase().includes(term) || (inv.purchase_orders?.po_number || '').toLowerCase().includes(term) || (inv.purchase_orders?.name || '').toLowerCase().includes(term);
      if (!matches) return false;
    }
    if (agencyFilter && inv.purchase_orders?.assigned_agency_id !== agencyFilter) return false;
    if (statusFilter && inv.payment_status !== statusFilter) return false;
    return true;
  });

  const sortedInvoices = [...filteredInvoices].sort((a, b) => {
    switch (sortBy) {
      case 'date_asc':
        return new Date(a.invoice_date).getTime() - new Date(b.invoice_date).getTime();
      case 'amount_desc':
        return (b.total || 0) - (a.total || 0);
      case 'agency_asc':
        return (a.purchase_orders?.agency_org?.name || '').localeCompare(b.purchase_orders?.agency_org?.name || '');
      case 'date_desc':
      default:
        return new Date(b.invoice_date).getTime() - new Date(a.invoice_date).getTime();
    }
  });
  const activeFilterCount = [agencyFilter, statusFilter].filter(Boolean).length;
  const SORT_OPTIONS = [
    { value: 'date_desc', label: 'Invoice Date (Newest first)' },
    { value: 'date_asc', label: 'Invoice Date (Oldest first)' },
    { value: 'amount_desc', label: 'Amount (Highest first)' },
    { value: 'agency_asc', label: 'Agency (A–Z)' },
  ];

  // Agency-wise outstanding summary (doc section 4.5)
  const agencySummary = new Map<string, { name: string; invoiced: number; paid: number }>();
  for (const inv of invoices || []) {
    const agencyId = inv.purchase_orders?.assigned_agency_id;
    if (!agencyId) continue;
    const entry = agencySummary.get(agencyId) || { name: inv.purchase_orders?.agency_org?.name || 'Agency', invoiced: 0, paid: 0 };
    entry.invoiced += inv.total || 0;
    if (inv.payment_status === 'paid') entry.paid += inv.total || 0;
    agencySummary.set(agencyId, entry);
  }
  const agencySummaryRows = Array.from(agencySummary.values());

  const totalInvoiced = (invoices || []).reduce((sum, i) => sum + (i.total || 0), 0);
  const totalPaid = (invoices || []).filter((i) => i.payment_status === 'paid').reduce((sum, i) => sum + (i.total || 0), 0);

  async function downloadInvoice(inv: InvoiceRow) {
    setDownloadingId(inv.id);
    try {
      const org = orgsById?.[inv.organization_id] || null;
      const client = clientsById?.[inv.client_id] || null;
      await generateInvoicePDF(inv as Invoice, inv.invoice_items || [], client, org);
    } finally {
      setDownloadingId(null);
    }
  }

  return (
    <div>
      <PageHeader title="Billing" subtitle="Invoices raised against you, across every linked agency" />

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
        <Card className="p-4">
          <p className="text-xs text-slate-500">Total Invoiced</p>
          <p className="text-xl font-bold text-slate-900 mt-1">{formatRupees(totalInvoiced)}</p>
        </Card>
        <Card className="p-4">
          <p className="text-xs text-slate-500">Total Paid</p>
          <p className="text-xl font-bold text-emerald-600 mt-1">{formatRupees(totalPaid)}</p>
        </Card>
        <Card className="p-4">
          <p className="text-xs text-slate-500">Outstanding</p>
          <p className="text-xl font-bold text-amber-600 mt-1">{formatRupees(totalInvoiced - totalPaid)}</p>
        </Card>
      </div>

      {agencySummaryRows.length > 0 && (
        <Card className="p-5 mb-6">
          <h2 className="font-semibold text-slate-900 mb-3 flex items-center gap-2"><Building2 className="w-4 h-4 text-slate-400" /> Agency-wise Outstanding</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {agencySummaryRows.map((a) => (
              <div key={a.name} className="border border-slate-100 rounded-lg px-3 py-2.5">
                <p className="text-sm font-medium text-slate-800 truncate">{a.name}</p>
                <div className="flex items-baseline justify-between mt-1">
                  <span className="text-xs text-slate-400">Outstanding</span>
                  <span className="text-sm font-semibold text-amber-600">{formatRupees(a.invoiced - a.paid)}</span>
                </div>
                <div className="flex items-baseline justify-between">
                  <span className="text-xs text-slate-400">Invoiced</span>
                  <span className="text-xs text-slate-500">{formatRupees(a.invoiced)}</span>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      <div className="flex flex-wrap items-center gap-2 mb-5">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search invoice or PO number..."
            className="w-full pl-9 pr-3 py-2 border border-slate-300 rounded-lg text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <select value={sortBy} onChange={(e) => setSortBy(e.target.value)} className="px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500">
          {SORT_OPTIONS.map((o) => <option key={o.value} value={o.value}>Sort: {o.label}</option>)}
        </select>
        <FilterButton activeCount={activeFilterCount} onClick={() => setFilterDrawerOpen(true)} />
        {activeFilterCount > 0 && <span className="text-xs text-slate-400">{filteredInvoices.length} of {(invoices || []).length} shown</span>}
      </div>

      <FilterDrawer
        open={filterDrawerOpen}
        onClose={() => setFilterDrawerOpen(false)}
        onClear={() => { setAgencyFilter(''); setStatusFilter(''); }}
        activeCount={activeFilterCount}
        resultCount={filteredInvoices.length}
        resultLabel="invoices"
      >
        <FilterSection label="Agency">
          <select value={agencyFilter} onChange={(e) => setAgencyFilter(e.target.value)} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500">
            <option value="">All Agencies</option>
            {agencyOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
        </FilterSection>
        <FilterSection label="Status">
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500">
            <option value="">All Statuses</option>
            {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </FilterSection>
      </FilterDrawer>

      <div className="space-y-3">
        {sortedInvoices.map((inv) => (
          <Card key={inv.id} className="p-4">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
              <div className="min-w-[140px]">
                <p className="font-semibold text-slate-900">{inv.invoice_number}</p>
                <p className="text-xs text-slate-500">{new Date(inv.invoice_date).toLocaleDateString('en-IN')}</p>
              </div>
              <div className="min-w-[120px]">
                <p className="text-xs text-slate-400">PO</p>
                <p className="text-sm text-slate-700">{inv.purchase_orders?.name || inv.purchase_orders?.po_number || '—'}</p>
              </div>
              <div className="min-w-[140px]">
                <p className="text-xs text-slate-400">Agency</p>
                <p className="text-sm text-slate-700">{inv.purchase_orders?.agency_org?.name || '—'}</p>
              </div>
              <div className="min-w-[100px]">
                <p className="text-xs text-slate-400">Due Date</p>
                <p className="text-sm text-slate-700">{inv.due_date ? new Date(inv.due_date).toLocaleDateString('en-IN') : '—'}</p>
              </div>
              <div className="min-w-[100px]">
                <p className="text-lg font-bold text-slate-900 flex items-center gap-0.5"><IndianRupee className="w-4 h-4" />{inv.total.toLocaleString('en-IN')}</p>
              </div>
              <StatusBadge status={inv.payment_status} />
              <button
                onClick={() => downloadInvoice(inv)}
                disabled={downloadingId === inv.id}
                className="ml-auto flex items-center gap-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 px-3 py-1.5 rounded-lg text-sm font-medium disabled:opacity-50"
              >
                {downloadingId === inv.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                PDF
              </button>
            </div>
          </Card>
        ))}
        {!isLoading && filteredInvoices.length === 0 && (
          <Card>
            <EmptyState
              icon={<FileText className="w-12 h-12" />}
              title={invoices && invoices.length > 0 ? 'No invoices match these filters' : 'No invoices yet'}
              subtitle={invoices && invoices.length > 0 ? 'Try clearing a filter' : "Invoices your agencies raise against your POs will show up here"}
            />
          </Card>
        )}
      </div>
    </div>
  );
}
