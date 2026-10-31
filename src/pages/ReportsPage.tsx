import { fetchAllPages } from '@/lib/paginatedQuery';
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { Card, FilterButton, FilterDrawer, FilterSection } from '@/components/ui';
import {
  generateSurveyReportPDF, generateInstallationReportPDF, generateInvoicePDF, generateInvoiceBundlePDF,
  generateFinalClientReportPDF, exportShopsToExcel, exportMultiSheetExcel, exportPOUtilizationToExcel,
  exportVehicleLoadLogToExcel, generatePreApprovalPPT, generateFinalInstallationPPT,
  buildDesignComparisonRows, generateDesignComparisonPDF, generateDesignComparisonPPT,
  generateDesignComparisonPDFMulti, generateDesignComparisonPPTMulti,
  SurveyReportEntry, InstallationReportEntry, FinalReportEntry, InvoiceReportEntry,
} from '@/lib/reports';
import { fetchVehicleLoadLog } from '@/lib/vehicleLoadLog';
import { generatePortfolioReport } from '@/lib/reportPortfolio';
import {
  FileText, FileSpreadsheet, Presentation, Download, FileBarChart, ShoppingCart, Truck,
  Layers, CheckCircle2, AlertCircle, X, Loader2, Store, Search, Images,
} from 'lucide-react';
import type { Organization, Client, POLineItemUtilization, DesignVersion, DesignVersionItem } from '@/lib/types';

// Report types that walk shop-by-shop (as opposed to Excel exports, which
// already write everything into a single file/workbook regardless of how
// many shops are included).
const PER_SHOP_REPORT_TYPES = new Set(['survey-pdf', 'installation-pdf', 'final-report-pdf', 'design-approval-pdf', 'design-approval-ppt']);
// Client-side safety valve: generating a design comparison walks every
// board's photo through canvas rendering, so an unnarrowed "all shops"
// selection could otherwise hang the tab for minutes.
const DESIGN_APPROVAL_MAX_SHOPS = 40;

type FormatVariant = { type: string; label: string; ext: 'PDF' | 'PPTX' | 'XLSX' };
interface ReportCardDef {
  id: string;
  label: string;
  desc: string;
  icon: any;
  color: string;
  variants: FormatVariant[];
}

const REPORT_GROUPS: { title: string; subtitle: string; cards: ReportCardDef[] }[] = [
  {
    title: 'Field reports',
    subtitle: 'Survey, installation and consolidated client reports — sectioned per shop',
    cards: [
      { id: 'survey', label: 'Survey Report', desc: 'Photos, dimensions and GPS for every surveyed shop.', icon: FileText, color: 'blue', variants: [{ type: 'survey-pdf', label: 'PDF', ext: 'PDF' }] },
      { id: 'installation', label: 'Installation Report', desc: 'Proof photos and GPS for every completed installation.', icon: FileText, color: 'emerald', variants: [{ type: 'installation-pdf', label: 'PDF', ext: 'PDF' }] },
      { id: 'final-report', label: 'Final Client Report', desc: 'Full journey — survey through installation — in one document.', icon: FileBarChart, color: 'teal', variants: [{ type: 'final-report-pdf', label: 'PDF', ext: 'PDF' }] },
    ],
  },
  {
    title: 'Design approval',
    subtitle: 'The marked survey photo next to the design for every board',
    cards: [
      {
        id: 'design-approval', label: 'Design Approval Report',
        desc: 'Side-by-side: what was surveyed vs. what was designed, board by board. 2 boards per PDF page, 1 board per slide in the deck. Combine every shop into one file, or export one file per shop — your call, in the toggle above.',
        icon: Layers, color: 'fuchsia',
        variants: [{ type: 'design-approval-pdf', label: 'PDF', ext: 'PDF' }, { type: 'design-approval-ppt', label: 'Deck', ext: 'PPTX' }],
      },
    ],
  },
  {
    title: 'Client presentation decks',
    subtitle: 'Ready-to-present slide decks for sign-off calls',
    cards: [
      { id: 'ppt-preapproval', label: 'Pre-Approval Deck', desc: 'Survey photos only, one slide per shop — for sign-off before design begins.', icon: Presentation, color: 'amber', variants: [{ type: 'ppt-preapproval', label: 'Deck', ext: 'PPTX' }] },
      { id: 'ppt-final', label: 'Final Installation Deck', desc: 'Before/after photos, one slide per shop — for Work Order close-out.', icon: Presentation, color: 'emerald', variants: [{ type: 'ppt-final', label: 'Deck', ext: 'PPTX' }] },
    ],
  },
  {
    title: 'Data exports',
    subtitle: 'Spreadsheets for offline review — photo and design links included where available',
    cards: [
      { id: 'excel', label: 'Shops Export', desc: 'Shop summary plus separate Survey Photos, Installation Photos and Design Files sheets — one row per photo, marked boards flagged, real clickable links.', icon: FileSpreadsheet, color: 'cyan', variants: [{ type: 'excel', label: 'Excel', ext: 'XLSX' }] },
      { id: 'excel-multi', label: 'Multi-Sheet Export', desc: 'One sheet per pipeline stage, plus the same Survey/Installation/Design photo sheets.', icon: FileSpreadsheet, color: 'blue', variants: [{ type: 'excel-multi', label: 'Excel', ext: 'XLSX' }] },
      { id: 'po-utilization', label: 'PO Utilization Report', desc: 'Budgeted vs. surveyed/approved/produced/installed vs. invoiced, with variance flags.', icon: ShoppingCart, color: 'indigo', variants: [{ type: 'po-utilization', label: 'Excel', ext: 'XLSX' }] },
      { id: 'vehicle-load-log', label: 'Vehicle Load Log', desc: 'Every board loaded onto every vehicle, with driver, quantities and trip grouping.', icon: Truck, color: 'blue', variants: [{ type: 'vehicle-load-log', label: 'Excel', ext: 'XLSX' }] },
    ],
  },
  {
    title: 'Billing',
    subtitle: '',
    cards: [
      { id: 'invoice', label: 'Invoice PDF', desc: 'Itemized invoice(s) with your agency letterhead.', icon: FileText, color: 'green', variants: [{ type: 'invoice-pdf', label: 'PDF', ext: 'PDF' }] },
    ],
  },
];

