import { useState, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { Card, Select, Textarea, Input, EmptyState } from '@/components/ui';
import { logAudit, createNotification } from '@/lib/helpers';
import { submitCorrections, setAvailability } from '@/lib/reviewApi';
import { useRealtimeInvalidate } from '@/lib/useRealtimeInvalidate';
import { CameraCapture } from '@/components/CameraCapture';
import { formatDim, LENGTH_UNIT_OPTIONS, areaSqFt } from '@/lib/units';
import { useLiveLocationTracking } from '@/lib/locationTracking';
import { MarkedPhotoGrid } from '@/components/MarkedPhotoGrid';
import { computeImageHash, hammingDistance, DUPLICATE_HASH_THRESHOLD } from '@/lib/imageHash';
import { haversineDistanceMeters, GPS_DISTANCE_FLAG_METERS } from '@/lib/geoDistance';
import { reverseGeocode } from '@/lib/geocode';
import { stampGeoTag, ensureLandscape } from '@/lib/geoStamp';
import { computePOVariance } from '@/lib/poVariance';
import type { SurveyPhoto, BoardMarking, WorkItem, POWorkContext, POLineItemWorkContext } from '@/lib/types';
import {
  Home, Briefcase, MapPin, Bell, User, Camera, Navigation, CheckCircle2,
  ChevronLeft, AlertCircle, Map as MapIcon, Loader2, Wrench, Ruler, Package, X,
  Paintbrush, ClipboardList, ImagePlus, Trash2, PlusCircle,
} from 'lucide-react';
import { FieldMapView, NotificationsView, ProfileView, navigateToShop, AssignedShopList } from './SurveyorPage';

type MobileTab = 'home' | 'work' | 'map' | 'notifications' | 'profile';

const EXCEPTION_REASONS = [
  'Shop Closed', 'Owner Unavailable', 'Material Damaged', 'Wrong Material',
  'Site Problem', 'Permission Problem', 'Reschedule Required', 'Other',
];

// A shop is installable once production has actually finished and been
// approved — used both by "My Installations" to gate the Start button and
// by the wizard's own "today's queue" progress strip/next-job advance.
const READY_STATUSES = ['production_done', 'production_ready', 'dispatched', 'installation_pending', 'installing'];

export default function InstallerPage() {
  const { profile, signOut } = useAuth();
  const [tab, setTab] = useState<MobileTab>('home');
  const [activeJob, setActiveJob] = useState<string | null>(null);
  const [directInstallOpen, setDirectInstallOpen] = useState(false);

  if (activeJob) {
    return <InstallationWizard shopId={activeJob} onExit={(nextShopId) => setActiveJob(nextShopId || null)} />;
  }

  if (directInstallOpen) {
    return <DirectInstallWizard onExit={() => setDirectInstallOpen(false)} />;
  }

  return (
    <div className="min-h-screen bg-slate-50 pb-20 max-w-md mx-auto">
      {tab === 'home' && <InstallerHome onStart={(shopId) => setActiveJob(shopId)} onDirectInstall={() => setDirectInstallOpen(true)} />}
      {tab === 'work' && <InstallerWork onStart={(shopId) => setActiveJob(shopId)} />}
      {tab === 'map' && <FieldMapView />}
      {tab === 'notifications' && <NotificationsView />}
      {tab === 'profile' && <ProfileView onSignOut={signOut} />}

      <div className="fixed bottom-0 left-0 right-0 max-w-md mx-auto bg-white border-t border-slate-200 flex items-center justify-around py-2 px-2 z-40">
        <TabBtn icon={Home} label="Home" active={tab === 'home'} onClick={() => setTab('home')} />
        <TabBtn icon={Briefcase} label="My Work" active={tab === 'work'} onClick={() => setTab('work')} />
        <TabBtn icon={MapIcon} label="Map" active={tab === 'map'} onClick={() => setTab('map')} />
        <TabBtn icon={Bell} label="Alerts" active={tab === 'notifications'} onClick={() => setTab('notifications')} />
        <TabBtn icon={User} label="Profile" active={tab === 'profile'} onClick={() => setTab('profile')} />
      </div>
    </div>
  );
}

function TabBtn({ icon: Icon, label, active, onClick }: { icon: any; label: string; active: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} className={`flex flex-col items-center gap-1 px-3 py-1.5 rounded-lg transition ${active ? 'text-blue-600' : 'text-slate-400'}`}>
      <Icon className="w-5 h-5" />
      <span className="text-xs font-medium">{label}</span>
    </button>
  );
}

function InstallerHome({ onStart, onDirectInstall }: { onStart: (shopId: string) => void; onDirectInstall: () => void }) {
  const { profile } = useAuth();
  const orgId = profile?.organization_id;

  const { data: assignments } = useQuery({
    queryKey: ['installer-assignments', profile?.id],
    queryFn: async () => {
      const { data } = await supabase
        .from('shop_assignments')
        .select('*, shops(*, clients(name))')
        .eq('user_id', profile!.id)
        .eq('role', 'installer')
        .order('assigned_at', { ascending: false });
      return data;
    },
    enabled: !!profile?.id,
  });

  // Direct Install (migration 0077/0078) — how many active Work Orders
  // this specific installer has actually been ASSIGNED to via
  // po_assignments. Deliberately not "every active direct_install PO in
  // the org" any more — that showed every installer every Work Order
  // regardless of who the office actually meant it for. po_assignments
  // itself carries no money so it's readable by the installer role
  // (migration 0078); v_po_work_context supplies the non-financial PO
  // fields (RLS on purchase_orders itself is financial-role-only).
  const { data: directInstallPOs } = useQuery({
    queryKey: ['direct-install-pos', orgId, profile?.id],
    queryFn: async () => {
      const { data: myAssignments, error: assignError } = await supabase
        .from('po_assignments')
        .select('purchase_order_id')
        .eq('user_id', profile!.id)
        .eq('role', 'installer');
      if (assignError) { console.error('[InstallerHome] could not load Direct Install assignments:', assignError.message); return []; }
      const poIds = (myAssignments || []).map((a) => a.purchase_order_id);
      if (poIds.length === 0) return [];

      const { data, error } = await supabase
        .from('v_po_work_context')
        .select('id')
        .eq('organization_id', orgId)
        .eq('fulfillment_type', 'direct_install')
        .eq('status', 'active')
        .in('id', poIds);
      if (error) { console.error('[InstallerHome] could not load direct-install POs:', error.message); return []; }
      return data;
    },
    enabled: !!orgId && !!profile?.id,
  });

  // Previously this list only refreshed when the tab remounted (switching
  // away and back). An installer newly assigned from Production's
  // "Completed" approval or from the Shop Detail page's "Assign Installer"
  // button would not see the job appear here — or the shop's status flip
  // to production_done and unlock "Start Install" — until they happened
  // to switch tabs. Same live-refresh pattern as the office-side queues.
  useRealtimeInvalidate(['shop_assignments', 'shops', 'installation_jobs', 'field_corrections'], orgId, [['installer-assignments', profile?.id], ['installer-open-corrections', profile?.id]]);
  useRealtimeInvalidate(['purchase_orders', 'po_assignments'], orgId, [['direct-install-pos', orgId, profile?.id]]);

  const assigned = (assignments || []).filter((a) => a.status !== 'completed').length;
  const completed = (assignments || []).filter((a) => a.status === 'completed').length;
  const pending = assigned;
  const nextJob = (assignments || []).find((a) => READY_STATUSES.includes(a.shops?.status || ''));
  const directInstallAvailable = (directInstallPOs || []).length > 0;

  return (
    <div className="p-4">
      <div className="mb-6">
        <h1 className="text-xl font-bold text-slate-900">Hello, {profile?.full_name?.split(' ')[0]}</h1>
        <p className="text-sm text-slate-500">Today's installations</p>
      </div>

      <div className="grid grid-cols-3 gap-3 mb-6">
        <Card className="p-3 text-center">
          <p className="text-2xl font-bold text-blue-600">{assigned}</p>
          <p className="text-xs text-slate-500">Assigned</p>
        </Card>
        <Card className="p-3 text-center">
          <p className="text-2xl font-bold text-amber-600">{pending}</p>
          <p className="text-xs text-slate-500">Pending</p>
        </Card>
        <Card className="p-3 text-center">
          <p className="text-2xl font-bold text-green-600">{completed}</p>
          <p className="text-xs text-slate-500">Done</p>
        </Card>
      </div>

      {nextJob ? (
        <button
          onClick={() => onStart(nextJob.shop_id)}
          className="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-4 rounded-xl text-lg shadow-lg transition flex items-center justify-center gap-2"
        >
          <Wrench className="w-5 h-5" /> START NEXT INSTALL
        </button>
      ) : (
        <Card className="p-6 text-center">
          <CheckCircle2 className="w-12 h-12 text-green-500 mx-auto mb-2" />
          <p className="text-slate-700 font-medium">All caught up!</p>
          <p className="text-sm text-slate-400">No pending installations</p>
        </Card>
      )}

      {nextJob && (
        <Card className="mt-4 p-4">
          <p className="text-xs text-slate-400 mb-1">NEXT JOB</p>
          <p className="font-semibold text-slate-900">{nextJob.shops?.name}</p>
          <p className="text-sm text-slate-500">{nextJob.shops?.clients?.name}</p>
          <p className="text-sm text-slate-500 flex items-center gap-1 mt-1">
            <MapPin className="w-3.5 h-3.5" /> {nextJob.shops?.city}
          </p>
        </Card>
      )}

      {/* Direct Install (migration 0077) — wall-painting / on-ground Work
          Orders with no shop list up front. No "Start" job is ever
          assigned for these; the ground crew picks the Work Order, paints
          a wall, and logs the site themselves, right from here. Only
          shown when there's actually an active Work Order of this type to
          log against, so an org that never uses this feature never sees it. */}
      {directInstallAvailable && (
        <button
          onClick={onDirectInstall}
          className="w-full mt-4 bg-amber-500 hover:bg-amber-600 text-white font-bold py-4 rounded-xl text-base shadow-lg transition flex items-center justify-center gap-2"
        >
          <Paintbrush className="w-5 h-5" /> LOG A DIRECT INSTALL SITE
        </button>
      )}
    </div>
  );
}

function InstallerWork({ onStart }: { onStart: (shopId: string) => void }) {
  const { profile } = useAuth();
  const orgId = profile?.organization_id;

  const { data: assignments } = useQuery({
    queryKey: ['installer-work', profile?.id],
    queryFn: async () => {
      const { data } = await supabase
        .from('shop_assignments')
        .select('*, shops(*, clients(name))')
        .eq('user_id', profile!.id)
        .eq('role', 'installer')
        .order('assigned_at', { ascending: false });
      return data;
    },
    enabled: !!profile?.id,
  });

  useRealtimeInvalidate(['shop_assignments', 'shops', 'installation_jobs', 'field_corrections'], orgId, [['installer-work', profile?.id], ['installer-open-corrections', profile?.id]]);

  const shopIds = (assignments || []).map((a) => a.shop_id);

  // Open redo tasks are authoritative. A shop can be in installation_review and
  // still must immediately re-open for this installer when Owner/Admin sends a
  // specific Work Item back. Do not rely on shop status alone.
  const { data: openCorrections = [] } = useQuery({
    queryKey: ['installer-open-corrections', profile?.id],
    queryFn: async () => {
      const { data, error } = await supabase.from('field_corrections')
        .select('id,shop_id,work_item_id,installation_proof_id,issue_type,note,created_at')
        .eq('stage','installation').eq('assigned_to',profile!.id).eq('status','open')
        .order('created_at',{ascending:false});
      if (error && /field_corrections|schema cache/i.test(error.message||'')) return [];
      if (error) throw error; return data || [];
    }, enabled: !!profile?.id,
  });
  const correctionsByShop = new Map<string, any[]>();
  for (const c of openCorrections as any[]) correctionsByShop.set(c.shop_id,[...(correctionsByShop.get(c.shop_id)||[]),c]);

  // What to bring, per shop — pulled straight from the Owner/Admin-approved
  // work items (approved_* columns, set when the survey was approved), so
  // an installer can see materials/quantities/measurements right on the
  // job list before ever opening a job, without anyone re-typing them.
  const { data: approvedItems } = useQuery({
    queryKey: ['installer-work-approved-items', shopIds.join(',')],
    queryFn: async () => {
      if (shopIds.length === 0) return [] as WorkItem[];
      const { data } = await supabase.from('work_items').select('*').in('shop_id', shopIds).not('approved_width', 'is', null);
      return (data || []) as WorkItem[];
    },
    enabled: shopIds.length > 0,
  });

  // A shop only becomes installable once production has actually been
  // approved as completed — same statuses InstallerHome already uses to
  // pick "next job". Previously this tab let "Start Install" fire for any
  // assigned shop regardless of stage (survey-only, mid-design, whatever),
  // which is exactly the "skips approval" gap — a shop with no completed
  // production could get an installation job. The database now rejects
  // that insert too (migration 0010), but gating it here means the
  // installer sees why up front instead of an error after tapping in.

  return (
    <div className="p-4">
      <h1 className="text-xl font-bold text-slate-900 mb-4">My Installations</h1>
      <AssignedShopList
        assignments={assignments || []}
        getButtonState={(a) => {
          const shopStatus = a.shops?.status || 'pending';
          const redo = correctionsByShop.get(a.shop_id) || [];
          const isInstalled = shopStatus === 'installed';
          const isAwaitingApproval = shopStatus === 'installation_review';
          const isReady = READY_STATUSES.includes(shopStatus);
          if (redo.length) return { label: `Fix Redo (${redo.length})`, disabled: false };
          if (isInstalled) return { label: 'Installed', disabled: true, done: true };
          if (isAwaitingApproval) return { label: 'Awaiting Approval', disabled: true };
          if (!isReady) return { label: 'Not Ready Yet', disabled: true };
          return { label: 'Start Install', disabled: false };
        }}
        onStart={onStart}
        emptyLabel="No installations assigned"
        renderExtra={(a) => { const redo=correctionsByShop.get(a.shop_id)||[]; if(!redo.length)return null; return <div className="mt-2 rounded-xl border border-amber-300 bg-amber-50 p-2.5"><p className="text-xs font-bold text-amber-900">Redo requested · {redo.length} item{redo.length===1?'':'s'}</p><p className="text-[11px] text-amber-700 mt-0.5">Open this shop to fix only the Work Item(s) returned by Owner/Admin.</p>{redo.slice(0,2).map((c:any)=><p key={c.id} className="text-[11px] text-amber-800 mt-1">• {c.note||'Installation evidence needs correction'}</p>)}</div> }}
      />
    </div>
  );
}

