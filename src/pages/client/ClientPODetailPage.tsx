import { useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import * as XLSX from 'xlsx';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { Card, EmptyState, ProgressBar, ConfirmDialog, StatusBadge, Select, Modal, Input, Textarea, Drawer } from '@/components/ui';
import { LineItemProgressChart } from '@/components/LineItemProgressChart';
import { MarkedPhotoGrid } from '@/components/MarkedPhotoGrid';
import { InstallationPhotoGrid } from '@/components/InstallationPhotoGrid';
import { ShopForm, emptyShopFormValues } from '@/components/ShopForm';
import { findShopHeaderRow, findExtraHeaders, buildShopRows, resolveZoneIds, type ParsedShopRow } from '@/lib/shopBulkUpload';
import { logAudit, notifyLinkedOrg } from '@/lib/helpers';
import type { PurchaseOrder, ClientPOLineItemProgress, SurveyPhoto, BoardMarking, WorkItem } from '@/lib/types';
import { STATUS_LABELS } from '@/lib/types';
import {
  stagePct, finalStage, formatQty, clientPoWorkStatus, CLIENT_PO_WORK_STATUS_LABELS, CLIENT_PO_WORK_STATUS_COLORS,
} from '@/lib/clientPortal';
import {
  ArrowLeft, Store, MapPin, FileText, Loader2, XCircle, ListChecks, TrendingUp, Search,
  LayoutDashboard, Image as ImageIcon, PieChart, AlertTriangle, AlertCircle, X, Pencil, Plus, Trash2, Map as MapIcon,
  UploadCloud, Phone, Ruler, ChevronRight,
} from 'lucide-react';
import { useClientRealtimeInvalidate } from '@/lib/useClientRealtimeInvalidate';
import { ClientPoSiteMap } from './ClientPoSiteMap';

type PoRow = PurchaseOrder & { agency_org: { name: string } | null };
type ShopRow = {
  id: string; name: string; owner_name: string | null; contact_phone: string | null;
  address: string | null; city: string | null; district: string | null; village: string | null;
  zone: string | null; state: string | null;
  status: string; latitude: number | null; longitude: number | null;
  extra_details: Record<string, string> | null;
};
type PhotoRow = { id: string; photo_url: string; caption: string | null; photo_type: string; angle: string | null };
type LineItemRow = { id: string; description: string; uom: 'sqft' | 'piece' | 'lot'; budgeted_qty: number | null; budgeted_area: number | null };

const STAGE_STEPS: { key: 'surveyed' | 'approved' | 'produced' | 'installed'; label: string }[] = [
  { key: 'surveyed', label: 'Survey' },
  { key: 'approved', label: 'Approved / Design' },
  { key: 'produced', label: 'Production' },
  { key: 'installed', label: 'Installation' },
];

const TABS = [
  { key: 'overview', label: 'Overview', icon: LayoutDashboard },
  { key: 'shops', label: 'Shops', icon: Store },
  { key: 'report', label: 'Report', icon: PieChart },
  { key: 'map', label: 'Map', icon: MapIcon },
] as const;
type TabKey = typeof TABS[number]['key'];

const UOM_OPTIONS = [
  { value: 'sqft', label: 'Sq.ft' },
  { value: 'piece', label: 'Piece' },
  { value: 'lot', label: 'Lot' },
];
const emptyEditLine = { id: '', description: '', uom: 'sqft' as 'sqft' | 'piece' | 'lot', budgeted_qty: '', budgeted_area: '' };

const SURVEYED_OR_LATER = new Set([
  'surveyed', 'approval_pending', 'approved', 'design_pending', 'designing', 'design_ready', 'in_review',
  'design_approved', 'production_pending', 'in_production', 'production_ready', 'production_hold',
  'production_done', 'dispatched', 'installation_pending', 'installing', 'installation_review', 'installed', 'billed',
]);
const INSTALLED_OR_LATER = new Set(['installation_review', 'installed', 'billed', 'dispatched']);

// PO Detail — everything about ONE PO lives here, nested, instead of being
// spread across flat top-level tabs: Overview (progress + budget/scope),
// Shops (the client's own site list — add one by one or bulk-import via
// Excel while the PO is still pending_acceptance, then read-only with
// photos once the agency accepts and starts work), Report (progress +
// photo compliance scoped to just this PO), and Map. This nests under a
// Campaign now (Campaign -> its POs -> open one), reached via
// ClientCampaignDetailPage.tsx.
//
// No rate/₹ anywhere on this page, and no Billing tab — a Client
// Organization user never sees agency pricing or invoice/payment data,
// full stop. Money lives entirely on the agency side of the platform.
export default function ClientPODetailPage() {
  const { campaignId, poId } = useParams<{ campaignId: string; poId: string }>();
  const navigate = useNavigate();
  const { profile } = useAuth();
  const orgId = profile?.organization_id;
  const queryClient = useQueryClient();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [tab, setTab] = useState<TabKey>('overview');

  // ---- Shops-tab-local filters ----
  const [shopSearch, setShopSearch] = useState('');
  const [shopStatusFilter, setShopStatusFilter] = useState('');
  const [shopZoneFilter, setShopZoneFilter] = useState('');
  const [drawerShopId, setDrawerShopId] = useState<string | null>(null);

  // ---- Shops CRUD (client can only add/edit/remove while pending_acceptance) ----
  const [addShopOpen, setAddShopOpen] = useState(false);
  const [shopForm, setShopForm] = useState(emptyShopFormValues);
  const [editShopTarget, setEditShopTarget] = useState<ShopRow | null>(null);
  const [deleteShopTarget, setDeleteShopTarget] = useState<ShopRow | null>(null);
  const [bulkUploadOpen, setBulkUploadOpen] = useState(false);
  const [bulkAoa, setBulkAoa] = useState<unknown[][] | null>(null);
  const [bulkHeaders, setBulkHeaders] = useState<string[]>([]);
  const [bulkHeaderRowIndex, setBulkHeaderRowIndex] = useState(0);
  const [bulkExtraHeaders, setBulkExtraHeaders] = useState<string[]>([]);
  const [bulkIncludedExtra, setBulkIncludedExtra] = useState<Record<string, boolean>>({});
  const [bulkFileName, setBulkFileName] = useState('');
  const [bulkError, setBulkError] = useState('');

  // ---- Report-tab-local state ----
  const [reportLineItemId, setReportLineItemId] = useState('');

  // ---- Edit (still pending_acceptance only) ----
  const [editOpen, setEditOpen] = useState(false);
  const [editForm, setEditForm] = useState({ po_number: '', name: '', po_date: '', notes: '', payment_terms: '' });
  const [editLines, setEditLines] = useState<(typeof emptyEditLine)[]>([]);

  const { data: po, isLoading } = useQuery({
    queryKey: ['client-po-detail', poId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('purchase_orders')
        .select('*, agency_org:organizations!purchase_orders_assigned_agency_id_fkey(name)')
        .eq('id', poId)
        .maybeSingle();
      if (error) throw error;
      return data as PoRow | null;
    },
    enabled: !!poId,
  });

  const { data: lineItems } = useQuery({
    queryKey: ['client-po-line-items', poId],
    queryFn: async () => {
      const { data, error } = await supabase.from('po_line_items').select('*').eq('purchase_order_id', poId).order('created_at');
      if (error) throw error;
      return data as LineItemRow[];
    },
    enabled: !!poId,
  });

  const { data: progress } = useQuery({
    queryKey: ['client-po-progress', poId],
    queryFn: async () => {
      const { data, error } = await supabase.from('v_client_po_line_item_progress').select('*').eq('purchase_order_id', poId);
      if (error) throw error;
      return data as ClientPOLineItemProgress[];
    },
    enabled: !!poId,
  });

  const { data: shops } = useQuery({
    queryKey: ['client-po-shops', poId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('shops')
        .select('id, name, owner_name, contact_phone, address, city, district, village, zone, state, status, latitude, longitude, extra_details')
        .eq('purchase_order_id', poId)
        .order('created_at');
      if (error) throw error;
      return data as ShopRow[];
    },
    enabled: !!poId,
  });

  // Photo counts, for the Shops tab's thumbnail-count badges and the
  // Report tab's photo-compliance table — one lightweight query per photo
  // table (id + shop_id only), counted client-side, rather than a
  // per-shop query.
  const { data: surveyPhotoRows } = useQuery({
    queryKey: ['client-po-survey-photos', poId, (shops || []).map((s) => s.id).join(',')],
    queryFn: async () => {
      const ids = (shops || []).map((s) => s.id);
      if (ids.length === 0) return [];
      const { data, error } = await supabase.from('survey_photos').select('id, shop_id').in('shop_id', ids);
      if (error) throw error;
      return data as { id: string; shop_id: string }[];
    },
    enabled: !!poId && !!shops && shops.length > 0,
  });
  const { data: installPhotoRows } = useQuery({
    queryKey: ['client-po-install-photos', poId, (shops || []).map((s) => s.id).join(',')],
    queryFn: async () => {
      const ids = (shops || []).map((s) => s.id);
      if (ids.length === 0) return [];
      const { data, error } = await supabase.from('installation_proofs').select('id, shop_id').in('shop_id', ids);
      if (error) throw error;
      return data as { id: string; shop_id: string }[];
    },
    enabled: !!poId && !!shops && shops.length > 0,
  });

  // Full detail for whichever shop is open in the side drawer: photos
  // (survey + installation), the board markings needed to render survey
  // photos MARKED (not plain — see migration 0052), and the work items
  // (board specs: type/size/qty) for that shop. board_markings has no
  // shop_id column of its own — it hangs off survey_photo_id — so
  // markings are fetched in a second step once we know this shop's
  // survey photo ids.
  const { data: drawerData, isLoading: drawerLoading, error: drawerError } = useQuery({
    queryKey: ['client-po-shop-detail', drawerShopId],
    queryFn: async () => {
      const [surveyRes, installRes, workItemsRes] = await Promise.all([
        supabase.from('survey_photos').select('*').eq('shop_id', drawerShopId).order('created_at'),
        supabase.from('installation_proofs').select('id, photo_url, caption, photo_type, angle').eq('shop_id', drawerShopId).order('captured_at'),
        supabase.from('work_items').select('*').eq('shop_id', drawerShopId).order('created_at'),
      ]);
      // Every sub-query's error is checked and thrown explicitly instead
      // of silently falling back to an empty array — a genuine fetch
      // failure (RLS denial, a column not yet present on this database)
      // should surface as a visible error in the drawer, not look
      // identical to "this shop just has no photos yet".
      if (surveyRes.error) throw new Error(`Could not load survey photos: ${surveyRes.error.message}`);
      if (installRes.error) throw new Error(`Could not load installation photos: ${installRes.error.message}`);
      if (workItemsRes.error) throw new Error(`Could not load boards: ${workItemsRes.error.message}`);
      const surveyPhotos = (surveyRes.data || []) as SurveyPhoto[];
      const photoIds = surveyPhotos.map((p) => p.id);
      const markingsRes = photoIds.length
        ? await supabase.from('board_markings').select('*').in('survey_photo_id', photoIds)
        : { data: [] as BoardMarking[], error: null };
      if (markingsRes.error) throw new Error(`Could not load board markings: ${markingsRes.error.message}`);
      return {
        surveyPhotos,
        installationPhotos: (installRes.data || []) as PhotoRow[],
        markings: (markingsRes.data || []) as BoardMarking[],
        workItems: (workItemsRes.data || []) as WorkItem[],
      };
    },
    enabled: !!drawerShopId,
  });

  // Needed to resolve shops.client_id (NOT NULL, references the AGENCY's
  // own internal clients row for this client — same value PO creation
  // already resolves via client_agency_links.agency_client_id) when the
  // client adds a shop themselves.
  const { data: agencyLink } = useQuery({
    queryKey: ['client-po-agency-link', orgId, po?.assigned_agency_id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('client_agency_links')
        .select('agency_client_id')
        .eq('client_org_id', orgId).eq('agency_org_id', po!.assigned_agency_id).maybeSingle();
      if (error) throw error;
      return data as { agency_client_id: string | null } | null;
    },
    enabled: !!orgId && !!po?.assigned_agency_id,
  });

  useClientRealtimeInvalidate(orgId, [
    ['client-po-detail', poId],
    ['client-po-progress', poId],
    ['client-po-shops', poId],
  ]);

  // ---- Delete — a client_admin may permanently delete their own Work
  // Order only while it's still pending_acceptance (RLS-enforced,
  // migration 0053). Any sites the client already added on it are
  // cleaned up explicitly rather than left behind as orphaned rows; line
  // items cascade-delete automatically.
  const deleteMutation = useMutation({
    mutationFn: async () => {
      if (!po) return;
      const { error: shopsErr } = await supabase.from('shops').delete().eq('purchase_order_id', po.id);
      if (shopsErr) throw shopsErr;
      const { error } = await supabase.from('purchase_orders').delete().eq('id', po.id);
      if (error) throw error;
      await logAudit('purchase_orders', po.id, 'delete', null, null, null, `Deleted Work Order ${po.po_number}`);
      if (po.assigned_agency_id) {
        await notifyLinkedOrg(po.assigned_agency_id, 'Client Work Order deleted', `${po.po_number} was deleted by the client before acceptance.`, 'warning', '/purchase-orders');
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['client-campaigns-pos-rollup', orgId] });
      queryClient.invalidateQueries({ queryKey: ['client-campaign-pos', po?.campaign_id] });
      navigate(`/client/campaigns/${campaignId}`);
    },
  });

  // ---- Edit — full header + line items while still 'pending_acceptance'
  // (existing direct-table path, RLS-backed by migrations 0037/0039).
  // Once the agency has accepted, po_number/po_date/line items become
  // agency-owned and RLS blocks a direct UPDATE — but the client can
  // still fix Name/Notes/Payment Terms themselves via the
  // client_update_po_details RPC (migration 0069), which also logs the
  // change into the AGENCY's own audit trail (not just the client's),
  // so the agency actually sees who changed what.
  const isLocked = po?.assignment_status !== 'pending_acceptance';

  const editMutation = useMutation({
    mutationFn: async () => {
      if (!po) return;

      if (isLocked) {
        const { error } = await supabase.rpc('client_update_po_details', {
          p_po_id: po.id,
          p_name: editForm.name,
          p_notes: editForm.notes,
          p_payment_terms: editForm.payment_terms,
        });
        if (error) throw new Error(error.message.replace(/^.*?:\s*/, ''));
        return;
      }

      const { error } = await supabase.from('purchase_orders').update({
        po_number: editForm.po_number,
        name: editForm.name || null,
        po_date: editForm.po_date,
        notes: editForm.notes || null,
        payment_terms: editForm.payment_terms || null,
      }).eq('id', po.id);
      if (error) throw error;

      const existingIds = new Set((lineItems || []).map((l) => l.id));
      const keptIds = new Set(editLines.filter((l) => l.id).map((l) => l.id));
      const toDelete = [...existingIds].filter((id) => !keptIds.has(id));
      if (toDelete.length) {
        const { error: delErr } = await supabase.from('po_line_items').delete().in('id', toDelete);
        if (delErr) throw delErr;
      }

      for (const line of editLines) {
        if (!line.description.trim()) continue;
        const payload = {
          description: line.description.trim(),
          uom: line.uom,
          budgeted_qty: line.uom !== 'sqft' && line.budgeted_qty ? Number(line.budgeted_qty) : null,
          budgeted_area: line.uom === 'sqft' && line.budgeted_area ? Number(line.budgeted_area) : null,
        };
        if (line.id) {
          const { error: updErr } = await supabase.from('po_line_items').update(payload).eq('id', line.id);
          if (updErr) throw updErr;
        } else {
          const { error: insErr } = await supabase.from('po_line_items').insert({ ...payload, organization_id: po.organization_id, purchase_order_id: po.id });
          if (insErr) throw insErr;
        }
      }

      await logAudit('purchase_orders', po.id, 'update', null, null, null, `Client edited Work Order ${editForm.po_number}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['client-po-detail', poId] });
      queryClient.invalidateQueries({ queryKey: ['client-po-line-items', poId] });
      queryClient.invalidateQueries({ queryKey: ['client-po-progress', poId] });
      queryClient.invalidateQueries({ queryKey: ['client-campaigns-pos', orgId] });
      setEditOpen(false);
    },
  });

  function openEdit() {
    if (!po) return;
    setEditForm({ po_number: po.po_number, name: po.name || '', po_date: po.po_date, notes: po.notes || '', payment_terms: po.payment_terms || '' });
    setEditLines((lineItems || []).map((l) => ({
      id: l.id, description: l.description, uom: l.uom,
      budgeted_qty: l.budgeted_qty != null ? String(l.budgeted_qty) : '',
      budgeted_area: l.budgeted_area != null ? String(l.budgeted_area) : '',
    })));
    setEditOpen(true);
  }
  function updateEditLine(idx: number, field: string, value: string) {
    setEditLines(editLines.map((l, i) => (i === idx ? { ...l, [field]: value } : l)));
  }
  function addEditLine() {
    setEditLines([...editLines, { ...emptyEditLine }]);
  }
  function removeEditLine(idx: number) {
    setEditLines(editLines.filter((_, i) => i !== idx));
  }

  // ---- Shops CRUD — client can add/edit/remove shops on this PO only
  // while it's still pending_acceptance (RLS-enforced, mirrors the line
  // item edit rule). Once the agency accepts, this becomes their
  // operational data and the Shops tab switches to read-only + photos.
  // ---- Shops CRUD — a client can always ADD a new site to their own
  // Work Order (adding never risks existing data); editing/removing an
  // existing site is only offered per-shop, while that specific site is
  // still 'pending' (no field work recorded on it yet) — RLS-enforced,
  // migration 0053.
  const canAddShop = po?.origin === 'client_created';
  const canModifyShop = (shop: ShopRow) => po?.origin === 'client_created' && shop.status === 'pending';

  const addShopMutation = useMutation({
    mutationFn: async () => {
      if (!po || !agencyLink?.agency_client_id) throw new Error('Could not resolve this agency — try again in a moment.');
      const { error } = await supabase.from('shops').insert({
        organization_id: po.assigned_agency_id,
        client_id: agencyLink.agency_client_id,
        purchase_order_id: po.id,
        name: shopForm.name.trim(),
        owner_name: shopForm.owner_name || null,
        contact_phone: shopForm.contact_phone || null,
        address: shopForm.address || null,
        village: shopForm.village || null,
        city: shopForm.city || null,
        district: shopForm.district || null,
        zone: shopForm.zone || null,
        state: shopForm.state || null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['client-po-shops', poId] });
      setAddShopOpen(false);
      setShopForm(emptyShopFormValues);
    },
  });

  const editShopMutation = useMutation({
    mutationFn: async () => {
      if (!editShopTarget) return;
      const { error } = await supabase.from('shops').update({
        name: shopForm.name.trim(),
        owner_name: shopForm.owner_name || null,
        contact_phone: shopForm.contact_phone || null,
        address: shopForm.address || null,
        village: shopForm.village || null,
        city: shopForm.city || null,
        district: shopForm.district || null,
        zone: shopForm.zone || null,
        state: shopForm.state || null,
      }).eq('id', editShopTarget.id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['client-po-shops', poId] });
      setEditShopTarget(null);
      setShopForm(emptyShopFormValues);
    },
  });

  const deleteShopMutation = useMutation({
    mutationFn: async (shop: ShopRow) => {
      const { error } = await supabase.from('shops').delete().eq('id', shop.id);
      if (error) throw error;
      await logAudit('shops', shop.id, 'delete', null, null, null, `Removed site ${shop.name}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['client-po-shops', poId] });
      setDeleteShopTarget(null);
    },
  });

  const bulkIncludedExtraKeys = useMemo(
    () => new Set(bulkExtraHeaders.filter((h) => bulkIncludedExtra[h])),
    [bulkExtraHeaders, bulkIncludedExtra]
  );
  const bulkParsedRows: ParsedShopRow[] = useMemo(
    () => (bulkAoa ? buildShopRows(bulkAoa, bulkHeaderRowIndex, bulkHeaders, bulkIncludedExtraKeys) : []),
    [bulkAoa, bulkHeaderRowIndex, bulkHeaders, bulkIncludedExtraKeys]
  );

  const bulkAddShopsMutation = useMutation({
    mutationFn: async () => {
      if (!po || !agencyLink?.agency_client_id) throw new Error('Could not resolve this agency — try again in a moment.');
      if (bulkParsedRows.length === 0) throw new Error('No valid rows found — every row needs at least a Name.');
      // Resolve every distinct "Zone" text in the sheet to a real zone_id
      // under the AGENCY's org (migration 0065 allows this cross-org
      // read/create for a client_admin on their own client_created PO) so
      // these shops are actually zone-filterable for the agency, not just
      // zone-labeled.
      const zoneIds = await resolveZoneIds(po.assigned_agency_id!, po.project_id || null, bulkParsedRows.map((r) => r.known.zone));
      const rows = bulkParsedRows.map(({ known, extra }) => ({
        organization_id: po.assigned_agency_id,
        client_id: agencyLink.agency_client_id,
        purchase_order_id: po.id,
        name: known.name,
        owner_name: known.owner_name || null,
        contact_phone: known.contact_phone || null,
        address: known.address || null,
        village: known.village || null,
        city: known.city || null,
        district: known.district || null,
        zone: known.zone || null,
        zone_id: known.zone ? zoneIds.get(known.zone.trim().toLowerCase()) || null : null,
        state: known.state || null,
        extra_details: extra,
      }));
      const { error } = await supabase.from('shops').insert(rows);
      if (error) throw error;
      await logAudit('shops', po.id, 'insert', null, null, null, `Bulk-uploaded ${rows.length} sites from Excel`);
      return rows.length;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['client-po-shops', poId] });
      resetBulkState();
      setBulkUploadOpen(false);
    },
  });

  function resetBulkState() {
    setBulkAoa(null);
    setBulkHeaders([]);
    setBulkHeaderRowIndex(0);
    setBulkExtraHeaders([]);
    setBulkIncludedExtra({});
    setBulkFileName('');
    setBulkError('');
  }

  function openAddShop() {
    setShopForm(emptyShopFormValues);
    setAddShopOpen(true);
  }
  function openEditShop(shop: ShopRow) {
    setShopForm({
      name: shop.name, owner_name: shop.owner_name || '', contact_phone: shop.contact_phone || '',
      address: shop.address || '', village: shop.village || '', city: shop.city || '',
      district: shop.district || '', zone: shop.zone || '', state: shop.state || '',
    });
    setEditShopTarget(shop);
  }

  function handleBulkFile(file: File) {
    setBulkError('');
    setBulkFileName(file.name);
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = e.target?.result;
        const wb = XLSX.read(data, { type: 'binary' });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1 });
        const found = findShopHeaderRow(aoa);
        if (!found) {
          setBulkError('Could not find a "Name" column in this file — check the file has a header row with at least a Name column.');
          setBulkAoa(null);
          return;
        }
        const extras = findExtraHeaders(found.headers);
        setBulkAoa(aoa);
        setBulkHeaders(found.headers);
        setBulkHeaderRowIndex(found.headerRowIndex);
        setBulkExtraHeaders(extras);
        setBulkIncludedExtra(Object.fromEntries(extras.map((h) => [h, true])));
      } catch {
        setBulkError('Could not read this file. Make sure it\'s a valid .xlsx or .csv file.');
        setBulkAoa(null);
      }
    };
    reader.readAsBinaryString(file);
  }

  const surveyCountByShop = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of surveyPhotoRows || []) m.set(r.shop_id, (m.get(r.shop_id) || 0) + 1);
    return m;
  }, [surveyPhotoRows]);
  const installCountByShop = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of installPhotoRows || []) m.set(r.shop_id, (m.get(r.shop_id) || 0) + 1);
    return m;
  }, [installPhotoRows]);

  // Search matches across every field a client would actually recall a
  // site by — not just name/city — since at real scale (thousands of
  // sites) "which field was it in" shouldn't be something the user has
  // to guess.
  const filteredShops = useMemo(() => {
    const q = shopSearch.trim().toLowerCase();
    return (shops || []).filter((s) => {
      if (q) {
        const haystack = [s.name, s.city, s.district, s.village, s.zone, s.address, s.owner_name, s.contact_phone].filter(Boolean).join(' ').toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      if (shopStatusFilter && s.status !== shopStatusFilter) return false;
      if (shopZoneFilter && (s.zone || '') !== shopZoneFilter) return false;
      return true;
    });
  }, [shops, shopSearch, shopStatusFilter, shopZoneFilter]);

  // At real scale (thousands of sites) rendering every matched row at
  // once would make the list heavy and slow to scroll — cap what's
  // actually painted and nudge toward narrowing the search/filters
  // instead, same idea as a search engine's result page.
  const SHOP_RENDER_CAP = 200;
  const shopsToRender = filteredShops.slice(0, SHOP_RENDER_CAP);

  const shopStatusOptions = useMemo(
    () => Array.from(new Set((shops || []).map((s) => s.status))).sort(),
    [shops]
  );
  const shopZoneOptions = useMemo(
    () => Array.from(new Set((shops || []).map((s) => s.zone).filter((z): z is string => !!z))).sort(),
    [shops]
  );

  const drawerShop = (shops || []).find((s) => s.id === drawerShopId) || null;

  // ---- Report tab derived data — per-line-item stage breakdown, feeding
  // the donut+bars chart instead of a burndown-over-time chart.
  const reportLineItemOptions = (progress || []).map((r) => ({ value: r.po_line_item_id, label: r.description }));
  const selectedProgressRow = (progress || []).find((r) => r.po_line_item_id === reportLineItemId) || null;
  const lineItemStageValues: { key: 'surveyed' | 'approved' | 'produced' | 'installed'; label: string; pct: number | null }[] = selectedProgressRow
    ? STAGE_STEPS.map((s) => ({ key: s.key, label: s.label, pct: stagePct([selectedProgressRow], s.key) }))
    : [];
  const lineItemFinalStage = po ? finalStage(po.fulfillment_type) : 'installed';
  const lineItemCompletionPct = selectedProgressRow ? stagePct([selectedProgressRow], lineItemFinalStage) : null;

  const photoComplianceRows = useMemo(() => (shops || []).map((s) => {
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
    return { shop: s, surveyCount, installCount, compliant, reason };
  }), [shops, surveyCountByShop, installCountByShop]);
  const nonCompliantCount = photoComplianceRows.filter((r) => !r.compliant).length;

  if (isLoading) {
    return <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 text-blue-600 animate-spin" /></div>;
  }

  if (!po) {
    return (
      <div>
        <button onClick={() => navigate(`/client/campaigns/${campaignId}`)} className="flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800 mb-4">
          <ArrowLeft className="w-4 h-4" /> Back to Campaign
        </button>
        <Card><EmptyState icon={<FileText className="w-12 h-12" />} title="Work Order not found" subtitle="It may have been removed, or you don't have access to it" /></Card>
      </div>
    );
  }

  const completionPct = stagePct(progress || [], finalStage(po.fulfillment_type));
  const workStatus = clientPoWorkStatus(po, completionPct);

  return (
    <div>
      <button onClick={() => navigate(`/client/campaigns/${campaignId}`)} className="flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800 mb-4">
        <ArrowLeft className="w-4 h-4" /> Back to Campaign
      </button>

      <div className="flex flex-wrap items-start justify-between gap-4 mb-5">
        <div>
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-2xl font-bold text-slate-900">{po.name || po.po_number}</h1>
            <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${CLIENT_PO_WORK_STATUS_COLORS[workStatus]}`}>
              {CLIENT_PO_WORK_STATUS_LABELS[workStatus]}
            </span>
          </div>
          {po.name && <p className="text-sm text-slate-400 mt-0.5">{po.po_number}</p>}
          <p className="text-sm text-slate-500 mt-1">
            {po.agency_org?.name || 'Unassigned agency'} · {new Date(po.po_date).toLocaleDateString('en-IN')} · {po.fulfillment_type === 'supply_only' ? 'Supply Only' : 'Survey + Install'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={openEdit} className="flex items-center gap-1.5 text-sm text-blue-600 border border-blue-200 hover:bg-blue-50 px-3 py-1.5 rounded-lg font-medium">
            <Pencil className="w-3.5 h-3.5" /> Edit
          </button>
          {po.assignment_status === 'pending_acceptance' && (
            <button onClick={() => setDeleteOpen(true)} className="flex items-center gap-1.5 text-sm text-red-600 border border-red-200 hover:bg-red-50 px-3 py-1.5 rounded-lg font-medium">
              <XCircle className="w-4 h-4" /> Delete
            </button>
          )}
        </div>
      </div>

      {po.assignment_status === 'pending_acceptance' && (
        <Card className="p-4 mb-5 border-amber-200 bg-amber-50/40">
          <p className="text-sm text-amber-800">Waiting on {po.agency_org?.name || 'the agency'} to accept this Work Order. You can still edit or delete it from here before they respond.</p>
        </Card>
      )}
      {po.assignment_status === 'rejected' && (
        <Card className="p-4 mb-5 border-red-200 bg-red-50/40">
          <p className="text-sm text-red-700">This Work Order was declined by the agency.</p>
        </Card>
      )}

      {/* Progress strip — always visible above the tabs, since "how far
          along is this" is the one thing worth seeing no matter which tab
          you're on. */}
      <Card className="p-5 mb-5">
        <h2 className="font-semibold text-slate-900 mb-4 flex items-center gap-2"><TrendingUp className="w-4 h-4 text-slate-400" /> Progress</h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          {STAGE_STEPS.map((stage) => {
            const pct = stagePct(progress || [], stage.key);
            return (
              <div key={stage.key}>
                <div className="flex items-center justify-between text-xs text-slate-500 mb-1">
                  <span>{stage.label}</span><span>{pct != null ? `${Math.round(pct)}%` : '—'}</span>
                </div>
                <ProgressBar pct={pct} />
              </div>
            );
          })}
        </div>
      </Card>

      {/* Tabs — Overview / Shops / Report / Map, so the page never reads
          as one long scroll mixing budget tables, photo grids, charts and
          a map all at once. */}
      <div className="flex items-center gap-1 border-b border-slate-200 mb-5 overflow-x-auto">
        {TABS.map((t) => {
          const Icon = t.icon;
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px whitespace-nowrap transition ${
                active ? 'border-blue-600 text-blue-600' : 'border-transparent text-slate-500 hover:text-slate-800'
              }`}
            >
              <Icon className="w-4 h-4" /> {t.label}
              {t.key === 'shops' && (shops || []).length > 0 && (
                <span className={`ml-1 px-1.5 py-0.5 rounded-full text-[10px] ${active ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-500'}`}>{shops!.length}</span>
              )}
            </button>
          );
        })}
      </div>

      {tab === 'overview' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2">
            <Card className="p-5">
              <h2 className="font-semibold text-slate-900 mb-3 flex items-center gap-2"><ListChecks className="w-4 h-4 text-slate-400" /> Budget / Line Items</h2>
              <div className="border border-slate-200 rounded-lg overflow-x-auto">
                <table className="w-full text-sm min-w-[520px]">
                  <thead className="bg-slate-50 text-slate-500 text-xs uppercase">
                    <tr>
                      <th className="text-left px-3 py-2">Description</th>
                      <th className="text-right px-3 py-2">Ordered</th>
                      <th className="text-right px-3 py-2">Surveyed</th>
                      <th className="text-right px-3 py-2">Installed / Produced</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {(lineItems || []).map((item) => {
                      const row = (progress || []).find((r) => r.po_line_item_id === item.id);
                      const ordered = item.uom === 'sqft' ? item.budgeted_area : item.budgeted_qty;
                      const surveyed = row ? (item.uom === 'sqft' ? row.surveyed_area : row.surveyed_qty) : null;
                      const done = row ? (po.fulfillment_type === 'supply_only' ? row.produced_qty : (item.uom === 'sqft' ? row.installed_area : row.installed_qty)) : null;
                      return (
                        <tr key={item.id}>
                          <td className="px-3 py-2 text-slate-900">{item.description}</td>
                          <td className="px-3 py-2 text-right text-slate-600">{formatQty(ordered, item.uom)}</td>
                          <td className="px-3 py-2 text-right text-slate-600">{formatQty(surveyed, item.uom)}</td>
                          <td className="px-3 py-2 text-right font-medium text-slate-900">{formatQty(done, po.fulfillment_type === 'supply_only' ? 'piece' : item.uom)}</td>
                        </tr>
                      );
                    })}
                    {(lineItems || []).length === 0 && (
                      <tr><td colSpan={4} className="px-3 py-6 text-center text-slate-400">No line items on this Work Order yet.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
              {po.notes && (
                <div className="mt-3 text-sm text-slate-600 bg-slate-50 rounded-lg px-3 py-2">
                  <span className="text-slate-400">Notes: </span>{po.notes}
                </div>
              )}
            </Card>
          </div>

          <div>
            <Card className="p-5">
              <h2 className="font-semibold text-slate-900 mb-3">Work Order Details</h2>
              <dl className="space-y-2 text-sm">
                <div className="flex justify-between"><dt className="text-slate-400">Order Date</dt><dd className="text-slate-700">{new Date(po.po_date).toLocaleDateString('en-IN')}</dd></div>
                <div className="flex justify-between"><dt className="text-slate-400">Fulfillment</dt><dd className="text-slate-700">{po.fulfillment_type === 'supply_only' ? 'Supply Only' : 'Survey + Install'}</dd></div>
                <div className="flex justify-between"><dt className="text-slate-400">Sites</dt><dd className="text-slate-700">{(shops || []).length}</dd></div>
                {po.payment_terms && <div className="flex justify-between gap-3"><dt className="text-slate-400 shrink-0">Payment Terms</dt><dd className="text-slate-700 text-right">{po.payment_terms}</dd></div>}
                {po.file_url && (
                  <div className="pt-2">
                    <a href={po.file_url} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline flex items-center gap-1">
                      <FileText className="w-3.5 h-3.5" /> View Work Order Document
                    </a>
                  </div>
                )}
              </dl>
            </Card>
          </div>
        </div>
      )}

      {tab === 'shops' && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <p className="text-sm text-slate-500">{(shops || []).length} site{(shops || []).length === 1 ? '' : 's'} on this Work Order</p>
            {canAddShop && (
              <div className="flex items-center gap-2">
                <button onClick={() => setBulkUploadOpen(true)} className="flex items-center gap-1.5 text-sm text-slate-600 border border-slate-200 hover:bg-slate-50 px-3 py-1.5 rounded-lg font-medium">
                  <UploadCloud className="w-3.5 h-3.5" /> Bulk Upload (Excel)
                </button>
                <button onClick={openAddShop} className="flex items-center gap-1.5 bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded-lg font-medium text-sm">
                  <Plus className="w-3.5 h-3.5" /> Add Shop
                </button>
              </div>
            )}
          </div>

          <Card className="p-4 mb-4">
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
              <div className="sm:col-span-2 relative">
                <label className="block text-xs font-medium text-slate-500 mb-1">Search</label>
                <Search className="w-4 h-4 text-slate-400 absolute left-3 top-[34px] -translate-y-1/2" />
                <input
                  value={shopSearch}
                  onChange={(e) => setShopSearch(e.target.value)}
                  placeholder="Name, city, district, village, zone, contact..."
                  className="w-full pl-9 pr-3 py-2 border border-slate-300 rounded-lg text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">Zone</label>
                <select value={shopZoneFilter} onChange={(e) => setShopZoneFilter(e.target.value)} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500">
                  <option value="">All Zones</option>
                  {shopZoneOptions.map((z) => <option key={z} value={z}>{z}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">Status</label>
                <select value={shopStatusFilter} onChange={(e) => setShopStatusFilter(e.target.value)} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500">
                  <option value="">All Statuses</option>
                  {shopStatusOptions.map((s) => <option key={s} value={s}>{STATUS_LABELS[s] || s}</option>)}
                </select>
              </div>
            </div>
            {(shopSearch || shopStatusFilter || shopZoneFilter) && (
              <div className="flex items-center justify-between mt-3 pt-3 border-t border-slate-100">
                <p className="text-xs text-slate-400">{filteredShops.length} of {(shops || []).length} sites match</p>
                <button onClick={() => { setShopSearch(''); setShopStatusFilter(''); setShopZoneFilter(''); }} className="text-xs text-slate-500 hover:text-slate-700 flex items-center gap-1 font-medium">
                  <X className="w-3.5 h-3.5" /> Clear
                </button>
              </div>
            )}
          </Card>

          <div className="space-y-2">
            {shopsToRender.map((shop) => {
              const sCount = surveyCountByShop.get(shop.id) || 0;
              const iCount = installCountByShop.get(shop.id) || 0;
              const locationLine = [shop.address, shop.village, shop.city, shop.district].filter(Boolean).join(', ');
              return (
                <Card key={shop.id} className="overflow-hidden hover:border-blue-300 transition">
                  <div className="w-full flex items-center justify-between gap-3 px-4 py-3">
                    <button onClick={() => setDrawerShopId(shop.id)} className="min-w-0 flex-1 text-left flex items-center gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-slate-900 truncate">{shop.name}</p>
                        {locationLine && (
                          <p className="text-xs text-slate-500 flex items-center gap-1 truncate mt-0.5">
                            <MapPin className="w-3 h-3 shrink-0" /> {locationLine}{shop.zone ? ` · Zone: ${shop.zone}` : ''}
                          </p>
                        )}
                        {shop.contact_phone && (
                          <p className="text-xs text-slate-400 flex items-center gap-1 truncate mt-0.5">
                            <Phone className="w-3 h-3 shrink-0" /> {shop.owner_name ? `${shop.owner_name} · ` : ''}{shop.contact_phone}
                          </p>
                        )}
                      </div>
                      <ChevronRight className="w-4 h-4 text-slate-300 shrink-0" />
                    </button>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-xs text-slate-400 flex items-center gap-1"><ImageIcon className="w-3.5 h-3.5" /> {sCount + iCount}</span>
                      <StatusBadge status={shop.status} label={STATUS_LABELS[shop.status]} />
                    </div>
                  </div>
                </Card>
              );
            })}
            {filteredShops.length === 0 && (
              <Card>
                <EmptyState
                  icon={<Store className="w-12 h-12" />}
                  title={(shops || []).length > 0 ? 'No sites match these filters' : 'No sites added yet'}
                  subtitle={canAddShop && (shops || []).length === 0 ? 'Add sites one by one, or bulk upload via Excel' : undefined}
                />
              </Card>
            )}
            {filteredShops.length > SHOP_RENDER_CAP && (
              <p className="text-xs text-slate-400 text-center py-2">
                Showing the first {SHOP_RENDER_CAP} of {filteredShops.length} matches — narrow your search or filters to find a specific site faster.
              </p>
            )}
          </div>
        </div>
      )}

      {tab === 'report' && (
        <div className="space-y-6">
          <Card className="p-5">
            <div className="flex items-center gap-2 mb-3">
              <ImageIcon className="w-4.5 h-4.5 text-slate-400" />
              <h2 className="font-semibold text-slate-900">Photo Compliance</h2>
              {nonCompliantCount > 0 && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-700">
                  <AlertTriangle className="w-3 h-3" /> {nonCompliantCount} need attention
                </span>
              )}
            </div>
            <div className="border border-slate-200 rounded-lg overflow-x-auto max-h-80 overflow-y-auto">
              <table className="w-full text-sm min-w-[560px]">
                <thead className="bg-slate-50 text-slate-500 text-xs uppercase sticky top-0">
                  <tr>
                    <th className="text-left px-3 py-2">Site</th>
                    <th className="text-left px-3 py-2">Status</th>
                    <th className="text-right px-3 py-2">Survey Photos</th>
                    <th className="text-right px-3 py-2">Install Photos</th>
                    <th className="text-center px-3 py-2">Compliant</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {photoComplianceRows.map((r) => (
                    <tr key={r.shop.id} className={!r.compliant ? 'bg-amber-50/40' : ''}>
                      <td className="px-3 py-2 text-slate-900">{r.shop.name}<span className="block text-xs text-slate-400">{r.shop.city}</span></td>
                      <td className="px-3 py-2 text-slate-600">{STATUS_LABELS[r.shop.status] || r.shop.status}</td>
                      <td className="px-3 py-2 text-right text-slate-600">{r.surveyCount}</td>
                      <td className="px-3 py-2 text-right text-slate-600">{r.installCount}</td>
                      <td className="px-3 py-2 text-center">
                        {r.compliant ? <StatusBadge status="completed" label="Yes" /> : <StatusBadge status="production_hold" label={r.reason} />}
                      </td>
                    </tr>
                  ))}
                  {photoComplianceRows.length === 0 && (
                    <tr><td colSpan={5} className="px-3 py-6 text-center text-slate-400">No sites yet.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </Card>

          <Card className="p-5">
            <div className="flex items-center gap-2 mb-4">
              <PieChart className="w-4.5 h-4.5 text-slate-400" />
              <h2 className="font-semibold text-slate-900">Progress by Line Item</h2>
            </div>
            {(progress || []).length === 0 ? (
              <EmptyState icon={<PieChart className="w-10 h-10" />} title="No line items yet" />
            ) : (
              <>
                <div className="max-w-sm mb-5">
                  <Select label="Line Item" value={reportLineItemId} onChange={setReportLineItemId} options={reportLineItemOptions} />
                </div>
                {!selectedProgressRow ? (
                  <p className="text-sm text-slate-400 py-6 text-center">Pick a line item to see its progress breakdown.</p>
                ) : (
                  <LineItemProgressChart
                    completionPct={lineItemCompletionPct}
                    completionLabel={STAGE_STEPS.find((s) => s.key === lineItemFinalStage)?.label || 'Complete'}
                    stages={lineItemStageValues}
                  />
                )}
              </>
            )}
          </Card>
        </div>
      )}

      {tab === 'map' && (
        <ClientPoSiteMap shops={shops || []} />
      )}

      <ConfirmDialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        onConfirm={() => deleteMutation.mutate()}
        title="Delete this Work Order?"
        message={`This permanently deletes ${po.name ? `${po.name} (${po.po_number})` : po.po_number} and any sites you've added on it, before the agency responds. This can't be undone.`}
        confirmLabel={deleteMutation.isPending ? 'Deleting...' : 'Delete'}
        danger
      />

      <Modal open={editOpen} onClose={() => setEditOpen(false)} title="Edit Work Order" size="xl">
        <div className="space-y-4">
          {isLocked && (
            <div className="flex items-start gap-2.5 bg-blue-50 border border-blue-100 rounded-lg px-3.5 py-2.5 text-sm text-blue-800">
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
              <p>{po.agency_org?.name || 'The agency'} has already accepted this Work Order, so the number, date and line items are now managed by them. You can still fix the name, notes or payment terms yourself — they'll see it in their activity log.</p>
            </div>
          )}

          <Input
            label="Work Order Name (optional)"
            value={editForm.name}
            onChange={(v) => setEditForm({ ...editForm, name: v })}
            placeholder="e.g. Q3 Andheri Dealer Boards"
          />

          {!isLocked && (
            <div className="grid grid-cols-2 gap-4">
              <Input label="Work Order No." value={editForm.po_number} onChange={(v) => setEditForm({ ...editForm, po_number: v })} required />
              <Input label="Order Date" type="date" value={editForm.po_date} onChange={(v) => setEditForm({ ...editForm, po_date: v })} required />
            </div>
          )}

          <Input label="Payment Terms" value={editForm.payment_terms} onChange={(v) => setEditForm({ ...editForm, payment_terms: v })} placeholder="e.g. 50% advance, 50% on installation" />
          <Textarea label="Notes / Timeline" value={editForm.notes} onChange={(v) => setEditForm({ ...editForm, notes: v })} />

          {!isLocked && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-sm font-medium text-slate-700">Scope / Line Items</label>
                <button onClick={addEditLine} type="button" className="text-sm text-blue-600 font-medium flex items-center gap-1"><Plus className="w-3.5 h-3.5" /> Add Item</button>
              </div>
              <div className="space-y-2">
                {editLines.map((line, idx) => (
                  <div key={idx} className="grid grid-cols-12 gap-2 items-start bg-slate-50 border border-slate-200 rounded-lg p-2">
                    <div className="col-span-6">
                      <input placeholder="Description / work type" value={line.description} onChange={(e) => updateEditLine(idx, 'description', e.target.value)} className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm" />
                    </div>
                    <div className="col-span-3">
                      <select value={line.uom} onChange={(e) => updateEditLine(idx, 'uom', e.target.value)} className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm bg-white">
                        {UOM_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                    </div>
                    <div className="col-span-2">
                      <input
                        placeholder={line.uom === 'sqft' ? 'Area' : 'Qty'}
                        type="number"
                        value={line.uom === 'sqft' ? line.budgeted_area : line.budgeted_qty}
                        onChange={(e) => updateEditLine(idx, line.uom === 'sqft' ? 'budgeted_area' : 'budgeted_qty', e.target.value)}
                        className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm"
                      />
                    </div>
                    <div className="col-span-1 flex justify-center pt-1.5">
                      {editLines.length > 1 && (
                        <button type="button" onClick={() => removeEditLine(idx)} className="text-slate-400 hover:text-red-600">
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
                {editLines.length === 0 && (
                  <button onClick={addEditLine} type="button" className="text-sm text-blue-600 font-medium">+ Add a line item</button>
                )}
              </div>
            </div>
          )}

          {editMutation.isError && <p className="text-sm text-red-600">{(editMutation.error as Error).message}</p>}

          <button
            onClick={() => editMutation.mutate()}
            disabled={editMutation.isPending || (!isLocked && (!editForm.po_number || !editForm.po_date))}
            className="w-full flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-700 text-white font-medium py-2.5 rounded-lg transition disabled:opacity-50"
          >
            {editMutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
            {editMutation.isPending ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </Modal>

      {/* Add Shop (single) */}
      <Modal open={addShopOpen} onClose={() => setAddShopOpen(false)} title="Add Shop" size="lg">
        <ShopForm form={shopForm} setForm={setShopForm} />
        {addShopMutation.isError && <p className="text-sm text-red-600 mt-3">{(addShopMutation.error as Error).message}</p>}
        <button
          onClick={() => addShopMutation.mutate()}
          disabled={addShopMutation.isPending || !shopForm.name.trim()}
          className="w-full flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-700 text-white font-medium py-2.5 rounded-lg transition disabled:opacity-50 mt-4"
        >
          {addShopMutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
          {addShopMutation.isPending ? 'Adding...' : 'Add Shop'}
        </button>
      </Modal>

      {/* Edit Shop */}
      <Modal open={!!editShopTarget} onClose={() => setEditShopTarget(null)} title="Edit Shop" size="lg">
        <ShopForm form={shopForm} setForm={setShopForm} />
        {editShopMutation.isError && <p className="text-sm text-red-600 mt-3">{(editShopMutation.error as Error).message}</p>}
        <button
          onClick={() => editShopMutation.mutate()}
          disabled={editShopMutation.isPending || !shopForm.name.trim()}
          className="w-full flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-700 text-white font-medium py-2.5 rounded-lg transition disabled:opacity-50 mt-4"
        >
          {editShopMutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
          {editShopMutation.isPending ? 'Saving...' : 'Save Changes'}
        </button>
      </Modal>

      {/* Bulk Upload via Excel */}
      <Modal open={bulkUploadOpen} onClose={() => { setBulkUploadOpen(false); resetBulkState(); }} title="Bulk Upload Shops" size="lg">
        <div className="space-y-4">
          <div className="bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5">
            <p className="text-xs text-slate-500">
              Upload a .xlsx or .csv file with one row per site. Always-recognized columns (any order, any position in the file):{' '}
              <span className="font-medium text-slate-700">Name</span> (required), Owner Name / Contact Person, Contact Phone, Address, City, District, Zone, State, Village (optional).
              Any other column in your file will be shown below so you can choose whether to keep it.
            </p>
          </div>

          <label className="flex flex-col items-center justify-center gap-2 border-2 border-dashed border-slate-300 hover:border-blue-400 rounded-lg py-8 cursor-pointer transition">
            <UploadCloud className="w-8 h-8 text-slate-400" />
            <span className="text-sm text-slate-600 font-medium">{bulkFileName || 'Click to choose a file'}</span>
            <span className="text-xs text-slate-400">.xlsx, .xls, or .csv</span>
            <input type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={(e) => e.target.files?.[0] && handleBulkFile(e.target.files[0])} />
          </label>

          {bulkError && <p className="text-sm text-red-600">{bulkError}</p>}

          {bulkExtraHeaders.length > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-3">
              <p className="text-xs font-medium text-amber-800 mb-2">
                Found {bulkExtraHeaders.length} extra column{bulkExtraHeaders.length === 1 ? '' : 's'} in your file that aren't part of the standard fields. Keep them as additional details on each site?
              </p>
              <div className="space-y-1.5">
                {bulkExtraHeaders.map((h) => (
                  <label key={h} className="flex items-center gap-2 text-sm text-amber-900">
                    <input
                      type="checkbox"
                      checked={!!bulkIncludedExtra[h]}
                      onChange={(e) => setBulkIncludedExtra({ ...bulkIncludedExtra, [h]: e.target.checked })}
                      className="rounded border-amber-300"
                    />
                    {h}
                  </label>
                ))}
              </div>
            </div>
          )}

          {bulkParsedRows.length > 0 && (
            <div className="border border-slate-200 rounded-lg overflow-x-auto max-h-56 overflow-y-auto">
              <table className="w-full text-xs min-w-[480px]">
                <thead className="bg-slate-50 text-slate-500 uppercase sticky top-0">
                  <tr>
                    <th className="text-left px-2 py-1.5">Name</th>
                    <th className="text-left px-2 py-1.5">City</th>
                    <th className="text-left px-2 py-1.5">District</th>
                    <th className="text-left px-2 py-1.5">Zone</th>
                    <th className="text-left px-2 py-1.5">Contact</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {bulkParsedRows.slice(0, 50).map((r, i) => (
                    <tr key={i}>
                      <td className="px-2 py-1.5 text-slate-800">{r.known.name}</td>
                      <td className="px-2 py-1.5 text-slate-600">{r.known.city}</td>
                      <td className="px-2 py-1.5 text-slate-600">{r.known.district}</td>
                      <td className="px-2 py-1.5 text-slate-600">{r.known.zone}</td>
                      <td className="px-2 py-1.5 text-slate-600">{r.known.contact_phone}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {bulkParsedRows.length > 50 && <p className="text-xs text-slate-400 px-2 py-1.5">...and {bulkParsedRows.length - 50} more rows</p>}
            </div>
          )}

          {bulkAddShopsMutation.isError && <p className="text-sm text-red-600">{(bulkAddShopsMutation.error as Error).message}</p>}

          <button
            onClick={() => bulkAddShopsMutation.mutate()}
            disabled={bulkAddShopsMutation.isPending || bulkParsedRows.length === 0}
            className="w-full flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-700 text-white font-medium py-2.5 rounded-lg transition disabled:opacity-50"
          >
            {bulkAddShopsMutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
            {bulkAddShopsMutation.isPending ? 'Uploading...' : `Add ${bulkParsedRows.length || ''} Site${bulkParsedRows.length === 1 ? '' : 's'}`}
          </button>
        </div>
      </Modal>

      <ConfirmDialog
        open={!!deleteShopTarget}
        onClose={() => setDeleteShopTarget(null)}
        onConfirm={() => deleteShopTarget && deleteShopMutation.mutate(deleteShopTarget)}
        title="Remove this site?"
        message={`This removes "${deleteShopTarget?.name}" from the Work Order. This can't be undone.`}
        confirmLabel={deleteShopMutation.isPending ? 'Removing...' : 'Remove'}
        danger
      />

      {/* Shop details — slides in from the right instead of an inline
          accordion, so the list underneath never reflows and every field a
          client needs (full address hierarchy, contact, board specs, and
          the actual MARKED survey photos — not plain ones) has room to
          breathe in one focused panel. */}
      <Drawer
        open={!!drawerShop}
        onClose={() => setDrawerShopId(null)}
        title={drawerShop?.name || 'Shop'}
        subtitle={drawerShop ? STATUS_LABELS[drawerShop.status] || drawerShop.status : undefined}
        width="lg"
      >
        {drawerShop && (
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <StatusBadge status={drawerShop.status} label={STATUS_LABELS[drawerShop.status]} />
              {canModifyShop(drawerShop) ? (
                <div className="flex items-center gap-2">
                  <button onClick={() => { openEditShop(drawerShop); setDrawerShopId(null); }} className="flex items-center gap-1 text-xs text-slate-500 hover:text-blue-600 px-2 py-1 border border-slate-200 rounded">
                    <Pencil className="w-3 h-3" /> Edit
                  </button>
                  <button onClick={() => { setDeleteShopTarget(drawerShop); setDrawerShopId(null); }} className="flex items-center gap-1 text-xs text-slate-500 hover:text-red-600 px-2 py-1 border border-slate-200 rounded">
                    <Trash2 className="w-3 h-3" /> Remove
                  </button>
                </div>
              ) : canAddShop && (
                <p className="text-xs text-slate-400">Field work has started — edit/remove is locked to protect it.</p>
              )}
            </div>

            <div>
              <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Location</h3>
              <dl className="space-y-1.5 text-sm">
                {drawerShop.address && <DetailRow label="Address" value={drawerShop.address} />}
                {drawerShop.village && <DetailRow label="Village" value={drawerShop.village} />}
                {drawerShop.city && <DetailRow label="City" value={drawerShop.city} />}
                {drawerShop.district && <DetailRow label="District" value={drawerShop.district} />}
                {drawerShop.zone && <DetailRow label="Zone" value={drawerShop.zone} />}
                {drawerShop.state && <DetailRow label="State" value={drawerShop.state} />}
                {!drawerShop.address && !drawerShop.village && !drawerShop.city && !drawerShop.district && !drawerShop.zone && !drawerShop.state && (
                  <p className="text-xs text-slate-400">No location details added.</p>
                )}
              </dl>
            </div>

            <div>
              <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Contact</h3>
              <dl className="space-y-1.5 text-sm">
                {drawerShop.owner_name && <DetailRow label="Owner" value={drawerShop.owner_name} />}
                {drawerShop.contact_phone && <DetailRow label="Phone" value={drawerShop.contact_phone} />}
                {!drawerShop.owner_name && !drawerShop.contact_phone && <p className="text-xs text-slate-400">No contact details added.</p>}
              </dl>
            </div>

            {drawerShop.extra_details && Object.keys(drawerShop.extra_details).length > 0 && (
              <div>
                <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Additional Details</h3>
                <dl className="space-y-1.5 text-sm">
                  {Object.entries(drawerShop.extra_details).map(([k, v]) => (
                    <DetailRow key={k} label={k} value={v} />
                  ))}
                </dl>
              </div>
            )}

            {drawerLoading ? (
              <div className="flex items-center gap-2 text-sm text-slate-400 py-4"><Loader2 className="w-4 h-4 animate-spin" /> Loading details...</div>
            ) : drawerError ? (
              <div className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2.5">
                {(drawerError as Error).message}
              </div>
            ) : (
              <>
                {(drawerData?.workItems.length || 0) > 0 && (
                  <div>
                    <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2 flex items-center gap-1.5"><Ruler className="w-3.5 h-3.5" /> Boards</h3>
                    <div className="space-y-2">
                      {drawerData!.workItems.map((wi) => (
                        <div key={wi.id} className="flex items-center justify-between text-sm bg-slate-50 rounded-lg px-3 py-2">
                          <span className="text-slate-700">{wi.work_type_name || 'Board'}</span>
                          <span className="text-slate-500 text-xs">
                            {wi.survey_width && wi.survey_height ? `${wi.survey_width}×${wi.survey_height} ${wi.survey_unit || ''}` : '—'}
                            {wi.survey_quantity ? ` · Qty ${wi.survey_quantity}` : ''}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div>
                  <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Survey Photos ({drawerData?.surveyPhotos.length || 0})</h3>
                  <MarkedPhotoGrid
                    photos={drawerData?.surveyPhotos || []}
                    markings={drawerData?.markings || []}
                    workItems={drawerData?.workItems || []}
                  />
                </div>

                <div>
                  <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Installation Photos ({drawerData?.installationPhotos.length || 0})</h3>
                  <InstallationPhotoGrid photos={drawerData?.installationPhotos || []} />
                </div>
              </>
            )}
          </div>
        )}
      </Drawer>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-slate-400 shrink-0">{label}</dt>
      <dd className="text-slate-700 text-right">{value}</dd>
    </div>
  );
}