const colorMap: Record<string, string> = {
  blue: 'bg-blue-50 text-blue-600', cyan: 'bg-cyan-50 text-cyan-600',
  emerald: 'bg-emerald-50 text-emerald-600', green: 'bg-green-50 text-green-600',
  teal: 'bg-teal-50 text-teal-600', amber: 'bg-amber-50 text-amber-600',
  indigo: 'bg-indigo-50 text-indigo-600', fuchsia: 'bg-fuchsia-50 text-fuchsia-600',
};

export default function ReportsPage() {
  const { profile } = useAuth();
  const orgId = profile?.organization_id;

  const [selectedClient, setSelectedClient] = useState('');
  const [selectedPO, setSelectedPO] = useState('');
  const [zoneFilter, setZoneFilter] = useState('');
  const [shopStatus, setShopStatus] = useState('');
  const [period, setPeriod] = useState<'all' | 'today' | 'week' | 'month' | 'last30' | 'custom'>('all');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [selectedShopIds, setSelectedShopIds] = useState<Set<string>>(new Set());
  const [shopSearch, setShopSearch] = useState('');
  const [downloadMode, setDownloadMode] = useState<'combined' | 'separate'>('combined');
  const [reportSearch, setReportSearch] = useState('');
  const [filterOpen, setFilterOpen] = useState(false);
  const [generating, setGenerating] = useState<string | null>(null);
  const [genProgress, setGenProgress] = useState<{ done: number; total: number } | null>(null);
  const [notice, setNotice] = useState<{ kind: 'error' | 'success'; message: string } | null>(null);

  // Resetting a level whenever its parent changes so the dropdowns can never
  // point at a combination that no longer makes sense (e.g. a PO from a
  // campaign that was just deselected).
  useEffect(() => { setSelectedPO(''); setSelectedShopIds(new Set()); }, [selectedClient]);
  useEffect(() => { setSelectedShopIds(new Set()); }, [selectedPO]);

  const { data: org } = useQuery({
    queryKey: ['organization', orgId],
    queryFn: async () => {
      const { data } = await supabase.from('organizations').select('*').eq('id', orgId).maybeSingle();
      return data as Organization | null;
    },
    enabled: !!orgId,
  });

  const { data: clients } = useQuery({
    queryKey: ['clients', orgId],
    queryFn: async () => {
      const data = await fetchAllPages<any>((a, b) => supabase.from('clients').select('id, name').eq('organization_id', orgId!).eq('is_active', true).order('id').range(a, b));
      return data as Client[];
    },
    enabled: !!orgId,
  });


  const { data: purchaseOrders } = useQuery({
    queryKey: ['purchase-orders-reports', orgId],
    queryFn: async () => {
      const data = await fetchAllPages<any>((a, b) => supabase.from('purchase_orders').select('id, po_number, name, client_id, project_id').eq('organization_id', orgId!).order('id').range(a, b));
      return data as { id: string; po_number: string; name: string | null; client_id: string; project_id: string | null }[];
    },
    enabled: !!orgId,
  });

  const { data: zones } = useQuery({
    queryKey: ['report-zones', orgId],
    queryFn: async () => fetchAllPages<{ id: string; name: string }>((a,b) =>
      supabase.from('zones').select('id,name').eq('organization_id',orgId!).order('id').range(a,b)),
    enabled: !!orgId,
  });

  const { data: shops } = useQuery({
    queryKey: ['shops-reports', orgId, selectedClient, selectedPO],
    queryFn: async () => {
      let q = supabase.from('shops').select('*, clients(name), projects(name), zones(name), purchase_orders(name,po_number)').eq('organization_id', orgId);
      if (selectedClient) q = q.eq('client_id', selectedClient);
      if (selectedPO) q = q.eq('purchase_order_id', selectedPO);
      return fetchAllPages<any>((a, b) => q.order('id').range(a, b));
    },
    enabled: !!orgId,
  });

  const { data: workItems, isError: workItemsError } = useQuery({
    queryKey: ['work-items-reports', orgId],
    queryFn: async () => {
      const data = await fetchAllPages<any>((a, b) => supabase.from('work_items').select('*').eq('organization_id', orgId!).order('id').range(a, b));
      return data;
    },
    enabled: !!orgId,
  });

  const { data: surveys } = useQuery({
    queryKey: ['surveys-reports', orgId],
    queryFn: async () => {
      // `surveys` has two FKs into `profiles` (surveyor_id, reviewed_by) — a
      // plain `profiles(full_name)` embed is ambiguous and errors out.
      return fetchAllPages<any>((a, b) => supabase.from('surveys').select('*, profiles:surveyor_id(full_name)').eq('organization_id', orgId!).order('id').range(a, b));
    },
    enabled: !!orgId,
  });

  const { data: surveyPhotos, isError: surveyPhotosError } = useQuery({
    queryKey: ['survey-photos-reports', orgId],
    queryFn: async () => {
      const data = await fetchAllPages<any>((a, b) => supabase.from('survey_photos').select('*').eq('organization_id', orgId!).order('id').range(a, b));
      return data;
    },
    enabled: !!orgId,
  });

  const { data: surveyPhotoItems } = useQuery({
    queryKey: ['survey-photo-items-reports', orgId],
    queryFn: async () => {
      const { data, error } = await supabase.from('survey_photo_items').select('survey_photo_id,work_item_id').eq('organization_id', orgId);
      if (error && !/survey_photo_items|schema cache|could not find the table/i.test(error.message || '')) throw error;
      return error ? [] : (data || []);
    },
    enabled: !!orgId,
  });

  // Marked board polygons — needed so exports can burn the marked area into
  // the exported image instead of just linking to a plain, unmarked photo.
  const { data: boardMarkings, isError: boardMarkingsError } = useQuery({
    queryKey: ['board-markings-reports', orgId],
    queryFn: async () => {
      const data = await fetchAllPages<any>((a, b) => supabase.from('board_markings').select('*').eq('organization_id', orgId!).order('id').range(a, b));
      return data;
    },
    enabled: !!orgId,
  });

  const { data: installations, isError: installationsError } = useQuery({
    queryKey: ['installations-reports', orgId],
    queryFn: async () => {
      // `installation_jobs` has two FKs into `profiles` — same ambiguous-embed issue as surveys.
      return fetchAllPages<any>((a, b) => supabase.from('installation_jobs').select('*, profiles:installer_id(full_name), installation_proofs(*)').eq('organization_id', orgId!).order('id').range(a, b));
    },
    enabled: !!orgId,
  });

  const { data: invoices } = useQuery({
    queryKey: ['invoices-reports', orgId],
    queryFn: async () => {
      const { data } = await supabase.from('invoices').select('*, invoice_items(*), clients(name)').eq('organization_id', orgId).order('created_at', { ascending: false });
      return data || [];
    },
    enabled: !!orgId,
  });

  // Design versions + the join table linking each version to the boards it
  // covers — needed for the Design Approval report (survey photo vs. design).
  const { data: designVersions, isError: designVersionsError } = useQuery({
    queryKey: ['design-versions-reports', orgId],
    queryFn: async () => {
      const data = await fetchAllPages<any>((a, b) => supabase.from('design_versions').select('*').eq('organization_id', orgId!).order('id').range(a, b));
      return data;
    },
    enabled: !!orgId,
  });

  const { data: designVersionItems, isError: designVersionItemsError } = useQuery({
    queryKey: ['design-version-items-reports', orgId],
    queryFn: async () => {
      const data = await fetchAllPages<any>((a, b) => supabase.from('design_version_items').select('*').eq('organization_id', orgId!).order('id').range(a, b));
      return data;
    },
    enabled: !!orgId,
  });

  const { data: poUtilizationRows } = useQuery({
    queryKey: ['po-utilization-reports', orgId, selectedClient],
    queryFn: async () => {
      let q = supabase.from('v_po_line_item_utilization').select('*');
      if (selectedClient) q = q.eq('client_id', selectedClient);
      return fetchAllPages<POLineItemUtilization>((a, b) => q.order('po_date', { ascending: false }).range(a, b));
    },
    enabled: !!orgId,
  });

  const periodRange = useMemo(() => {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (period === 'today') return { from: start, to: now };
    if (period === 'week') { start.setDate(start.getDate() - ((start.getDay() + 6) % 7)); return { from: start, to: now }; }
    if (period === 'month') { start.setDate(1); return { from: start, to: now }; }
    if (period === 'last30') { start.setDate(start.getDate() - 29); return { from: start, to: now }; }
    if (period === 'custom') return { from: dateFrom ? new Date(`${dateFrom}T00:00:00`) : null,
      to: dateTo ? new Date(`${dateTo}T23:59:59`) : null };
    return { from: null, to: null };
  }, [period, dateFrom, dateTo]);

  // Report period follows actual field activity, not just shop creation.
  // An old shop surveyed this month should appear in this month's report.
  const activityByShop = useMemo(() => {
    const dates = new Map<string, number>();
    for (const row of [...(surveys || []), ...(installations || [])]) {
      const time = Date.parse(row.completed_at || row.submitted_at || row.created_at || '');
      if (row.shop_id && Number.isFinite(time)) dates.set(row.shop_id, Math.max(dates.get(row.shop_id) || 0,time));
    }
    return dates;
  }, [surveys, installations]);

  const scopedShops = useMemo(() => shops || [], [shops]);
  const filteredShops = useMemo(() => scopedShops.filter((s: any) => {
    if (selectedShopIds.size && !selectedShopIds.has(s.id)) return false;
    if (zoneFilter === '__NO_ZONE__' && s.zone_id) return false;
    if (zoneFilter && zoneFilter !== '__NO_ZONE__' && s.zone_id !== zoneFilter) return false;
    if (shopStatus && s.status !== shopStatus) return false;
    const when = activityByShop.get(s.id) || Date.parse(s.updated_at || s.created_at || '');
    if (periodRange.from && (!Number.isFinite(when) || when < periodRange.from.getTime())) return false;
    if (periodRange.to && (!Number.isFinite(when) || when > periodRange.to.getTime())) return false;
    return true;
  }), [scopedShops, selectedShopIds, zoneFilter, shopStatus, periodRange, activityByShop]);
  const visibleShopOptions = useMemo(() => {
    const q = shopSearch.trim().toLowerCase();
    if (!q) return scopedShops;
    return scopedShops.filter((s: any) => s.name?.toLowerCase().includes(q) || s.city?.toLowerCase().includes(q));
  }, [scopedShops, shopSearch]);

  // Prunes selections that fall out of scope whenever the Client/Campaign/PO
  // filters change the underlying shop list, so a stale shop id from a
  // previous scope can never silently linger in the selection.
  useEffect(() => {
    setSelectedShopIds((prev) => {
      if (prev.size === 0) return prev;
      const validIds = new Set(scopedShops.map((s: any) => s.id));
      const next = new Set([...prev].filter((id) => validIds.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [scopedShops]);

  function toggleShopSelected(id: string) {
    setSelectedShopIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  const selectedClientLabel = useMemo(() => clients?.find((c) => c.id === selectedClient)?.name, [selectedClient, clients]);

  const poOptions = useMemo(
    () => (purchaseOrders || []).filter((p) =>
      (!selectedClient || p.client_id === selectedClient) &&
      true
    ),
    [purchaseOrders, selectedClient]
  );
  const scopedPoUtilizationRows = useMemo(
    () => (poUtilizationRows || []).filter((r) =>
      (!selectedPO || r.purchase_order_id === selectedPO)
    ),
    [poUtilizationRows, selectedPO]
  );

  const activeFilterCount = [selectedClient, selectedPO, zoneFilter, shopStatus, period !== 'all' ? period : ''].filter(Boolean).length + (selectedShopIds.size > 0 ? 1 : 0);

  function clearFilters() {
    setSelectedClient(''); setSelectedPO(''); setSelectedShopIds(new Set()); setShopSearch('');
    setZoneFilter(''); setShopStatus(''); setPeriod('all'); setDateFrom(''); setDateTo('');
  }

  // Every shop-touching Excel export reads from the same raw tables, so
  // each photo/design file always lands on its own row (see
  // buildSurveyPhotoRows etc. in reports.ts) instead of being squeezed
  // into one messy multi-URL cell per shop.
  function excelPhotoSources() {
    return {
      surveyPhotos: surveyPhotos || [],
      boardMarkings: boardMarkings || [],
      installationProofs: (installations || []).flatMap((i) => i.installation_proofs || []),
      designVersions: designVersions || [],
      designVersionItems: designVersionItems || [],
    };
  }

  async function handleGenerate(type: string) {
    setGenerating(type);
    setGenProgress(null);
    setNotice(null);
    try {
      const combined = downloadMode === 'combined';
      if (period === 'custom' && dateFrom && dateTo && dateFrom > dateTo) {
        throw new Error('The From date cannot be later than the To date.');
      }
      const hasShopFilters = !!(zoneFilter || shopStatus || selectedShopIds.size);
      if (hasShopFilters && ['invoice-pdf','po-utilization'].includes(type)) {
        throw new Error('Zone and shop filters apply to field reports only; clear them for billing and Work Order utilization.');
      }


      if (PER_SHOP_REPORT_TYPES.has(type) && filteredShops.length === 0) {
        setNotice({ kind: 'error', message: 'Select at least one shop using the filters first.' });
        return;
      }

      // Other-format actions share a scoped, evidence-aware export path.
      if (type.startsWith('unified:')) {
        const [,kind,format] = type.split(':');
        if (!['PDF','PPTX','XLSX'].includes(format)) throw new Error('Unsupported export format.');
        const isShopReport = !['invoice','po-utilization','vehicle-load-log'].includes(kind);
        if (isShopReport && (workItemsError || surveyPhotosError || boardMarkingsError || installationsError || (['design-approval','final-report'].includes(kind) && (designVersionsError || designVersionItemsError)))) {
          throw new Error('Some report evidence could not be fetched. Please retry after checking the connection and Storage permissions.');
        }
        if (isShopReport && (!workItems || !surveyPhotos || !boardMarkings || !installations)) {
          throw new Error('Report evidence is still loading. Please retry after the data has finished loading.');
        }
        if (!isShopReport && kind !== 'vehicle-load-log' && (zoneFilter || shopStatus || selectedShopIds.size)) {
          throw new Error('Zone, shop-status and shop selection apply to shop reports only. Clear these filters to export financial or vehicle reports.');
        }
        const dateWithin = (v: string | null | undefined) => {
          if (!periodRange.from && !periodRange.to) return true;
          const t=Date.parse(v || '');
          return Number.isFinite(t) && (!periodRange.from || t >= periodRange.from.getTime()) && (!periodRange.to || t <= periodRange.to.getTime());
        };
        const selectedPOIds = new Set((purchaseOrders || []).filter(p =>
          (!selectedClient || p.client_id === selectedClient) && (!selectedPO || p.id === selectedPO)
        ).map(p=>p.id));
        const allowedShopIds = new Set(filteredShops.map((s:any)=>s.id));
        const vehicleRows = kind === 'vehicle-load-log' && orgId ? (await fetchVehicleLoadLog(orgId, periodRange.from || undefined))
          .filter(r=>allowedShopIds.has(r.shop_id) && dateWithin(r.loaded_at)) : [];
        const n = await generatePortfolioReport({
          shops: filteredShops,
          workItems: (workItems || []).filter(w=>filteredShops.some(s=>s.id === w.shop_id)),
          surveys: (surveys || []).filter(r=>filteredShops.some(s=>s.id === r.shop_id)),
          surveyPhotos: (surveyPhotos || []).filter(r=>filteredShops.some(s=>s.id === r.shop_id)),
          markings: (boardMarkings || []).filter(m=>(surveyPhotos || []).some(p=>p.id === m.survey_photo_id && filteredShops.some(s=>s.id===p.shop_id))),
          surveyPhotoItems: (surveyPhotoItems || []).filter((link:any)=>(surveyPhotos || []).some(p=>p.id===link.survey_photo_id && filteredShops.some(s=>s.id===p.shop_id))),
          installations: (installations || []).filter(r=>filteredShops.some(s=>s.id === r.shop_id)),
          designVersions: designVersions || [],
          designVersionItems: designVersionItems || [],
          invoices: (invoices || []).filter(r=>(!selectedClient || r.client_id===selectedClient) && (!selectedPO || r.purchase_order_id===selectedPO) && dateWithin(r.invoice_date || r.created_at)),
          utilization: (scopedPoUtilizationRows || []).filter(r=>selectedPOIds.has(r.purchase_order_id) && dateWithin(r.po_date)),
          vehicleRows,
        }, {
          kind, format: format as 'PDF'|'PPTX'|'XLSX',
          filePrefix: `${kind}-${period}`,
          organization: org?.name || 'Agency',
          period: period === 'all' ? 'All dates' : period === 'custom' ? `${dateFrom || 'Start'} to ${dateTo || 'End'}` : period,
          combined,
          onImageProgress: (done,total) => setGenProgress({done,total}),
        });
        setNotice({kind:'success',message:`${format} report ready · ${n} ${isShopReport ? 'shop(s)' : 'section(s)'}.`});
        return;
      }

      switch (type) {
        case 'survey-pdf': {
          const entries: SurveyReportEntry[] = [];
          for (const shop of filteredShops.filter((s: any) => s.status !== 'pending' && s.status !== 'assigned')) {
            const shopSurvey = (surveys || []).find((s) => s.shop_id === shop.id);
            if (!shopSurvey) continue;
            const photos = (surveyPhotos || []).filter((p) => p.shop_id === shop.id);
            const items = (workItems || []).filter((w) => w.shop_id === shop.id);
            const photoIds = new Set(photos.map((p) => p.id));
            const shopMarkings = (boardMarkings || []).filter((m) => photoIds.has(m.survey_photo_id));
            entries.push({ shop: shop as any, survey: shopSurvey as any, photos: photos as any, workItems: items as any, surveyorName: (shopSurvey as any).profiles?.full_name || 'Unknown', markings: shopMarkings as any });
          }
          if (entries.length === 0) { setNotice({ kind: 'error', message: 'No submitted surveys found for the selected shops.' }); break; }
          if (combined) {
            await generateSurveyReportPDF(entries, org, { groupLabel: selectedClientLabel, fileName: bundleFileName('survey-report', selectedClientLabel, entries.length) });
          } else {
            for (const entry of entries) await generateSurveyReportPDF([entry], org);
          }
          setNotice({ kind: 'success', message: `Survey Report ready — ${entries.length} shop(s).` });
          break;
        }

        case 'installation-pdf': {
          const entries: InstallationReportEntry[] = [];
          for (const shop of filteredShops.filter((s: any) => s.status === 'installed')) {
            const job = (installations || []).find((i) => i.shop_id === shop.id);
            if (!job) continue;
            const proofs = job.installation_proofs || [];
            const items = (workItems || []).filter((w) => w.shop_id === shop.id);
            entries.push({ shop: shop as any, job: job as any, proofs: proofs as any, workItems: items as any, installerName: (job as any).profiles?.full_name || 'Unknown' });
          }
          if (entries.length === 0) { setNotice({ kind: 'error', message: 'No installation records found for the selected shops.' }); break; }
          if (combined) {
            await generateInstallationReportPDF(entries, org, { groupLabel: selectedClientLabel, fileName: bundleFileName('installation-report', selectedClientLabel, entries.length) });
          } else {
            for (const entry of entries) await generateInstallationReportPDF([entry], org);
          }
          setNotice({ kind: 'success', message: `Installation Report ready — ${entries.length} shop(s).` });
          break;
        }

        case 'invoice-pdf': {
          const entries: InvoiceReportEntry[] = [];
          for (const inv of (invoices || [])) {
            if (selectedClient && inv.client_id !== selectedClient) continue;
            if (selectedPO && inv.purchase_order_id !== selectedPO) continue;
            if (periodRange.from && Date.parse(inv.invoice_date || inv.created_at || '') < periodRange.from.getTime()) continue;
            if (periodRange.to && Date.parse(inv.invoice_date || inv.created_at || '') > periodRange.to.getTime()) continue;
            const client = (clients || []).find((c) => c.id === inv.client_id);
            entries.push({ invoice: inv as any, items: inv.invoice_items || [], client: client || null });
          }
          if (entries.length === 0) { setNotice({ kind: 'error', message: 'No invoices found for the selected filters.' }); break; }
          if (combined) {
            await generateInvoiceBundlePDF(entries, org, { fileName: bundleFileName('invoices', selectedClientLabel, entries.length) });
          } else {
            for (const entry of entries) await generateInvoicePDF(entry.invoice, entry.items, entry.client, org);
          }
          setNotice({ kind: 'success', message: `Invoice PDF ready — ${entries.length} invoice(s).` });
          break;
        }

        case 'final-report-pdf': {
          const entries: FinalReportEntry[] = [];
          for (const shop of filteredShops.filter((s: any) => s.status === 'installed')) {
            const survey = (surveys || []).find((s) => s.shop_id === shop.id);
            const photos = (surveyPhotos || []).filter((p) => p.shop_id === shop.id);
            const items = (workItems || []).filter((w) => w.shop_id === shop.id);
            const job = (installations || []).find((i) => i.shop_id === shop.id);
            const proofs = job?.installation_proofs || [];
            const photoIds = new Set(photos.map((p) => p.id));
            const shopMarkings = (boardMarkings || []).filter((m) => photoIds.has(m.survey_photo_id));
            entries.push({ shop: shop as any, survey: (survey as any) || null, surveyPhotos: photos as any, workItems: items as any, proofs: proofs as any, surveyorName: (survey as any)?.profiles?.full_name || 'Unknown', installerName: (job as any)?.profiles?.full_name || 'Unknown', markings: shopMarkings as any });
          }
          if (entries.length === 0) { setNotice({ kind: 'error', message: 'None of the selected shops have been installed.' }); break; }
          if (combined) {
            await generateFinalClientReportPDF(entries, org, { groupLabel: selectedClientLabel, fileName: bundleFileName('final-client-report', selectedClientLabel, entries.length) });
          } else {
            for (const entry of entries) await generateFinalClientReportPDF([entry], org);
          }
          setNotice({ kind: 'success', message: `Final Client Report ready — ${entries.length} shop(s).` });
          break;
        }

        case 'design-approval-pdf':
        case 'design-approval-ppt': {
          const candidateShops = filteredShops.filter((s: any) => (workItems || []).some((w) => w.shop_id === s.id));
          if (candidateShops.length === 0) { setNotice({ kind: 'error', message: 'No work items found for the selected shops.' }); break; }
          if (candidateShops.length > DESIGN_APPROVAL_MAX_SHOPS) {
            setNotice({ kind: 'error', message: `Ek baar mein ${DESIGN_APPROVAL_MAX_SHOPS} shops tak hi. Filters se PO ya shop selection se list chota karein (abhi ${candidateShops.length} shops match ho rahe hain).` });
            break;
          }
          setGenProgress({ done: 0, total: candidateShops.length });
          const entries: { shop: any; rows: Awaited<ReturnType<typeof buildDesignComparisonRows>> }[] = [];
          for (const shop of candidateShops) {
            const items = (workItems || []).filter((w) => w.shop_id === shop.id);
            const photos = (surveyPhotos || []).filter((p) => p.shop_id === shop.id);
            const photoIds = new Set(photos.map((p) => p.id));
            const markings = (boardMarkings || []).filter((m) => photoIds.has(m.survey_photo_id));
            const photoLinks = (surveyPhotoItems || []).filter((x: any) => photoIds.has(x.survey_photo_id));
            const rows = await buildDesignComparisonRows(items as any, photos as any, markings as any, designVersions || [], designVersionItems || [], photoLinks as any);
            entries.push({ shop, rows });
            setGenProgress({ done: entries.length, total: candidateShops.length });
          }

          const fileBase = bundleBaseName('design-approval', selectedClientLabel, candidateShops.length);
          if (combined) {
            if (type === 'design-approval-pdf') await generateDesignComparisonPDFMulti(entries, org, fileBase);
            else await generateDesignComparisonPPTMulti(entries, org, fileBase);
          } else {
            for (const entry of entries) {
              if (entry.rows.length === 0) continue;
              if (type === 'design-approval-pdf') await generateDesignComparisonPDF(entry.shop, entry.rows, org);
              else await generateDesignComparisonPPT(entry.shop, entry.rows, org);
            }
          }
          setNotice({ kind: 'success', message: `Design Approval ${type === 'design-approval-pdf' ? 'Report' : 'Deck'} ready — ${candidateShops.length} shop(s)${combined ? ', combined into one file' : ', one file each'}.` });
          break;
        }

        case 'excel':
          if (combined) exportShopsToExcel(filteredShops, workItems || [], bundleBaseName('shops-export', selectedClientLabel, filteredShops.length), excelPhotoSources());
          else filteredShops.forEach((shop:any) => exportShopsToExcel([shop], (workItems || []).filter(w=>w.shop_id===shop.id), bundleBaseName(`shop-${shop.name}`,selectedClientLabel,1),excelPhotoSources()));
          setNotice({ kind: 'success', message: `Excel ready — ${filteredShops.length} shop(s).` });
          break;

        case 'excel-multi':
          if(combined) exportMultiSheetExcel(filteredShops, workItems || [], 'multi-sheet-report', excelPhotoSources());
          else filteredShops.forEach((shop:any) => exportMultiSheetExcel([shop], (workItems || []).filter(w=>w.shop_id===shop.id), `multi-sheet-${shop.name}`,excelPhotoSources()));
          setNotice({ kind: 'success', message: 'Multi-sheet Excel ready.' });
          break;

        case 'po-utilization':
          if (scopedPoUtilizationRows.length === 0) { setNotice({ kind: 'error', message: 'Is filter ke liye koi PO line items nahi mile.' }); break; }
          exportPOUtilizationToExcel(scopedPoUtilizationRows.filter(r => (!periodRange.from || Date.parse(r.po_date) >= periodRange.from.getTime()) && (!periodRange.to || Date.parse(r.po_date) <= periodRange.to.getTime())) as any[], bundleBaseName('po-utilization', selectedClientLabel, 0));
          setNotice({ kind: 'success', message: 'PO Utilization Excel ready.' });
          break;

        case 'vehicle-load-log': {
          if (!orgId) break;
          const logRows = (await fetchVehicleLoadLog(orgId, periodRange.from || undefined)).filter(r => filteredShops.some(s => s.id === r.shop_id) && (!periodRange.to || Date.parse(r.loaded_at) <= periodRange.to.getTime()));
          if (logRows.length === 0) { setNotice({ kind: 'error', message: 'Abhi tak koi vehicle load record nahi hai.' }); break; }
          exportVehicleLoadLogToExcel(logRows, bundleBaseName('vehicle-load-log', selectedClientLabel, 0));
          setNotice({ kind: 'success', message: 'Vehicle Load Log Excel ready.' });
          break;
        }

        case 'ppt-preapproval': {
          const batch = filteredShops.filter((s: any) => ['surveyed', 'approval_pending', 'approved'].includes(s.status));
          const groups = combined ? [batch] : batch.map(shop=>[shop]);
          for (const group of groups) {
            const ids=new Set(group.map(s=>s.id));
            await generatePreApprovalPPT(group as any,(workItems || []).filter(w=>ids.has(w.shop_id)) as any,
              (surveyPhotos || []).filter(p=>ids.has(p.shop_id)) as any,org,(boardMarkings || []) as any,
              bundleBaseName('preapproval', combined ? selectedClientLabel : group[0]?.name, group.length));
          }
          setNotice({ kind: 'success', message: `${groups.length} Pre-Approval deck(s) ready.` });
          break;
        }

        case 'ppt-final': {
          const batch = filteredShops.filter((s: any) => s.status === 'installed');
          const groups = combined ? [batch] : batch.map(shop=>[shop]);
          for (const group of groups) {
            const ids = new Set(group.map(s=>s.id));
            await generateFinalInstallationPPT(group as any,
              (workItems || []).filter(w=>ids.has(w.shop_id)) as any,
              ((installations || []).flatMap(i=>i.installation_proofs || []) as any[]).filter(p=>ids.has(p.shop_id)),
              org,bundleBaseName('final-installation',combined?selectedClientLabel:group[0]?.name,group.length));
          }
          setNotice({kind:'success',message:`${groups.length} Final Installation deck(s) ready.`});
          break;
        }
      }
    } catch (error) {
      setNotice({ kind: 'error', message: error instanceof Error ? error.message : 'Report generation failed. Please retry.' });
    } finally {
      setGenerating(null);
      setGenProgress(null);
    }
  }

  return (
    <div className="max-w-[1440px] mx-auto">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><h1 className="text-base font-semibold text-slate-900">Reports</h1><span className="text-xs text-slate-500">Marked evidence, original measurements and professional exports</span></div>

      {notice && (
        <div className={`flex items-start gap-2.5 rounded-lg px-4 py-3 mb-5 text-sm ${notice.kind === 'error' ? 'bg-red-50 text-red-700 border border-red-100' : 'bg-emerald-50 text-emerald-700 border border-emerald-100'}`}>
          {notice.kind === 'error' ? <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" /> : <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />}
          <p className="flex-1">{notice.message}</p>
          <button onClick={() => setNotice(null)} className="text-current opacity-60 hover:opacity-100"><X className="w-4 h-4" /></button>
        </div>
      )}

      {/* Fast, frequently used filters stay visible; secondary scope lives in Advanced. */}
      <Card className="p-3 mb-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 mb-2">
          <label className="text-xs font-medium text-slate-600">Client
            <select aria-label="Report client" value={selectedClient} onChange={e => setSelectedClient(e.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-sm">
              <option value="">All clients</option>
              {(clients || []).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <label className="text-xs font-medium text-slate-600">Work Order
            <select aria-label="Report work order" value={selectedPO} onChange={e => setSelectedPO(e.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-sm">
              <option value="">All work orders</option>
              {poOptions.map(po => <option key={po.id} value={po.id}>{po.name ? `${po.name} (${po.po_number})` : po.po_number}</option>)}
            </select>
          </label>
          <label className="text-xs font-medium text-slate-600">Zone
            <select aria-label="Report zone" value={zoneFilter} onChange={e => setZoneFilter(e.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-sm">
              <option value="">All zones</option>
              <option value="__NO_ZONE__">No Zone</option>
              {(zones || []).map(z => <option key={z.id} value={z.id}>{z.name}</option>)}
            </select>
          </label>
          <label className="text-xs font-medium text-slate-600">Date range
            <select aria-label="Report date range" value={period} onChange={e=>setPeriod(e.target.value as typeof period)} className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-sm">
              <option value="all">All dates</option><option value="today">Today</option><option value="week">This week</option>
              <option value="month">This month</option><option value="last30">Last 30 days</option><option value="custom">Custom dates</option>
            </select>
          </label>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-3 flex-wrap">
            <FilterButton activeCount={activeFilterCount} onClick={() => setFilterOpen(true)} />
            <div className="flex items-center gap-1.5 text-sm text-slate-600">
              <Store className="w-4 h-4 text-slate-400" />
              <span className="font-semibold text-slate-900">{filteredShops.length.toLocaleString('en-IN')}</span>
              <span className="text-slate-500">shop{filteredShops.length === 1 ? '' : 's'} selected by filters</span>
            </div>
            {activeFilterCount > 0 && (
              <button onClick={clearFilters} className="text-xs font-medium text-blue-600 hover:text-blue-700">Clear filters</button>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {period === 'custom' && <>
              <label className="text-xs text-slate-600">From <input aria-label="From date" type="date" value={dateFrom} onChange={e=>setDateFrom(e.target.value)} className="rounded border border-slate-300 p-1" /></label>
              <label className="text-xs text-slate-600">To <input aria-label="To date" type="date" value={dateTo} onChange={e=>setDateTo(e.target.value)} className="rounded border border-slate-300 p-1" /></label>
            </>}
          </div>
          <div className="flex items-center gap-1 bg-slate-100 rounded-lg p-1">
            <button
              type="button"
              onClick={() => setDownloadMode('combined')}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition ${downloadMode === 'combined' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
            >
              One combined file
            </button>
            <button
              type="button"
              onClick={() => setDownloadMode('separate')}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition ${downloadMode === 'separate' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
            >
              Separate file per shop
            </button>
          </div>
        </div>
        {(selectedClientLabel || selectedPO || selectedShopIds.size > 0) && (
          <div className="flex flex-wrap gap-1.5 mt-3 pt-3 border-t border-slate-100">
            {selectedClientLabel && <ScopeChip label={`Client: ${selectedClientLabel}`} onClear={() => setSelectedClient('')} />}
            {selectedPO && <ScopeChip label={`PO: ${purchaseOrders?.find((p) => p.id === selectedPO)?.po_number || '—'}`} onClear={() => setSelectedPO('')} />}
            {selectedShopIds.size > 0 && <ScopeChip label={`${selectedShopIds.size} shop(s) selected`} onClear={() => setSelectedShopIds(new Set())} />}
            {zoneFilter && <ScopeChip label={`Zone: ${zoneFilter === '__NO_ZONE__' ? 'No Zone' : zones?.find(z=>z.id===zoneFilter)?.name || 'Zone'}`} onClear={()=>setZoneFilter('')} />}
            {shopStatus && <ScopeChip label={`Status: ${shopStatus.replace(/_/g,' ')}`} onClear={()=>setShopStatus('')} />}
          </div>
        )}
      </Card>

      <FilterDrawer
        open={filterOpen}
        onClose={() => setFilterOpen(false)}
        onClear={clearFilters}
        activeCount={activeFilterCount}
        resultCount={filteredShops.length}
        resultLabel="shops"
      >
        <FilterSection label="Shop status">
          <select value={shopStatus} onChange={e=>setShopStatus(e.target.value)} aria-label="Report shop status" className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white">
            <option value="">All statuses</option>
            {Array.from(new Set(scopedShops.map((s:any)=>s.status).filter(Boolean))).sort().map(st=><option key={st} value={st}>{st.replace(/_/g,' ')}</option>)}
          </select>
        </FilterSection>
        <FilterSection label="Shops (optional — leave empty for all matching shops)">
          <div className="border border-slate-200 rounded-lg overflow-hidden">
            <div className="flex items-center gap-2 px-2.5 py-2 border-b border-slate-100 bg-slate-50">
              <Search className="w-3.5 h-3.5 text-slate-400 shrink-0" />
              <input
                type="text"
                value={shopSearch}
                onChange={(e) => setShopSearch(e.target.value)}
                placeholder="Search shop or city..."
                className="flex-1 text-sm bg-transparent outline-none placeholder:text-slate-400"
              />
              {selectedShopIds.size > 0 && (
                <button onClick={() => setSelectedShopIds(new Set())} className="text-xs font-medium text-blue-600 hover:text-blue-700 shrink-0">
                  Clear ({selectedShopIds.size})
                </button>
              )}
            </div>
            <div className="max-h-52 overflow-y-auto divide-y divide-slate-50">
              {visibleShopOptions.length === 0 && (
                <div className="px-3 py-4 text-sm text-slate-400 text-center">No shops match.</div>
              )}
              {visibleShopOptions.map((s: any) => (
                <label key={s.id} className="flex items-center gap-2.5 px-3 py-2 hover:bg-slate-50 cursor-pointer text-sm">
                  <input
                    type="checkbox"
                    checked={selectedShopIds.has(s.id)}
                    onChange={() => toggleShopSelected(s.id)}
                    className="rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                  />
                  <span className="flex-1 min-w-0 truncate text-slate-800">{s.name}</span>
                  <span className="text-xs text-slate-400 shrink-0">{s.city || ''}</span>
                </label>
              ))}
            </div>
          </div>
          <p className="text-xs text-slate-400 mt-1.5">
            {selectedShopIds.size > 0 ? `${selectedShopIds.size} shop(s) selected` : `Nothing picked — all ${scopedShops.length} matching shops will be used`}
          </p>
        </FilterSection>
      </FilterDrawer>

      {/* Compact canonical report catalog. One row = one report type, no repeated export cards. */}
      <div className="rounded-xl border border-slate-200 bg-white overflow-hidden shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-4 py-3">
          <div className="flex items-center gap-2">
            <FileBarChart className="h-4 w-4 text-slate-500" />
            <h2 className="text-sm font-semibold text-slate-900">Report library</h2>
            <span className="text-xs text-slate-400">One report, three formats</span>
          </div>
          <div className="relative w-full sm:w-64">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input aria-label="Find report" value={reportSearch} onChange={e=>setReportSearch(e.target.value)}
              placeholder="Find report type" className="w-full rounded-lg border border-slate-200 py-1.5 pl-8 pr-3 text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-600" />
          </div>
        </div>
        {REPORT_GROUPS.map((group) => {
          const cards=group.cards.filter(c=>`${c.label} ${c.desc} ${group.title}`.toLowerCase().includes(reportSearch.trim().toLowerCase()));
          if (!cards.length) return null;
          return <section key={group.title} aria-label={group.title}>
            <div className="border-b border-slate-100 bg-slate-50 px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">{group.title}</div>
            <div className="divide-y divide-slate-100">
              {cards.map(rc=>{
                const Icon=rc.icon;
                return <div key={rc.id} className="flex flex-col gap-2 px-4 py-3 transition-colors hover:bg-slate-50/60 lg:flex-row lg:items-center lg:gap-4">
                  <div className="flex min-w-0 flex-1 items-start gap-3">
                    <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${colorMap[rc.color]}`}><Icon className="h-4 w-4" /></div>
                    <div className="min-w-0">
                      <h3 className="text-sm font-semibold text-slate-900">{rc.label}</h3>
                      <p className="mt-0.5 line-clamp-2 text-xs leading-5 text-slate-500">{rc.desc}</p>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5 pl-12 lg:pl-0" aria-label={`Download ${rc.label}`}>
                    {(['PDF','PPTX','XLSX'] as const).map(format=>{
                      const type=`unified:${rc.id}:${format}`;
                      const active=generating===type;
                      return <button key={format} type="button" onClick={()=>void handleGenerate(type)} disabled={!!generating}
                        aria-label={`Export ${rc.label} as ${format}`}
                        className="inline-flex min-w-[76px] items-center justify-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700 disabled:cursor-wait disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-600">
                        {active ? <Loader2 className="h-3.5 w-3.5 animate-spin"/> : <Download className="h-3.5 w-3.5" />}
                        {format==='PPTX'?'PPT':format}
                      </button>;
                    })}
                  </div>
                </div>;
              })}
            </div>
          </section>;
        })}
        {reportSearch && !REPORT_GROUPS.some(g=>g.cards.some(c=>`${c.label} ${c.desc} ${g.title}`.toLowerCase().includes(reportSearch.trim().toLowerCase()))) &&
          <p className="px-4 py-8 text-center text-sm text-slate-500">No matching report type.</p>}
      </div>
      {generating && <div role="status" className="mt-3 flex items-center gap-2 text-xs text-slate-600">
        <Loader2 className="h-4 w-4 animate-spin" /> Preparing report evidence
        {genProgress && genProgress.total>0 ? ` · ${genProgress.done} of ${genProgress.total} images` : '…'}
      </div>}
      <div className="mt-3 flex items-center gap-2 text-xs text-slate-500">
        <Images className="h-3.5 w-3.5 shrink-0" />
        Original photos and saved board polygons are combined before export. Each image is accompanied by its linked measurements; unreadable evidence stops the export with an error.
      </div>
    </div>
  );
}

function ScopeChip({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 text-xs font-medium bg-slate-100 text-slate-600 pl-2.5 pr-1.5 py-1 rounded-full">
      {label}
      <button onClick={onClear} className="hover:text-slate-900"><X className="w-3 h-3" /></button>
    </span>
  );
}

function bundleBaseName(prefix: string, clientLabel: string | undefined, count: number) {
  const base = clientLabel ? `${prefix}-${clientLabel}` : prefix;
  const withCount = count > 1 ? `${base}-${count}-shops` : base;
  return withCount.replace(/[^a-z0-9-]+/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

function bundleFileName(prefix: string, clientLabel: string | undefined, count: number) {
  return `${bundleBaseName(prefix, clientLabel, count)}.pdf`;
}
