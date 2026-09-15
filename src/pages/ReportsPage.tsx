import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { Card, PageHeader, FilterButton, FilterDrawer, FilterSection } from '@/components/ui';
import {
  generateSurveyReportPDF, generateInstallationReportPDF, generateInvoicePDF, generateInvoiceBundlePDF,
  generateFinalClientReportPDF, exportShopsToExcel, exportMultiSheetExcel, exportPOUtilizationToExcel,
  exportVehicleLoadLogToExcel, generatePreApprovalPPT, generateFinalInstallationPPT,
  buildDesignComparisonRows, generateDesignComparisonPDF, generateDesignComparisonPPT,
  generateDesignComparisonPDFMulti, generateDesignComparisonPPTMulti,
  SurveyReportEntry, InstallationReportEntry, FinalReportEntry, InvoiceReportEntry,
} from '@/lib/reports';
import { fetchVehicleLoadLog } from '@/lib/vehicleLoadLog';
import {
  FileText, FileSpreadsheet, Presentation, Download, FileBarChart, ShoppingCart, Truck,
  Layers, CheckCircle2, AlertCircle, X, Loader2, Store, Search,
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
      { id: 'ppt-final', label: 'Final Installation Deck', desc: 'Before/after photos, one slide per shop — for campaign close-out.', icon: Presentation, color: 'emerald', variants: [{ type: 'ppt-final', label: 'Deck', ext: 'PPTX' }] },
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
const extBadge: Record<string, string> = {
  PDF: 'bg-red-50 text-red-600', PPTX: 'bg-orange-50 text-orange-600', XLSX: 'bg-green-50 text-green-600',
};

export default function ReportsPage() {
  const { profile } = useAuth();
  const orgId = profile?.organization_id;

  const [selectedClient, setSelectedClient] = useState('');
  const [selectedCampaign, setSelectedCampaign] = useState('');
  const [selectedPO, setSelectedPO] = useState('');
  const [selectedShopIds, setSelectedShopIds] = useState<Set<string>>(new Set());
  const [shopSearch, setShopSearch] = useState('');
  const [downloadMode, setDownloadMode] = useState<'combined' | 'separate'>('combined');
  const [filterOpen, setFilterOpen] = useState(false);
  const [generating, setGenerating] = useState<string | null>(null);
  const [genProgress, setGenProgress] = useState<{ done: number; total: number } | null>(null);
  const [notice, setNotice] = useState<{ kind: 'error' | 'success'; message: string } | null>(null);

  // Resetting a level whenever its parent changes so the dropdowns can never
  // point at a combination that no longer makes sense (e.g. a PO from a
  // campaign that was just deselected).
  useEffect(() => { setSelectedCampaign(''); setSelectedPO(''); setSelectedShopIds(new Set()); }, [selectedClient]);
  useEffect(() => { setSelectedPO(''); setSelectedShopIds(new Set()); }, [selectedCampaign]);
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
      const { data } = await supabase.from('clients').select('id, name').eq('organization_id', orgId).eq('is_active', true).order('name');
      return data as Client[];
    },
    enabled: !!orgId,
  });

  const { data: campaigns } = useQuery({
    queryKey: ['projects-reports', orgId],
    queryFn: async () => {
      const { data } = await supabase.from('projects').select('id, name, client_id').eq('organization_id', orgId).order('name');
      return data as { id: string; name: string; client_id: string }[];
    },
    enabled: !!orgId,
  });

  const { data: purchaseOrders } = useQuery({
    queryKey: ['purchase-orders-reports', orgId],
    queryFn: async () => {
      const { data } = await supabase.from('purchase_orders').select('id, po_number, client_id, project_id').eq('organization_id', orgId).order('po_number');
      return data as { id: string; po_number: string; client_id: string; project_id: string | null }[];
    },
    enabled: !!orgId,
  });

  const { data: shops } = useQuery({
    queryKey: ['shops-reports', orgId, selectedClient, selectedCampaign, selectedPO],
    queryFn: async () => {
      let q = supabase.from('shops').select('*, clients(name), projects(name), zones(name)').eq('organization_id', orgId);
      if (selectedClient) q = q.eq('client_id', selectedClient);
      if (selectedCampaign) q = q.eq('project_id', selectedCampaign);
      if (selectedPO) q = q.eq('purchase_order_id', selectedPO);
      const { data } = await q.order('name');
      return data || [];
    },
    enabled: !!orgId,
  });

  const { data: workItems } = useQuery({
    queryKey: ['work-items-reports', orgId],
    queryFn: async () => {
      const { data } = await supabase.from('work_items').select('*').eq('organization_id', orgId);
      return data || [];
    },
    enabled: !!orgId,
  });

  const { data: surveys } = useQuery({
    queryKey: ['surveys-reports', orgId],
    queryFn: async () => {
      // `surveys` has two FKs into `profiles` (surveyor_id, reviewed_by) — a
      // plain `profiles(full_name)` embed is ambiguous and errors out.
      const { data, error } = await supabase.from('surveys').select('*, profiles:surveyor_id(full_name)').eq('organization_id', orgId);
      if (error) throw new Error(`Could not load surveys: ${error.message}`);
      return data || [];
    },
    enabled: !!orgId,
  });

  const { data: surveyPhotos } = useQuery({
    queryKey: ['survey-photos-reports', orgId],
    queryFn: async () => {
      const { data } = await supabase.from('survey_photos').select('*').eq('organization_id', orgId);
      return data || [];
    },
    enabled: !!orgId,
  });

  // Marked board polygons — needed so exports can burn the marked area into
  // the exported image instead of just linking to a plain, unmarked photo.
  const { data: boardMarkings } = useQuery({
    queryKey: ['board-markings-reports', orgId],
    queryFn: async () => {
      const { data } = await supabase.from('board_markings').select('*').eq('organization_id', orgId);
      return data || [];
    },
    enabled: !!orgId,
  });

  const { data: installations } = useQuery({
    queryKey: ['installations-reports', orgId],
    queryFn: async () => {
      // `installation_jobs` has two FKs into `profiles` — same ambiguous-embed issue as surveys.
      const { data, error } = await supabase.from('installation_jobs').select('*, profiles:installer_id(full_name), installation_proofs(*)').eq('organization_id', orgId);
      if (error) throw new Error(`Could not load installations: ${error.message}`);
      return data || [];
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
  const { data: designVersions } = useQuery({
    queryKey: ['design-versions-reports', orgId],
    queryFn: async () => {
      const { data } = await supabase.from('design_versions').select('*').eq('organization_id', orgId);
      return (data || []) as DesignVersion[];
    },
    enabled: !!orgId,
  });

  const { data: designVersionItems } = useQuery({
    queryKey: ['design-version-items-reports', orgId],
    queryFn: async () => {
      const { data } = await supabase.from('design_version_items').select('*').eq('organization_id', orgId);
      return (data || []) as DesignVersionItem[];
    },
    enabled: !!orgId,
  });

  const { data: poUtilizationRows } = useQuery({
    queryKey: ['po-utilization-reports', orgId, selectedClient],
    queryFn: async () => {
      let q = supabase.from('v_po_line_item_utilization').select('*');
      if (selectedClient) q = q.eq('client_id', selectedClient);
      const { data, error } = await q.order('po_date', { ascending: false });
      if (error) throw error;
      return data as POLineItemUtilization[];
    },
    enabled: !!orgId,
  });

  const scopedShops = useMemo(() => shops || [], [shops]);
  const filteredShops = useMemo(
    () => selectedShopIds.size > 0 ? scopedShops.filter((s: any) => selectedShopIds.has(s.id)) : scopedShops,
    [scopedShops, selectedShopIds]
  );
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

  const campaignOptions = useMemo(
    () => (campaigns || []).filter((c) => !selectedClient || c.client_id === selectedClient),
    [campaigns, selectedClient]
  );
  const poOptions = useMemo(
    () => (purchaseOrders || []).filter((p) =>
      (!selectedClient || p.client_id === selectedClient) &&
      (!selectedCampaign || p.project_id === selectedCampaign)
    ),
    [purchaseOrders, selectedClient, selectedCampaign]
  );
  const scopedPoUtilizationRows = useMemo(
    () => (poUtilizationRows || []).filter((r) =>
      (!selectedCampaign || r.project_id === selectedCampaign) &&
      (!selectedPO || r.purchase_order_id === selectedPO)
    ),
    [poUtilizationRows, selectedCampaign, selectedPO]
  );

  const activeFilterCount = [selectedClient, selectedCampaign, selectedPO].filter(Boolean).length + (selectedShopIds.size > 0 ? 1 : 0);

  function clearFilters() {
    setSelectedClient(''); setSelectedCampaign(''); setSelectedPO(''); setSelectedShopIds(new Set()); setShopSearch('');
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

      if (PER_SHOP_REPORT_TYPES.has(type) && filteredShops.length === 0) {
        setNotice({ kind: 'error', message: 'Pehle filters se kam se kam ek shop select karein.' });
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
          if (entries.length === 0) { setNotice({ kind: 'error', message: 'Selected shops ke liye koi submitted survey nahi mila.' }); break; }
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
          if (entries.length === 0) { setNotice({ kind: 'error', message: 'Selected shops ke liye koi installation record nahi mila.' }); break; }
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
            const client = (clients || []).find((c) => c.id === inv.client_id);
            entries.push({ invoice: inv as any, items: inv.invoice_items || [], client: client || null });
          }
          if (entries.length === 0) { setNotice({ kind: 'error', message: 'Is filter ke liye koi invoice nahi mila.' }); break; }
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
          if (entries.length === 0) { setNotice({ kind: 'error', message: 'Selected shops mein se koi bhi "installed" stage par nahi hai.' }); break; }
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
          if (candidateShops.length === 0) { setNotice({ kind: 'error', message: 'Selected shops ke liye koi board (work item) nahi mila.' }); break; }
          if (candidateShops.length > DESIGN_APPROVAL_MAX_SHOPS) {
            setNotice({ kind: 'error', message: `Ek baar mein ${DESIGN_APPROVAL_MAX_SHOPS} shops tak hi. Filters se PO, Campaign ya shop selection se list chota karein (abhi ${candidateShops.length} shops match ho rahe hain).` });
            break;
          }
          setGenProgress({ done: 0, total: candidateShops.length });
          const entries: { shop: any; rows: Awaited<ReturnType<typeof buildDesignComparisonRows>> }[] = [];
          for (const shop of candidateShops) {
            const items = (workItems || []).filter((w) => w.shop_id === shop.id);
            const photos = (surveyPhotos || []).filter((p) => p.shop_id === shop.id);
            const photoIds = new Set(photos.map((p) => p.id));
            const markings = (boardMarkings || []).filter((m) => photoIds.has(m.survey_photo_id));
            const rows = await buildDesignComparisonRows(items as any, photos as any, markings as any, designVersions || [], designVersionItems || []);
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
          exportShopsToExcel(filteredShops, workItems || [], bundleBaseName('shops-export', selectedClientLabel, filteredShops.length), excelPhotoSources());
          setNotice({ kind: 'success', message: `Excel ready — ${filteredShops.length} shop(s).` });
          break;

        case 'excel-multi':
          exportMultiSheetExcel(filteredShops, workItems || [], 'multi-sheet-report', excelPhotoSources());
          setNotice({ kind: 'success', message: 'Multi-sheet Excel ready.' });
          break;

        case 'po-utilization':
          if (scopedPoUtilizationRows.length === 0) { setNotice({ kind: 'error', message: 'Is filter ke liye koi PO line items nahi mile.' }); break; }
          exportPOUtilizationToExcel(scopedPoUtilizationRows as any[], bundleBaseName('po-utilization', selectedClientLabel, 0));
          setNotice({ kind: 'success', message: 'PO Utilization Excel ready.' });
          break;

        case 'vehicle-load-log': {
          if (!orgId) break;
          const logRows = await fetchVehicleLoadLog(orgId);
          if (logRows.length === 0) { setNotice({ kind: 'error', message: 'Abhi tak koi vehicle load record nahi hai.' }); break; }
          exportVehicleLoadLogToExcel(logRows, bundleBaseName('vehicle-load-log', selectedClientLabel, 0));
          setNotice({ kind: 'success', message: 'Vehicle Load Log Excel ready.' });
          break;
        }

        case 'ppt-preapproval':
          await generatePreApprovalPPT(
            filteredShops.filter((s: any) => ['surveyed', 'approval_pending', 'approved'].includes(s.status)) as any,
            (workItems || []).filter((w) => filteredShops.some((s: any) => s.id === w.shop_id)) as any,
            (surveyPhotos || []).filter((p) => filteredShops.some((s: any) => s.id === p.shop_id)) as any,
            org,
            (boardMarkings || []) as any
          );
          setNotice({ kind: 'success', message: 'Pre-Approval Deck ready.' });
          break;

        case 'ppt-final':
          await generateFinalInstallationPPT(
            filteredShops.filter((s: any) => s.status === 'installed') as any,
            (workItems || []).filter((w) => filteredShops.some((s: any) => s.id === w.shop_id)) as any,
            ((installations || []).flatMap((i) => i.installation_proofs || []) as any[]).filter((p) => filteredShops.some((s: any) => s.id === p.shop_id)),
            org
          );
          setNotice({ kind: 'success', message: 'Final Installation Deck ready.' });
          break;
      }
    } catch {
      setNotice({ kind: 'error', message: 'Report generation failed. Please try again.' });
    } finally {
      setGenerating(null);
      setGenProgress(null);
    }
  }

  return (
    <div className="max-w-[1200px] mx-auto">
      <PageHeader title="Reports" subtitle="Generate PDF, Excel and PowerPoint reports for any client, campaign or PO" />

      {notice && (
        <div className={`flex items-start gap-2.5 rounded-lg px-4 py-3 mb-5 text-sm ${notice.kind === 'error' ? 'bg-red-50 text-red-700 border border-red-100' : 'bg-emerald-50 text-emerald-700 border border-emerald-100'}`}>
          {notice.kind === 'error' ? <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" /> : <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />}
          <p className="flex-1">{notice.message}</p>
          <button onClick={() => setNotice(null)} className="text-current opacity-60 hover:opacity-100"><X className="w-4 h-4" /></button>
        </div>
      )}

      {/* Scope bar */}
      <Card className="p-4 mb-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3 flex-wrap">
            <FilterButton activeCount={activeFilterCount} onClick={() => setFilterOpen(true)} />
            <div className="flex items-center gap-1.5 text-sm text-slate-600">
              <Store className="w-4 h-4 text-slate-400" />
              <span className="font-semibold text-slate-900">{filteredShops.length.toLocaleString('en-IN')}</span>
              <span className="text-slate-500">shop{filteredShops.length === 1 ? '' : 's'} in scope</span>
            </div>
            {activeFilterCount > 0 && (
              <button onClick={clearFilters} className="text-xs font-medium text-blue-600 hover:text-blue-700">Clear filters</button>
            )}
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
        {(selectedClientLabel || selectedCampaign || selectedPO || selectedShopIds.size > 0) && (
          <div className="flex flex-wrap gap-1.5 mt-3 pt-3 border-t border-slate-100">
            {selectedClientLabel && <ScopeChip label={`Client: ${selectedClientLabel}`} onClear={() => setSelectedClient('')} />}
            {selectedCampaign && <ScopeChip label={`Campaign: ${campaigns?.find((c) => c.id === selectedCampaign)?.name || '—'}`} onClear={() => setSelectedCampaign('')} />}
            {selectedPO && <ScopeChip label={`PO: ${purchaseOrders?.find((p) => p.id === selectedPO)?.po_number || '—'}`} onClear={() => setSelectedPO('')} />}
            {selectedShopIds.size > 0 && <ScopeChip label={`${selectedShopIds.size} shop(s) selected`} onClear={() => setSelectedShopIds(new Set())} />}
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
        <FilterSection label="Client">
          <select value={selectedClient} onChange={(e) => setSelectedClient(e.target.value)} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500">
            <option value="">All clients</option>
            {(clients || []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </FilterSection>
        <FilterSection label="Campaign">
          <select value={selectedCampaign} onChange={(e) => setSelectedCampaign(e.target.value)} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500">
            <option value="">All campaigns</option>
            {campaignOptions.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </FilterSection>
        <FilterSection label="Purchase order">
          <select value={selectedPO} onChange={(e) => setSelectedPO(e.target.value)} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500">
            <option value="">All purchase orders</option>
            {poOptions.map((p) => <option key={p.id} value={p.id}>{p.po_number}</option>)}
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

      {/* Report groups */}
      <div className="space-y-8">
        {REPORT_GROUPS.map((group) => (
          <div key={group.title}>
            <div className="mb-3">
              <h2 className="text-sm font-semibold text-slate-900">{group.title}</h2>
              {group.subtitle && <p className="text-xs text-slate-500 mt-0.5">{group.subtitle}</p>}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {group.cards.map((rc) => {
                const Icon = rc.icon;
                return (
                  <Card key={rc.id} className="p-5 flex flex-col">
                    <div className="flex items-start justify-between mb-3">
                      <div className={`w-11 h-11 rounded-lg flex items-center justify-center ${colorMap[rc.color]}`}>
                        <Icon className="w-5 h-5" />
                      </div>
                      <div className="flex gap-1">
                        {rc.variants.map((v) => (
                          <span key={v.ext} className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${extBadge[v.ext]}`}>{v.ext}</span>
                        ))}
                      </div>
                    </div>
                    <h3 className="font-semibold text-slate-900 mb-1">{rc.label}</h3>
                    <p className="text-sm text-slate-500 mb-4 flex-1">{rc.desc}</p>
                    <div className="flex gap-2">
                      {rc.variants.map((v) => {
                        const isGenerating = generating === v.type;
                        return (
                          <button
                            key={v.type}
                            onClick={() => handleGenerate(v.type)}
                            disabled={!!generating}
                            className="flex-1 flex items-center justify-center gap-1.5 bg-slate-900 hover:bg-slate-800 text-white text-sm font-medium py-2.5 rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            {isGenerating ? (
                              <>
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                {genProgress ? `${genProgress.done}/${genProgress.total}` : '...'}
                              </>
                            ) : (
                              <>
                                <Download className="w-3.5 h-3.5" />
                                {rc.variants.length > 1 ? v.label : 'Generate'}
                              </>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </Card>
                );
              })}
            </div>
          </div>
        ))}
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
