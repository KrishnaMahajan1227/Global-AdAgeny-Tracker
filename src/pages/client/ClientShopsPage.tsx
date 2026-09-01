import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import * as XLSX from 'xlsx';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { Card, EmptyState, PageHeader, StatusBadge, Modal, Select, ConfirmDialog, Drawer, FilterButton, FilterDrawer, FilterSection } from '@/components/ui';
import { ShopForm, emptyShopFormValues, type ShopFormValues } from '@/components/ShopForm';
import { findShopHeaderRow, findExtraHeaders, buildShopRows, resolveZoneIds, type ParsedShopRow } from '@/lib/shopBulkUpload';
import { MarkedPhotoGrid } from '@/components/MarkedPhotoGrid';
import { InstallationPhotoGrid } from '@/components/InstallationPhotoGrid';
import { formatDim } from '@/lib/units';
import { logAudit } from '@/lib/helpers';
import { STATUS_LABELS, type PurchaseOrder, type Campaign, type ClientAgencyLink, type SurveyPhoto, type BoardMarking, type WorkItem } from '@/lib/types';
import {
  Store, Plus, Search, MapPin, Phone, Image as ImageIcon, ChevronRight, Pencil, Trash2,
  Loader2, UploadCloud, Ruler,
} from 'lucide-react';

type ShopRow = {
  id: string; name: string; owner_name: string | null; contact_phone: string | null;
  address: string | null; city: string | null; district: string | null; village: string | null;
  zone: string | null; state: string | null; status: string; purchase_order_id: string | null;
  extra_details: Record<string, string> | null; created_at: string;
};
type PoRow = Pick<PurchaseOrder, 'id' | 'po_number' | 'name' | 'campaign_id' | 'assigned_agency_id' | 'origin' | 'project_id'> & { agency_org: { name: string } | null };
type PhotoRow = { id: string; photo_url: string; caption: string | null; photo_type: string; angle: string | null };

const SHOP_RENDER_CAP = 200;

