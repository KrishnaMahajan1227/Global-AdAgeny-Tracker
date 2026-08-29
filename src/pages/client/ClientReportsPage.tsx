import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { Card, EmptyState, PageHeader, StatusBadge, Select } from '@/components/ui';
import { LineItemProgressChart } from '@/components/LineItemProgressChart';
import { exportClientCampaignReport, exportClientPhotoComplianceReport, exportClientSiteDetailReport } from '@/lib/reports';
import { STATUS_LABELS, type PurchaseOrder, type ClientPOLineItemProgress, type Campaign, type WorkItem, type SurveyPhoto, type InstallationProof } from '@/lib/types';
import {
  buildClientCampaignRows, CLIENT_PO_WORK_STATUS_LABELS, CLIENT_PO_WORK_STATUS_COLORS, stagePct, finalStage,
} from '@/lib/clientPortal';
import { Download, FileBarChart, Image as ImageIcon, PieChart, AlertTriangle, Megaphone, Building2, ShoppingCart } from 'lucide-react';

type PoRow = PurchaseOrder & { agency_org: { name: string } | null };
type ShopRow = { id: string; name: string; city: string | null; district: string | null; address: string | null; status: string; purchase_order_id: string | null };

const SURVEYED_OR_LATER = new Set([
  'surveyed', 'approval_pending', 'approved', 'design_pending', 'designing', 'design_ready', 'in_review',
  'design_approved', 'production_pending', 'in_production', 'production_ready', 'production_hold',
  'production_done', 'dispatched', 'installation_pending', 'installing', 'installation_review', 'installed', 'billed',
]);
const INSTALLED_OR_LATER = new Set(['installation_review', 'installed', 'billed', 'dispatched']);
const STAGE_STEPS: { key: 'surveyed' | 'approved' | 'produced' | 'installed'; label: string }[] = [
  { key: 'surveyed', label: 'Survey' },
  { key: 'approved', label: 'Approved / Design' },
  { key: 'produced', label: 'Production' },
  { key: 'installed', label: 'Installation' },
];

