import { useState, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { Card, Select, Textarea } from '@/components/ui';
import { logAudit, createNotification } from '@/lib/helpers';
import { useRealtimeInvalidate } from '@/lib/useRealtimeInvalidate';
import { CameraCapture } from '@/components/CameraCapture';
import { formatDim } from '@/lib/units';
import { useLiveLocationTracking, LocationShareIndicator } from '@/lib/locationTracking';
import { MarkedPhotoGrid } from '@/components/MarkedPhotoGrid';
import { computeImageHash, hammingDistance, DUPLICATE_HASH_THRESHOLD } from '@/lib/imageHash';
import { haversineDistanceMeters, GPS_DISTANCE_FLAG_METERS } from '@/lib/geoDistance';
import type { SurveyPhoto, BoardMarking, WorkItem } from '@/lib/types';
import {
  Home, Briefcase, MapPin, Bell, User, Camera, Navigation, CheckCircle2,
  ChevronLeft, AlertCircle, Map as MapIcon, Loader2, Wrench, Ruler, Package, X,
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

  if (activeJob) {
    return <InstallationWizard shopId={activeJob} onExit={(nextShopId) => setActiveJob(nextShopId || null)} />;
  }

  return (
    <div className="min-h-screen bg-slate-50 pb-20 max-w-md mx-auto">
      {tab === 'home' && <InstallerHome onStart={(shopId) => setActiveJob(shopId)} />}
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

function InstallerHome({ onStart }: { onStart: (shopId: string) => void }) {
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

  // Previously this list only refreshed when the tab remounted (switching
  // away and back). An installer newly assigned from Production's
  // "Completed" approval or from the Shop Detail page's "Assign Installer"
  // button would not see the job appear here — or the shop's status flip
  // to production_done and unlock "Start Install" — until they happened
  // to switch tabs. Same live-refresh pattern as the office-side queues.
  useRealtimeInvalidate(['shop_assignments', 'shops'], orgId, [['installer-assignments', profile?.id]]);

  const assigned = (assignments || []).filter((a) => a.status !== 'completed').length;
  const completed = (assignments || []).filter((a) => a.status === 'completed').length;
  const pending = assigned;
  const nextJob = (assignments || []).find((a) => a.shops?.status === 'production_done' || a.shops?.status === 'dispatched' || a.shops?.status === 'installation_pending');

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

  useRealtimeInvalidate(['shop_assignments', 'shops'], orgId, [['installer-work', profile?.id]]);

  const shopIds = (assignments || []).map((a) => a.shop_id);

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
          const isInstalled = shopStatus === 'installed';
          const isAwaitingApproval = shopStatus === 'installation_review';
          const isReady = READY_STATUSES.includes(shopStatus);
          if (isInstalled) return { label: 'Installed', disabled: true, done: true };
          if (isAwaitingApproval) return { label: 'Awaiting Approval', disabled: true };
          if (!isReady) return { label: 'Not Ready Yet', disabled: true };
          return { label: 'Start Install', disabled: false };
        }}
        onStart={onStart}
        emptyLabel="No installations assigned"
        renderExtra={(a) => {
          const shopStatus = a.shops?.status || 'pending';
          const isInstalled = shopStatus === 'installed';
          const isAwaitingApproval = shopStatus === 'installation_review';
          const isReady = READY_STATUSES.includes(shopStatus);
          return (
            <>
              {isAwaitingApproval && (
                <p className="text-[11px] text-amber-600 bg-amber-50 border border-amber-100 rounded-lg px-2 py-1 mt-1.5">
                  Submitted — waiting for Admin/Owner to approve this installation.
                </p>
              )}
              {!isInstalled && !isAwaitingApproval && !isReady && (
                <p className="text-[11px] text-amber-600 bg-amber-50 border border-amber-100 rounded-lg px-2 py-1 mt-1.5">
                  Waiting on production to be completed and approved.
                </p>
              )}
              <MaterialsToBring items={(approvedItems || []).filter((it) => it.shop_id === a.shop_id)} />
            </>
          );
        }}
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
  const [proofPhotos, setProofPhotos] = useState<{ url: string; type: string; angle: 'front' | 'side' | 'other' }[]>([]);
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
  const [jobBlockedReason, setJobBlockedReason] = useState<string | null>(null);

  // Live location sharing while this installation is in progress — pinged
  // to worker_locations so the Owner/Admin Live Field Map shows the
  // installer moving in real time, same as the surveyor flow.
  const { status: locStatus, lastSentAt } = useLiveLocationTracking(true, profile?.id, profile?.organization_id);

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
  const pendingJobQueue = (pendingJobAssignments || []).filter((a) => READY_STATUSES.includes(a.shops?.status || ''));
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

  // Create installation job on mount
  useEffect(() => {
    async function createJob() {
      if (!profile || !shop || jobId) return;
      const existing = await supabase.from('installation_jobs').select('id').eq('shop_id', shopId).eq('installer_id', profile.id).maybeSingle();
      if (existing.data) { setJobId(existing.data.id); return; }
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

  async function handlePhotoCaptured(dataUrl: string, fileName: string) {
    // cameraFor doubles as the angle here ('front' / 'side' / 'other') —
    // photo_type stays the constant 'installed' (matches the existing
    // check constraint); angle is the new, separate column that Section 7
    // actually needs the multi-angle requirement enforced against.
    const angle = cameraFor as 'front' | 'side' | 'other' | null;
    setCameraFor(null);
    if (!angle || !profile || !jobId) return;
    const res = await fetch(dataUrl);
    const blob = await res.blob();
    const file = new File([blob], fileName, { type: blob.type });
    const path = `${profile.organization_id}/${jobId}/installed-${angle}-${Date.now()}-${fileName}`;
    const { error } = await supabase.storage.from('installation-proof').upload(path, file);
    if (error) { alert('Upload failed: ' + error.message); return; }
    const { data: urlData } = supabase.storage.from('installation-proof').getPublicUrl(path);

    // Section 7 — perceptual hash + duplicate-across-shops check. Never
    // blocks the upload; only flags the row (and pings Admin/Owner) so a
    // reused photo is visible at Installation Review, not silently
    // accepted. Wrapped defensively — a hashing failure should never stop
    // an installer from submitting real work.
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

    const { data: inserted } = await supabase.from('installation_proofs').insert({
      organization_id: profile.organization_id,
      installation_job_id: jobId,
      shop_id: shopId,
      storage_path: path,
      photo_url: urlData.publicUrl,
      photo_type: 'installed',
      angle,
      phash,
      duplicate_flag: duplicateFlag,
      duplicate_of: duplicateOf,
      gps_lat: gps?.lat || null,
      gps_lng: gps?.lng || null,
      gps_accuracy: gps?.accuracy || null,
    }).select('id').single();

    if (duplicateFlag && inserted) {
      const { data: admins } = await supabase.from('profiles').select('id').eq('organization_id', profile.organization_id).in('role', ['agency_owner', 'admin']);
      for (const admin of admins || []) {
        await createNotification(admin.id, 'Duplicate Installation Photo Suspected', `An installation photo for ${shop?.name || 'a shop'} looks like it may have been reused from another site — review before approving.`, 'warning', '/installation-review');
      }
    }

    setProofPhotos([...proofPhotos, { url: urlData.publicUrl, type: 'installed', angle }]);
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
        for (const item of approvedItems) {
          const w = item.approved_width!;
          const h = item.approved_height!;
          const qty = item.approved_quantity || 1;
          const { error: itemError } = await supabase.from('work_items').update({
            installed_width: w,
            installed_height: h,
            installed_unit: item.approved_unit,
            installed_quantity: qty,
            installed_area: item.approved_area ?? w * h * qty,
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

      queryClient.invalidateQueries();
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

  const steps = exception
    ? ['Shop', 'Material Check', 'Photo', 'Exception', 'Submit']
    : ['Shop', 'Material Check', 'Photo', 'Review', 'Submit'];

  return (
    <div className="min-h-screen bg-slate-50 max-w-md mx-auto">
      <div className="bg-white border-b border-slate-200 sticky top-0 z-30">
        <div className="flex items-center justify-between p-4">
          <button onClick={() => onExit()} className="text-sm text-slate-500">Cancel</button>
          <p className="font-semibold text-slate-900">Step {step} of {steps.length}</p>
          <span className="text-xs text-slate-400">{steps[step - 1]}</span>
        </div>
        {jobQueuePosition >= 0 && jobQueueTotal > 0 && (
          <p className="px-4 pb-1 text-xs text-blue-600 font-medium">Job {jobQueuePosition + 1} of {jobQueueTotal} today</p>
        )}
        <div className="flex px-4 pb-3 gap-1">
          {steps.map((_, i) => (
            <div key={i} className={`h-1.5 flex-1 rounded-full ${i < step ? 'bg-blue-600' : 'bg-slate-200'}`} />
          ))}
        </div>
        <div className="px-4 pb-3">
          <LocationShareIndicator status={locStatus} lastSentAt={lastSentAt} />
        </div>
      </div>

      <CameraCapture
        open={!!cameraFor}
        onClose={() => setCameraFor(null)}
        onCapture={handlePhotoCaptured}
        title={cameraFor ? `${cameraFor.charAt(0).toUpperCase()}${cameraFor.slice(1)} Photo` : 'Photo'}
      />

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

            <Card className="p-4">
              <div className="flex items-center gap-2 mb-2">
                <MapPin className="w-5 h-5 text-blue-600" />
                <span className="font-medium text-slate-900">Location</span>
              </div>
              {gpsStatus === 'captured' && gps ? (
                <p className="text-sm text-green-600 flex items-center gap-1">
                  <CheckCircle2 className="w-4 h-4" /> Location captured ({gps.accuracy.toFixed(0)}m)
                </p>
              ) : gpsStatus === 'capturing' ? (
                <p className="text-sm text-blue-600 flex items-center gap-1"><Loader2 className="w-4 h-4 animate-spin" /> Capturing...</p>
              ) : (
                <p className="text-sm text-amber-600">Location unavailable</p>
              )}
            </Card>

            <ApprovedSpecsCard items={approvedItems} photos={surveyPhotos || []} markings={boardMarkings || []} />

            <button
              onClick={() => navigateToShop(shop)}
              className="w-full flex items-center justify-center gap-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 font-medium py-2.5 rounded-lg text-sm transition"
            >
              <Navigation className="w-4 h-4" /> Navigate to Shop
            </button>

            <button onClick={() => setStep(2)} className="w-full bg-slate-900 text-white font-medium py-3 rounded-lg">Continue</button>
          </div>
        )}

        {/* Step 2 — Material Check / Loading Register (vehicle/load check
            gate, §3.2/§9.4). Must be filled + photographed before Photo/
            Install unlocks — the installer records exactly how much of
            each approved board is physically loaded before heading out,
            not just a yes/no tick, so Owner/Admin can see produced vs
            loaded vs approved on Installation Review afterwards. */}
        {step === 2 && (
          <div className="space-y-4">
            {vehicleLoad ? (
              <div className="flex items-start gap-2.5 bg-emerald-50 border-2 border-emerald-300 rounded-xl px-3.5 py-3">
                <Package className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" />
                <div className="min-w-0">
                  <p className="text-sm font-bold text-emerald-800">Gaadi Load Ho Chuki Hai</p>
                  <p className="text-xs text-emerald-700 mt-0.5">
                    Vehicle <span className="font-semibold">{vehicleLoad.vehicle_number}</span>
                    {vehicleLoad.driver_name ? ` · Driver ${vehicleLoad.driver_name}` : ''} — neeche jo quantity dikh rahi hai wahi maal load kiya gaya hai. Gaadi par ek baar dekh lo sab sahi hai, kuch kam-zyada ho to number badal do, phir confirm kar do.
                  </p>
                </div>
              </div>
            ) : (
              <div className="flex items-start gap-2.5 bg-amber-50 border-2 border-amber-300 rounded-xl px-3.5 py-3">
                <AlertCircle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
                <p className="text-xs text-amber-800">Is shop ke liye Production ne abhi tak load record nahi kiya — jitna maal gaadi mein le ja rahe ho, wahi quantity yahan bhar do.</p>
              </div>
            )}
            <Card className="p-4">
              <div className="flex items-center gap-2 mb-1">
                <Package className="w-5 h-5 text-blue-600" />
                <span className="font-medium text-slate-900">Kitna Maal Gaya</span>
              </div>
              <p className="text-xs text-slate-500 mb-3">Har board ka utna number bharo jitna gaadi mein rakha hai. Approved quantity pehle se bhari hai — sirf badlo agar kam ja raha hai.</p>

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
                if (missing) { alert('Har board ka loaded quantity bharo, uske baad hi aage badh sakte ho.'); return; }
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
            <p className="text-sm text-slate-600">Installation ho jaane ke baad kaam ki photo lo. Kam se kam 1 photo lena zaroori hai — client jitni angles maangta hai, utni le sakte ho.</p>

            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => setCameraFor('front')}
                className={`flex flex-col items-center justify-center gap-1 border-2 font-bold py-3.5 rounded-xl ${proofPhotos.some((p) => p.angle === 'front') ? 'bg-green-50 border-green-300 text-green-700' : 'bg-blue-50 border-blue-200 text-blue-700'}`}
              >
                <Camera className="w-5 h-5" />
                <span className="text-sm">{proofPhotos.some((p) => p.angle === 'front') ? 'Front ✓ (retake)' : 'Front Photo'}</span>
              </button>
              <button
                onClick={() => setCameraFor('side')}
                className={`flex flex-col items-center justify-center gap-1 border-2 font-bold py-3.5 rounded-xl ${proofPhotos.some((p) => p.angle === 'side') ? 'bg-green-50 border-green-300 text-green-700' : 'bg-blue-50 border-blue-200 text-blue-700'}`}
              >
                <Camera className="w-5 h-5" />
                <span className="text-sm">{proofPhotos.some((p) => p.angle === 'side') ? 'Side ✓ (retake)' : 'Side Photo'}</span>
              </button>
            </div>

            <button
              onClick={() => setCameraFor('other')}
              className="w-full flex items-center justify-center gap-2 text-slate-500 text-sm font-medium py-2"
            >
              <Camera className="w-4 h-4" /> Ek aur photo jodo (optional)
            </button>

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
                if (proofPhotos.length === 0) { alert('Aage badhne se pehle kam se kam 1 photo lo.'); return; }
                setStep(4);
              }}
              className="w-full bg-slate-900 text-white font-medium py-3 rounded-lg"
            >
              Continue
            </button>
            <button onClick={() => setStep(2)} className="w-full flex items-center justify-center gap-1 bg-slate-200 text-slate-700 font-medium py-3 rounded-lg">
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
                  {approvedItems.map((it) => (
                    <div key={it.id} className="flex items-center justify-between bg-slate-50 rounded-lg px-3 py-2 text-sm">
                      <div>
                        <p className="font-medium text-slate-900">{it.material || it.work_type_name || 'Item'}</p>
                        <p className="text-xs text-slate-500">{formatDim(it.approved_width)}×{formatDim(it.approved_height)} {it.approved_unit} · Qty {it.approved_quantity || 1}</p>
                      </div>
                      <p className="text-xs font-semibold text-blue-600">{it.approved_area != null ? Math.round(it.approved_area) : ''} sq {it.approved_unit}</p>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-slate-400">No approved measurements found for this shop.</p>
              )}
              <p className="text-xs text-slate-400 mt-2">These are the measurements approved by your Admin/Owner during survey review — installed as-is, no need to re-enter them.</p>
              <div className="mt-3">
                <Textarea label="Note for reviewer (optional)" value={installNotes} onChange={setInstallNotes} rows={2} />
              </div>
            </Card>

            <div className="flex gap-2">
              <button onClick={() => setStep(3)} className="flex items-center justify-center gap-1 bg-slate-200 text-slate-700 font-medium py-3 rounded-lg flex-1">
                <ChevronLeft className="w-4 h-4" /> Back
              </button>
              <button onClick={() => setStep(5)} className="bg-slate-900 text-white font-medium py-3 rounded-lg flex-1">Continue</button>
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
              <button onClick={() => { setException(null); setStep(3); }} className="flex items-center justify-center gap-1 bg-slate-200 text-slate-700 font-medium py-3 rounded-lg flex-1">
                <ChevronLeft className="w-4 h-4" /> Back
              </button>
              <button onClick={() => setStep(5)} className="bg-slate-900 text-white font-medium py-3 rounded-lg flex-1">Continue</button>
            </div>
          </div>
        )}

        {/* Submit */}
        {step === 5 && (
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
function ApprovedSpecsCard({ items, photos, markings }: { items: WorkItem[]; photos: SurveyPhoto[]; markings: BoardMarking[] }) {
  if (items.length === 0 && photos.length === 0) return null;

  return (
    <Card className="p-4">
      <div className="flex items-center gap-2 mb-3">
        <Ruler className="w-5 h-5 text-blue-600" />
        <span className="font-medium text-slate-900">Approved Installation Details</span>
      </div>

      {items.length > 0 && (
        <div className="space-y-2 mb-3">
          {items.map((it) => (
            <div key={it.id} className="flex items-center justify-between bg-blue-50 rounded-lg px-3 py-2 text-sm">
              <div>
                <p className="font-medium text-slate-900">{it.material || it.work_type_name || 'Item'}</p>
                <p className="text-xs text-slate-500">{formatDim(it.approved_width)}×{formatDim(it.approved_height)} {it.approved_unit}{it.approved_notes ? ` · ${it.approved_notes}` : ''}</p>
              </div>
              <p className="text-sm font-bold text-blue-700 shrink-0 pl-2">×{it.approved_quantity || 1}</p>
            </div>
          ))}
        </div>
      )}

      {photos.length > 0 && (
        <>
          <p className="text-xs text-slate-400 mb-1.5">Survey mein jaha mark kiya gaya waha hi lagana hai — photo par tap karke bada dekh sakte ho:</p>
          <MarkedPhotoGrid photos={photos} markings={markings} workItems={items} />
        </>
      )}
    </Card>
  );
}