// Compact "what to bring" summary shown right on the job card — approved
// material, dimensions, and quantity, exactly as Owner/Admin approved it
// during survey review. Lets an installer plan what to load in the van
// before they even tap into a job.
function MaterialsToBring({ items }: { items: WorkItem[] }) {
  if (items.length === 0) return null;
  return (
    <div className="bg-slate-50 border border-slate-200 rounded-lg p-2.5 mb-3">
      <p className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide flex items-center gap-1 mb-1.5">
        <Package className="w-3.5 h-3.5" /> Materials to Bring
      </p>
      <div className="space-y-1">
        {items.map((it) => (
          <div key={it.id} className="flex items-center justify-between text-xs text-slate-700">
            <span className="truncate pr-2">
              {it.material || it.work_type_name || 'Item'}
              {it.approved_width && it.approved_height ? ` — ${formatDim(it.approved_width)}×${formatDim(it.approved_height)} ${it.approved_unit || ''}` : ''}
            </span>
            <span className="font-semibold text-slate-900 shrink-0">×{it.approved_quantity || 1}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function InstallationWizard({ shopId, onExit }: { shopId: string; onExit: (nextShopId?: string) => void }) {
  const { profile } = useAuth();
  const queryClient = useQueryClient();
  const [step, setStep] = useState(1);
  // Vehicle/Load Check (Architecture v2.0 §3.2 gap item / §9.4 Step 2) — a
  // DB trigger (migration 0044) already refuses to let this job reach
  // 'completed'/'exception' unless material_check_confirmed = true. This
  // is the loading register: for every approved board, the installer
  // enters the actual QUANTITY physically loaded onto the vehicle (not
  // just a yes/no tick) — pre-filled with the approved quantity but
  // editable, so a genuine partial load (e.g. one board left behind for a
  // second trip) is recorded honestly instead of forced to match. This
  // is what lets Owner/Admin later see produced vs loaded vs approved
  // side by side on Installation Review, not just "installer said ready."
  const [materialLoadedQty, setMaterialLoadedQty] = useState<Record<string, string>>({});
  const [materialCheckConfirmed, setMaterialCheckConfirmed] = useState(false);
  const [materialCheckSaving, setMaterialCheckSaving] = useState(false);
  const [proofPhotos, setProofPhotos] = useState<{ id?: string; storagePath?: string; url: string; type: string; angle: 'front' | 'side' | 'other'; workItemId?: string }[]>([]);
  const [bulkGalleryFiles, setBulkGalleryFiles] = useState<File[]>([]);
  const [bulkGalleryMap, setBulkGalleryMap] = useState<Record<number, string>>({});
  const [bulkUploading, setBulkUploading] = useState(false);
  // No manual measurement entry anymore — installed_* is auto-copied from
  // the Owner/Admin-approved work item specs at submit time. Only a free
  // text note is still collected, in case the installer wants to flag
  // something for the reviewer.
  const [installNotes, setInstallNotes] = useState('');
  const [gps, setGps] = useState<{ lat: number; lng: number; accuracy: number } | null>(null);
  const [gpsStatus, setGpsStatus] = useState<'idle' | 'capturing' | 'captured' | 'denied'>('idle');
  const [exception, setException] = useState<string | null>(null);
  const [exceptionNote, setExceptionNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [cameraFor, setCameraFor] = useState<string | null>(null);
  const [selectedProofWorkItemId, setSelectedProofWorkItemId] = useState('');
  const [expandedInstallItemId, setExpandedInstallItemId] = useState<string | null>(null);
  const [jobBlockedReason, setJobBlockedReason] = useState<string | null>(null);
  const [unavail, setUnavail] = useState<{ item: WorkItem; reason: string; note: string; file: File | null } | null>(null);
  const [unavailBusy, setUnavailBusy] = useState(false);

  // Live location sharing while this installation is in progress — pinged
  // to worker_locations so the Owner/Admin Live Field Map shows the
  // installer moving in real time, same as the surveyor flow.
  useLiveLocationTracking(true, profile?.id, profile?.organization_id);

  const { data: correctionTasks } = useQuery({
    queryKey: ['installation-field-corrections', shopId, profile?.id],
    queryFn: async () => { const { data, error } = await supabase.from('field_corrections').select('id, issue_type, note, work_item_id, installation_proof_id, created_at').eq('shop_id', shopId).eq('stage', 'installation').eq('assigned_to', profile!.id).eq('status', 'open').order('created_at'); if (error && /field_corrections|schema cache/i.test(error.message||'')) return []; if (error) throw error; return data || []; },
    enabled: !!shopId && !!profile?.id,
  });

  const { data: shop } = useQuery({
    queryKey: ['shop', shopId],
    queryFn: async () => {
      const { data } = await supabase.from('shops').select('*, clients(name)').eq('id', shopId).maybeSingle();
      return data;
    },
  });

  // §9.4 Step 6 — "today's queue" progress strip + auto-advance to the
  // next job on submit. Same query key as "My Installations" (shares its
  // cache), filtered to the same READY_STATUSES gate that screen already
  // uses to decide what's actually startable right now.
  const { data: pendingJobAssignments } = useQuery({
    queryKey: ['installer-work', profile?.id],
    queryFn: async () => {
      const { data } = await supabase
        .from('shop_assignments')
        .select('shop_id, shops(status)')
        .eq('user_id', profile!.id)
        .eq('role', 'installer')
        .order('assigned_at', { ascending: false });
      return (data || []) as unknown as { shop_id: string; shops: { status: string | null } | null }[];
    },
    enabled: !!profile?.id,
  });
  const correctionShopIds = new Set((correctionTasks || []).map((c:any)=>shopId));
  const pendingJobQueue = (pendingJobAssignments || []).filter((a) => READY_STATUSES.includes(a.shops?.status || '') || correctionShopIds.has(a.shop_id));
  const jobQueuePosition = pendingJobQueue.findIndex((a) => a.shop_id === shopId);
  const jobQueueTotal = pendingJobQueue.length;
  const nextJobShopId = jobQueuePosition >= 0 ? pendingJobQueue.find((a, i) => i !== jobQueuePosition)?.shop_id : undefined;

  const { data: workItems } = useQuery({
    queryKey: ['shop-work-items-install', shopId],
    queryFn: async () => {
      const { data } = await supabase.from('work_items').select('*').eq('shop_id', shopId).order('created_at');
      return data as WorkItem[] | null;
    },
  });

  // Approved items only — these carry the exact width/height/material/
  // quantity an Owner/Admin signed off on when the survey was reviewed.
  const approvedItems = (workItems || []).filter((it) => it.approved_width != null && it.approved_height != null);
  const installableItems = approvedItems.filter((it) => !it.excluded_from_calculations && (it.execution_state || 'active') === 'active');
  const unavailableItems = approvedItems.filter((it) => it.excluded_from_calculations || (it.execution_state && it.execution_state !== 'active'));

  async function markItemAvailability(item: WorkItem, unavailable: boolean) {
    if (!profile) return;
    if (!unavailable) {
      try { await setAvailability(item.id, false, null, null); } catch (e: any) { alert(e.message); return; }
      await queryClient.invalidateQueries({ queryKey: ['shop-work-items-install', shopId] });
      await queryClient.invalidateQueries({ queryKey: ['shop-work-items', shopId] });
      return;
    }
    setUnavail({ item, reason: item.execution_reason || '', note: item.execution_note || '', file: null });
  }

  async function saveUnavailable() {
    if (!unavail) return;
    const { item, reason, note, file } = unavail;
    if (!reason.trim()) { alert('Reason likhna zaroori hai.'); return; }
    if (!file) { alert('Site ki photo zaroori hai.'); return; }
    setUnavailBusy(true);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = () => reject(r.error); r.readAsDataURL(file); });
      await handlePhotoCaptured(dataUrl, file.name, 'other', item.id, `NOT INSTALLED: ${reason.trim()}`);
      await setAvailability(item.id, true, reason.trim(), note.trim() || null);
      if (selectedProofWorkItemId === item.id) setSelectedProofWorkItemId('');
      setUnavail(null);
      await queryClient.invalidateQueries({ queryKey: ['shop-work-items-install', shopId] });
      await queryClient.invalidateQueries({ queryKey: ['shop-work-items', shopId] });
    } catch (e: any) { alert(`Could not mark not available: ${e?.message || e}`); } finally { setUnavailBusy(false); }
  }

  // Phase 8 — the Production-side Vehicle Load record for this shop, if
  // Production already loaded it for this installer (migration 0062).
  // When it exists, the loading register below is pre-filled from what
  // Production actually loaded — not re-typed from scratch — and the
  // installer is confirming/correcting Production's numbers instead of
  // declaring them cold.
  const { data: vehicleLoad } = useQuery({
    queryKey: ['installer-vehicle-load', shopId, profile?.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('vehicle_loads')
        .select('*, vehicle_load_items(*)')
        .eq('shop_id', shopId)
        .eq('installer_id', profile!.id)
        .neq('status', 'cancelled')
        .order('loaded_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) { console.error('[InstallationWizard] could not load vehicle load:', error.message); return null; }
      return data as (import('@/lib/types').VehicleLoad & { vehicle_load_items: import('@/lib/types').VehicleLoadItem[] }) | null;
    },
    enabled: !!shopId && !!profile?.id,
  });

  // Pre-fill the loading register with each board's approved quantity as
  // soon as the items load, so the common case (everything loaded as
  // approved) is zero-typing — the installer only has to edit a field if
  // an actual partial load happened. If Production already recorded a
  // vehicle load for this shop, that takes priority over the approved
  // quantity — it's what was actually physically loaded, which is the
  // whole point of this register.
  useEffect(() => {
    if (approvedItems.length === 0) return;
    const loadedByItem = new Map((vehicleLoad?.vehicle_load_items || []).map((li) => [li.work_item_id, li.qty_loaded]));
    setMaterialLoadedQty((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const it of approvedItems) {
        const fromVehicleLoad = loadedByItem.get(it.id);
        if (fromVehicleLoad !== undefined) {
          // Vehicle load data always wins once it exists, even if the
          // installer had an earlier self-typed value cached — Production's
          // record is the source of truth for what left the workshop.
          if (next[it.id] !== String(fromVehicleLoad)) { next[it.id] = String(fromVehicleLoad); changed = true; }
        } else if (next[it.id] === undefined) {
          next[it.id] = String(it.approved_quantity ?? 1);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workItems, vehicleLoad]);

  // The marked-up survey photos (same "what to install where" marks the
  // Owner/Admin saw on Survey Review) so the installer sees exactly the
  // approved scene instead of re-deriving it on site.
  //
  // Fetched by shop_id (not by picking a single work item's survey_id) —
  // same pattern the agency-side Shop Detail screen (ShopsPages.tsx)
  // already uses. A shop can have more than one survey behind it (a
  // re-survey, or boards added across separate visits), and picking just
  // the first work item's survey_id silently dropped every photo/marking
  // that belonged to any other survey for that shop. Going by shop_id
  // instead means every marked photo for this shop shows up here,
  // regardless of which survey it came from.
  const { data: surveyPhotos } = useQuery({
    queryKey: ['install-survey-photos', shopId],
    queryFn: async () => {
      const { data } = await supabase.from('survey_photos').select('*').eq('shop_id', shopId).order('created_at');
      return data as SurveyPhoto[];
    },
    enabled: !!shopId,
  });

  const { data: boardMarkings } = useQuery({
    queryKey: ['install-board-markings', shopId, (surveyPhotos || []).map((p) => p.id).join(',')],
    queryFn: async () => {
      const photoIds = (surveyPhotos || []).map((p) => p.id);
      if (photoIds.length === 0) return [] as BoardMarking[];
      const { data } = await supabase.from('board_markings').select('*').in('survey_photo_id', photoIds);
      return data as BoardMarking[];
    },
    enabled: !!surveyPhotos,
  });


  // Explicit Survey Photo -> Work Item links. Older deployments may not yet
  // have this relation, so board_markings.work_item_id remains a compatible
  // fallback for deciding which approved reference photo belongs to an item.
  const { data: surveyPhotoItemLinks } = useQuery({
    queryKey: ['install-survey-photo-items', shopId, (surveyPhotos || []).map((p) => p.id).join(',')],
    queryFn: async () => {
      const photoIds = (surveyPhotos || []).map((p) => p.id);
      if (photoIds.length === 0) return [] as { survey_photo_id: string; work_item_id: string }[];
      const { data, error } = await supabase.from('survey_photo_items').select('survey_photo_id,work_item_id').in('survey_photo_id', photoIds);
      if (error) {
        if (/survey_photo_items|schema cache|could not find the table/i.test(error.message || '')) return [];
        throw error;
      }
      return (data || []) as { survey_photo_id: string; work_item_id: string }[];
    },
    enabled: !!surveyPhotos,
  });

  // Create installation job on mount
  useEffect(() => {
    async function createJob() {
      if (!profile || !shop || jobId) return;
      const existing = await supabase.from('installation_jobs').select('id').eq('shop_id', shopId).eq('installer_id', profile.id).order('created_at', { ascending: false }).limit(1);
      if (existing.data && existing.data.length) { setJobId(existing.data[0].id); return; }
      const { data, error } = await supabase.from('installation_jobs').insert({
        organization_id: profile.organization_id,
        shop_id: shopId,
        installer_id: profile.id,
        status: 'started',
        started_at: new Date().toISOString(),
      }).select().single();
      if (data) setJobId(data.id);
      else if (error) {
        // The database itself now refuses to start a job before production
        // is actually completed and approved (migration 0010) — surface
        // that clearly instead of leaving the installer stuck on a blank
        // step with only a console error to go on.
        console.error('[InstallationWizard] could not create installation job:', error.message);
        setJobBlockedReason(error.message);
      }
    }
    createJob();
  }, [profile, shop, shopId, jobId]);

  // Resume an interrupted shop exactly from persisted server evidence.
  // Photos are uploaded immediately, so switching to another shop never
  // discards completed captures. When this shop is opened again, reload the
  // proof rows and their Work Item mappings instead of starting with an empty
  // in-memory photo list.
  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from('installation_proofs')
        .select('id,storage_path,photo_url,photo_type,angle,work_item_id')
        .eq('installation_job_id', jobId)
        .order('captured_at');
      if (cancelled) return;
      if (error) {
        // work_item_id may be absent on an older schema cache; retry legacy.
        if (/work_item_id|schema cache|column/i.test(error.message || '')) {
          const legacy = await supabase.from('installation_proofs').select('id,storage_path,photo_url,photo_type,angle').eq('installation_job_id', jobId).order('captured_at');
          if (!cancelled && !legacy.error) setProofPhotos((legacy.data || []).map((p: any) => ({ id: p.id, storagePath: p.storage_path, url: p.photo_url, type: p.photo_type || 'installed', angle: p.angle || 'other' })));
        }
        return;
      }
      setProofPhotos((data || []).map((p: any) => ({ id: p.id, storagePath: p.storage_path, url: p.photo_url, type: p.photo_type || 'installed', angle: p.angle || 'other', workItemId: p.work_item_id || undefined })));
    })();
    return () => { cancelled = true; };
  }, [jobId]);

  // Lightweight per-shop UI draft. Uploaded photos themselves live in
  // Supabase (above); this only restores where the installer was in the UI.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(`adroute-install-draft:${shopId}`);
      if (!raw) return;
      const d = JSON.parse(raw);
      if (d.step === 1 || d.step === 4) setStep(d.step);
      if (typeof d.expandedInstallItemId === 'string') setExpandedInstallItemId(d.expandedInstallItemId);
      if (typeof d.selectedProofWorkItemId === 'string') setSelectedProofWorkItemId(d.selectedProofWorkItemId);
      if (typeof d.installNotes === 'string') setInstallNotes(d.installNotes);
    } catch { /* ignore a damaged local draft */ }
  }, [shopId]);

  useEffect(() => {
    try { localStorage.setItem(`adroute-install-draft:${shopId}`, JSON.stringify({ step, expandedInstallItemId, selectedProofWorkItemId, installNotes })); } catch { /* storage unavailable */ }
  }, [shopId, step, expandedInstallItemId, selectedProofWorkItemId, installNotes]);

  // GPS
  useEffect(() => {
    if (gpsStatus === 'idle') {
      setGpsStatus('capturing');
      navigator.geolocation.getCurrentPosition(
        (pos) => { setGps({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy }); setGpsStatus('captured'); },
        () => setGpsStatus('denied'),
        { enableHighAccuracy: true, timeout: 10000 }
      );
    }
  }, [gpsStatus]);

  // Writes the load-check gate straight to installation_jobs as soon as
  // the installer confirms it — deliberately not deferred to
  // completeInstallation(), so "who ticked it, when" (materials
  // physically loaded, at departure) stays honest even if the actual
  // install happens hours later.
  async function confirmMaterialCheck() {
    if (!jobId || !profile) return;
    setMaterialCheckSaving(true);
    try {
      // Item-level loading record — work_type/material name kept alongside
      // the quantities so Owner/Admin can read the reconciliation on
      // Installation Review without a separate work_items join for
      // display purposes (the ids are still there for anything that does
      // need the join).
      const loadingRecord = approvedItems.map((it) => ({
        work_item_id: it.id,
        work_type_name: it.work_type_name || it.material || 'Item',
        approved_quantity: it.approved_quantity ?? 1,
        loaded_quantity: parseFloat(materialLoadedQty[it.id]) || 0,
      }));
      const { error } = await supabase.from('installation_jobs').update({
        material_check_confirmed: true,
        material_check_confirmed_by: profile.id,
        material_check_confirmed_at: new Date().toISOString(),
        material_check_items: loadingRecord,
        vehicle_load_id: vehicleLoad?.id ?? null,
      }).eq('id', jobId).select('id');
      if (error) throw new Error(error.message);
      setMaterialCheckConfirmed(true);
      setStep(3);
    } catch (err: any) {
      console.error('[confirmMaterialCheck] failed:', err);
      alert(`Could not save the material check: ${err?.message || 'Unknown error'}. Please try again.`);
    } finally {
      setMaterialCheckSaving(false);
    }
  }

  async function handlePhotoCaptured(dataUrl: string, fileName: string, forcedAngle?: 'front' | 'side' | 'other', explicitWorkItemId?: string, caption?: string) {
    // cameraFor doubles as the angle here ('front' / 'side' / 'other') —
    // photo_type stays the constant 'installed' (matches the existing
    // check constraint); angle is the new, separate column that Section 7
    // actually needs the multi-angle requirement enforced against.
    const angle = forcedAngle || (cameraFor as 'front' | 'side' | 'other' | null);
    if (!forcedAngle) setCameraFor(null);
    if (!angle || !profile || !jobId) return;

    // Geo-tag stamp burned onto the photo itself (site name, address,
    // lat/long, timestamp) — real proof of where/when this was actually
    // taken, visible everywhere this photo is ever shown or exported, not
    // just a lat/lng column that only some screens bother to read.
    // Falls back to the plain photo if stamping fails for any reason —
    // never blocks a real installation photo from uploading.
    let uploadDataUrl = dataUrl;
    try {
      uploadDataUrl = await ensureLandscape(dataUrl);
      uploadDataUrl = await stampGeoTag(uploadDataUrl, {
        siteName: shop?.name,
        addressLine: [shop?.address, shop?.city, shop?.state].filter(Boolean).join(', ') || null,
        lat: shop?.latitude ?? null,
        lng: shop?.longitude ?? null,
        accuracy: null,
      });
    } catch (stampErr) {
      console.error('[handlePhotoCaptured] geo-tag stamp failed (non-fatal, uploading unstamped):', stampErr);
    }

    const res = await fetch(uploadDataUrl);
    const blob = await res.blob();
    const file = new File([blob], fileName, { type: blob.type });
    const path = `${profile.organization_id}/${jobId}/installed-${angle}-${Date.now()}-${fileName}`;
    const { error } = await supabase.storage.from('installation-proof').upload(path, file);
    if (error) { alert('Upload failed: ' + error.message); return; }
    const { data: urlData } = supabase.storage.from('installation-proof').getPublicUrl(path);

    // Section 7 — perceptual hash + duplicate-across-shops check. Hashed
    // from the ORIGINAL (pre-stamp) photo, not the geo-tagged upload — the
    // stamp's timestamp/address text is different on every capture by
    // definition, which would poison the perceptual hash and make a truly
    // reused photo look unique. Never blocks the upload; only flags the
    // row (and pings Admin/Owner) so a reused photo is visible at
    // Installation Review, not silently accepted. Wrapped defensively — a
    // hashing failure should never stop an installer from submitting real
    // work.
    let phash: string | null = null;
    let duplicateFlag = false;
    let duplicateOf: string | null = null;
    try {
      phash = await computeImageHash(dataUrl);
      if (phash) {
        const { data: existingHashes } = await supabase

          .from('installation_proofs')
          .select('id, phash, shop_id')
          .eq('organization_id', profile.organization_id)
          .not('phash', 'is', null)
          .neq('shop_id', shopId)
          .limit(500);
        for (const candidate of existingHashes || []) {
          if (candidate.phash && hammingDistance(phash, candidate.phash) <= DUPLICATE_HASH_THRESHOLD) {
            duplicateFlag = true;
            duplicateOf = candidate.id;
            break;
          }
        }
      }
    } catch (hashErr) {
      console.error('[handlePhotoCaptured] duplicate-hash check failed (non-fatal):', hashErr);
    }

    const proofPayload: any = {
      organization_id: profile.organization_id,
      installation_job_id: jobId,
      shop_id: shopId,
      storage_path: path,
      photo_url: urlData.publicUrl,
      photo_type: 'installed',
      caption: caption || null,
      work_item_id: explicitWorkItemId || selectedProofWorkItemId || (approvedItems.length === 1 ? approvedItems[0].id : null),
      angle,
      phash,
      duplicate_flag: duplicateFlag,
      duplicate_of: duplicateOf,
      gps_lat: gps?.lat || null,
      gps_lng: gps?.lng || null,
      gps_accuracy: gps?.accuracy || null,
    };
    let insertResult = await supabase.from('installation_proofs').insert(proofPayload).select('id').single();
    // Compatibility with deployments where the work_item_id migration has not
    // reached PostgREST's schema cache yet. The proof itself must never be lost.
    if (insertResult.error && /work_item_id|schema cache|column/i.test(insertResult.error.message || '')) {
      const { work_item_id: _ignored, ...legacyPayload } = proofPayload;
      insertResult = await supabase.from('installation_proofs').insert(legacyPayload).select('id').single();
    }
    if (insertResult.error) {
      await supabase.storage.from('installation-proof').remove([path]);
      throw new Error(`Could not save installation photo: ${insertResult.error.message}`);
    }
    const inserted = insertResult.data;

    if (duplicateFlag && inserted) {
      const { data: admins } = await supabase.from('profiles').select('id').eq('organization_id', profile.organization_id).in('role', ['agency_owner', 'admin']);
      for (const admin of admins || []) {
        await createNotification(admin.id, 'Duplicate Installation Photo Suspected', `An installation photo for ${shop?.name || 'a shop'} looks like it may have been reused from another site — review before approving.`, 'warning', '/installation-review');
      }
    }

    setProofPhotos((current) => [...current, { id: inserted?.id, storagePath: path, url: urlData.publicUrl, type: 'installed', angle, workItemId: explicitWorkItemId || selectedProofWorkItemId || (approvedItems.length === 1 ? approvedItems[0].id : undefined) }]);
  }


  async function handleInstallationFileSelection(files: FileList | null, explicitWorkItemId?: string) {
    if (!files?.length) return;
    const targetWorkItemId = explicitWorkItemId || selectedProofWorkItemId;
    if (approvedItems.length > 1 && !targetWorkItemId) {
      alert('Select the exact work item / measurement before uploading photos.');
      return;
    }
    const selected = Array.from(files);
    let uploaded = 0;
    const failures: string[] = [];
    for (const file of selected) {
      try {
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(reader.error || new Error('Could not read file'));
          reader.readAsDataURL(file);
        });
        if (targetWorkItemId) setSelectedProofWorkItemId(targetWorkItemId);
        await handlePhotoCaptured(dataUrl, file.name, 'other', targetWorkItemId);
        uploaded += 1;
      } catch (err: any) {
        failures.push(`${file.name}: ${err?.message || 'Upload failed'}`);
      }
    }
    if (failures.length) alert(`${uploaded} of ${selected.length} photos uploaded.\n${failures.join('\n')}`);
  }

  async function deleteInstallationPhoto(photo: { id?: string; storagePath?: string; url: string }) {
    if (!window.confirm('Delete this installation photo? This will not delete the work item.')) return;
    try {
      if (photo.id) {
        const { error } = await supabase.from('installation_proofs').delete().eq('id', photo.id);
        if (error) throw error;
      } else if (photo.storagePath) {
        const { error } = await supabase.from('installation_proofs').delete().eq('storage_path', photo.storagePath);
        if (error) throw error;
      }
      if (photo.storagePath) await supabase.storage.from('installation-proof').remove([photo.storagePath]);
      setProofPhotos((current) => current.filter((p) => p !== photo));
    } catch (err: any) {
      alert(`Could not delete photo: ${err?.message || 'Unknown error'}`);
    }
  }

  async function uploadMappedGallery() {
    if (!bulkGalleryFiles.length) return;
    const missing = bulkGalleryFiles.findIndex((_, i) => !bulkGalleryMap[i]);
    if (missing >= 0) { alert(`Choose a work item for photo ${missing + 1}.`); return; }
    setBulkUploading(true);
    const failures: string[] = [];
    let uploaded = 0;
    for (let i = 0; i < bulkGalleryFiles.length; i++) {
      const file = bulkGalleryFiles[i];
      try {
        const list = { 0: file, length: 1, item: () => file } as unknown as FileList;
        await handleInstallationFileSelection(list, bulkGalleryMap[i]);
        uploaded++;
      } catch (err: any) { failures.push(`${file.name}: ${err?.message || 'Upload failed'}`); }
    }
    setBulkUploading(false);
    if (uploaded === bulkGalleryFiles.length) { setBulkGalleryFiles([]); setBulkGalleryMap({}); }
    if (failures.length) alert(`${uploaded} of ${bulkGalleryFiles.length} photos uploaded.\n${failures.join('\n')}`);
  }


  async function completeInstallation() {
    if (!profile || !jobId || !shop) return;
    setSubmitting(true);
    try {
      // Every write below is now checked — previously an unchecked failure
      // here (e.g. on the installation_jobs update) could still let the
      // shop flip to 'installed' and show "Complete!" to the installer,
      // while the actual job record never reflected it, breaking Reports
      // and the shop Timeline.
      // Installed specs are copied straight from what Owner/Admin already
      // approved — the installer never types width/height/quantity in.
      if (!exception) {
        for (const item of installableItems) {
          const w = item.approved_width!;
          const h = item.approved_height!;
          const qty = item.approved_quantity || 1;
          const { error: itemError } = await supabase.from('work_items').update({
            installed_width: w,
            installed_height: h,
            installed_unit: item.approved_unit,
            installed_quantity: qty,
            installed_area: item.approved_area ?? Math.round(areaSqFt(w, item.approved_unit || 'ft', h, item.approved_unit || 'ft') * qty * 100) / 100,
            installed_notes: installNotes || item.approved_notes || null,
            installed_at: new Date().toISOString(),
            status: 'installed',
          }).eq('id', item.id).select('id');
          if (itemError) throw new Error(`Could not update work item: ${itemError.message}`);
        }
      }

      // Section 7 — flag (never block) an install whose captured GPS is
      // implausibly far from the shop's stored lat/long. Only computed
      // when both points are actually known.
      let gpsDistanceMeters: number | null = null;
      let gpsDistanceFlag = false;
      if (gps && shop?.latitude != null && shop?.longitude != null) {
        gpsDistanceMeters = haversineDistanceMeters(gps.lat, gps.lng, shop.latitude, shop.longitude);
        gpsDistanceFlag = gpsDistanceMeters > GPS_DISTANCE_FLAG_METERS;
      }

      // Update job
      const { error: jobError } = await supabase.from('installation_jobs').update({
        status: exception ? 'exception' : 'completed',
        gps_lat: gps?.lat || null,
        gps_lng: gps?.lng || null,
        gps_accuracy: gps?.accuracy || null,
        gps_captured_at: new Date().toISOString(),
        gps_distance_meters: gpsDistanceMeters,
        gps_distance_flag: gpsDistanceFlag,
        completed_at: new Date().toISOString(),
        exception_reason: exception,
        exception_note: exceptionNote || null,
        // A fresh (re)submission always resets the review to 'pending' —
        // matters for the redo case, where an Owner/Admin rejected a
        // previous attempt and the installer is reusing the same job row.
        review_status: exception ? 'not_applicable' : 'pending',
        material_check_confirmed: true,
        material_check_confirmed_by: profile.id,
        material_check_confirmed_at: new Date().toISOString(),
        reviewed_by: null,
        reviewed_at: null,
        review_note: null,
      }).eq('id', jobId).select('id');
      if (jobError) throw new Error(`Could not update installation job: ${jobError.message}`);

      // Update shop. A successful (non-exception) install no longer jumps
      // straight to 'installed' — it goes to 'installation_review' and
      // waits for an Owner/Admin to approve it on the Installation Review
      // page (mirrors how Survey/Design/Production already require
      // approval before moving on). Only that approval — never this
      // write — can set the shop to 'installed', enforced in the database
      // by migration 0014's trigger.
      const { error: shopError } = await supabase.from('shops').update({ status: exception ? 'installation_pending' : 'installation_review' }).eq('id', shopId).select('id');
      if (shopError) throw new Error(`Could not update shop status: ${shopError.message}`);

      // Update assignment
      const { error: assignError } = await supabase.from('shop_assignments').update({ status: 'completed', completed_at: new Date().toISOString() }).eq('shop_id', shopId).eq('user_id', profile.id).eq('role', 'installer').select('id');
      if (assignError) console.error('[completeInstallation] could not update assignment:', assignError.message);

      await logAudit('installation_jobs', jobId, 'complete', null, null, null, `Installation ${exception ? 'with exception' : 'completed'} for ${shop.name}`);

      // Notify admins
      const { data: admins } = await supabase.from('profiles').select('id').eq('organization_id', profile.organization_id).in('role', ['agency_owner', 'admin']);
      if (admins) {
        for (const a of admins) {
          await createNotification(
            a.id,
            exception ? 'Installation Exception' : 'Installation Awaiting Approval',
            exception
              ? `Installation reported with exception for ${shop.name}`
              : `Installation for ${shop.name} is complete and waiting for your approval`,
            'info',
            '/installation-review'
          );
        }
        // Section 7 — separate, explicit heads-up when GPS looks
        // implausible, so it doesn't get lost in the generic "awaiting
        // approval" notification above.
        if (gpsDistanceFlag && gpsDistanceMeters != null) {
          for (const a of admins) {
            await createNotification(
              a.id,
              'Installation GPS Looks Off',
              `Installation for ${shop.name} was captured ~${Math.round(gpsDistanceMeters)}m from the shop's stored location — worth a look before approving.`,
              'warning',
              '/installation-review'
            );
          }
        }
      }

      if ((correctionTasks || []).length && !exception) {
        // atomic: marks corrections resubmitted, clears stale decisions, drops replaced photos, notifies reviewers
        await submitCorrections('installation', shopId);
      }
      queryClient.invalidateQueries();
      try { localStorage.removeItem(`adroute-install-draft:${shopId}`); } catch { /* ignore */ }
      setCompleted(true);
    } catch (err: any) {
      console.error('[completeInstallation] failed:', err);
      alert(`Failed to complete installation: ${err?.message || 'Unknown error'}. Nothing was marked done — please try again.`);
    } finally {
      setSubmitting(false);
    }
  }

  if (jobBlockedReason) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4 max-w-md mx-auto">
        <Card className="p-8 text-center">
          <AlertCircle className="w-16 h-16 text-amber-500 mx-auto mb-4" />
          <h2 className="text-xl font-bold text-slate-900 mb-2">Can't Start Yet</h2>
          <p className="text-sm text-slate-500 mb-6">{jobBlockedReason}</p>
          <button onClick={() => onExit()} className="w-full bg-slate-900 text-white font-medium py-3 rounded-lg">Back</button>
        </Card>
      </div>
    );
  }

  if (completed) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4 max-w-md mx-auto">
        <Card className="p-8 text-center">
          <CheckCircle2 className="w-16 h-16 text-green-500 mx-auto mb-4" />
          <h2 className="text-xl font-bold text-slate-900 mb-2">{exception ? 'Exception Reported' : 'Submitted for Approval'}</h2>
          <p className="text-sm text-slate-500 mb-6">
            {exception
              ? `Your exception for ${shop?.name} has been recorded. This job will come back to your list once it's ready to retry.`
              : `Installation for ${shop?.name} has been recorded and sent to your Admin/Owner for approval. It will show as Installed once approved.`}
          </p>
          <button onClick={() => onExit(nextJobShopId)} className="w-full bg-blue-600 text-white font-medium py-3 rounded-lg">
            {nextJobShopId ? 'Next Job' : 'Done'}
          </button>
          {nextJobShopId && (
            <button onClick={() => onExit()} className="w-full text-sm text-slate-500 font-medium py-2.5 mt-1">
              Done for now
            </button>
          )}
        </Card>
      </div>
    );
  }

  const steps = exception ? ['Shop', 'Photos', 'Exception'] : ['Shop', 'Photos', 'Review & Submit'];
  const visibleStep = step === 1 ? 1 : step === 3 ? 2 : 3;

  return (
    <div className="min-h-screen bg-slate-50 max-w-md mx-auto">
      <div className="bg-white border-b border-slate-200 sticky top-0 z-30">
        <div className="flex items-center justify-between p-4">
          <button onClick={() => onExit()} className="text-sm text-slate-500">Cancel</button>
          <p className="font-semibold text-slate-900">Step {visibleStep} of {steps.length}</p>
          <span className="text-xs text-slate-400">{steps[visibleStep - 1]}</span>
        </div>
        {jobQueuePosition >= 0 && jobQueueTotal > 0 && (
          <p className="px-4 pb-1 text-xs text-blue-600 font-medium">Job {jobQueuePosition + 1} of {jobQueueTotal} today</p>
        )}
        <div className="flex px-4 pb-3 gap-1">
          {steps.map((_, i) => (
            <div key={i} className={`h-1.5 flex-1 rounded-full ${i < visibleStep ? 'bg-blue-600' : 'bg-slate-200'}`} />
          ))}
        </div>
      </div>

      <CameraCapture
        open={!!cameraFor}
        onClose={() => setCameraFor(null)}
        onCapture={(dataUrl, fileName) => handlePhotoCaptured(dataUrl, fileName, undefined, selectedProofWorkItemId || undefined)}
        title={cameraFor ? `${cameraFor.charAt(0).toUpperCase()}${cameraFor.slice(1)} Photo` : 'Photo'}
      />

      {unavail && (
        <div className="fixed inset-0 z-[60] bg-black/60 flex items-end sm:items-center justify-center p-3">
          <div className="bg-white w-full max-w-md rounded-2xl p-4 space-y-3">
            <p className="font-bold text-slate-900">Install nahi hua — {unavail.item.work_type_name || unavail.item.material || 'work item'}</p>
            <p className="text-xs text-slate-500">Reason + site ki photo dein. Yeh kaam installed sq.ft / qty / billing me count nahi hoga, par history me reason aur photo dikhegi.</p>
            <select value={['Site renovation','Shop band / owner nahi mila','Permission nahi mili','Site pe jagah nahi / blocked','Kaam scope se hata diya'].includes(unavail.reason) ? unavail.reason : ''} onChange={(e) => setUnavail({ ...unavail, reason: e.target.value })} className="w-full border rounded-lg px-3 py-2 text-sm bg-white">
              <option value="">Reason chuniye…</option>
              {['Site renovation','Shop band / owner nahi mila','Permission nahi mili','Site pe jagah nahi / blocked','Kaam scope se hata diya'].map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
            <input value={unavail.reason} onChange={(e) => setUnavail({ ...unavail, reason: e.target.value })} placeholder="Ya apna reason likhiye" className="w-full border rounded-lg px-3 py-2 text-sm" />
            <input value={unavail.note} onChange={(e) => setUnavail({ ...unavail, note: e.target.value })} placeholder="Comment (optional)" className="w-full border rounded-lg px-3 py-2 text-sm" />
            <label className="w-full flex items-center justify-center gap-2 border-2 border-dashed border-blue-300 bg-blue-50 text-blue-700 text-sm font-semibold py-3 rounded-xl cursor-pointer">
              <Camera className="w-4 h-4" /> {unavail.file ? `Photo: ${unavail.file.name}` : 'Site ki photo lein / chunein (zaroori)'}
              <input type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => setUnavail({ ...unavail, file: e.target.files?.[0] || null })} />
            </label>
            <div className="flex gap-2">
              <button onClick={() => setUnavail(null)} className="flex-1 bg-slate-100 text-slate-700 py-3 rounded-lg font-medium">Cancel</button>
              <button disabled={unavailBusy} onClick={() => void saveUnavailable()} className="flex-1 bg-amber-600 text-white py-3 rounded-lg font-semibold disabled:opacity-50">{unavailBusy ? 'Saving…' : 'Mark not installed'}</button>
            </div>
          </div>
        </div>
      )}

      <div className="p-4">
        {step === 1 && shop && (
          <div className="space-y-4">
            <Card className="p-4">
              <h2 className="font-bold text-slate-900 text-lg mb-3">{shop.name}</h2>
              <div className="space-y-2 text-sm text-slate-600">
                <p>Client: {shop.clients?.name}</p>
                <p>Address: {shop.address || 'N/A'}</p>
                <p>City: {shop.city}, {shop.state}</p>
              </div>
            </Card>

            {correctionTasks && correctionTasks.length > 0 && <Card className="p-4 border border-amber-300 bg-amber-50"><p className="font-semibold text-sm text-amber-900">Correction-only installation · {correctionTasks.length} item{correctionTasks.length===1?'':'s'}</p><p className="text-xs text-amber-700 mt-1">Only the affected Work Item(s) are shown below. Previously accepted evidence is preserved.</p><div className="mt-2 space-y-1">{correctionTasks.map((c:any)=><div key={c.id} className="text-xs bg-white/80 border border-amber-200 rounded px-2 py-1.5"><b>{c.issue_type==='installation_photo'?'Replace installation photo':'Redo work item'}</b>{c.note?` — ${c.note}`:''}</div>)}</div></Card>}

            <ApprovedSpecsCard
              items={correctionTasks && correctionTasks.length > 0 ? approvedItems.filter((it:any) => correctionTasks.some((c:any) => c.work_item_id === it.id)) : approvedItems}
              photos={surveyPhotos || []}
              markings={boardMarkings || []}
              photoItemLinks={surveyPhotoItemLinks || []}
              expandedItemId={expandedInstallItemId}
              onToggleItem={(itemId) => setExpandedInstallItemId((current) => current === itemId ? null : itemId)}
              proofPhotos={proofPhotos}
              onTakePhoto={(itemId) => { setSelectedProofWorkItemId(itemId); setCameraFor('front'); }}
              onUploadPhotos={(itemId, files) => { setSelectedProofWorkItemId(itemId); void handleInstallationFileSelection(files, itemId); }}
              onDeletePhoto={(photo) => void deleteInstallationPhoto(photo)}
              onMarkUnavailable={(item) => void markItemAvailability(item, true)}
              onRestore={(item) => void markItemAvailability(item, false)}
            />

            {proofPhotos.length > 0 && (
              <Card className="p-3">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-sm font-semibold text-slate-900">Installation photos</p>
                  <span className="text-xs font-semibold text-blue-600">{proofPhotos.length} added</span>
                </div>
                <div className="grid grid-cols-4 gap-2">
                  {proofPhotos.map((p, i) => (
                    <div key={`${p.url}-${i}`} className="relative rounded-lg overflow-hidden bg-slate-100 aspect-[4/3]">
                      <img src={p.url} alt="Installation proof" className="w-full h-full object-contain bg-slate-100" />
                      <button onClick={() => void deleteInstallationPhoto(p)} className="absolute top-1 right-1 bg-red-600/90 text-white rounded-full p-1.5 shadow" aria-label="Delete photo"><Trash2 className="w-3 h-3" /></button>
                    </div>
                  ))}
                </div>
              </Card>
            )}

            <Card className="p-4 border-slate-200">
              <div className="flex items-start gap-3 mb-3">
                <ImagePlus className="w-5 h-5 text-blue-600 mt-0.5" />
                <div><p className="font-semibold text-slate-900">Bulk Gallery Upload</p><p className="text-xs text-slate-500 mt-0.5">Select multiple photos, then map each photo to its exact work item before uploading.</p></div>
              </div>
              <label className="w-full flex items-center justify-center gap-2 border-2 border-dashed border-blue-200 bg-blue-50/50 text-blue-700 text-sm font-semibold py-3 rounded-xl cursor-pointer">
                <ImagePlus className="w-4 h-4" /> Choose multiple photos
                <input type="file" accept="image/*" multiple className="hidden" onChange={(e) => { const fs = Array.from(e.target.files || []); setBulkGalleryFiles(fs); setBulkGalleryMap({}); e.currentTarget.value = ''; }} />
              </label>
              {bulkGalleryFiles.length > 0 && <div className="mt-3 space-y-2">
                {bulkGalleryFiles.map((file, i) => <div key={`${file.name}-${i}`} className="rounded-xl border border-slate-200 p-3 bg-white">
                  <p className="text-xs font-semibold text-slate-800 truncate mb-2">Photo {i + 1}: {file.name}</p>
                  <select value={bulkGalleryMap[i] || ''} onChange={(e) => setBulkGalleryMap((m) => ({...m, [i]: e.target.value}))} className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white">
                    <option value="">Map to work item...</option>{installableItems.map((it, idx) => <option key={it.id} value={it.id}>{it.work_type_name || it.material || `Work Item ${idx + 1}`} · {formatDim(it.approved_width)}×{formatDim(it.approved_height)} {it.approved_unit}</option>)}
                  </select>
                </div>)}
                <button type="button" disabled={bulkUploading} onClick={() => void uploadMappedGallery()} className="w-full bg-blue-600 disabled:opacity-50 text-white font-semibold py-3 rounded-xl">{bulkUploading ? 'Uploading...' : `Upload ${bulkGalleryFiles.length} Mapped Photo${bulkGalleryFiles.length > 1 ? 's' : ''}`}</button>
              </div>}
            </Card>

            <button
              onClick={() => {
                const targetItems = (correctionTasks && correctionTasks.length > 0)
                  ? installableItems.filter((it) => correctionTasks.some((c: any) => c.work_item_id === it.id || (c.installation_proof_id && proofPhotos.some((p) => p.id === c.installation_proof_id && p.workItemId === it.id))))
                  : installableItems;
                const missingPhoto = targetItems.filter((it) => !proofPhotos.some((p) => p.workItemId === it.id) && !(installableItems.length === 1 && proofPhotos.length > 0));
                if (missingPhoto.length) { alert(`Photo baaki hai: ${missingPhoto.map((it) => it.work_type_name || it.material || 'Work item').join(', ')}.\nHar available item ki photo lein, ya site ready nahi hai to us item ko "Not available" mark karein.`); return; }
                if (installableItems.length === 0 && unavailableItems.length === 0 && proofPhotos.length === 0) { alert('Add at least one installation photo.'); return; }
                setStep(4);
              }}
              className="w-full bg-slate-900 text-white font-semibold py-3.5 rounded-xl"
            >
              Review Installation
            </button>

            <button onClick={() => navigateToShop(shop)} className="w-full flex items-center justify-center gap-1.5 text-blue-700 font-medium py-2.5 text-sm">
              <Navigation className="w-4 h-4" /> Open Directions
            </button>
          </div>
        )}

        {/* Step 2 — Material Check / Loading Register (vehicle/load check
            gate, §3.2/§9.4). Must be filled + photographed before Photo/
            Install unlocks — the installer records exactly how much of
            each approved board is physically loaded before heading out,
            not just a yes/no tick, so Owner/Admin can see produced vs
            loaded vs approved on Installation Review afterwards. */}
        {false && step === 2 && (
          <div className="space-y-4">
            {vehicleLoad ? (
              <div className="flex items-start gap-2.5 bg-emerald-50 border-2 border-emerald-300 rounded-xl px-3.5 py-3">
                <Package className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" />
                <div className="min-w-0">
                  <p className="text-sm font-bold text-emerald-800">Gaadi Load Ho Chuki Hai</p>
                  <p className="text-xs text-emerald-700 mt-0.5">
                    Vehicle <span className="font-semibold">{vehicleLoad?.vehicle_number}</span>
                    {vehicleLoad?.driver_name ? ` · Driver ${vehicleLoad?.driver_name}` : ''} — quantities shown below are the recorded loaded quantities.
                  </p>
                </div>
              </div>
            ) : (
              <div className="flex items-start gap-2.5 bg-amber-50 border-2 border-amber-300 rounded-xl px-3.5 py-3">
                <AlertCircle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
                <p className="text-xs text-amber-800">No production load record is available for this shop.</p>
              </div>
            )}
            <Card className="p-4">
              <div className="flex items-center gap-2 mb-1">
                <Package className="w-5 h-5 text-blue-600" />
                <span className="font-medium text-slate-900">Kitna Maal Gaya</span>
              </div>
              <p className="text-xs text-slate-500 mb-3">Enter the quantity actually loaded for each work item. The approved quantity is prefilled — change it only if fewer units were loaded.</p>

              {approvedItems.length > 0 ? (
                <div className="space-y-2">
                  {approvedItems.map((it) => {
                    const loadedVal = materialLoadedQty[it.id] ?? '';
                    const loadedNum = parseFloat(loadedVal) || 0;
                    const approvedQty = it.approved_quantity ?? 1;
                    const short = loadedNum < approvedQty;
                    return (
                      <div
                        key={it.id}
                        className={`flex items-center justify-between gap-3 rounded-lg px-3 py-2.5 border-2 ${short ? 'bg-amber-50 border-amber-300' : 'bg-green-50 border-green-300'}`}
                      >
                        <div className="min-w-0">
                          <p className="font-medium text-slate-900 truncate">{it.material || it.work_type_name || 'Item'}</p>
                          <p className="text-xs text-slate-500">{formatDim(it.approved_width)}×{formatDim(it.approved_height)} {it.approved_unit} · Approved Qty {approvedQty}</p>
                        </div>
                        <input
                          type="number"
                          inputMode="decimal"
                          min={0}
                          value={loadedVal}
                          onChange={(e) => setMaterialLoadedQty({ ...materialLoadedQty, [it.id]: e.target.value })}
                          className="w-20 shrink-0 text-center border border-slate-300 rounded-lg py-2 text-sm font-semibold"
                        />
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="text-sm text-slate-400">No approved boards found for this shop.</p>
              )}
            </Card>

            <button
              onClick={() => {
                if (materialCheckConfirmed) { setStep(3); return; }
                const missing = approvedItems.some((it) => materialLoadedQty[it.id] === undefined || materialLoadedQty[it.id] === '');
                if (missing) { alert('Enter the loaded quantity for every work item before continuing.'); return; }
                confirmMaterialCheck();
              }}
              disabled={materialCheckSaving}
              className="w-full bg-slate-900 text-white font-medium py-3 rounded-lg disabled:opacity-50"
            >
              {materialCheckSaving ? 'Saving...' : materialCheckConfirmed ? 'Confirmed — Continue' : 'Confirm & Continue'}
            </button>
            <button onClick={() => setStep(1)} className="w-full flex items-center justify-center gap-1 bg-slate-200 text-slate-700 font-medium py-3 rounded-lg">
              <ChevronLeft className="w-4 h-4" /> Back
            </button>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-4">
            <p className="text-sm text-slate-600">After installation, capture or upload proof photos. At least one photo is required; add as many angles as the client requires.</p>

            {approvedItems.length > 0 && <Card className="p-3"><div className="flex items-start justify-between gap-2 mb-2"><div><p className="text-xs font-semibold text-slate-700 uppercase tracking-wide">Installation work items</p><p className="text-[11px] text-slate-500 mt-0.5">Install available items. If a surveyed location is unavailable today, mark only that item — it stays in history but is excluded from installed/billing calculations.</p></div></div><div className="space-y-2">{approvedItems.map((it, idx) => { const unavailable = it.excluded_from_calculations || (it.execution_state && it.execution_state !== 'active'); return <div key={it.id} className={`rounded-xl border p-3 ${unavailable?'border-amber-300 bg-amber-50':'border-slate-200 bg-white'}`}><div className="flex items-start justify-between gap-2"><button disabled={!!unavailable} onClick={() => { setSelectedProofWorkItemId(it.id); setCameraFor('installed'); }} className="min-w-0 flex-1 text-left disabled:cursor-default"><p className="font-semibold text-slate-900 text-sm">{it.work_type_name || it.material || `Work Item ${idx + 1}`}</p><p className="text-xs text-slate-500 mt-0.5">{formatDim(it.approved_width)} × {formatDim(it.approved_height)} {it.approved_unit} · {Math.round((it.approved_area || 0) * 100) / 100} sq.ft · Qty {it.approved_quantity || 1}</p>{unavailable?<><p className="text-xs font-semibold text-amber-800 mt-1">Not available for installation · excluded from calculation</p><p className="text-[11px] text-amber-700">{it.execution_reason}{it.execution_note?` · ${it.execution_note}`:''}</p></>:<p className="text-xs text-blue-600 font-medium mt-1">Tap to take photo</p>}</button><button type="button" onClick={() => void markItemAvailability(it, !unavailable)} className={`shrink-0 text-[11px] font-semibold px-2.5 py-1.5 rounded-lg border ${unavailable?'border-emerald-300 bg-white text-emerald-700':'border-amber-300 bg-amber-50 text-amber-800'}`}>{unavailable?'Make available':'Not available'}</button></div></div>})}</div></Card>}

            <Card className="p-3 border-slate-200"><label className="block text-xs font-semibold text-slate-700 mb-1">Gallery upload: choose work item</label><select value={selectedProofWorkItemId} onChange={(e) => setSelectedProofWorkItemId(e.target.value)} className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white"><option value="">Select work item...</option>{installableItems.map((it, idx) => <option key={it.id} value={it.id}>{it.work_type_name || it.material || `Work Item ${idx + 1}`} · {formatDim(it.approved_width)}×{formatDim(it.approved_height)} {it.approved_unit}</option>)}</select></Card>

            <label className="w-full flex items-center justify-center gap-2 border-2 border-dashed border-blue-200 bg-blue-50/50 text-blue-700 text-sm font-semibold py-3 rounded-xl cursor-pointer hover:bg-blue-50">
              <ImagePlus className="w-4 h-4" /> Upload one or multiple installation photos
              <input type="file" accept="image/*" multiple className="hidden" onChange={(e) => { handleInstallationFileSelection(e.target.files); e.currentTarget.value = ''; }} />
            </label>

            {proofPhotos.length > 0 && (
              <div className="grid grid-cols-3 gap-2">
                {proofPhotos.map((p, i) => (
                  <div key={i} className="relative rounded-lg overflow-hidden">
                    <img src={p.url} alt={`${p.angle} installation`} className="w-full h-20 object-cover" />
                    <span className="absolute bottom-1 left-1 bg-black/60 text-white text-[9px] font-medium px-1 py-0.5 rounded capitalize">{p.angle}</span>
                    <button
                      onClick={() => setProofPhotos(proofPhotos.filter((_, idx) => idx !== i))}
                      className="absolute top-1 right-1 bg-black/60 text-white rounded-full p-0.5"
                      aria-label="Remove photo"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <button
              onClick={() => {
                const missingProof = installableItems.find((it) => !proofPhotos.some((p) => p.workItemId === it.id));
                if (missingProof) { alert(`Add at least one installation photo for ${missingProof.work_type_name || missingProof.material || 'each available work item'}, or mark that work item Not available.`); return; }
                setStep(4);
              }}
              className="w-full bg-slate-900 text-white font-medium py-3 rounded-lg"
            >
              Continue
            </button>
            <button onClick={() => setStep(1)} className="w-full flex items-center justify-center gap-1 bg-slate-200 text-slate-700 font-medium py-3 rounded-lg">
              <ChevronLeft className="w-4 h-4" /> Back
            </button>

            <button onClick={() => { setException('Other'); setExceptionNote(''); setStep(4); }} className="w-full text-sm text-red-600 font-medium py-2">
              Report Exception Instead
            </button>
          </div>
        )}

        {/* Review step (no exception) — read-only, no manual measurement entry.
            Installed specs are the same approved specs shown in Step 1;
            the installer just confirms and can add an optional note. */}
        {step === 4 && exception === null && (
          <div className="space-y-4">
            <Card className="p-4">
              <h2 className="font-semibold text-slate-900 mb-3">Review Before Submitting</h2>
              {approvedItems.length > 0 ? (
                <div className="space-y-2">
                  {approvedItems.map((it) => { const unavailable = it.excluded_from_calculations || (it.execution_state && it.execution_state !== 'active'); return (
                    <div key={it.id} className={`rounded-lg px-3 py-2 text-sm border ${unavailable?'bg-amber-50 border-amber-200':'bg-slate-50 border-transparent'}`}>
                      <div className="flex items-center justify-between gap-2"><div><p className="font-medium text-slate-900">{it.material || it.work_type_name || 'Item'}</p><p className="text-xs text-slate-500">{formatDim(it.approved_width)}×{formatDim(it.approved_height)} {it.approved_unit} · Qty {it.approved_quantity || 1}</p></div>{unavailable?<span className="text-[10px] font-bold text-amber-800 bg-amber-100 px-2 py-1 rounded-full">NOT INSTALLED · EXCLUDED</span>:<p className="text-xs font-semibold text-blue-600">{it.approved_area != null ? Math.round(it.approved_area) : ''} sq.ft</p>}</div>
                      {unavailable && <p className="text-[11px] text-amber-700 mt-1">{it.execution_reason || 'Site unavailable'}{it.execution_note?` · ${it.execution_note}`:''} · 0 installed sq.ft / qty for billing</p>}
                    </div>
                  );})}
                </div>
              ) : (
                <p className="text-sm text-slate-400">No approved measurements found for this shop.</p>
              )}
              <p className="text-xs text-slate-400 mt-2">These are the measurements approved by your Admin/Owner during survey review — installed as-is, no need to re-enter them.</p>
              <div className="mt-4 border-t border-slate-100 pt-4">
                <div className="flex items-center justify-between mb-3"><p className="text-sm font-semibold text-slate-900">Installation Photo Review</p><span className="text-xs font-semibold text-blue-600">{proofPhotos.length} photos</span></div>
                <div className="space-y-3">{approvedItems.map((it, idx) => { const ps = proofPhotos.filter((p) => p.workItemId === it.id); if (!ps.length) return null; return <div key={it.id}><p className="text-xs font-semibold text-slate-600 mb-1.5">{it.work_type_name || it.material || `Work Item ${idx + 1}`} · {ps.length} photo{ps.length > 1 ? 's' : ''}</p><div className="grid grid-cols-3 gap-2">{ps.map((p, pi) => <div key={`${p.url}-${pi}`} className="relative aspect-[4/3] rounded-lg overflow-hidden bg-slate-100"><img src={p.url} alt="Installation proof" className="w-full h-full object-contain bg-slate-100"/><button type="button" onClick={() => void deleteInstallationPhoto(p)} className="absolute top-1 right-1 bg-red-600/90 text-white rounded-full p-1.5" aria-label="Delete photo"><Trash2 className="w-3 h-3"/></button></div>)}</div></div>; })}</div>
              </div>
              <div className="mt-3">
                <Textarea label="Note for reviewer (optional)" value={installNotes} onChange={setInstallNotes} rows={2} />
              </div>
            </Card>

            <div className="flex gap-2">
              <button onClick={() => setStep(1)} className="flex items-center justify-center gap-1 bg-slate-200 text-slate-700 font-medium py-3 rounded-lg flex-1">
                <ChevronLeft className="w-4 h-4" /> Back
              </button>
              <button onClick={completeInstallation} disabled={submitting} className="bg-blue-600 disabled:opacity-50 text-white font-semibold py-3 rounded-lg flex-1">{submitting ? 'Submitting...' : 'Final Submit'}</button>
            </div>
          </div>
        )}

        {/* Exception step */}
        {step === 4 && exception !== null && (
          <div className="space-y-4">
            <Card className="p-4">
              <h2 className="font-semibold text-slate-900 mb-3">Report Exception</h2>
              <Select label="Reason" value={exception} onChange={setException} options={EXCEPTION_REASONS.map((r) => ({ value: r, label: r }))} />
              <div className="mt-3">
                <Textarea label="Note (optional)" value={exceptionNote} onChange={setExceptionNote} rows={3} />
              </div>
            </Card>
            <div className="flex gap-2">
              <button onClick={() => { setException(null); setStep(1); }} className="flex items-center justify-center gap-1 bg-slate-200 text-slate-700 font-medium py-3 rounded-lg flex-1">
                <ChevronLeft className="w-4 h-4" /> Back
              </button>
              <button onClick={completeInstallation} disabled={submitting} className="bg-red-600 disabled:opacity-50 text-white font-semibold py-3 rounded-lg flex-1">{submitting ? 'Submitting...' : 'Submit Exception'}</button>
            </div>
          </div>
        )}

        {/* Submit */}
        {false && step === 5 && (
          <div className="space-y-4">
            <Card className="p-6 text-center">
              <CheckCircle2 className="w-12 h-12 text-blue-500 mx-auto mb-3" />
              <h2 className="text-lg font-bold text-slate-900 mb-2">Ready to Complete</h2>
              <p className="text-sm text-slate-500 mb-4">
                {shop?.name} - {proofPhotos.length} photos, {exception ? `Exception: ${exception}` : 'Installation complete'}
              </p>
              <button
                onClick={completeInstallation}
                disabled={submitting}
                className="w-full bg-green-600 hover:bg-green-700 text-white font-bold py-4 rounded-xl text-lg disabled:opacity-50"
              >
                {submitting ? 'Completing...' : 'MARK INSTALLATION COMPLETE'}
              </button>
            </Card>
            <button onClick={() => setStep(4)} className="w-full flex items-center justify-center gap-1 bg-slate-200 text-slate-700 font-medium py-3 rounded-lg">
              <ChevronLeft className="w-4 h-4" /> Back
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// Shows exactly what Owner/Admin approved at Survey Review: the marked-up
// board photos (same rendering used on that review screen) plus each
// approved item's material/dimensions/quantity — so the installer sees the
// approved scene and specs up front instead of re-measuring on site.
//
// `photos` can be more than one image, and any single photo can carry more
// than one marking (e.g. a wide shopfront shot with two boards marked on
// it). Both cases are handled the same way here: every photo is rendered
// with ALL of its own markings drawn on it (renderMarkedImage already keeps
// each marking as its own separate, numbered polygon), and the board
// name(s) that photo covers are listed right under its thumbnail — so with
// several photos, or several boards on one photo, the installer can still
// tell at a glance which marking is which board. Tapping a thumbnail opens
// a full-size view so a small grid image never has to be squinted at to
// see exactly where to install.
// `photos` can be more than one image, and any single photo can carry more
// than one marking (e.g. a wide shopfront shot with two boards marked on
// it). Both cases are handled by MarkedPhotoGrid below, which renders
// every photo's markings independently — no single slow/failed photo can
// hold up or hide the others, and every marking on a shared photo draws
// as its own numbered polygon. Tapping a thumbnail opens a full-size view
// so a small grid image never has to be squinted at to see exactly where
// to install.
function ApprovedSpecsCard({
  items, photos, markings, photoItemLinks, expandedItemId, onToggleItem,
  proofPhotos, onTakePhoto, onUploadPhotos, onDeletePhoto, onMarkUnavailable, onRestore,
}: {
  items: WorkItem[];
  photos: SurveyPhoto[];
  markings: BoardMarking[];
  photoItemLinks: { survey_photo_id: string; work_item_id: string }[];
  expandedItemId: string | null;
  onToggleItem: (itemId: string) => void;
  proofPhotos: { id?: string; storagePath?: string; url: string; type: string; angle: 'front' | 'side' | 'other'; workItemId?: string }[];
  onTakePhoto: (itemId: string) => void;
  onUploadPhotos: (itemId: string, files: FileList | null) => void;
  onDeletePhoto: (photo: { id?: string; storagePath?: string; url: string; type: string; angle: 'front' | 'side' | 'other'; workItemId?: string }) => void;
  onMarkUnavailable: (item: WorkItem) => void;
  onRestore: (item: WorkItem) => void;
}) {
  if (items.length === 0) return null;

  const photoIdsForItem = (itemId: string) => {
    const ids = new Set<string>();
    photoItemLinks.filter((l) => l.work_item_id === itemId).forEach((l) => ids.add(l.survey_photo_id));
    markings.filter((m: any) => m.work_item_id === itemId).forEach((m) => ids.add(m.survey_photo_id));
    return ids;
  };

  return (
    <Card className="p-0 overflow-hidden border-slate-200">
      <div className="px-4 pt-4 pb-3 border-b border-slate-100">
        <div className="flex items-center gap-2">
          <Ruler className="w-5 h-5 text-blue-600" />
          <div>
            <p className="font-semibold text-slate-900">Approved Installation Details</p>
            <p className="text-xs text-slate-500 mt-0.5">Tap a work item to view the survey reference and add installation photos.</p>
          </div>
        </div>
      </div>

      <div className="divide-y divide-slate-100">
        {items.map((it, idx) => {
          const open = expandedItemId === it.id;
          const linkedIds = photoIdsForItem(it.id);
          const itemPhotos = photos.filter((p) => linkedIds.has(p.id));
          const itemMarkings = markings.filter((m: any) => m.work_item_id === it.id || linkedIds.has(m.survey_photo_id));
          const installedCount = proofPhotos.filter((p) => p.workItemId === it.id).length;
          const label = it.work_type_name || it.material || `Work Item ${idx + 1}`;
          return (
            <div key={it.id} className={(it.excluded_from_calculations || (it.execution_state && it.execution_state !== 'active')) ? 'bg-amber-50' : open ? 'bg-blue-50/40' : 'bg-white'}>
              <button type="button" onClick={() => onToggleItem(it.id)} className="w-full px-4 py-3.5 flex items-center gap-3 text-left active:bg-slate-50">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="font-semibold text-slate-900 truncate">{label}</p>
                    {installedCount > 0 && <span className="shrink-0 text-[10px] font-bold bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded-full">{installedCount} PHOTO{installedCount > 1 ? 'S' : ''}</span>}
                  </div>
                  <p className="text-xs text-blue-600 mt-0.5">{open ? 'Installation details' : 'Tap to view details & add photos'}</p>
                </div>
                <span className={`text-blue-600 text-lg transition-transform ${open ? 'rotate-45' : ''}`}>+</span>
              </button>
              {(it.excluded_from_calculations || (it.execution_state && it.execution_state !== 'active')) ? (
                <div className="mx-4 mb-3 rounded-lg border border-amber-300 bg-amber-100/70 px-3 py-2">
                  <p className="text-xs font-bold text-amber-900">NOT INSTALLED — count nahi hoga</p>
                  <p className="text-xs text-amber-800 mt-0.5">Reason: {it.execution_reason || 'not given'}{it.execution_note ? ` · ${it.execution_note}` : ''}</p>
                  <button type="button" onClick={() => onRestore(it)} className="mt-1.5 text-xs font-semibold text-blue-700 underline">Wapas installable karein</button>
                </div>
              ) : (
                <div className="px-4 pb-3 -mt-1">
                  <button type="button" onClick={() => onMarkUnavailable(it)} className="w-full text-xs font-semibold text-amber-800 bg-amber-50 border border-amber-300 rounded-lg py-2 active:bg-amber-100">🚫 Not available — install nahi hua (reason + photo)</button>
                </div>
              )}

              {open && (
                <div className="px-4 pb-4 space-y-3">
                  <div className="grid grid-cols-3 gap-2">
                    <div className="rounded-lg bg-white border border-slate-200 p-2.5"><p className="text-[10px] uppercase tracking-wide text-slate-400">Size</p><p className="text-xs font-semibold text-slate-800 mt-1">{formatDim(it.approved_width)} × {formatDim(it.approved_height)} {it.approved_unit}</p></div>
                    <div className="rounded-lg bg-white border border-slate-200 p-2.5"><p className="text-[10px] uppercase tracking-wide text-slate-400">Quantity</p><p className="text-xs font-semibold text-slate-800 mt-1">{it.approved_quantity || 1}</p></div>
                    <div className="rounded-lg bg-white border border-slate-200 p-2.5"><p className="text-[10px] uppercase tracking-wide text-slate-400">Area</p><p className="text-xs font-semibold text-slate-800 mt-1">{it.approved_area != null ? `${Math.round(it.approved_area * 100) / 100} sq.ft` : '—'}</p></div>
                  </div>
                  <div className="rounded-xl bg-white border border-slate-200 p-3">
                    <p className="text-[11px] font-bold tracking-wide text-slate-500 uppercase mb-2">Survey reference</p>
                    {itemPhotos.length > 0 ? (
                      <MarkedPhotoGrid photos={itemPhotos} markings={itemMarkings} workItems={[it]} />
                    ) : (
                      <div className="rounded-lg bg-slate-50 px-3 py-4 text-center text-xs text-slate-500">No survey photo is mapped to this work item.</div>
                    )}
                  </div>

                  {installedCount > 0 && <div className="rounded-xl bg-white border border-slate-200 p-3"><div className="flex items-center justify-between mb-2"><p className="text-[11px] font-bold tracking-wide text-slate-500 uppercase">Installation photos</p><span className="text-[10px] font-semibold text-emerald-700">{installedCount} added</span></div><div className="grid grid-cols-3 gap-2">{proofPhotos.filter((p) => p.workItemId === it.id).map((p, pi) => <div key={`${p.url}-${pi}`} className="relative aspect-[4/3] rounded-lg overflow-hidden bg-slate-100"><img src={p.url} alt={`${label} installation`} className="w-full h-full object-contain bg-slate-100"/><button type="button" onClick={() => onDeletePhoto(p)} className="absolute top-1 right-1 bg-red-600/90 text-white rounded-full p-1.5 shadow" aria-label="Delete installation photo"><Trash2 className="w-3 h-3"/></button></div>)}</div></div>}

                  <div className="grid grid-cols-2 gap-2">
                    <button type="button" onClick={() => onTakePhoto(it.id)} className="flex items-center justify-center gap-2 bg-blue-600 active:bg-blue-700 text-white font-semibold py-3 rounded-xl text-sm">
                      <Camera className="w-4 h-4" /> Take Photo
                    </button>
                    <label className="flex items-center justify-center gap-2 bg-white border border-blue-200 text-blue-700 font-semibold py-3 rounded-xl text-sm cursor-pointer active:bg-blue-50">
                      <ImagePlus className="w-4 h-4" /> Gallery
                      <input type="file" accept="image/*" multiple className="hidden" onChange={(e) => { onUploadPhotos(it.id, e.target.files); e.currentTarget.value = ''; }} />
                    </label>
                  </div>
                  <p className="text-[11px] text-slate-500 text-center">Photos added here are automatically linked to <span className="font-semibold text-slate-700">{label}</span>.</p>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

// ============================================================================
// DIRECT INSTALL (migration 0077) — wall-painting / on-ground campaigns with
// no shop list up front. No survey, no design, no production: the ground
// crew picks a Direct Installation Work Order, paints a wall, and logs the
// site (which they fill in themselves — the PO usually only says something
// like "wherever possible between City A and City B" or "this dealer's
// walls"), its size, and photo proof, right here. Submitting creates a
// fresh shop + work_item + installation_job + installation_proofs, landing
// on the SAME `installation_review` gate every normal installation goes
// through — Owner/Admin approves it on the existing Installation Review
// page exactly like any other job. No new tables, no new views: this reuses
// the pipeline's own tables end to end, which is also why PO
// utilization/burndown/billing/reports all pick this up automatically (they
// already key off work_items.po_line_item_id).
// ============================================================================

const DIRECT_INSTALL_STEPS = ['Work Order', 'Site & Size', 'Photos'];

interface DirectInstallPhoto {
  url: string;
  storagePath: string;
  angle: 'front' | 'side' | 'other';
}

function DirectInstallWizard({ onExit }: { onExit: () => void }) {
  const { profile } = useAuth();
  const orgId = profile?.organization_id;
  const queryClient = useQueryClient();

  const [step, setStep] = useState(1);
  const [poId, setPoId] = useState('');
  const [lineItemId, setLineItemId] = useState('');

  const [siteName, setSiteName] = useState('');
  const [address, setAddress] = useState('');
  const [city, setCity] = useState('');
  const [state, setState] = useState('');
  const [landmark, setLandmark] = useState('');
  const [width, setWidth] = useState('');
  const [height, setHeight] = useState('');
  const [unit, setUnit] = useState('ft');
  const [quantity, setQuantity] = useState('1');
  const [notes, setNotes] = useState('');

  const [gps, setGps] = useState<{ lat: number; lng: number; accuracy: number } | null>(null);
  const [gpsStatus, setGpsStatus] = useState<'idle' | 'capturing' | 'captured' | 'denied'>('idle');
  const [locating, setLocating] = useState(false);
  const [locateError, setLocateError] = useState<string | null>(null);

  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [shopId, setShopId] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [shopName, setShopName] = useState('');

  const [cameraOpen, setCameraOpen] = useState(false);
  const [nextAngle, setNextAngle] = useState<'front' | 'side' | 'other'>('front');
  const [photos, setPhotos] = useState<DirectInstallPhoto[]>([]);
  const [finishing, setFinishing] = useState(false);
  const [completed, setCompleted] = useState(false);

  // Passive GPS capture as soon as the wizard opens — same as the normal
  // Installation Wizard — so a location is usually already sitting there
  // by the time the installer reaches Step 2 and taps "Use My Location".
  useEffect(() => {
    if (gpsStatus !== 'idle') return;
    setGpsStatus('capturing');
    navigator.geolocation.getCurrentPosition(
      (pos) => { setGps({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy }); setGpsStatus('captured'); },
      () => setGpsStatus('denied'),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }, [gpsStatus]);

  // Active Work Orders of type direct_install that THIS installer has
  // actually been assigned to (migration 0078's po_assignments) — read
  // from the non-financial v_po_work_context view (installer role has no
  // SELECT on purchase_orders itself, migration 0029).
  const { data: pos, isLoading: posLoading } = useQuery({
    queryKey: ['direct-install-po-list', orgId, profile?.id],
    queryFn: async () => {
      const { data: myAssignments, error: assignError } = await supabase
        .from('po_assignments')
        .select('purchase_order_id')
        .eq('user_id', profile!.id)
        .eq('role', 'installer');
      if (assignError) throw new Error(`Could not load your Direct Install assignments: ${assignError.message}`);
      const poIds = (myAssignments || []).map((a) => a.purchase_order_id);
      if (poIds.length === 0) return [] as POWorkContext[];

      const { data, error } = await supabase
        .from('v_po_work_context')
        .select('*')
        .eq('organization_id', orgId)
        .eq('fulfillment_type', 'direct_install')
        .eq('status', 'active')
        .in('id', poIds)
        .order('po_date', { ascending: false });
      if (error) throw new Error(`Could not load Direct Installation Work Orders: ${error.message}`);
      return data as POWorkContext[];
    },
    enabled: !!orgId && !!profile?.id,
  });
  useRealtimeInvalidate(['po_assignments'], orgId, [['direct-install-po-list', orgId, profile?.id]]);

  const selectedPo = (pos || []).find((p) => p.id === poId) || null;

  const { data: lineItems } = useQuery({
    queryKey: ['direct-install-line-items', poId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('v_po_line_item_work_context')
        .select('*')
        .eq('purchase_order_id', poId)
        .order('description');
      if (error) throw new Error(`Could not load this Work Order's budget lines: ${error.message}`);
      return data as POLineItemWorkContext[];
    },
    enabled: !!poId,
  });

  // Auto-select the only line item when there's just one — most Direct
  // Install POs have a single "Wall Painting" line, so this saves a tap.
  useEffect(() => {
    if (lineItems && lineItems.length === 1 && !lineItemId) setLineItemId(lineItems[0].id);
  }, [lineItems, lineItemId]);

  const selectedLineItem = (lineItems || []).find((li) => li.id === lineItemId) || null;

  // Friendly work-type name for the work_item row — falls back to the
  // line item's own description (e.g. "Wall Painting — Dealer Boards")
  // when there's no linked work_types row to name it from.
  const { data: workTypes } = useQuery({
    queryKey: ['org-work-types', orgId],
    queryFn: async () => {
      const { data, error } = await supabase.from('work_types').select('id, name').eq('organization_id', orgId);
      if (error) { console.error('[DirectInstallWizard] could not load work types:', error.message); return []; }
      return data as { id: string; name: string }[];
    },
    enabled: !!orgId,
  });
  const workTypeName = selectedLineItem
    ? (workTypes || []).find((wt) => wt.id === selectedLineItem.work_type_id)?.name || selectedLineItem.description
    : null;

  // How much has already been logged against every line item on this PO —
  // summed straight off work_items (org-scoped, no financial lock, unlike
  // v_po_line_item_utilization which carries `rate`). Powers the live
  // budget-vs-logged banner exactly like the Surveyor's PO variance banner.
  const { data: loggedByLineItem } = useQuery({
    queryKey: ['direct-install-logged', poId, (lineItems || []).map((li) => li.id).join(',')],
    queryFn: async () => {
      const ids = (lineItems || []).map((li) => li.id);
      if (ids.length === 0) return new Map<string, number>();
      const { data, error } = await supabase
        .from('work_items')
        .select('po_line_item_id, installed_area, installed_quantity')
        .in('po_line_item_id', ids);
      if (error) { console.error('[DirectInstallWizard] could not load logged-so-far totals:', error.message); return new Map<string, number>(); }
      const map = new Map<string, number>();
      for (const row of data || []) {
        if (!row.po_line_item_id) continue;
        const li = (lineItems || []).find((l) => l.id === row.po_line_item_id);
        const areaBased = li ? li.uom === 'sqft' : true;
        const value = areaBased ? (row.installed_area || 0) : (row.installed_quantity || 0);
        map.set(row.po_line_item_id, (map.get(row.po_line_item_id) || 0) + value);
      }
      return map;
    },
    enabled: !!lineItems && lineItems.length > 0,
  });

  const isAreaUom = selectedLineItem ? selectedLineItem.uom === 'sqft' : true;
  const widthNum = parseFloat(width) || 0;
  const heightNum = parseFloat(height) || 0;
  const qtyNum = Math.max(1, parseInt(quantity, 10) || 1);
  const computedArea = isAreaUom && widthNum > 0 && heightNum > 0 ? areaSqFt(widthNum, unit, heightNum, unit) * qtyNum : 0;
  const thisMeasurement = isAreaUom ? computedArea : qtyNum;

  const variance = selectedLineItem
    ? computePOVariance(selectedLineItem, loggedByLineItem?.get(selectedLineItem.id) || 0, thisMeasurement)
    : null;

  const canContinueStep1 = !!poId && !!lineItemId;
  const canContinueStep2 = siteName.trim().length > 0 && (isAreaUom ? widthNum > 0 && heightNum > 0 : qtyNum > 0);

  async function createSiteAndJob() {
    if (!profile || !selectedPo || !selectedLineItem) return;
    setCreating(true);
    setCreateError(null);
    try {
      const { data: shop, error: shopError } = await supabase.from('shops').insert({
        organization_id: profile.organization_id,
        client_id: selectedPo.client_id,
        project_id: selectedPo.project_id,
        purchase_order_id: selectedPo.id,
        name: siteName.trim(),
        address: address.trim() || null,
        city: city.trim() || null,
        state: state.trim() || null,
        latitude: gps?.lat ?? null,
        longitude: gps?.lng ?? null,
        // Goes straight to the same review queue every other completed
        // installation lands on (migration 0014) — Owner/Admin approves
        // it from the existing Installation Review page, no new screen.
        status: 'installation_review',
        extra_details: landmark.trim() ? { landmark: landmark.trim() } : {},
      }).select().single();
      if (shopError) throw new Error(`Could not save the site: ${shopError.message}`);

      const { data: workItem, error: workItemError } = await supabase.from('work_items').insert({
        organization_id: profile.organization_id,
        shop_id: shop.id,
        work_type_id: selectedLineItem.work_type_id,
        work_type_name: workTypeName,
        po_line_item_id: selectedLineItem.id,
        installed_width: isAreaUom ? widthNum : null,
        installed_height: isAreaUom ? heightNum : null,
        installed_unit: isAreaUom ? unit : null,
        installed_quantity: qtyNum,
        installed_area: isAreaUom ? computedArea : null,
        installed_notes: notes.trim() || null,
        installed_at: new Date().toISOString(),
        status: 'installed',
      }).select().single();
      if (workItemError) throw new Error(`Could not save the painted size: ${workItemError.message}`);

      const { data: job, error: jobError } = await supabase.from('installation_jobs').insert({
        organization_id: profile.organization_id,
        shop_id: shop.id,
        installer_id: profile.id,
        status: 'completed',
        review_status: 'pending',
        // No vehicle/load-check applies here — there's no pre-approved
        // board to check against, the on-site photo IS the proof.
        material_check_confirmed: true,
        gps_lat: gps?.lat ?? null,
        gps_lng: gps?.lng ?? null,
        gps_accuracy: gps?.accuracy ?? null,
        gps_captured_at: gps ? new Date().toISOString() : null,
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        notes: notes.trim() || null,
      }).select().single();
      if (jobError) throw new Error(`Could not save the installation record: ${jobError.message}`);

      // Best-effort — lets this show up in the installer's own "Done"
      // count on Home/My Work the same way an assigned job would. Never
      // blocks the flow if it fails.
      await supabase.from('shop_assignments').insert({
        organization_id: profile.organization_id,
        shop_id: shop.id,
        user_id: profile.id,
        role: 'installer',
        status: 'completed',
        completed_at: new Date().toISOString(),
      });

      setShopId(shop.id);
      setShopName(shop.name);
      setJobId(job.id);
      setStep(3);
    } catch (err: any) {
      console.error('[DirectInstallWizard] createSiteAndJob failed:', err);
      setCreateError(err?.message || 'Something went wrong saving this site. Please try again.');
    } finally {
      setCreating(false);
    }
  }

  async function handlePhotoCaptured(dataUrl: string, fileName: string, forcedAngle?: 'front' | 'side' | 'other') {
    const angle = nextAngle;
    setCameraOpen(false);
    if (!profile || !jobId || !shopId) return;
    try {
      // Same geo-tag stamp as the normal Installation Wizard — the site
      // name and address the ground crew themselves just typed in, plus
      // GPS + timestamp, burned onto the photo itself.
      let uploadDataUrl = dataUrl;
      try {
        uploadDataUrl = await stampGeoTag(dataUrl, {
          siteName: shopName || siteName,
          addressLine: [address, city, state].filter(Boolean).join(', ') || null,
          lat: gps?.lat ?? null,
          lng: gps?.lng ?? null,
          accuracy: gps?.accuracy ?? null,
        });
      } catch (stampErr) {
        console.error('[DirectInstallWizard] geo-tag stamp failed (non-fatal, uploading unstamped):', stampErr);
      }

      const res = await fetch(uploadDataUrl);
      const blob = await res.blob();
      const file = new File([blob], fileName, { type: blob.type });
      const path = `${profile.organization_id}/${jobId}/direct-${angle}-${Date.now()}-${fileName}`;
      const { error: uploadError } = await supabase.storage.from('installation-proof').upload(path, file);
      if (uploadError) { alert('Photo upload failed: ' + uploadError.message); return; }
      const { data: urlData } = supabase.storage.from('installation-proof').getPublicUrl(path);

      const { error: insertError } = await supabase.from('installation_proofs').insert({
        organization_id: profile.organization_id,
        installation_job_id: jobId,
        shop_id: shopId,
        storage_path: path,
        photo_url: urlData.publicUrl,
        photo_type: 'installed',
        angle,
        gps_lat: gps?.lat ?? null,
        gps_lng: gps?.lng ?? null,
        gps_accuracy: gps?.accuracy ?? null,
      });
      if (insertError) { alert('Could not save the photo record: ' + insertError.message); return; }

      setPhotos((prev) => [...prev, { url: urlData.publicUrl, storagePath: path, angle }]);
      // Cycle front -> side -> other -> other..., matching Section 7's
      // "at least front + side" convention from the normal install flow.
      setNextAngle((a) => (a === 'front' ? 'side' : 'other'));
    } catch (err: any) {
      console.error('[DirectInstallWizard] handlePhotoCaptured failed:', err);
      alert(`Could not save that photo: ${err?.message || 'Unknown error'}. Please try again.`);
    }
  }

  async function removePhoto(photo: DirectInstallPhoto) {
    setPhotos((prev) => prev.filter((p) => p.storagePath !== photo.storagePath));
    await supabase.from('installation_proofs').delete().eq('storage_path', photo.storagePath);
    await supabase.storage.from('installation-proof').remove([photo.storagePath]);
  }

  async function finish() {
    if (!profile || !jobId || !shopId) return;
    setFinishing(true);
    try {
      await logAudit('installation_jobs', jobId, 'complete', null, null, null, `Direct Install logged for ${shopName} (${selectedPo?.po_number || ''})`);

      const { data: admins } = await supabase.from('profiles').select('id').eq('organization_id', profile.organization_id).in('role', ['agency_owner', 'admin']);
      for (const admin of admins || []) {
        await createNotification(
          admin.id,
          'Direct Install Logged',
          `${profile.full_name} logged a new Direct Install site "${shopName}" against ${selectedPo?.po_number || 'a Work Order'} — waiting for your review.`,
          'info',
          '/installation-review'
        );
      }

      queryClient.invalidateQueries();
      setCompleted(true);
    } catch (err: any) {
      console.error('[DirectInstallWizard] finish failed:', err);
      // Everything that actually matters (shop/work item/job/photos) is
      // already saved at this point — a notification/audit hiccup here
      // shouldn't strand the installer on this screen.
      setCompleted(true);
    } finally {
      setFinishing(false);
    }
  }

  async function useMyLocation() {
    setLocating(true);
    setLocateError(null);
    try {
      const pos = await new Promise<GeolocationPosition>((resolve, reject) =>
        navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 10000 })
      );
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      setGps({ lat, lng, accuracy: pos.coords.accuracy });
      setGpsStatus('captured');
      const result = await reverseGeocode(lat, lng);
      setAddress(result.formattedAddress);
      if (result.city) setCity(result.city);
      if (result.state) setState(result.state);
    } catch (err: any) {
      setLocateError(err?.message || 'Could not detect your location. You can still fill the address in by hand.');
    } finally {
      setLocating(false);
    }
  }

  function resetForAnother() {
    setStep(1); setPoId(''); setLineItemId('');
    setSiteName(''); setAddress(''); setCity(''); setState(''); setLandmark('');
    setWidth(''); setHeight(''); setUnit('ft'); setQuantity('1'); setNotes('');
    setShopId(null); setJobId(null); setShopName('');
    setPhotos([]); setNextAngle('front'); setCompleted(false); setCreateError(null); setLocateError(null);
  }

  if (completed) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4 pb-24 max-w-md mx-auto">
        <Card className="p-8 text-center">
          <CheckCircle2 className="w-16 h-16 text-green-500 mx-auto mb-4" />
          <h2 className="text-xl font-bold text-slate-900 mb-2">Site Logged!</h2>
          <p className="text-sm text-slate-500 mb-6">
            {shopName} has been submitted with {photos.length} photo{photos.length === 1 ? '' : 's'} and is waiting for Owner/Admin review, same as any other installation.
          </p>
          <button onClick={resetForAnother} className="w-full bg-amber-500 hover:bg-amber-600 text-white font-medium py-3 rounded-lg mb-2">
            Log Another Site
          </button>
          <button onClick={onExit} className="w-full bg-slate-100 hover:bg-slate-200 text-slate-700 font-medium py-3 rounded-lg">
            Back to Home
          </button>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 pb-24 max-w-md mx-auto">
      <CameraCapture open={cameraOpen} onClose={() => setCameraOpen(false)} onCapture={handlePhotoCaptured} title={`Site Photo (${nextAngle})`} />

      <div className="bg-white border-b border-slate-200 sticky top-0 z-30">
        <div className="flex items-center justify-between p-4">
          <button onClick={onExit} className="text-sm text-slate-500">Cancel</button>
          <p className="font-semibold text-slate-900">Step {step} of 3</p>
          <span className="text-xs text-slate-400">{DIRECT_INSTALL_STEPS[step - 1]}</span>
        </div>
        <div className="flex px-4 pb-3 gap-1">
          {[1, 2, 3].map((s) => (
            <div key={s} className={`h-1.5 flex-1 rounded-full ${s <= step ? 'bg-amber-500' : 'bg-slate-200'}`} />
          ))}
        </div>
      </div>

      <div className="p-4 space-y-4">
        {/* Step 1: pick the Work Order + which budget line this site counts against */}
        {step === 1 && (
          <div className="space-y-4">
            <Card className="p-4 bg-amber-50 border-amber-200">
              <div className="flex items-center gap-2 mb-1">
                <Paintbrush className="w-5 h-5 text-amber-600" />
                <span className="font-medium text-slate-900">Direct Install</span>
              </div>
              <p className="text-xs text-slate-600">
                No shop list for this kind of Work Order — pick it below, then fill in the site yourself once you're there.
              </p>
            </Card>

            {posLoading ? (
              <div className="flex justify-center py-8"><Loader2 className="w-6 h-6 text-amber-500 animate-spin" /></div>
            ) : (pos || []).length === 0 ? (
              <EmptyState icon={<ClipboardList className="w-10 h-10" />} title="No Direct Installation Work Orders" subtitle="You haven't been assigned to any yet — ask your Admin/Owner to add you to one." />
            ) : (
              <div className="space-y-2">
                {(pos || []).map((po) => (
                  <button
                    key={po.id}
                    onClick={() => { setPoId(po.id); setLineItemId(''); }}
                    className={`w-full text-left p-4 rounded-xl border-2 transition ${poId === po.id ? 'border-amber-500 bg-amber-50' : 'border-slate-200 bg-white'}`}
                  >
                    <p className="font-semibold text-slate-900">{po.name || po.po_number}</p>
                    {po.name && <p className="text-xs text-slate-400">{po.po_number}</p>}
                    <p className="text-xs text-slate-500 mt-0.5">{new Date(po.po_date).toLocaleDateString('en-IN')}</p>
                  </button>
                ))}
              </div>
            )}

            {poId && (
              <>
                <p className="text-sm font-medium text-slate-700 pt-2">Which budget line does this site count against?</p>
                {(lineItems || []).length === 0 ? (
                  <p className="text-xs text-slate-400">Loading budget lines...</p>
                ) : (
                  <div className="space-y-2">
                    {(lineItems || []).map((li) => {
                      const logged = loggedByLineItem?.get(li.id) || 0;
                      const budget = li.uom === 'sqft' ? li.budgeted_area : li.budgeted_qty;
                      return (
                        <button
                          key={li.id}
                          onClick={() => setLineItemId(li.id)}
                          className={`w-full text-left p-3 rounded-xl border-2 transition ${lineItemId === li.id ? 'border-amber-500 bg-amber-50' : 'border-slate-200 bg-white'}`}
                        >
                          <p className="font-medium text-slate-900 text-sm">{li.description}</p>
                          {budget != null && (
                            <p className="text-xs text-slate-500 mt-0.5">
                              {logged.toLocaleString('en-IN')} / {budget.toLocaleString('en-IN')} {li.uom === 'sqft' ? 'sqft' : li.uom} logged so far
                            </p>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
              </>
            )}

            <button
              disabled={!canContinueStep1}
              onClick={() => setStep(2)}
              className="w-full bg-slate-900 disabled:bg-slate-300 text-white font-medium py-3 rounded-lg"
            >
              Continue
            </button>
          </div>
        )}

        {/* Step 2: the ground crew fills in what the office never had — the
            site itself — plus what got painted and how big. */}
        {step === 2 && (
          <div className="space-y-4">
            <Card className="p-4">
              <div className="flex items-center gap-2 mb-2">
                <MapPin className="w-5 h-5 text-amber-600" />
                <span className="font-medium text-slate-900">Site Location</span>
              </div>
              <p className="text-xs text-slate-500 mb-3">This Work Order doesn't come with a fixed shop list — fill in whatever you can about this wall/dealer yourself.</p>

              <button
                onClick={useMyLocation}
                disabled={locating}
                className="w-full flex items-center justify-center gap-1.5 bg-amber-50 hover:bg-amber-100 text-amber-700 font-medium py-2.5 rounded-lg text-sm transition mb-3 disabled:opacity-60"
              >
                {locating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Navigation className="w-4 h-4" />}
                {locating ? 'Detecting location...' : 'Use My Location'}
              </button>
              {locateError && <p className="text-xs text-red-500 mb-3">{locateError}</p>}
              {gpsStatus === 'captured' && gps && (
                <p className="text-xs text-green-600 flex items-center gap-1 mb-3"><CheckCircle2 className="w-3.5 h-3.5" /> Location captured (accuracy: {gps.accuracy.toFixed(0)}m)</p>
              )}

              <div className="space-y-3">
                <Input label="Site / Dealer Name" value={siteName} onChange={setSiteName} placeholder="e.g. Sharma General Store" required />
                <Textarea label="Address (optional)" value={address} onChange={setAddress} rows={2} placeholder="Street, area, pincode..." />
                <div className="grid grid-cols-2 gap-3">
                  <Input label="City" value={city} onChange={setCity} />
                  <Input label="State" value={state} onChange={setState} />
                </div>
                <Input label="Landmark (optional)" value={landmark} onChange={setLandmark} placeholder="e.g. Near bus stand" />
              </div>
            </Card>

            <Card className="p-4">
              <div className="flex items-center gap-2 mb-3">
                <Ruler className="w-5 h-5 text-amber-600" />
                <span className="font-medium text-slate-900">What Got Painted</span>
              </div>
              {selectedLineItem && (
                <p className="text-xs text-slate-500 mb-3">Against: {selectedLineItem.description}</p>
              )}

              {isAreaUom ? (
                <div className="grid grid-cols-3 gap-2 mb-2">
                  <Input label="Width" type="number" value={width} onChange={setWidth} placeholder="0" />
                  <Input label="Height" type="number" value={height} onChange={setHeight} placeholder="0" />
                  <Select label="Unit" value={unit} onChange={setUnit} options={LENGTH_UNIT_OPTIONS} />
                </div>
              ) : null}
              <div className="grid grid-cols-2 gap-2">
                <Input label="Quantity" type="number" value={quantity} onChange={setQuantity} placeholder="1" />
                {isAreaUom && (
                  <div className="flex flex-col justify-end">
                    <p className="text-xs text-slate-400 mb-1">Total Area</p>
                    <p className="text-lg font-bold text-slate-900">{computedArea > 0 ? `${computedArea.toFixed(1)} sqft` : '—'}</p>
                  </div>
                )}
              </div>

              {variance && variance.budgeted != null && (
                <div className={`mt-3 rounded-lg p-3 text-xs ${variance.exceeds ? 'bg-amber-50 border border-amber-200 text-amber-700' : 'bg-slate-50 border border-slate-200 text-slate-600'}`}>
                  {variance.exceeds && <AlertCircle className="w-4 h-4 inline mr-1" />}
                  Running total after this site: {variance.runningTotal.toLocaleString('en-IN')} / {variance.budgeted.toLocaleString('en-IN')} {variance.isAreaUom ? 'sqft' : ''} budgeted
                  {variance.exceeds ? ` — ${variance.exceedsBy.toLocaleString('en-IN')} over budget. You can still submit; flagging this for the office to see.` : ''}
                </div>
              )}

              <div className="mt-3">
                <Textarea label="Notes (optional)" value={notes} onChange={setNotes} rows={2} placeholder="Anything the office should know" />
              </div>
            </Card>

            {createError && <p className="text-sm text-red-500 bg-red-50 border border-red-200 rounded-lg p-3">{createError}</p>}

            <div className="flex gap-2">
              <button onClick={() => setStep(1)} className="flex-1 bg-slate-100 text-slate-700 font-medium py-3 rounded-lg">Back</button>
              <button
                disabled={!canContinueStep2 || creating}
                onClick={createSiteAndJob}
                className="flex-[2] bg-slate-900 disabled:bg-slate-300 text-white font-medium py-3 rounded-lg flex items-center justify-center gap-2"
              >
                {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                {creating ? 'Saving Site...' : 'Save & Add Photos'}
              </button>
            </div>
          </div>
        )}

        {/* Step 3: photo proof — the same installation-proofs pipeline every
            other install uses, so it shows up on Installation Review with
            all the same GPS/duplicate checks other photos get. */}
        {step === 3 && (
          <div className="space-y-4">
            <Card className="p-4">
              <p className="font-semibold text-slate-900">{shopName}</p>
              <p className="text-xs text-slate-500">Add at least one photo of the painted wall — a wide shot and a close-up work best.</p>
            </Card>

            <div className="grid grid-cols-3 gap-2">
              {photos.map((p) => (
                <div key={p.storagePath} className="relative aspect-square rounded-lg overflow-hidden border border-slate-200">
                  <img src={p.url} alt={p.angle} className="w-full h-full object-contain bg-slate-100" />
                  <span className="absolute bottom-0 left-0 right-0 bg-black/50 text-white text-[10px] text-center py-0.5 capitalize">{p.angle}</span>
                  <button onClick={() => removePhoto(p)} className="absolute top-1 right-1 bg-black/60 text-white rounded-full p-0.5">
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              ))}
              <button
                onClick={() => setCameraOpen(true)}
                className="aspect-square rounded-lg border-2 border-dashed border-amber-300 bg-amber-50 flex flex-col items-center justify-center gap-1 text-amber-600"
              >
                <ImagePlus className="w-6 h-6" />
                <span className="text-xs font-medium">Add Photo</span>
              </button>
            </div>

            <div className="flex gap-2">
              <button onClick={() => setCameraOpen(true)} className="flex-1 bg-amber-500 hover:bg-amber-600 text-white font-medium py-3 rounded-lg flex items-center justify-center gap-2">
                <Camera className="w-4 h-4" /> Take Photo
              </button>
            </div>

            <button
              disabled={photos.length === 0 || finishing}
              onClick={finish}
              className="w-full bg-slate-900 disabled:bg-slate-300 text-white font-bold py-3.5 rounded-lg flex items-center justify-center gap-2"
            >
              {finishing ? <Loader2 className="w-4 h-4 animate-spin" /> : <PlusCircle className="w-4 h-4" />}
              {finishing ? 'Submitting...' : 'Submit for Review'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