// Reports — campaign performance export, photo compliance report, and a
// per-line-item progress chart (the same donut+stage-bars used on the PO
// Detail page's Report tab, for a consistent visual language across the
// whole client portal instead of a separate time-series chart here).
// Everything works off rate-free data (ClientPOLineItemProgress) — see
// clientPortal.ts's header comment for why that separation exists.
export default function ClientReportsPage() {
  const { profile } = useAuth();
  const orgId = profile?.organization_id;

  const [campaignFilter, setCampaignFilter] = useState('');
  const [agencyFilter, setAgencyFilter] = useState('');
  const [poFilter, setPoFilter] = useState('');
  const [progressPoId, setProgressPoId] = useState('');
  const [progressLineItemId, setProgressLineItemId] = useState('');

  // Dropping the parent filters resets whichever child filter they'd
  // otherwise leave pointed at a Work Order that's no longer in scope.
  useEffect(() => { setPoFilter(''); }, [campaignFilter, agencyFilter]);

  const { data: campaigns } = useQuery({
    queryKey: ['client-reports-campaigns', orgId],
    queryFn: async () => {
      const { data, error } = await supabase.from('campaigns').select('*').eq('client_org_id', orgId).order('created_at', { ascending: false });
      if (error) throw error;
      return data as Campaign[];
    },
    enabled: !!orgId,
  });

  const { data: pos } = useQuery({
    queryKey: ['client-reports-pos', orgId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('purchase_orders')
        .select('*, agency_org:organizations!purchase_orders_assigned_agency_id_fkey(name)')
        .eq('client_org_id', orgId)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data as PoRow[];
    },
    enabled: !!orgId,
  });

  const { data: shops } = useQuery({
    queryKey: ['client-reports-shops', orgId],
    queryFn: async () => {
      const { data, error } = await supabase.from('shops').select('id, name, city, district, address, status, purchase_order_id');
      if (error) throw error;
      return data as ShopRow[];
    },
    enabled: !!orgId,
  });

  const { data: progress } = useQuery({
    queryKey: ['client-reports-progress', orgId],
    queryFn: async () => {
      const { data, error } = await supabase.from('v_client_po_line_item_progress').select('*');
      if (error) throw error;
      return data as ClientPOLineItemProgress[];
    },
    enabled: !!orgId,
  });

  const { data: workItems } = useQuery({
    queryKey: ['client-reports-work-items', orgId],
    queryFn: async () => {
      const { data, error } = await supabase.from('work_items').select('id, shop_id, work_type_name, survey_area, survey_quantity, approved_area, approved_quantity, uom, created_at');
      if (error) throw error;
      return data as Pick<WorkItem, 'id' | 'shop_id' | 'work_type_name' | 'survey_area' | 'survey_quantity' | 'approved_area' | 'approved_quantity' | 'uom' | 'created_at'>[];
    },
    enabled: !!orgId,
  });

  const { data: surveyPhotos } = useQuery({
    queryKey: ['client-reports-survey-photos', orgId],
    queryFn: async () => {
      const { data, error } = await supabase.from('survey_photos').select('shop_id, photo_url, photo_type, created_at');
      if (error) throw error;
      return data as Pick<SurveyPhoto, 'shop_id' | 'photo_url' | 'photo_type' | 'created_at'>[];
    },
    enabled: !!orgId,
  });

  const { data: installPhotos } = useQuery({
    queryKey: ['client-reports-install-photos', orgId],
    queryFn: async () => {
      const { data, error } = await supabase.from('installation_proofs').select('shop_id, photo_url, photo_type, created_at');
      if (error) throw error;
      return data as Pick<InstallationProof, 'shop_id' | 'photo_url' | 'photo_type' | 'created_at'>[];
    },
    enabled: !!orgId,
  });

  const campaignById = useMemo(() => new Map((campaigns || []).map((c) => [c.id, c])), [campaigns]);

  // Agencies actually present in this client's own POs — built from real
  // data, not a platform-wide list, since offering an agency this client
  // has never worked with as a filter option would be meaningless.
  const agencyOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of pos || []) if (p.assigned_agency_id && p.agency_org?.name) map.set(p.assigned_agency_id, p.agency_org.name);
    return [{ value: '', label: 'All Agencies' }, ...Array.from(map.entries()).map(([id, name]) => ({ value: id, label: name }))];
  }, [pos]);

  const scopedPos = useMemo(
    () => (pos || []).filter((p) =>
      (!campaignFilter || p.campaign_id === campaignFilter) &&
      (!agencyFilter || p.assigned_agency_id === agencyFilter) &&
      (!poFilter || p.id === poFilter)
    ),
    [pos, campaignFilter, agencyFilter, poFilter]
  );
  // Kept as an alias — every section below already reads this name; only
  // its definition changed to also respect the Agency/Work Order filters.
  const posInCampaignFilter = scopedPos;

  const workOrderOptions = useMemo(() => {
    const scoped = (pos || []).filter((p) =>
      (!campaignFilter || p.campaign_id === campaignFilter) &&
      (!agencyFilter || p.assigned_agency_id === agencyFilter)
    );
    return [{ value: '', label: 'All Work Orders' }, ...scoped.map((p) => ({ value: p.id, label: p.name ? `${p.name} (${p.po_number})` : p.po_number }))];
  }, [pos, campaignFilter, agencyFilter]);

  // ---- Campaign performance ----
  const campaignRows = useMemo(
    () => buildClientCampaignRows(posInCampaignFilter, shops || [], progress || []),
    [posInCampaignFilter, shops, progress]
  );

  function handleExportCampaigns() {
    exportClientCampaignReport(
      campaignRows.map((r) => {
        const po = posInCampaignFilter.find((p) => p.id === r.po_id);
        const campaignName = po?.campaign_id ? campaignById.get(po.campaign_id)?.name || '—' : '—';
        return {
          campaign_name: campaignName,
          po_number: r.po_number,
          po_date: r.po_date,
          agency_name: r.agency_name,
          fulfillment_type: r.fulfillment_type,
          work_status: CLIENT_PO_WORK_STATUS_LABELS[r.work_status],
          sites_total: r.sites_total,
          completion_pct: r.completion_pct,
        };
      })
    );
  }

  // ---- Photo compliance (scoped to the same campaign filter) ----
  const poById = useMemo(() => new Map((pos || []).map((p) => [p.id, p])), [pos]);
  const poIdsInFilter = useMemo(() => new Set(posInCampaignFilter.map((p) => p.id)), [posInCampaignFilter]);
  const surveyCountByShop = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of surveyPhotos || []) m.set(p.shop_id, (m.get(p.shop_id) || 0) + 1);
    return m;
  }, [surveyPhotos]);
  const installCountByShop = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of installPhotos || []) m.set(p.shop_id, (m.get(p.shop_id) || 0) + 1);
    return m;
  }, [installPhotos]);

  const photoComplianceRows = useMemo(() => (shops || [])
    .filter((s) => !s.purchase_order_id || poIdsInFilter.has(s.purchase_order_id))
    .map((s) => {
      const po = s.purchase_order_id ? poById.get(s.purchase_order_id) : null;
      const surveyCount = surveyCountByShop.get(s.id) || 0;
      const installCount = installCountByShop.get(s.id) || 0;

      let compliant = true;
      let reason = 'OK';
      if (SURVEYED_OR_LATER.has(s.status) && surveyCount === 0) {
        compliant = false;
        reason = 'Survey photos missing';
      } else if (INSTALLED_OR_LATER.has(s.status) && installCount === 0) {
        compliant = false;
        reason = 'Installation photos missing';
      }

      return {
        shop_name: s.name,
        city: s.city,
        po_number: po?.name || po?.po_number || '—',
        status: STATUS_LABELS[s.status] || s.status,
        survey_photo_count: surveyCount,
        installation_photo_count: installCount,
        compliant,
        reason,
      };
    }), [shops, poById, poIdsInFilter, surveyCountByShop, installCountByShop]);

  const nonCompliantCount = photoComplianceRows.filter((r) => !r.compliant).length;

  function handleExportPhotoCompliance() {
    exportClientPhotoComplianceReport(photoComplianceRows);
  }

  // ---- Site Detail Report — the full corporate-style export: what was
  // assigned, when, how much is done, where, and every photo as a real
  // link (not just a count). Scoped by the same Campaign/Agency/Work
  // Order filters as everything else on this page. ----
  const workItemsByShop = useMemo(() => {
    const m = new Map<string, typeof workItems>();
    for (const w of workItems || []) {
      const list = m.get(w.shop_id) || [];
      list.push(w);
      m.set(w.shop_id, list as any);
    }
    return m;
  }, [workItems]);

  const siteDetailRows = useMemo(() => (shops || [])
    .filter((s) => !s.purchase_order_id || poIdsInFilter.has(s.purchase_order_id))
    .map((s) => {
      const po = s.purchase_order_id ? poById.get(s.purchase_order_id) : null;
      const items = workItemsByShop.get(s.id) || [];
      const workTypes = Array.from(new Set(items.map((w) => w.work_type_name).filter(Boolean)));
      const totalArea = items.reduce((sum, w) => sum + (w.approved_area ?? w.survey_area ?? 0), 0);
      const totalQty = items.reduce((sum, w) => sum + (w.approved_quantity ?? w.survey_quantity ?? 0), 0);
      const earliestAssigned = items.length > 0 ? items.map((w) => w.created_at).sort()[0] : null;
      return {
        shop_name: s.name,
        city: s.city,
        district: s.district,
        address: s.address,
        campaign_name: po?.campaign_id ? campaignById.get(po.campaign_id)?.name || '—' : '—',
        po_label: po ? (po.name || po.po_number) : '—',
        agency_name: po?.agency_org?.name || '—',
        status_label: STATUS_LABELS[s.status] || s.status,
        work_types: workTypes.join(', ') || '—',
        total_area_sqft: totalArea > 0 ? Math.round(totalArea * 100) / 100 : null,
        total_qty: totalQty > 0 ? totalQty : null,
        assigned_on: earliestAssigned ? new Date(earliestAssigned).toLocaleDateString('en-IN') : '—',
        survey_photo_count: surveyCountByShop.get(s.id) || 0,
        installation_photo_count: installCountByShop.get(s.id) || 0,
      };
    }), [shops, poIdsInFilter, poById, workItemsByShop, campaignById, surveyCountByShop, installCountByShop]);

  const siteShopIdsInFilter = useMemo(() => new Set(
    (shops || []).filter((s) => !s.purchase_order_id || poIdsInFilter.has(s.purchase_order_id)).map((s) => s.id)
  ), [shops, poIdsInFilter]);

  function shopMetaFor(shopId: string) {
    const s = (shops || []).find((sh) => sh.id === shopId);
    const po = s?.purchase_order_id ? poById.get(s.purchase_order_id) : null;
    return { shop_name: s?.name || 'Unknown', city: s?.city || null, po_label: po ? (po.name || po.po_number) : '—' };
  }

  function handleExportSiteDetail() {
    const surveyRows = (surveyPhotos || [])
      .filter((p) => siteShopIdsInFilter.has(p.shop_id))
      .map((p) => ({ ...shopMetaFor(p.shop_id), photo_type: p.photo_type, uploaded_on: new Date(p.created_at).toLocaleDateString('en-IN'), photo_url: p.photo_url }));
    const installRows = (installPhotos || [])
      .filter((p) => siteShopIdsInFilter.has(p.shop_id))
      .map((p) => ({ ...shopMetaFor(p.shop_id), photo_type: p.photo_type, uploaded_on: new Date(p.created_at).toLocaleDateString('en-IN'), photo_url: p.photo_url }));
    exportClientSiteDetailReport(siteDetailRows, surveyRows, installRows);
  }

  // ---- Per-line-item progress (donut + stage bars) ----
  const progressPoOptions = posInCampaignFilter.map((po) => ({ value: po.id, label: po.name ? `${po.name} (${po.po_number})` : po.po_number }));
  const lineItemsForProgressPo = (progress || []).filter((r) => r.purchase_order_id === progressPoId);
  const progressLineItemOptions = lineItemsForProgressPo.map((r) => ({ value: r.po_line_item_id, label: r.description }));
  const selectedProgressRow = lineItemsForProgressPo.find((r) => r.po_line_item_id === progressLineItemId) || null;
  const selectedPo = posInCampaignFilter.find((p) => p.id === progressPoId) || null;
  const progressFinalStage = selectedPo ? finalStage(selectedPo.fulfillment_type) : 'installed';
  const progressCompletionPct = selectedProgressRow ? stagePct([selectedProgressRow], progressFinalStage) : null;
  const progressStageValues = selectedProgressRow
    ? STAGE_STEPS.map((s) => ({ key: s.key, label: s.label, pct: stagePct([selectedProgressRow], s.key) }))
    : [];

  function handlePoChangeForProgress(poId: string) {
    setProgressPoId(poId);
    const firstLineItem = (progress || []).find((r) => r.purchase_order_id === poId);
    setProgressLineItemId(firstLineItem?.po_line_item_id || '');
  }

  const campaignOptions = [{ value: '', label: 'All Campaigns' }, ...(campaigns || []).map((c) => ({ value: c.id, label: c.name }))];

  const avgCompletionPct = useMemo(() => {
    const withPct = campaignRows.filter((r) => r.completion_pct != null);
    if (withPct.length === 0) return null;
    return withPct.reduce((sum, r) => sum + (r.completion_pct || 0), 0) / withPct.length;
  }, [campaignRows]);

  return (
    <div>
      <PageHeader title="Reports" subtitle="Exports and progress reports across every campaign and linked agency" />

      {(campaigns || []).length > 0 && (
        <Card className="p-4 mb-5">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1 flex items-center gap-1.5"><Megaphone className="w-3.5 h-3.5" /> Campaign</label>
              <select value={campaignFilter} onChange={(e) => setCampaignFilter(e.target.value)} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500">
                {campaignOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1 flex items-center gap-1.5"><Building2 className="w-3.5 h-3.5" /> Agency</label>
              <select value={agencyFilter} onChange={(e) => setAgencyFilter(e.target.value)} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500">
                {agencyOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1 flex items-center gap-1.5"><ShoppingCart className="w-3.5 h-3.5" /> Work Order</label>
              <select value={poFilter} onChange={(e) => setPoFilter(e.target.value)} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500">
                {workOrderOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
          </div>
        </Card>
      )}

      {/* Summary strip — the four numbers a client actually wants at a
          glance before drilling into a table or export. */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <SummaryStat label="Work Orders" value={String(campaignRows.length)} />
        <SummaryStat label="Sites Covered" value={String(campaignRows.reduce((sum, r) => sum + r.sites_total, 0))} />
        <SummaryStat label="Avg. Completion" value={avgCompletionPct != null ? `${Math.round(avgCompletionPct)}%` : '—'} />
        <SummaryStat label="Sites Needing Attention" value={String(nonCompliantCount)} warn={nonCompliantCount > 0} />
      </div>

      <div className="space-y-6">
        <Card className="p-5">
          <div className="flex items-start justify-between gap-4 flex-wrap mb-3">
            <div className="flex items-center gap-2">
              <FileBarChart className="w-4.5 h-4.5 text-slate-400" />
              <h2 className="font-semibold text-slate-900">Campaign Performance</h2>
            </div>
            <button
              onClick={handleExportCampaigns}
              disabled={campaignRows.length === 0}
              className="flex items-center gap-1.5 bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded-lg text-sm font-medium disabled:opacity-50"
            >
              <Download className="w-4 h-4" /> Export Excel
            </button>
          </div>
          {campaignRows.length === 0 ? (
            <EmptyState icon={<FileBarChart className="w-10 h-10" />} title="No Work Orders yet" />
          ) : (
            <div className="border border-slate-200 rounded-lg overflow-x-auto max-h-72 overflow-y-auto">
              <table className="w-full text-sm min-w-[560px]">
                <thead className="bg-slate-50 text-slate-500 text-xs uppercase sticky top-0">
                  <tr>
                    <th className="text-left px-3 py-2">Work Order</th>
                    <th className="text-left px-3 py-2">Agency</th>
                    <th className="text-left px-3 py-2">Status</th>
                    <th className="text-right px-3 py-2">Sites</th>
                    <th className="text-right px-3 py-2">Work Done</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {campaignRows.map((r) => (
                    <tr key={r.po_id}>
                      <td className="px-3 py-2 text-slate-900">{r.name || r.po_number}</td>
                      <td className="px-3 py-2 text-slate-600">{r.agency_name}</td>
                      <td className="px-3 py-2">
                        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${CLIENT_PO_WORK_STATUS_COLORS[r.work_status]}`}>
                          {CLIENT_PO_WORK_STATUS_LABELS[r.work_status]}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right text-slate-600">{r.sites_total}</td>
                      <td className="px-3 py-2 text-right font-medium text-slate-900">{r.completion_pct != null ? `${Math.round(r.completion_pct)}%` : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card className="p-5">
          <div className="flex items-start justify-between gap-4 flex-wrap mb-3">
            <div className="flex items-center gap-2">
              <ImageIcon className="w-4.5 h-4.5 text-slate-400" />
              <h2 className="font-semibold text-slate-900">Photo Compliance</h2>
              {nonCompliantCount > 0 && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-700">
                  <AlertTriangle className="w-3 h-3" /> {nonCompliantCount} need attention
                </span>
              )}
            </div>
            <button
              onClick={handleExportPhotoCompliance}
              disabled={photoComplianceRows.length === 0}
              className="flex items-center gap-1.5 bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded-lg text-sm font-medium disabled:opacity-50"
            >
              <Download className="w-4 h-4" /> Export Excel
            </button>
          </div>
          <div className="border border-slate-200 rounded-lg overflow-x-auto max-h-80 overflow-y-auto">
            <table className="w-full text-sm min-w-[640px]">
              <thead className="bg-slate-50 text-slate-500 text-xs uppercase sticky top-0">
                <tr>
                  <th className="text-left px-3 py-2">Site</th>
                  <th className="text-left px-3 py-2">Work Order</th>
                  <th className="text-left px-3 py-2">Status</th>
                  <th className="text-right px-3 py-2">Survey Photos</th>
                  <th className="text-right px-3 py-2">Install Photos</th>
                  <th className="text-center px-3 py-2">Compliant</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {photoComplianceRows.map((r, i) => (
                  <tr key={i} className={!r.compliant ? 'bg-amber-50/40' : ''}>
                    <td className="px-3 py-2 text-slate-900">{r.shop_name}<span className="block text-xs text-slate-400">{r.city}</span></td>
                    <td className="px-3 py-2 text-slate-600">{r.po_number}</td>
                    <td className="px-3 py-2 text-slate-600">{r.status}</td>
                    <td className="px-3 py-2 text-right text-slate-600">{r.survey_photo_count}</td>
                    <td className="px-3 py-2 text-right text-slate-600">{r.installation_photo_count}</td>
                    <td className="px-3 py-2 text-center">
                      {r.compliant ? <StatusBadge status="completed" label="Yes" /> : <StatusBadge status="production_hold" label={r.reason} />}
                    </td>
                  </tr>
                ))}
                {photoComplianceRows.length === 0 && (
                  <tr><td colSpan={6} className="px-3 py-6 text-center text-slate-400">No sites yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>

        <Card className="p-5">
          <div className="flex items-start justify-between gap-4 flex-wrap mb-3">
            <div>
              <div className="flex items-center gap-2">
                <FileBarChart className="w-4.5 h-4.5 text-slate-400" />
                <h2 className="font-semibold text-slate-900">Site Detail Report</h2>
              </div>
              <p className="text-xs text-slate-400 mt-1">
                The full corporate-style export — what was assigned, when, how much is done, where, and every survey/installation photo as a clickable link (not just a count).
              </p>
            </div>
            <button
              onClick={handleExportSiteDetail}
              disabled={siteDetailRows.length === 0}
              className="flex items-center gap-1.5 bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded-lg text-sm font-medium disabled:opacity-50 shrink-0"
            >
              <Download className="w-4 h-4" /> Export Excel
            </button>
          </div>
          {siteDetailRows.length === 0 ? (
            <EmptyState icon={<FileBarChart className="w-10 h-10" />} title="No sites in this scope yet" />
          ) : (
            <div className="border border-slate-200 rounded-lg overflow-x-auto max-h-80 overflow-y-auto">
              <table className="w-full text-sm min-w-[780px]">
                <thead className="bg-slate-50 text-slate-500 text-xs uppercase sticky top-0">
                  <tr>
                    <th className="text-left px-3 py-2">Site</th>
                    <th className="text-left px-3 py-2">Work Order</th>
                    <th className="text-left px-3 py-2">Agency</th>
                    <th className="text-left px-3 py-2">Work Type(s)</th>
                    <th className="text-left px-3 py-2">Status</th>
                    <th className="text-left px-3 py-2">Assigned On</th>
                    <th className="text-right px-3 py-2">Photos</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {siteDetailRows.map((r, i) => (
                    <tr key={i}>
                      <td className="px-3 py-2 text-slate-900">{r.shop_name}<span className="block text-xs text-slate-400">{r.city}</span></td>
                      <td className="px-3 py-2 text-slate-600">{r.po_label}</td>
                      <td className="px-3 py-2 text-slate-600">{r.agency_name}</td>
                      <td className="px-3 py-2 text-slate-600">{r.work_types}</td>
                      <td className="px-3 py-2 text-slate-600">{r.status_label}</td>
                      <td className="px-3 py-2 text-slate-600">{r.assigned_on}</td>
                      <td className="px-3 py-2 text-right text-slate-600">{r.survey_photo_count + r.installation_photo_count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card className="p-5">
          <div className="flex items-center gap-2 mb-3">
            <PieChart className="w-4.5 h-4.5 text-slate-400" />
            <h2 className="font-semibold text-slate-900">Progress by Line Item</h2>
          </div>
          {posInCampaignFilter.length === 0 ? (
            <EmptyState icon={<PieChart className="w-10 h-10" />} title="No Work Orders yet" />
          ) : (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-5">
                <Select label="Work Order" value={progressPoId} onChange={handlePoChangeForProgress} options={progressPoOptions} />
                <Select label="Line Item" value={progressLineItemId} onChange={setProgressLineItemId} options={progressLineItemOptions} />
              </div>
              {!selectedProgressRow ? (
                <p className="text-sm text-slate-400 py-6 text-center">Pick a Work Order and line item to see its progress breakdown.</p>
              ) : (
                <LineItemProgressChart
                  completionPct={progressCompletionPct}
                  completionLabel={STAGE_STEPS.find((s) => s.key === progressFinalStage)?.label || 'Complete'}
                  stages={progressStageValues}
                />
              )}
            </>
          )}
        </Card>
      </div>
    </div>
  );
}

function SummaryStat({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <Card className="p-4">
      <p className="text-xs text-slate-500">{label}</p>
      <p className={`text-xl font-bold mt-0.5 ${warn ? 'text-amber-600' : 'text-slate-900'}`}>{value}</p>
    </Card>
  );
}