// Shops — every site across every campaign/Work Order the client has,
// searchable and manageable from one place, instead of only reachable
// three levels deep (Campaign -> Work Order -> Shops tab). Same CRUD
// rules as the per-Work-Order Shops tab: adding a site is always
// available on a client-created Work Order; editing/removing an existing
// site is only offered while that specific site's own status is still
// 'pending' (no field work recorded on it yet) — RLS-enforced, migration
// 0053.
export default function ClientShopsPage() {
  const { profile } = useAuth();
  const orgId = profile?.organization_id;
  const queryClient = useQueryClient();

  const [search, setSearch] = useState('');
  const [zoneFilter, setZoneFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [workOrderFilter, setWorkOrderFilter] = useState('');
  const [campaignFilter, setCampaignFilter] = useState('');
  const [cityFilter, setCityFilter] = useState('');
  const [districtFilter, setDistrictFilter] = useState('');
  const [stateFilter, setStateFilter] = useState('');
  const [sortBy, setSortBy] = useState('created_desc');
  const [filterDrawerOpen, setFilterDrawerOpen] = useState(false);

  const [addOpen, setAddOpen] = useState(false);
  const [addWorkOrderId, setAddWorkOrderId] = useState('');
  const [shopForm, setShopForm] = useState<ShopFormValues>(emptyShopFormValues);
  const [editTarget, setEditTarget] = useState<ShopRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ShopRow | null>(null);
  const [drawerShopId, setDrawerShopId] = useState<string | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkWorkOrderId, setBulkWorkOrderId] = useState('');
  const [bulkAoa, setBulkAoa] = useState<unknown[][] | null>(null);
  const [bulkHeaders, setBulkHeaders] = useState<string[]>([]);
  const [bulkHeaderRowIndex, setBulkHeaderRowIndex] = useState(0);
  const [bulkExtraHeaders, setBulkExtraHeaders] = useState<string[]>([]);
  const [bulkIncludedExtra, setBulkIncludedExtra] = useState<Record<string, boolean>>({});
  const [bulkFileName, setBulkFileName] = useState('');
  const [bulkError, setBulkError] = useState('');
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [bulkDeleteWorkOrderId, setBulkDeleteWorkOrderId] = useState('');
  const [bulkDeleteZone, setBulkDeleteZone] = useState('');
  const [bulkDeleteCity, setBulkDeleteCity] = useState('');
  const [bulkDeleteDistrict, setBulkDeleteDistrict] = useState('');
  const [bulkDeleteState, setBulkDeleteState] = useState('');
  const [bulkDeleteConfirmText, setBulkDeleteConfirmText] = useState('');

  const { data: shops, isLoading } = useQuery({
    queryKey: ['client-shops-all', orgId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('shops')
        .select('id, name, owner_name, contact_phone, address, city, district, village, zone, state, status, purchase_order_id, extra_details, created_at')
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data as ShopRow[];
    },
    enabled: !!orgId,
  });

  const { data: pos } = useQuery({
    queryKey: ['client-shops-pos', orgId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('purchase_orders')
        .select('id, po_number, name, campaign_id, assigned_agency_id, origin, project_id, agency_org:organizations!purchase_orders_assigned_agency_id_fkey(name)')
        .eq('client_org_id', orgId);
      if (error) throw error;
      return data as unknown as PoRow[];
    },
    enabled: !!orgId,
  });

  const { data: campaigns } = useQuery({
    queryKey: ['client-shops-campaigns', orgId],
    queryFn: async () => {
      const { data, error } = await supabase.from('campaigns').select('id, name').eq('client_org_id', orgId);
      if (error) throw error;
      return data as Pick<Campaign, 'id' | 'name'>[];
    },
    enabled: !!orgId,
  });

  const { data: links } = useQuery({
    queryKey: ['client-shops-links', orgId],
    queryFn: async () => {
      const { data, error } = await supabase.from('client_agency_links').select('agency_org_id, agency_client_id').eq('client_org_id', orgId).eq('status', 'active');
      if (error) throw error;
      return data as Pick<ClientAgencyLink, 'agency_org_id' | 'agency_client_id'>[];
    },
    enabled: !!orgId,
  });

  const { data: photoCountRows } = useQuery({
    queryKey: ['client-shops-photo-counts', orgId],
    queryFn: async () => {
      const [surveyRes, installRes] = await Promise.all([
        supabase.from('survey_photos').select('shop_id'),
        supabase.from('installation_proofs').select('shop_id'),
      ]);
      return {
        survey: (surveyRes.data || []).map((r) => r.shop_id as string),
        install: (installRes.data || []).map((r) => r.shop_id as string),
      };
    },
    enabled: !!orgId,
  });

  const { data: drawerData, isLoading: drawerLoading, error: drawerError } = useQuery({
    queryKey: ['client-shops-drawer', drawerShopId],
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

  const poById = useMemo(() => new Map((pos || []).map((p) => [p.id, p])), [pos]);
  const campaignById = useMemo(() => new Map((campaigns || []).map((c) => [c.id, c])), [campaigns]);
  const linkByAgency = useMemo(() => new Map((links || []).map((l) => [l.agency_org_id, l])), [links]);

  // Only client-created Work Orders can receive client-added shops (RLS).
  const addableWorkOrders = (pos || []).filter((p) => p.origin === 'client_created');
  const workOrderOptions = addableWorkOrders.map((p) => ({
    value: p.id,
    label: `${p.name ? `${p.name} (${p.po_number})` : p.po_number}${p.campaign_id ? ` — ${campaignById.get(p.campaign_id)?.name || ''}` : ''}`,
  }));

  const surveyCountByShop = useMemo(() => {
    const m = new Map<string, number>();
    for (const id of photoCountRows?.survey || []) m.set(id, (m.get(id) || 0) + 1);
    return m;
  }, [photoCountRows]);
  const installCountByShop = useMemo(() => {
    const m = new Map<string, number>();
    for (const id of photoCountRows?.install || []) m.set(id, (m.get(id) || 0) + 1);
    return m;
  }, [photoCountRows]);

  const zoneOptions = useMemo(() => Array.from(new Set((shops || []).map((s) => s.zone).filter((z): z is string => !!z))).sort(), [shops]);
  const statusOptions = useMemo(() => Array.from(new Set((shops || []).map((s) => s.status))).sort(), [shops]);
  const cityOptions = useMemo(() => Array.from(new Set((shops || []).map((s) => s.city).filter((c): c is string => !!c))).sort(), [shops]);
  const districtOptions = useMemo(() => Array.from(new Set((shops || []).map((s) => s.district).filter((d): d is string => !!d))).sort(), [shops]);
  const stateOptions = useMemo(() => Array.from(new Set((shops || []).map((s) => s.state).filter((st): st is string => !!st))).sort(), [shops]);
  const poCampaignById = useMemo(() => new Map((pos || []).map((p) => [p.id, p.campaign_id])), [pos]);
  const poNumberById = useMemo(() => new Map((pos || []).map((p) => [p.id, p.name || p.po_number])), [pos]);

  const filteredShops = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (shops || []).filter((s) => {
      if (q) {
        const haystack = [s.name, s.city, s.district, s.village, s.zone, s.address, s.owner_name, s.contact_phone].filter(Boolean).join(' ').toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      if (zoneFilter && (s.zone || '') !== zoneFilter) return false;
      if (statusFilter && s.status !== statusFilter) return false;
      if (workOrderFilter && s.purchase_order_id !== workOrderFilter) return false;
      if (campaignFilter && (!s.purchase_order_id || poCampaignById.get(s.purchase_order_id) !== campaignFilter)) return false;
      if (cityFilter && (s.city || '') !== cityFilter) return false;
      if (districtFilter && (s.district || '') !== districtFilter) return false;
      if (stateFilter && (s.state || '') !== stateFilter) return false;
      return true;
    });
  }, [shops, search, zoneFilter, statusFilter, workOrderFilter, campaignFilter, cityFilter, districtFilter, stateFilter, poCampaignById]);

  const sortedShops = useMemo(() => {
    const arr = [...filteredShops];
    arr.sort((a, b) => {
      switch (sortBy) {
        case 'name_asc':
          return a.name.localeCompare(b.name);
        case 'zone_asc':
          return (a.zone || '').localeCompare(b.zone || '');
        case 'work_order_asc':
          return (poNumberById.get(a.purchase_order_id || '') || '').localeCompare(poNumberById.get(b.purchase_order_id || '') || '');
        case 'status_asc':
          return a.status.localeCompare(b.status);
        case 'created_asc':
          return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
        case 'created_desc':
        default:
          return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      }
    });
    return arr;
  }, [filteredShops, sortBy, poNumberById]);

  const shopsToRender = sortedShops.slice(0, SHOP_RENDER_CAP);
  const activeFilterCount = [zoneFilter, statusFilter, workOrderFilter, campaignFilter, cityFilter, districtFilter, stateFilter].filter(Boolean).length;
  const SORT_OPTIONS = [
    { value: 'created_desc', label: 'Newest first' },
    { value: 'created_asc', label: 'Oldest first' },
    { value: 'name_asc', label: 'Name (A–Z)' },
    { value: 'work_order_asc', label: 'Work Order (A–Z)' },
    { value: 'zone_asc', label: 'Zone (A–Z)' },
    { value: 'status_asc', label: 'Status' },
  ];

  function canAddTo(poId: string) {
    return addableWorkOrders.some((p) => p.id === poId);
  }
  function canModify(shop: ShopRow) {
    if (shop.status !== 'pending' || !shop.purchase_order_id) return false;
    return canAddTo(shop.purchase_order_id);
  }

  // ---- CREATE ----
  const addMutation = useMutation({
    mutationFn: async () => {
      const po = poById.get(addWorkOrderId);
      const link = po ? linkByAgency.get(po.assigned_agency_id || '') : null;
      if (!po || !link?.agency_client_id) throw new Error('Pick a Work Order first.');
      const { error } = await supabase.from('shops').insert({
        organization_id: po.assigned_agency_id,
        client_id: link.agency_client_id,
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
      queryClient.invalidateQueries({ queryKey: ['client-shops-all', orgId] });
      setAddOpen(false);
      setShopForm(emptyShopFormValues);
      setAddWorkOrderId('');
    },
  });

  // ---- UPDATE ----
  const editMutation = useMutation({
    mutationFn: async () => {
      if (!editTarget) return;
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
      }).eq('id', editTarget.id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['client-shops-all', orgId] });
      setEditTarget(null);
      setShopForm(emptyShopFormValues);
    },
  });

  // ---- DELETE ----
  const deleteMutation = useMutation({
    mutationFn: async (shop: ShopRow) => {
      const { error } = await supabase.from('shops').delete().eq('id', shop.id);
      if (error) throw error;
      await logAudit('shops', shop.id, 'delete', null, null, null, `Removed site ${shop.name}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['client-shops-all', orgId] });
      setDeleteTarget(null);
    },
  });

  // ---- BULK DELETE ----
  // Deliberately NOT selection-based: with a checkbox-per-row + a client
  // held Set<id>, both the picker and the "how many will this delete"
  // count are bounded by how many rows got fetched/rendered in the
  // browser (SHOP_RENDER_CAP). That's fine at a few hundred shops and
  // silently wrong/misleading at 100k+. Instead this deletes by
  // criteria: the user picks a Work Order plus optional Zone/City/
  // District/State, we ask Postgres for a COUNT (head:true — no rows
  // ever come to the browser) to preview the blast radius, and the
  // actual delete runs as a single filtered query. Same eligibility
  // rule as the single delete — only sites still 'pending' on a
  // client_created Work Order (RLS migration 0053) — is applied
  // directly in the filter, not by pre-checking each row.
  function bulkDeleteMatchQuery() {
    let q = supabase.from('shops').select('id', { count: 'exact', head: true })
      .eq('purchase_order_id', bulkDeleteWorkOrderId)
      .eq('status', 'pending');
    if (bulkDeleteZone) q = q.eq('zone', bulkDeleteZone);
    if (bulkDeleteCity) q = q.eq('city', bulkDeleteCity);
    if (bulkDeleteDistrict) q = q.eq('district', bulkDeleteDistrict);
    if (bulkDeleteState) q = q.eq('state', bulkDeleteState);
    return q;
  }

  const { data: bulkDeleteCountData, isFetching: bulkDeleteCountLoading } = useQuery({
    queryKey: ['client-shops-bulk-delete-count', orgId, bulkDeleteWorkOrderId, bulkDeleteZone, bulkDeleteCity, bulkDeleteDistrict, bulkDeleteState],
    queryFn: async () => {
      const { count, error } = await bulkDeleteMatchQuery();
      if (error) throw error;
      return count ?? 0;
    },
    enabled: bulkDeleteOpen && !!bulkDeleteWorkOrderId,
  });
  const bulkDeleteCount = bulkDeleteWorkOrderId ? (bulkDeleteCountData ?? 0) : 0;

  const bulkDeleteMutation = useMutation({
    mutationFn: async () => {
      if (!bulkDeleteWorkOrderId) throw new Error('Pick a Work Order first.');
      let q = supabase.from('shops').delete({ count: 'exact' })
        .eq('purchase_order_id', bulkDeleteWorkOrderId)
        .eq('status', 'pending');
      if (bulkDeleteZone) q = q.eq('zone', bulkDeleteZone);
      if (bulkDeleteCity) q = q.eq('city', bulkDeleteCity);
      if (bulkDeleteDistrict) q = q.eq('district', bulkDeleteDistrict);
      if (bulkDeleteState) q = q.eq('state', bulkDeleteState);
      const { error, count } = await q;
      if (error) throw error;
      const po = poById.get(bulkDeleteWorkOrderId);
      await logAudit('shops', bulkDeleteWorkOrderId, 'delete', null, null, null, `Bulk-removed ${count ?? 0} site${(count ?? 0) === 1 ? '' : 's'} from ${po?.name || po?.po_number || 'Work Order'}`);
      return count ?? 0;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['client-shops-all', orgId] });
      setBulkDeleteOpen(false);
      resetBulkDeleteState();
    },
  });

  function resetBulkDeleteState() {
    setBulkDeleteWorkOrderId('');
    setBulkDeleteZone('');
    setBulkDeleteCity('');
    setBulkDeleteDistrict('');
    setBulkDeleteState('');
    setBulkDeleteConfirmText('');
  }

  // ---- BULK ----
  const bulkIncludedExtraKeys = useMemo(
    () => new Set(bulkExtraHeaders.filter((h) => bulkIncludedExtra[h])),
    [bulkExtraHeaders, bulkIncludedExtra]
  );
  const bulkParsedRows: ParsedShopRow[] = useMemo(
    () => (bulkAoa ? buildShopRows(bulkAoa, bulkHeaderRowIndex, bulkHeaders, bulkIncludedExtraKeys) : []),
    [bulkAoa, bulkHeaderRowIndex, bulkHeaders, bulkIncludedExtraKeys]
  );

  const bulkMutation = useMutation({
    mutationFn: async () => {
      const po = poById.get(bulkWorkOrderId);
      const link = po ? linkByAgency.get(po.assigned_agency_id || '') : null;
      if (!po || !link?.agency_client_id) throw new Error('Pick a Work Order first.');
      if (bulkParsedRows.length === 0) throw new Error('No valid rows found — every row needs at least a Name.');
      // Resolve every distinct "Zone" text in the sheet to a real zone_id
      // under the AGENCY's org (migration 0065 allows this cross-org
      // read/create for a client_admin on their own client_created PO) so
      // these shops are actually zone-filterable for the agency, not just
      // zone-labeled.
      const zoneIds = await resolveZoneIds(po.assigned_agency_id!, po.project_id || null, bulkParsedRows.map((r) => r.known.zone));
      const rows = bulkParsedRows.map(({ known, extra }) => ({
        organization_id: po.assigned_agency_id,
        client_id: link.agency_client_id,
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
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['client-shops-all', orgId] });
      setBulkOpen(false);
      resetBulkState();
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
    setBulkWorkOrderId('');
  }

  function handleBulkFile(file: File) {
    setBulkError('');
    setBulkFileName(file.name);
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const wb = XLSX.read(e.target?.result, { type: 'binary' });
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
        setBulkError("Could not read this file. Make sure it's a valid .xlsx or .csv file.");
        setBulkAoa(null);
      }
    };
    reader.readAsBinaryString(file);
  }

  function openEdit(shop: ShopRow) {
    setShopForm({
      name: shop.name, owner_name: shop.owner_name || '', contact_phone: shop.contact_phone || '',
      address: shop.address || '', village: shop.village || '', city: shop.city || '',
      district: shop.district || '', zone: shop.zone || '', state: shop.state || '',
    });
    setEditTarget(shop);
  }

  const drawerShop = (shops || []).find((s) => s.id === drawerShopId) || null;
  const drawerPo = drawerShop?.purchase_order_id ? poById.get(drawerShop.purchase_order_id) : null;

  return (
    <div>
      <PageHeader
        title="Shops"
        subtitle="Every site across every campaign and Work Order, in one place"
        action={
          <div className="flex items-center gap-2">
            <button
              onClick={() => setBulkOpen(true)}
              disabled={addableWorkOrders.length === 0}
              className="flex items-center gap-1.5 text-sm text-slate-600 border border-slate-200 hover:bg-slate-50 px-3 py-2 rounded-lg font-medium disabled:opacity-40"
            >
              <UploadCloud className="w-4 h-4" /> Bulk Upload
            </button>
            <button
              onClick={() => setAddOpen(true)}
              disabled={addableWorkOrders.length === 0}
              title={addableWorkOrders.length === 0 ? 'Create a Work Order first' : undefined}
              className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg font-medium text-sm transition disabled:opacity-40"
            >
              <Plus className="w-4 h-4" /> Add Shop
            </button>
          </div>
        }
      />

      <div className="flex flex-wrap items-center gap-2 mb-5">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Name, city, district, village, zone..."
            className="w-full pl-9 pr-3 py-2 border border-slate-300 rounded-lg text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <select value={sortBy} onChange={(e) => setSortBy(e.target.value)} className="px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500">
          {SORT_OPTIONS.map((o) => <option key={o.value} value={o.value}>Sort: {o.label}</option>)}
        </select>
        <FilterButton activeCount={activeFilterCount} onClick={() => setFilterDrawerOpen(true)} />
        <div className="ml-auto pl-2 border-l border-slate-200">
          <button
            onClick={() => setBulkDeleteOpen(true)}
            disabled={addableWorkOrders.length === 0}
            title="Bulk delete"
            className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-red-600 px-2 py-1.5 rounded-lg font-medium disabled:opacity-40 disabled:hover:text-slate-400 transition"
          >
            <Trash2 className="w-3.5 h-3.5" /> Bulk Delete
          </button>
        </div>
      </div>

      <FilterDrawer
        open={filterDrawerOpen}
        onClose={() => setFilterDrawerOpen(false)}
        onClear={() => { setZoneFilter(''); setStatusFilter(''); setWorkOrderFilter(''); setCampaignFilter(''); setCityFilter(''); setDistrictFilter(''); setStateFilter(''); }}
        activeCount={activeFilterCount}
        resultCount={filteredShops.length}
        resultLabel="sites"
      >
        <FilterSection label="Work Order">
          <select value={workOrderFilter} onChange={(e) => setWorkOrderFilter(e.target.value)} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500 truncate">
            <option value="">All Work Orders</option>
            {(pos || []).map((p) => <option key={p.id} value={p.id}>{p.name ? `${p.name} (${p.po_number})` : p.po_number}</option>)}
          </select>
        </FilterSection>
        {(campaigns || []).length > 0 && (
          <FilterSection label="Campaign">
            <select value={campaignFilter} onChange={(e) => setCampaignFilter(e.target.value)} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500">
              <option value="">All Campaigns</option>
              {(campaigns || []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </FilterSection>
        )}
        <FilterSection label="Zone">
          <select value={zoneFilter} onChange={(e) => setZoneFilter(e.target.value)} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500">
            <option value="">All Zones</option>
            {zoneOptions.map((z) => <option key={z} value={z}>{z}</option>)}
          </select>
        </FilterSection>
        <FilterSection label="Status">
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500">
            <option value="">All Statuses</option>
            {statusOptions.map((s) => <option key={s} value={s}>{STATUS_LABELS[s] || s}</option>)}
          </select>
        </FilterSection>
        <FilterSection label="City">
          <select value={cityFilter} onChange={(e) => setCityFilter(e.target.value)} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500">
            <option value="">All Cities</option>
            {cityOptions.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </FilterSection>
        <FilterSection label="District">
          <select value={districtFilter} onChange={(e) => setDistrictFilter(e.target.value)} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500">
            <option value="">All Districts</option>
            {districtOptions.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
        </FilterSection>
        <FilterSection label="State">
          <select value={stateFilter} onChange={(e) => setStateFilter(e.target.value)} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500">
            <option value="">All States</option>
            {stateOptions.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </FilterSection>
      </FilterDrawer>

      <div className="space-y-2">
        {shopsToRender.map((shop) => {
          const po = shop.purchase_order_id ? poById.get(shop.purchase_order_id) : null;
          const sCount = surveyCountByShop.get(shop.id) || 0;
          const iCount = installCountByShop.get(shop.id) || 0;
          const locationLine = [shop.address, shop.village, shop.city, shop.district].filter(Boolean).join(', ');
          return (
            <Card key={shop.id} className="overflow-hidden hover:border-blue-300 transition">
              <div className="flex items-start gap-3 px-4 pt-3">
                <button onClick={() => setDrawerShopId(shop.id)} className="flex-1 min-w-0 flex items-center justify-between gap-3 py-0 text-left">
                  <div className="min-w-0 flex-1 flex items-center gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium text-slate-900 truncate">{shop.name}</p>
                        {po && <span className="shrink-0 text-[10px] font-medium text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded">{po.name || po.po_number}</span>}
                      </div>
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
                  </div>
                </button>
              </div>
              <div className="flex items-center justify-between px-4 pb-3 pt-2">
                <div className="flex items-center gap-2 pl-7">
                  <span className="text-xs text-slate-400 flex items-center gap-1"><ImageIcon className="w-3.5 h-3.5" /> {sCount + iCount}</span>
                  <StatusBadge status={shop.status} label={STATUS_LABELS[shop.status]} />
                </div>
                {canModify(shop) && (
                  <div className="flex items-center gap-2">
                    <button onClick={() => openEdit(shop)} className="text-slate-400 hover:text-blue-600"><Pencil className="w-3.5 h-3.5" /></button>
                    <button onClick={() => setDeleteTarget(shop)} className="text-slate-400 hover:text-red-600"><Trash2 className="w-3.5 h-3.5" /></button>
                  </div>
                )}
              </div>
            </Card>
          );
        })}
        {!isLoading && filteredShops.length === 0 && (
          <Card>
            <EmptyState
              icon={<Store className="w-12 h-12" />}
              title={(shops || []).length > 0 ? 'No sites match these filters' : 'No sites yet'}
              subtitle={(shops || []).length === 0 ? (addableWorkOrders.length > 0 ? 'Add sites one by one, or bulk upload via Excel' : 'Create a campaign and Work Order first') : undefined}
            />
          </Card>
        )}
        {filteredShops.length > SHOP_RENDER_CAP && (
          <p className="text-xs text-slate-400 text-center py-2">
            Showing the first {SHOP_RENDER_CAP} of {filteredShops.length} matches — narrow your search or filters to find a specific site faster.
          </p>
        )}
      </div>

      {/* CREATE */}
      <Modal open={addOpen} onClose={() => setAddOpen(false)} title="Add Shop" size="lg">
        <div className="space-y-4">
          <Select label="Work Order" value={addWorkOrderId} onChange={setAddWorkOrderId} options={workOrderOptions} required />
          <ShopForm form={shopForm} setForm={setShopForm} />
          {addMutation.isError && <p className="text-sm text-red-600">{(addMutation.error as Error).message}</p>}
          <button
            onClick={() => addMutation.mutate()}
            disabled={addMutation.isPending || !addWorkOrderId || !shopForm.name.trim()}
            className="w-full flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-700 text-white font-medium py-2.5 rounded-lg transition disabled:opacity-50"
          >
            {addMutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
            {addMutation.isPending ? 'Adding...' : 'Add Shop'}
          </button>
        </div>
      </Modal>

      {/* UPDATE */}
      <Modal open={!!editTarget} onClose={() => setEditTarget(null)} title="Edit Shop" size="lg">
        <div className="space-y-4">
          <ShopForm form={shopForm} setForm={setShopForm} />
          {editMutation.isError && <p className="text-sm text-red-600">{(editMutation.error as Error).message}</p>}
          <button
            onClick={() => editMutation.mutate()}
            disabled={editMutation.isPending || !shopForm.name.trim()}
            className="w-full flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-700 text-white font-medium py-2.5 rounded-lg transition disabled:opacity-50"
          >
            {editMutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
            {editMutation.isPending ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </Modal>

      {/* BULK */}
      <Modal open={bulkOpen} onClose={() => { setBulkOpen(false); resetBulkState(); }} title="Bulk Upload Shops" size="lg">
        <div className="space-y-4">
          <Select label="Work Order" value={bulkWorkOrderId} onChange={setBulkWorkOrderId} options={workOrderOptions} required />
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
          {bulkMutation.isError && <p className="text-sm text-red-600">{(bulkMutation.error as Error).message}</p>}
          <button
            onClick={() => bulkMutation.mutate()}
            disabled={bulkMutation.isPending || bulkParsedRows.length === 0 || !bulkWorkOrderId}
            className="w-full flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-700 text-white font-medium py-2.5 rounded-lg transition disabled:opacity-50"
          >
            {bulkMutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
            {bulkMutation.isPending ? 'Uploading...' : `Add ${bulkParsedRows.length || ''} Site${bulkParsedRows.length === 1 ? '' : 's'}`}
          </button>
        </div>
      </Modal>

      <ConfirmDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => deleteTarget && deleteMutation.mutate(deleteTarget)}
        title="Remove this site?"
        message={`This removes "${deleteTarget?.name}" from its Work Order. This can't be undone.`}
        confirmLabel={deleteMutation.isPending ? 'Removing...' : 'Remove'}
        danger
      />

      {/* BULK DELETE */}
      <Modal open={bulkDeleteOpen} onClose={() => { setBulkDeleteOpen(false); resetBulkDeleteState(); }} title="Bulk Delete Shops" size="lg">
        <div className="space-y-4">
          <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2.5">
            <p className="text-xs text-amber-800">
              This deletes by matching criteria, not by picking sites one at a time — so it works the same whether 10 sites match or 1,00,000. Only sites still <span className="font-medium">pending</span> (no field work recorded yet) are eligible, same rule as removing a single site. This can't be undone.
            </p>
          </div>

          <Select
            label="Work Order"
            value={bulkDeleteWorkOrderId}
            onChange={(v) => { setBulkDeleteWorkOrderId(v); setBulkDeleteConfirmText(''); }}
            options={workOrderOptions}
            required
          />

          {bulkDeleteWorkOrderId && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">Zone (optional)</label>
                <select value={bulkDeleteZone} onChange={(e) => { setBulkDeleteZone(e.target.value); setBulkDeleteConfirmText(''); }} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white outline-none focus:ring-2 focus:ring-red-500">
                  <option value="">Any zone</option>
                  {zoneOptions.map((z) => <option key={z} value={z}>{z}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">City (optional)</label>
                <select value={bulkDeleteCity} onChange={(e) => { setBulkDeleteCity(e.target.value); setBulkDeleteConfirmText(''); }} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white outline-none focus:ring-2 focus:ring-red-500">
                  <option value="">Any city</option>
                  {cityOptions.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">District (optional)</label>
                <select value={bulkDeleteDistrict} onChange={(e) => { setBulkDeleteDistrict(e.target.value); setBulkDeleteConfirmText(''); }} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white outline-none focus:ring-2 focus:ring-red-500">
                  <option value="">Any district</option>
                  {districtOptions.map((d) => <option key={d} value={d}>{d}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">State (optional)</label>
                <select value={bulkDeleteState} onChange={(e) => { setBulkDeleteState(e.target.value); setBulkDeleteConfirmText(''); }} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white outline-none focus:ring-2 focus:ring-red-500">
                  <option value="">Any state</option>
                  {stateOptions.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
            </div>
          )}

          {bulkDeleteWorkOrderId && (
            <div className={`rounded-lg px-3 py-2.5 border ${bulkDeleteCount > 0 ? 'bg-red-50 border-red-200' : 'bg-slate-50 border-slate-200'}`}>
              {bulkDeleteCountLoading ? (
                <p className="text-sm text-slate-500 flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Checking matches...</p>
              ) : bulkDeleteCount > 0 ? (
                <p className="text-sm text-red-700 font-medium">This will permanently delete {bulkDeleteCount} site{bulkDeleteCount === 1 ? '' : 's'}.</p>
              ) : (
                <p className="text-sm text-slate-500">No pending sites match these criteria.</p>
              )}
            </div>
          )}

          {bulkDeleteCount > 0 && (
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">Type DELETE to confirm</label>
              <input
                value={bulkDeleteConfirmText}
                onChange={(e) => setBulkDeleteConfirmText(e.target.value)}
                placeholder="DELETE"
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white outline-none focus:ring-2 focus:ring-red-500"
              />
            </div>
          )}

          {bulkDeleteMutation.isError && <p className="text-sm text-red-600">{(bulkDeleteMutation.error as Error).message}</p>}

          <button
            onClick={() => bulkDeleteMutation.mutate()}
            disabled={bulkDeleteMutation.isPending || bulkDeleteCount === 0 || bulkDeleteConfirmText !== 'DELETE'}
            className="w-full flex items-center justify-center gap-2 bg-red-600 hover:bg-red-700 text-white font-medium py-2.5 rounded-lg transition disabled:opacity-50"
          >
            {bulkDeleteMutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
            {bulkDeleteMutation.isPending ? 'Deleting...' : bulkDeleteCount > 0 ? `Delete ${bulkDeleteCount} Site${bulkDeleteCount === 1 ? '' : 's'}` : 'Delete'}
          </button>
        </div>
      </Modal>

      {/* DETAILS DRAWER */}
      <Drawer
        open={!!drawerShop}
        onClose={() => setDrawerShopId(null)}
        title={drawerShop?.name || 'Shop'}
        subtitle={drawerShop ? [(drawerPo?.name || drawerPo?.po_number), STATUS_LABELS[drawerShop.status] || drawerShop.status].filter(Boolean).join(' · ') : undefined}
        width="lg"
      >
        {drawerShop && (
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <StatusBadge status={drawerShop.status} label={STATUS_LABELS[drawerShop.status]} />
              {canModify(drawerShop) ? (
                <div className="flex items-center gap-2">
                  <button onClick={() => { openEdit(drawerShop); setDrawerShopId(null); }} className="flex items-center gap-1 text-xs text-slate-500 hover:text-blue-600 px-2 py-1 border border-slate-200 rounded">
                    <Pencil className="w-3 h-3" /> Edit
                  </button>
                  <button onClick={() => { setDeleteTarget(drawerShop); setDrawerShopId(null); }} className="flex items-center gap-1 text-xs text-slate-500 hover:text-red-600 px-2 py-1 border border-slate-200 rounded">
                    <Trash2 className="w-3 h-3" /> Remove
                  </button>
                </div>
              ) : (
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
                            {wi.survey_width && wi.survey_height ? `${formatDim(wi.survey_width)}×${formatDim(wi.survey_height)} ${wi.survey_unit || ''}` : '—'}
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
