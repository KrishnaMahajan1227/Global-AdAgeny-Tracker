import { FieldNavigation } from '@/components/FieldNavigation';
import { offlineDb, pendingInstallationPhotos, newLocalId, type PendingInstallationPhoto } from '@/lib/offlineDb';
import { syncInstallationPhoto, syncInstallationPhotos, isInstallationPhotoSyncing, loadInstallationProofs } from '@/lib/installationSync';
import { fieldNotice, fieldConfirm } from '@/lib/fieldDialogs';
import { loadFieldAssignments, loadAssignedFieldShop } from '@/lib/fieldAssignments';
import { loadRedoDrafts, queueRedoDraft, redoDraftId, syncRedoDraft, type RedoDraft } from '@/lib/fieldRedo';
import { useOnlineStatus } from '@/lib/useOnlineStatus';
import { useState, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { Card, Select, Textarea, Input, EmptyState, StatusBadge } from '@/components/ui';
import { logAudit, createNotification } from '@/lib/helpers';
import { submitCorrections, setAvailability } from '@/lib/reviewApi';
import { useRealtimeInvalidate } from '@/lib/useRealtimeInvalidate';
import { CameraCapture } from '@/components/CameraCapture';
import { formatDim, LENGTH_UNIT_OPTIONS, areaSqFt, itemSizeLabel, toFeet } from '@/lib/units';
import { useLiveLocationTracking } from '@/lib/locationTracking';
import { MarkedPhotoGrid } from '@/components/MarkedPhotoGrid';
import { computeImageHash, hammingDistance, DUPLICATE_HASH_THRESHOLD } from '@/lib/imageHash';
import { haversineDistanceMeters, GPS_DISTANCE_FLAG_METERS } from '@/lib/geoDistance';
import { reverseGeocode } from '@/lib/geocode';
import { stampGeoTag, ensureLandscape } from '@/lib/geoStamp';
import { capturePhotoLocation } from '@/lib/captureLocation';
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


function InstallerEntry({ shopId, onExit }: { shopId: string; onExit: (nextShopId?: string) => void }) {
  const { profile } = useAuth();
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['installer-entry-context', shopId, profile?.id],
    queryFn: async () => {
      const [corrections, selectedShop] = await Promise.all([
        supabase.from('field_corrections').select('id', { count: 'exact', head: true }).eq('shop_id', shopId).eq('stage', 'installation').eq('assigned_to', profile!.id).eq('status', 'open'),
        supabase.from('shops').select('id,status').eq('id', shopId).maybeSingle(),
      ]);
      // Do not treat a failed correction query as zero corrections: that
      // could send a returned job down the new-install path.
      if (corrections.error) throw new Error(`Unable to check installation corrections: ${corrections.error.message}`);
      if (selectedShop.error) throw new Error(`Unable to load shop: ${selectedShop.error.message}`);
      if (!selectedShop.data) throw new Error('Shop is unavailable or you do not have access.');
      return { correctionCount: corrections.count || 0, shopStatus: selectedShop.data.status || null };
    }, enabled: !!profile?.id,
  });
  if (isLoading) return <div className="p-8 text-center text-slate-500 text-sm">Loading installation…</div>;
  if (isError && !data) return <div className="mx-auto max-w-md p-4"><div role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"><p className="font-semibold">Cannot open this job yet</p><p className="mt-2 break-words">{error instanceof Error ? error.message : 'Unable to load the job.'}</p><div className="mt-3 flex gap-2"><button type="button" onClick={() => void refetch()} className="rounded-lg bg-slate-900 px-3 py-2 font-medium text-white">Retry</button><button type="button" onClick={() => onExit()} className="rounded-lg border border-slate-300 bg-white px-3 py-2">Back to jobs</button></div></div></div>;
  if ((data?.correctionCount || 0) > 0) return <InstallationWizard shopId={shopId} onExit={onExit} />;
  if (!READY_STATUSES.includes(data?.shopStatus || '')) return <InstallationSubmissionViewer shopId={shopId} onExit={() => onExit()} />;
  return <InstallationWizard shopId={shopId} onExit={onExit} />;
}

function InstallationSubmissionViewer({ shopId, onExit }: { shopId: string; onExit: () => void }) {
  const { profile } = useAuth();
  const { data: shop } = useQuery({
    queryKey: ['installer-view-shop', shopId],
    queryFn: async () => {
      return loadAssignedFieldShop(shopId, profile!.id, profile!.organization_id, 'installer');
    },
    enabled: !!shopId && !!profile?.id,
  });
  const { data: workItems = [] } = useQuery({
    queryKey: ['installer-view-items', shopId],
    queryFn: async () => {
      const { data } = await supabase.from('work_items').select('*').eq('shop_id', shopId).order('created_at');
      return (data || []) as WorkItem[];
    },
    enabled: !!shopId,
  });
  const { data: latestJob } = useQuery({
    queryKey: ['installer-view-job', shopId],
    queryFn: async () => {
      const { data } = await supabase.from('installation_jobs').select('id,status,started_at,completed_at,notes').eq('shop_id', shopId).eq('installer_id', profile!.id).order('completed_at', { ascending: false, nullsFirst: false }).order('created_at', { ascending: false }).limit(1).maybeSingle();
      return data as any;
    },
    enabled: !!shopId && !!profile?.id,
  });
  const { data: proofs = [] } = useQuery({
    queryKey: ['installer-view-proofs', latestJob?.id],
    queryFn: async () => {
      const { data } = await supabase.from('installation_proofs').select('id,photo_url,work_item_id,angle,photo_type').eq('installation_job_id', latestJob!.id).order('captured_at');
      return (data || []) as { id: string; photo_url: string; work_item_id?: string | null; angle?: string | null; photo_type?: string | null }[];
    },
    enabled: !!latestJob?.id,
  });

  const { data: referencePhotos = [] } = useQuery({
    queryKey: ['installer-submission-marked-reference', shopId],
    queryFn: async () => {
      const { data, error } = await supabase.from('survey_photos').select('*').eq('shop_id', shopId).order('created_at');
      if (error) throw error;
      return (data || []) as SurveyPhoto[];
    }, enabled: !!shopId,
  });
  const { data: referenceMarkings = [] } = useQuery({
    queryKey: ['installer-submission-markings', shopId, referencePhotos.map((photo) => photo.id).join(',')],
    queryFn: async () => {
      if (!referencePhotos.length) return [] as BoardMarking[];
      const { data, error } = await supabase.from('board_markings').select('*')
        .in('survey_photo_id', referencePhotos.map((photo) => photo.id));
      if (error) throw error;
      return (data || []) as BoardMarking[];
    }, enabled: referencePhotos.length > 0,
  });

  return (
    <div className="min-h-screen bg-slate-50 pb-24 max-w-md mx-auto">
      <div className="sticky top-0 z-20 border-b border-slate-200 bg-white/95 backdrop-blur">
        <div className="flex items-center justify-between px-4 py-3">
          <button onClick={onExit} className="text-sm font-medium text-slate-600">Back</button>
          <p className="text-sm font-semibold text-slate-900">Submitted Installation</p>
          <button type="button" onClick={() => navigateToShop(shop)} className="text-sm font-medium text-blue-600">Map</button>
        </div>
      </div>
      <div className="p-4 space-y-4">
        <Card className="p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-lg font-semibold text-slate-900">{shop?.name || 'Shop'}</p>
              <p className="mt-1 text-sm text-slate-500">{shop?.clients?.name || 'Client'}{shop?.purchase_orders ? ` · ${shop.purchase_orders.name || shop.purchase_orders.po_number || 'Work Order'}` : ''}</p>
            </div>
            <StatusBadge status={latestJob?.status || shop?.status || 'installation_review'} />
          </div>
          <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
            <div className="rounded-xl bg-slate-50 px-3 py-2"><p className="text-slate-500">Work items</p><p className="mt-1 font-semibold text-slate-900">{workItems.length}</p></div>
            <div className="rounded-xl bg-slate-50 px-3 py-2"><p className="text-slate-500">Photos</p><p className="mt-1 font-semibold text-slate-900">{proofs.length}</p></div>
            <div className="rounded-xl bg-slate-50 px-3 py-2"><p className="text-slate-500">Completed</p><p className="mt-1 font-semibold text-slate-900">{latestJob?.completed_at ? new Date(latestJob.completed_at).toLocaleDateString() : '—'}</p></div>
          </div>
          {latestJob?.notes && <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700"><p className="font-semibold">Submission note</p><p className="mt-1">{latestJob.notes}</p></div>}
          <p className="mt-3 text-xs text-slate-500">This installation is already submitted. Crew can still reopen this screen later to verify what was uploaded.</p>
        </Card>

        {referencePhotos.length > 0 && <Card className="p-3">
          <h2 className="text-sm font-semibold text-slate-900">Approved marked survey reference</h2>
          <p className="mt-1 mb-3 text-xs text-slate-500">Original boards and markings used for installation.</p>
          <MarkedPhotoGrid photos={referencePhotos} markings={referenceMarkings} workItems={workItems} />
        </Card>}
        <Card className="p-4">
          <h2 className="text-sm font-semibold text-slate-900">Installed work items</h2>
          <div className="mt-3 space-y-3">
            {workItems.length === 0 && <p className="text-xs text-slate-500">No work items found.</p>}
            {workItems.map((item, idx) => {
              const itemProofs = proofs.filter((p) => p.work_item_id === item.id || (!p.work_item_id && workItems.length === 1));
              return <div key={item.id} className="rounded-2xl border border-slate-200 bg-white p-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-slate-900">{item.work_type_name || item.material || `Work Item ${idx + 1}`}</p>
                    <p className="mt-1 text-xs text-slate-500">{itemSizeLabel(item, item.installed_width != null && item.approved_width == null ? 'installed' : 'approved')}{(item.approved_quantity || item.installed_quantity) ? ` · Qty ${item.approved_quantity || item.installed_quantity}` : ''}</p>
                  </div>
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-700">{itemProofs.length} photo{itemProofs.length === 1 ? '' : 's'}</span>
                </div>
                {!!item.notes && <p className="mt-2 text-xs text-slate-600">{item.notes}</p>}
                {itemProofs.length > 0 && <div className="mt-3 grid grid-cols-3 gap-2">{itemProofs.map((p) => <div key={p.id} className="aspect-[4/3] overflow-hidden rounded-xl bg-slate-100"><img src={p.photo_url} alt="Installation proof" className="h-full w-full object-contain" /></div>)}</div>}
              </div>;
            })}
          </div>
        </Card>
      </div>
    </div>
  );
}

export default function InstallerPage() {
  const { profile, signOut } = useAuth();
  const [tab, setTab] = useState<MobileTab>('work');
  const [activeJob, setActiveJob] = useState<string | null>(null);
  const [directInstallOpen, setDirectInstallOpen] = useState(false);

  if (activeJob) {
    return <><InstallerEntry shopId={activeJob} onExit={(nextShopId) => setActiveJob(nextShopId || null)} /></>;
  }

  if (directInstallOpen) {
    return <><DirectInstallWizard onExit={() => setDirectInstallOpen(false)} /></>;
  }

  return (
    <div className="min-h-screen bg-slate-50 pb-20 max-w-md mx-auto">
      
      {(tab === 'home' || tab === 'work') && <InstallerWork onStart={(shopId) => setActiveJob(shopId)} onDirectInstall={() => setDirectInstallOpen(true)} />}
      {tab === 'map' && <FieldMapView />}
      {tab === 'notifications' && <NotificationsView />}
      {tab === 'profile' && <ProfileView onSignOut={signOut} />}

      <FieldNavigation tab={tab} onChange={setTab} />
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
      return loadFieldAssignments(profile!.id, profile!.organization_id, 'installer');
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

function InstallerWork({ onStart, onDirectInstall }: { onStart: (shopId: string) => void; onDirectInstall: () => void }) {
  const { profile } = useAuth();
  const orgId = profile?.organization_id;

  const { data: assignments } = useQuery({
    queryKey: ['installer-work', profile?.id],
    queryFn: async () => {
      return loadFieldAssignments(profile!.id, profile!.organization_id, 'installer');
    },
    enabled: !!profile?.id,
  });

  useRealtimeInvalidate(['shop_assignments', 'shops', 'installation_jobs', 'field_corrections'], orgId, [['installer-work', profile?.id], ['installer-open-corrections', profile?.id]]);

  // Preserve existing Direct Install jobs even though the duplicate Home screen is gone.
  const { data: directInstallPOs = [] } = useQuery({
    queryKey: ['direct-install-pos', orgId, profile?.id],
    queryFn: async () => {
      const { data: assigned, error: assignmentError } = await supabase.from('po_assignments')
        .select('purchase_order_id').eq('user_id', profile!.id).eq('role', 'installer');
      if (assignmentError) throw assignmentError;
      const ids = (assigned || []).map((row) => row.purchase_order_id);
      if (!ids.length) return [];
      const { data, error } = await supabase.from('v_po_work_context').select('id,name,po_number')
        .eq('organization_id', orgId).eq('status','active').eq('fulfillment_type','direct_install').in('id',ids);
      if (error) throw error;
      return data || [];
    }, enabled: !!profile?.id && !!orgId,
  });
  const shopIds = (assignments || []).map((a) => a.shop_id);

  // Open redo tasks are authoritative. A shop can be in installation_review and
  // still must immediately re-open for this installer when Owner/Admin sends a
  // specific Work Item back. Do not rely on shop status alone.
  const { data: openCorrections = [], isError: correctionsListFailed, error: correctionsListError, refetch: retryCorrectionsList } = useQuery({
    queryKey: ['installer-open-corrections', profile?.id],
    queryFn: async () => {
      const { data, error } = await supabase.from('field_corrections')
        .select('id,shop_id,work_item_id,installation_proof_id,issue_type,note,created_at')
        .eq('stage','installation').eq('assigned_to',profile!.id).eq('status','open')
        .order('created_at',{ascending:false});
      if (error) throw error;
      return data || [];
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
      <div className="mb-3 flex items-center justify-between gap-2"><h1 className="text-lg font-semibold text-slate-900">My Installations</h1>
        {directInstallPOs.length > 0 && <button type="button" onClick={onDirectInstall} className="rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800">Direct install</button>}
      </div>
      {correctionsListFailed && <div role="alert" className="mb-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900"><p className="font-semibold">Correction status unavailable</p><p className="mt-1">{correctionsListError instanceof Error ? correctionsListError.message : 'Could not load returned jobs.'}</p><button type="button" className="mt-2 rounded-lg bg-white px-3 py-1.5 font-semibold ring-1 ring-amber-200" onClick={() => void retryCorrectionsList()}>Retry</button></div>}
      <AssignedShopList
        assignments={assignments || []}
        getButtonState={(a) => {
          const shopStatus = a.shops?.status || 'pending';
          const redo = correctionsByShop.get(a.shop_id) || [];
          const isInstalled = shopStatus === 'installed';
          const isAwaitingApproval = shopStatus === 'installation_review';
          const isReady = READY_STATUSES.includes(shopStatus);
          if (redo.length) return { label: `Fix Redo (${redo.length})`, disabled: false, tone: 'amber' as const };
          if (isInstalled) return { label: 'View Submission', disabled: false, done: true, tone: 'slate' as const };
          if (isAwaitingApproval) return { label: 'View Submission', disabled: false, done: true, tone: 'slate' as const };
          if (!isReady) return { label: 'Not Ready Yet', disabled: true, tone: 'slate' as const };
          return { label: 'Start Install', disabled: false, tone: 'blue' as const };
        }}
        onStart={onStart}
        emptyLabel="No installations assigned"
        renderExtra={(a) => { const redo=correctionsByShop.get(a.shop_id)||[]; if(!redo.length)return null; return <div className="mt-2 rounded-xl border border-amber-300 bg-amber-50 p-2.5"><p className="text-xs font-bold text-amber-900">Redo requested · {redo.length} item{redo.length===1?'':'s'}</p><p className="text-[11px] text-amber-700 mt-0.5">Open this shop to see the full redo context and fix only the Work Item(s) returned by Owner/Admin.</p>{redo.slice(0,2).map((c:any)=><p key={c.id} className="text-[11px] text-amber-800 mt-1">• {c.note||'Installation evidence needs correction'}</p>)}</div> }}
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
              {it.approved_width && it.approved_height ? ` — ${itemSizeLabel(it)}` : ''}
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
  const [proofPhotos, setProofPhotos] = useState<{ id?: string; storagePath?: string; url: string; type: string; angle: 'front' | 'side' | 'other'; workItemId?: string; queued?: boolean }[]>([]);
  const [queuedCount, setQueuedCount] = useState(0);
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
  const online = useOnlineStatus();
  const [redoDrafts, setRedoDrafts] = useState<Record<string, RedoDraft>>({});
  const [redoBusy, setRedoBusy] = useState<string | null>(null);
  const [redoError, setRedoError] = useState('');
  const redoAutoSyncAttempted = useRef(new Set<string>());
  const [unavail, setUnavail] = useState<{ item: WorkItem; reason: string; note: string; file: File | null } | null>(null);
  const [unavailBusy, setUnavailBusy] = useState(false);

  // Live location sharing while this installation is in progress — pinged
  // to worker_locations so the Owner/Admin Live Field Map shows the
  // installer moving in real time, same as the surveyor flow.
  useLiveLocationTracking(true, profile?.id, profile?.organization_id);

  const { data: correctionTasks, isLoading: correctionsLoading, isError: correctionsFailed, error: correctionsError, refetch: retryCorrections } = useQuery({
    queryKey: ['installation-field-corrections', shopId, profile?.id],
    queryFn: async () => {
      // First fetch only columns in migration 0057, so normal installations do
      // not query replacement_saved_at (introduced later in migration 0091).
      const { data: base, error: baseError } = await supabase.from('field_corrections')
        .select('id,issue_type,note,work_item_id,installation_proof_id,created_at')
        .eq('shop_id', shopId).eq('stage', 'installation').eq('assigned_to', profile!.id)
        .eq('status', 'open').order('created_at');
      if (baseError) throw new Error(`Could not check returned work: ${baseError.message}`);
      if (!base?.length) return [];
      // The server acknowledgement is mandatory for redo submission. If 0091
      // has not been deployed, do NOT hide returned jobs or assume they are saved.
      const { data: saved, error: savedError } = await supabase.from('field_corrections')
        .select('id,replacement_saved_at').in('id', base.map((item) => item.id));
      if (savedError) throw new Error(`Redo confirmation is unavailable. Check that migration 0091 is applied. ${savedError.message}`);
      const savedById = new Map((saved || []).map((item) => [item.id, item.replacement_saved_at]));
      return base.map((item) => ({ ...item, replacement_saved_at: savedById.get(item.id) ?? null }));
    },
    enabled: !!shopId && !!profile?.id,
  });

  useEffect(() => {
    if (!profile?.id) return;
    let active = true;
    loadRedoDrafts(profile.id, shopId, 'installation').then((drafts) => {
      if (active) setRedoDrafts(Object.fromEntries(drafts.map((draft) => [draft.correctionId, draft])));
    }).catch((err) => setRedoError(String(err)));
    return () => { active = false; };
  }, [profile?.id, shopId]);

  async function uploadSavedRedo(draft: RedoDraft) {
    if (!online) return;
    setRedoBusy(draft.correctionId); setRedoError('');
    try {
      await syncRedoDraft(draft);
      setRedoDrafts((current) => { const next = { ...current }; delete next[draft.correctionId]; return next; });
      await queryClient.invalidateQueries({ queryKey: ['installation-field-corrections', shopId] });
      await queryClient.invalidateQueries({ queryKey: ['shop-installation-proofs'] });
      // The previous submission photo ID stays intact; reload the canonical server rows.
      await queryClient.invalidateQueries({ queryKey: ['installer-view-proofs'] });
      if (jobId) { try { setProofPhotos(await loadInstallationProofs(jobId)); } catch { /* retry on refresh */ } }
    } catch (err: any) { setRedoError(err?.message || 'Upload failed. Your image is still saved on this device.'); }
    finally { setRedoBusy(null); }
  }

  useEffect(() => {
    if (!online) { redoAutoSyncAttempted.current.clear(); return; }
    const draft = Object.values(redoDrafts).find((item) => item.payload.ready && !redoAutoSyncAttempted.current.has(item.correctionId));
    if (!draft || redoBusy) return;
    redoAutoSyncAttempted.current.add(draft.correctionId);
    void uploadSavedRedo(draft);
  }, [online, redoDrafts, redoBusy]);

  async function queueRedoImage(c: any, dataUrl: string, fileName: string) {
    if (!profile) return;
    setCameraFor(null);
    setRedoError('');
    try {
      // Keep geo-stamp while preserving a durable original capture locally until the RPC acknowledges it.
      let stamped = dataUrl;
      try { stamped = await stampGeoTag(await ensureLandscape(dataUrl), {
        siteName: shop?.name, addressLine: [shop?.address, shop?.city, shop?.state].filter(Boolean).join(', '),
        lat: gps?.lat ?? null, lng: gps?.lng ?? null, accuracy: gps?.accuracy ?? null,
      }); } catch { /* Keep the original captured file if stamping is unavailable. */ }
      const draft: RedoDraft = { id: redoDraftId(profile.id, c.id), userId: profile.id, shopId,
        stage: 'installation', correctionId: c.id, status: 'queued', updatedAt: new Date().toISOString(),
        payload: { dataUrl: stamped, fileName, organizationId: profile.organization_id, angle: 'front', ready: true },
      };
      await queueRedoDraft(draft);
      setRedoDrafts((previous) => ({ ...previous, [c.id]: draft }));
      if (online) { redoAutoSyncAttempted.current.add(c.id); await uploadSavedRedo(draft); }
    } catch (err: any) { setRedoError(err?.message || 'Unable to save replacement image'); }
  }

  async function chooseRedoImage(c: any, file: File) {
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error || new Error('Could not read photo'));
        reader.readAsDataURL(file);
      });
      await queueRedoImage(c, dataUrl, file.name);
    } catch (err: any) { setRedoError(err?.message || 'Could not save photo'); }
  }

  async function submitRedo() {
    setRedoBusy('submit'); setRedoError('');
    try {
      await submitCorrections('installation', shopId);
      await queryClient.invalidateQueries();
      await queryClient.invalidateQueries();
      setCompleted(true);
    } catch (err: any) { setRedoError(err?.message || 'Could not submit corrected work'); }
    finally { setRedoBusy(null); }
  }

  const { data: shop } = useQuery({
    queryKey: ['shop', shopId],
    queryFn: async () => {
      return loadAssignedFieldShop(shopId, profile!.id, profile!.organization_id, 'installer');
    },
  });

  // The compact queue query has a different response shape from the main
  // installation list. A distinct query key prevents corrupting that cache.
  const { data: pendingJobAssignments } = useQuery({
    queryKey: ['installer-ready-job-queue', profile?.id],
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
      try { await setAvailability(item.id, false, null, null); } catch (e: any) { fieldNotice(e.message); return; }
      await queryClient.invalidateQueries({ queryKey: ['shop-work-items-install', shopId] });
      await queryClient.invalidateQueries({ queryKey: ['shop-work-items', shopId] });
      return;
    }
    setUnavail({ item, reason: item.execution_reason || '', note: item.execution_note || '', file: null });
  }

  async function saveUnavailable() {
    if (!unavail) return;
    const { item, reason, note, file } = unavail;
    if (!reason.trim()) { fieldNotice('A reason is required.'); return; }
    if (!file) { fieldNotice('A site photo is required.'); return; }
    setUnavailBusy(true);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = () => reject(r.error); r.readAsDataURL(file); });
      await handlePhotoCaptured(dataUrl, file.name, 'other', item.id, `NOT INSTALLED: ${reason.trim()}`);
      await setAvailability(item.id, true, reason.trim(), note.trim() || null);
      if (selectedProofWorkItemId === item.id) setSelectedProofWorkItemId('');
      setUnavail(null);
      await queryClient.invalidateQueries({ queryKey: ['shop-work-items-install', shopId] });
      await queryClient.invalidateQueries({ queryKey: ['shop-work-items', shopId] });
    } catch (e: any) { fieldNotice(`Could not mark not available: ${e?.message || e}`); } finally { setUnavailBusy(false); }
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
      if (existing.error) { setJobBlockedReason(`Cannot load installation job: ${existing.error.message}`); return; }
      if (existing.data && existing.data.length) { setJobId(existing.data[0].id); return; }
      // Never create a new installation job while redo state is unresolved,
      // or for a returned correction that must update the existing job.
      if (correctionsLoading || correctionsFailed || (correctionTasks || []).length > 0) return;
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
  }, [profile, shop, shopId, jobId, correctionsLoading, correctionsFailed, correctionTasks]);

  // Resume an interrupted shop exactly from persisted server evidence.
  // Photos are uploaded immediately, so switching to another shop never
  // discards completed captures. When this shop is opened again, reload the
  // proof rows and their Work Item mappings instead of starting with an empty
  // in-memory photo list.
  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    void loadInstallationProofs(jobId)
      .then(remote=>{if (!cancelled) setProofPhotos(current=>[...remote,...current.filter(p=>p.queued)]);})
      .catch(error=>{if(!cancelled) console.warn('Unable to refresh installation photos',error);});
    return () => { cancelled = true; };
  }, [jobId]);

  // Keep locally queued photos visible after closing/reopening, including
  // their original Work Item mapping, until the server confirms them.
  useEffect(() => {
    if (!profile?.id) return;
    let cancelled = false;
    const refresh = async () => {
      const pending = await pendingInstallationPhotos(profile.id, shopId);
      if (cancelled) return;
      setQueuedCount(pending.length);
      setProofPhotos(current => {
        const remote = current.filter(p => !p.queued);
        return [...remote,...pending.map(p => ({id:`local:${p.id}`,url:p.dataUrl,type:'installed',angle:p.angle,workItemId:p.workItemId||undefined,queued:true}))];
      });
    };
    void refresh();
    const onResume = () => void refresh();
    window.addEventListener('focus',onResume);
    return () => { cancelled = true;window.removeEventListener('focus',onResume); };
  }, [profile?.id, shopId]);

  useEffect(() => {
    if (!profile?.id || !online) return;
    let cancelled = false;
    const flush = async () => {
      const results = await syncInstallationPhotos(profile.id);
      if (cancelled) return;
      if (results.length) {
        const remoteById = new Map(results.map(item=>[`local:${item.localId}`,item.remote]));
        setProofPhotos(current=>current.map(p=>{
          const uploaded = remoteById.get(p.id || '');
          return uploaded ? {id:uploaded.id,url:uploaded.url,storagePath:uploaded.storagePath,
            type:'installed',angle:uploaded.angle,workItemId:uploaded.workItemId} : p;
        }));
      }
      const remaining=await pendingInstallationPhotos(profile.id,shopId);
      if (cancelled) return;
      setQueuedCount(remaining.length);
      if (jobId) {
        try {
          const remote=await loadInstallationProofs(jobId);
          if (cancelled) return;
          const stillQueued=new Set(remaining.map(x=>`local:${x.id}`));
          setProofPhotos(current=>[...remote,...current.filter(p=>p.queued&&stillQueued.has(p.id||''))]);
        } catch (error) { console.warn('Photo sync completed but refresh failed',error); }
      }
      if (results.length) void queryClient.invalidateQueries({queryKey:['shop',shopId]});
    };
    void flush().catch((error) => console.warn('Photo sync deferred; evidence remains stored on this device:', error));
    const onReconnect = () => void flush().catch((error) => console.warn('Photo sync retry deferred:', error));
    window.addEventListener('online', onReconnect);
    return () => { cancelled = true; window.removeEventListener('online', onReconnect); };
  }, [profile?.id, shopId, jobId, online, queryClient]);

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
      fieldNotice(`Could not save the material check: ${err?.message || 'Unknown error'}. Please try again.`);
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
    const photoGps = await capturePhotoLocation(gps);
    if (photoGps) { setGps(photoGps); setGpsStatus('captured'); }
    let uploadDataUrl = dataUrl;
    try {
      uploadDataUrl = await ensureLandscape(dataUrl);
      uploadDataUrl = await stampGeoTag(uploadDataUrl, {
        siteName: shop?.name,
        addressLine: [shop?.address, shop?.city, shop?.state].filter(Boolean).join(', ') || null,
        lat: photoGps?.lat ?? null,
        lng: photoGps?.lng ?? null,
        accuracy: photoGps?.accuracy ?? null,
      });
    } catch (stampErr) {
      console.error('[handlePhotoCaptured] geo-tag stamp failed (non-fatal, uploading unstamped):', stampErr);
    }

    // Durable-first: do not start a network upload until IndexedDB confirms
    // that the original marked/geostamped photo is saved on this device.
    const id = newLocalId();
    let originalHash: string | null = null;
    try { originalHash = await computeImageHash(dataUrl); } catch { /* optional duplicate detection */ }
    const cleanName = fileName.replace(/[^a-zA-Z0-9._-]/g,'_').slice(-90);
    const entry: PendingInstallationPhoto = {
      id, workerId:profile.id, organizationId:profile.organization_id,
      shopId, jobId, path:`${profile.organization_id}/${jobId}/installed-${angle}-${id}-${cleanName}`,
      dataUrl:uploadDataUrl, originalHash, angle,
      workItemId: explicitWorkItemId || selectedProofWorkItemId || (approvedItems.length===1?approvedItems[0].id:null),
      caption:caption || null, gps:photoGps, createdAt:new Date().toISOString(),
    };
    try { await offlineDb.installationPhotos.put(entry); }
    catch (error) { fieldNotice('Device storage is full or unavailable. The captured photo could not be saved. Free up space and try again.'); throw error; }
    setQueuedCount(count=>count+1);
    setProofPhotos(current=>[...current,{id:`local:${id}`,url:uploadDataUrl,type:'installed',angle,
      workItemId:entry.workItemId||undefined,queued:true}]);
    if (navigator.onLine) {
      const synced = await syncInstallationPhoto(entry);
      if (synced) {
        setQueuedCount(count=>Math.max(0,count-1));
        setProofPhotos(current=>current.map(p=>p.id===`local:${id}`
          ? {id:synced.id,storagePath:synced.storagePath,url:synced.url,type:'installed',
              angle:synced.angle,workItemId:synced.workItemId} : p));
      }
    }

  }


  async function handleInstallationFileSelection(files: FileList | null, explicitWorkItemId?: string) {
    if (!files?.length) return;
    const targetWorkItemId = explicitWorkItemId || selectedProofWorkItemId;
    if (approvedItems.length > 1 && !targetWorkItemId) {
      fieldNotice('Select the exact work item / measurement before uploading photos.');
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
    if (failures.length) fieldNotice(`${uploaded} of ${selected.length} photos uploaded.\n${failures.join('\n')}`);
  }

  async function deleteInstallationPhoto(photo: { id?: string; storagePath?: string; url: string }) {
    if (photo.id?.startsWith('local:')) {
      const localId = photo.id.slice(6);
      if (isInstallationPhotoSyncing(localId)) {fieldNotice('This photo is uploading. Retry after it has synced.'); return;}
      if (!await fieldConfirm('Remove this unsent photo from this device? It cannot be recovered.', 'Remove unsent photo?')) return;
      await offlineDb.installationPhotos.delete(localId);
      setQueuedCount(c=>Math.max(0,c-1));
      setProofPhotos(current=>current.filter(p=>p.id!==photo.id));
      return;
    }
    if (!await fieldConfirm('Remove this installation photo? Its work item remains unchanged.', 'Remove photo?')) return;
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
      fieldNotice(`Could not delete photo: ${err?.message || 'Unknown error'}`);
    }
  }

  async function uploadMappedGallery() {
    if (!bulkGalleryFiles.length) return;
    const missing = bulkGalleryFiles.findIndex((_, i) => !bulkGalleryMap[i]);
    if (missing >= 0) { fieldNotice(`Choose a work item for photo ${missing + 1}.`); return; }
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
    if (failures.length) fieldNotice(`${uploaded} of ${bulkGalleryFiles.length} photos uploaded.\n${failures.join('\n')}`);
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
      fieldNotice(`Failed to complete installation: ${err?.message || 'Unknown error'}. Nothing was marked done — please try again.`);
    } finally {
      setSubmitting(false);
    }
  }

  // A redo is NOT a fresh installation. Show the returned evidence, approved
  // measurements and marked survey references, then replace only the linked proof.
  // This bypasses the new-install wizard and prevents duplicate submissions.
  if (correctionsLoading) return <div className="mx-auto max-w-md p-6 text-center text-sm text-slate-500">Checking installation status…</div>;
  if (correctionsFailed && correctionTasks === undefined) return <div className="mx-auto max-w-md p-4"><div role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"><p className="font-semibold">Unable to verify corrections</p><p className="mt-2 break-words">{correctionsError instanceof Error ? correctionsError.message : 'Please retry when connected.'}</p><div className="mt-3 flex gap-2"><button type="button" onClick={() => void retryCorrections()} className="rounded-lg bg-slate-900 px-3 py-2 font-medium text-white">Retry</button><button type="button" onClick={() => onExit()} className="rounded-lg border border-slate-300 bg-white px-3 py-2">Back</button></div></div></div>;

  if ((correctionTasks || []).length > 0 && !completed) {
    const ready = correctionTasks!.every((c: any) => !!c.replacement_saved_at && !redoDrafts[c.id]);
    return <div className="mx-auto min-h-screen max-w-md bg-slate-50 pb-28">
      <div className="sticky top-0 z-30 flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-3">
        <button type="button" onClick={() => onExit()} className="rounded-lg p-1 text-slate-600" aria-label="Back"><ChevronLeft className="h-5 w-5" /></button>
        <div className="min-w-0"><h1 className="truncate text-sm font-semibold text-slate-900">Installation corrections</h1><p className="truncate text-xs text-slate-500">{shop?.name || 'Shop'} · {(correctionTasks || []).length} returned</p></div>
      </div>
      <CameraCapture open={!!cameraFor?.startsWith('redo:')} onClose={() => setCameraFor(null)} title="Replacement installation proof"
        onCapture={(dataUrl, name) => { const selected = correctionTasks!.find((c: any) => c.id === cameraFor?.slice(5)); if (selected) void queueRedoImage(selected, dataUrl, name); }} />
      <div className="space-y-3 p-3">
        {!online && <div className="rounded-xl bg-amber-50 p-3 text-xs text-amber-800">Offline — captured evidence remains on this device and will retry on reconnect.</div>}
        <p className="text-xs leading-5 text-slate-600">Only returned items need correction. Approved records stay unchanged. Replacement proof takes the place of the old submitted proof when saved.</p>
        {correctionTasks!.map((c: any, index: number) => {
          const originalProof = proofPhotos.find((proof) => proof.id === c.installation_proof_id);
          const itemId = c.work_item_id || originalProof?.workItemId;
          const item = approvedItems.find((work) => work.id === itemId);
          const linkedPhotoIds = new Set((boardMarkings || []).filter((mark) => mark.work_item_id === itemId).map((mark) => mark.survey_photo_id));
          for (const link of surveyPhotoItemLinks || []) if (link.work_item_id === itemId) linkedPhotoIds.add(link.survey_photo_id);
          const refPhotos = (surveyPhotos || []).filter((photo) => linkedPhotoIds.has(photo.id));
          const refMarks = (boardMarkings || []).filter((mark) => linkedPhotoIds.has(mark.survey_photo_id));
          const local = redoDrafts[c.id];
          const saved = !!c.replacement_saved_at && !local;
          return <section key={c.id} className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm">
            <div className="flex items-start justify-between gap-2"><div className="min-w-0"><h2 className="text-sm font-semibold text-slate-900">{index + 1}. {item?.work_type_name || item?.material || 'Installation proof'}</h2><p className="mt-1 text-xs text-slate-500">{item ? `${itemSizeLabel(item)} · Qty ${item.approved_quantity || 1}` : 'Submitted installation evidence'}</p></div><span className={`rounded-full px-2 py-1 text-[10px] font-semibold ${saved ? 'bg-emerald-50 text-emerald-700' : local ? 'bg-blue-50 text-blue-700' : 'bg-amber-50 text-amber-800'}`}>{saved ? 'Saved' : local ? 'Queued' : 'Redo'}</span></div>
            {c.note && <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900"><strong>Reviewer feedback:</strong> {c.note}</p>}
            {refPhotos.length > 0 && <div className="mt-3"><p className="mb-2 text-xs font-semibold text-slate-600">Approved marked survey reference</p><MarkedPhotoGrid photos={refPhotos} markings={refMarks} workItems={approvedItems} /></div>}
            {originalProof?.url && <div className="mt-3"><p className="mb-2 text-xs font-semibold text-slate-600">Previous installation proof</p><img src={originalProof.url} alt="Previously submitted installation proof" className="h-40 w-full rounded-lg bg-slate-100 object-contain" /></div>}
            {local && <div className="mt-3"><p className="mb-2 text-xs font-semibold text-blue-700">Replacement waiting to sync</p><img src={String(local.payload.dataUrl)} alt="Saved replacement proof" className="h-40 w-full rounded-lg bg-slate-100 object-contain" /></div>}
            {!saved && <div className="mt-3 flex items-center gap-2"><button onClick={() => setCameraFor(`redo:${c.id}`)} className="flex-1 rounded-xl bg-blue-700 px-3 py-2.5 text-sm font-semibold text-white">Take replacement photo</button><label className="cursor-pointer rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-xs font-semibold text-slate-700">Gallery<input type="file" accept="image/*" className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; if (f) void chooseRedoImage(c, f); e.currentTarget.value = ''; }} /></label></div>}
            {local && <button disabled={!online || redoBusy===c.id} onClick={() => void uploadSavedRedo(local)} className="mt-2 text-xs font-semibold text-blue-700 disabled:opacity-40">{redoBusy===c.id ? 'Syncing…' : 'Retry upload'}</button>}
          </section>;
        })}
        {redoError && <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800">{redoError}</div>}
        <button type="button" disabled={!ready || !online || !!redoBusy} onClick={() => void submitRedo()} className="w-full rounded-xl bg-emerald-700 px-3 py-3 text-sm font-semibold text-white disabled:bg-slate-300 disabled:text-slate-600">{redoBusy==='submit' ? 'Submitting…' : ready ? 'Submit corrected installation' : 'Save all returned evidence to submit'}</button>
      </div>
    </div>;
  }

  if (jobBlockedReason) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4 max-w-md mx-auto">
        <Card className="p-8 text-center">
          <AlertCircle className="w-16 h-16 text-amber-500 mx-auto mb-4" />
          <h2 className="text-xl font-bold text-slate-900 mb-2">Can't Start Yet</h2>
          <p className="text-sm text-slate-500 mb-6">{jobBlockedReason}</p>
          <button onClick={() => onExit()} className="w-full bg-slate-900 text-white text-sm font-medium py-2.5 rounded-lg">Back</button>
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
            <p className="font-bold text-slate-900">Not Installed — {unavail.item.work_type_name || unavail.item.material || 'work item'}</p>
            <p className="text-xs text-slate-500">Provide a reason and a site photo. This work item will be excluded from installed totals; the reason and evidence remain in the audit trail.</p>
            <select value={['Site renovation','Shop closed / Owner unavailable','Permission not granted','Site unavailable / Obstructed','Removed from scope'].includes(unavail.reason) ? unavail.reason : ''} onChange={(e) => setUnavail({ ...unavail, reason: e.target.value })} className="w-full border rounded-lg px-3 py-2 text-sm bg-white">
              <option value="">Choose a reason…</option>
              {['Site renovation','Shop closed / Owner unavailable','Permission not granted','Site unavailable / Obstructed','Removed from scope'].map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
            <input value={unavail.reason} onChange={(e) => setUnavail({ ...unavail, reason: e.target.value })} placeholder="Or enter a reason" className="w-full border rounded-lg px-3 py-2 text-sm" />
            <input value={unavail.note} onChange={(e) => setUnavail({ ...unavail, note: e.target.value })} placeholder="Comment (optional)" className="w-full border rounded-lg px-3 py-2 text-sm" />
            <label className="w-full flex items-center justify-center gap-2 border-2 border-dashed border-blue-300 bg-blue-50 text-blue-700 text-sm font-semibold py-3 rounded-xl cursor-pointer">
              <Camera className="w-4 h-4" /> {unavail.file ? `Photo: ${unavail.file.name}` : 'Take or select a site photo (required)'}
              <input type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => setUnavail({ ...unavail, file: e.target.files?.[0] || null })} />
            </label>
            <div className="flex gap-2">
              <button onClick={() => setUnavail(null)} className="flex-1 bg-slate-100 text-slate-700 py-3 rounded-lg font-medium">Cancel</button>
              <button disabled={unavailBusy} onClick={() => void saveUnavailable()} className="flex-1 bg-amber-600 text-white py-3 rounded-lg font-semibold disabled:opacity-50">{unavailBusy ? 'Saving…' : 'Mark not installed'}</button>
            </div>
          </div>
        </div>
      )}

      {(!online || queuedCount > 0) && <div role="status" className="mx-4 mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
        {queuedCount > 0 ? `${queuedCount} captured photo(s) saved on this device, waiting to sync.` : 'Offline — photos are saved locally; final submission needs internet.'}
        {online && queuedCount > 0 && <button type="button" className="ml-2 font-semibold underline" onClick={() => void syncInstallationPhotos(profile!.id).then(async () => {
          const remaining = await pendingInstallationPhotos(profile!.id, shopId);
          setQueuedCount(remaining.length);
          if (jobId) { const remote = await loadInstallationProofs(jobId); setProofPhotos([...remote, ...remaining.map((p) => ({id:`local:${p.id}`,url:p.dataUrl,type:'installed',angle:p.angle,workItemId:p.workItemId||undefined,queued:true}))]); }
        })}>Retry now</button>}
      </div>}
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
                      
                    </div>
                  ))}
                </div>
                <details className="mt-3 rounded-xl border border-slate-200 bg-white p-2">
                  <summary className="min-h-9 cursor-pointer px-2 py-1.5 text-xs font-medium text-slate-600">Manage photos</summary>
                  <div className="mt-2 space-y-1 border-t border-slate-100 pt-2">
                    {proofPhotos.map((photo, i) => <div key={photo.id || photo.storagePath || i} className="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-xs">
                      <span className="truncate text-slate-600">Photo {i+1} {photo.queued ? '· upload pending' : ''}</span>
                      <button type="button" onClick={() => void deleteInstallationPhoto(photo)} className="min-h-9 rounded-lg border border-rose-200 px-3 py-1.5 font-medium text-rose-700">Remove</button>
                    </div>)}
                  </div>
                </details>
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
                    <option value="">Map to work item...</option>{installableItems.map((it, idx) => <option key={it.id} value={it.id}>{it.work_type_name || it.material || `Work Item ${idx + 1}`} · {itemSizeLabel(it)}</option>)}
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
                if (missingPhoto.length) { fieldNotice(`Photos required for: ${missingPhoto.map((it) => it.work_type_name || it.material || 'Work item').join(', ')}.\nCapture a photo for each available item or mark the item as unavailable.`); return; }
                if (installableItems.length === 0 && unavailableItems.length === 0 && proofPhotos.length === 0) { fieldNotice('Add at least one installation photo.'); return; }
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
                  <p className="text-sm font-bold text-emerald-800">Vehicle load confirmed</p>
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
                          <p className="text-xs text-slate-500">{itemSizeLabel(it)} · Approved Qty {approvedQty}</p>
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
                if (missing) { fieldNotice('Enter the loaded quantity for every work item before continuing.'); return; }
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

            {approvedItems.length > 0 && <Card className="p-3"><div className="flex items-start justify-between gap-2 mb-2"><div><p className="text-xs font-semibold text-slate-700 uppercase tracking-wide">Installation work items</p><p className="text-[11px] text-slate-500 mt-0.5">Install available items. If a surveyed location is unavailable today, mark only that item — it stays in history but is excluded from installed/billing calculations.</p></div></div><div className="space-y-2">{approvedItems.map((it, idx) => { const unavailable = it.excluded_from_calculations || (it.execution_state && it.execution_state !== 'active'); return <div key={it.id} className={`rounded-xl border p-3 ${unavailable?'border-amber-300 bg-amber-50':'border-slate-200 bg-white'}`}><div className="flex items-start justify-between gap-2"><button disabled={!!unavailable} onClick={() => { setSelectedProofWorkItemId(it.id); setCameraFor('installed'); }} className="min-w-0 flex-1 text-left disabled:cursor-default"><p className="font-semibold text-slate-900 text-sm">{it.work_type_name || it.material || `Work Item ${idx + 1}`}</p><p className="text-xs text-slate-500 mt-0.5">{itemSizeLabel(it)} · Qty {it.approved_quantity || 1}</p>{unavailable?<><p className="text-xs font-semibold text-amber-800 mt-1">Not available for installation · excluded from calculation</p><p className="text-[11px] text-amber-700">{it.execution_reason}{it.execution_note?` · ${it.execution_note}`:''}</p></>:<p className="text-xs text-blue-600 font-medium mt-1">Tap to take photo</p>}</button><button type="button" onClick={() => void markItemAvailability(it, !unavailable)} className={`shrink-0 text-[11px] font-semibold px-2.5 py-1.5 rounded-lg border ${unavailable?'border-emerald-300 bg-white text-emerald-700':'border-amber-300 bg-amber-50 text-amber-800'}`}>{unavailable?'Make available':'Not available'}</button></div></div>})}</div></Card>}

            <Card className="p-3 border-slate-200"><label className="block text-xs font-semibold text-slate-700 mb-1">Gallery upload: choose work item</label><select value={selectedProofWorkItemId} onChange={(e) => setSelectedProofWorkItemId(e.target.value)} className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white"><option value="">Select work item...</option>{installableItems.map((it, idx) => <option key={it.id} value={it.id}>{it.work_type_name || it.material || `Work Item ${idx + 1}`} · {itemSizeLabel(it)}</option>)}</select></Card>

            <label className="w-full flex items-center justify-center gap-2 border-2 border-dashed border-blue-200 bg-blue-50/50 text-blue-700 text-sm font-semibold py-3 rounded-xl cursor-pointer hover:bg-blue-50">
              <ImagePlus className="w-4 h-4" /> Upload one or multiple installation photos
              <input type="file" accept="image/*" multiple className="hidden" onChange={(e) => { handleInstallationFileSelection(e.target.files); e.currentTarget.value = ''; }} />
            </label>

            {proofPhotos.length > 0 && (
              <div className="grid grid-cols-3 gap-2">
                {proofPhotos.map((p, i) => (
                  <div key={i} className="relative rounded-lg overflow-hidden">
                    <img src={p.url} alt={`${p.angle} installation`} className="w-full h-24 object-contain bg-slate-100" />
                    <span className="absolute bottom-1 left-1 bg-black/60 text-white text-[9px] font-medium px-1 py-0.5 rounded capitalize">{p.angle}</span>
                    
                  </div>
                ))}
              </div>
            )}
            {proofPhotos.length > 0 && <details className="rounded-xl border border-slate-200 bg-white p-2">
              <summary className="cursor-pointer px-2 py-1.5 text-xs font-medium text-slate-600">Manage uploaded photos</summary>
              <div className="mt-2 space-y-1 border-t border-slate-100 pt-2">{proofPhotos.map((photo, index) => <div key={photo.id || photo.storagePath || index} className="flex items-center justify-between gap-2 px-2 py-1 text-xs">
                <span className="text-slate-600">Photo {index+1}</span>
                <button type="button" onClick={() => void deleteInstallationPhoto(photo)} className="min-h-9 rounded-lg border border-rose-200 px-3 font-medium text-rose-700">Remove</button>
              </div>)}</div>
            </details>}

            <button
              onClick={() => {
                const missingProof = installableItems.find((it) => !proofPhotos.some((p) => p.workItemId === it.id));
                if (missingProof) { fieldNotice(`Add at least one installation photo for ${missingProof.work_type_name || missingProof.material || 'each available work item'}, or mark that work item Not available.`); return; }
                setStep(4);
              }}
              className="w-full bg-slate-900 text-white text-sm font-medium py-2.5 rounded-lg"
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
                      <div className="flex items-center justify-between gap-2"><div><p className="font-medium text-slate-900">{it.material || it.work_type_name || 'Item'}</p><p className="text-xs text-slate-500">{itemSizeLabel(it)} · Qty {it.approved_quantity || 1}</p></div>{unavailable?<span className="text-[10px] font-bold text-amber-800 bg-amber-100 px-2 py-1 rounded-full">NOT INSTALLED</span>:null}</div>
                      {unavailable && <p className="text-[11px] text-amber-700 mt-1">{it.execution_reason || 'Site unavailable'}{it.execution_note?` · ${it.execution_note}`:''} · Marked not installed</p>}
                    </div>
                  );})}
                </div>
              ) : (
                <p className="text-sm text-slate-400">No approved measurements found for this shop.</p>
              )}
              <p className="text-xs text-slate-400 mt-2">These are the measurements approved by your Admin/Owner during survey review — installed as-is, no need to re-enter them.</p>
              <div className="mt-4 border-t border-slate-100 pt-4">
                <div className="flex items-center justify-between mb-3"><p className="text-sm font-semibold text-slate-900">Installation Photo Review</p><span className="text-xs font-semibold text-blue-600">{proofPhotos.length} photos</span></div>
                <div className="space-y-3">{approvedItems.map((it, idx) => { const ps = proofPhotos.filter((p) => p.workItemId === it.id); if (!ps.length) return null; return <div key={it.id}><p className="text-xs font-semibold text-slate-600 mb-1.5">{it.work_type_name || it.material || `Work Item ${idx + 1}`} · {ps.length} photo{ps.length > 1 ? 's' : ''}</p><div className="grid grid-cols-3 gap-2">{ps.map((p, pi) => <div key={`${p.url}-${pi}`} className="relative aspect-[4/3] rounded-lg overflow-hidden bg-slate-100"><img src={p.url} alt="Installation proof" className="w-full h-full object-contain bg-slate-100"/>{p.queued && <span className="absolute bottom-0 inset-x-0 bg-amber-700 px-1 py-0.5 text-center text-[10px] text-white">Upload pending</span>}</div>)}</div></div>; })}</div>
              </div>
              <div className="mt-3">
                <Textarea label="Note for reviewer (optional)" value={installNotes} onChange={setInstallNotes} rows={2} />
              </div>
            </Card>

            <div className="flex gap-2">
              <button onClick={() => setStep(1)} className="flex items-center justify-center gap-1 bg-slate-200 text-slate-700 font-medium py-3 rounded-lg flex-1">
                <ChevronLeft className="w-4 h-4" /> Back
              </button>
              <button onClick={completeInstallation} disabled={submitting || queuedCount>0 || !online} className="bg-blue-600 disabled:opacity-50 text-white font-semibold py-3 rounded-lg flex-1">{submitting ? 'Submitting...' : 'Final Submit'}</button>
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
              <button onClick={completeInstallation} disabled={submitting || queuedCount>0 || !online} className="bg-red-600 disabled:opacity-50 text-white font-semibold py-3 rounded-lg flex-1">{submitting ? 'Submitting...' : 'Submit Exception'}</button>
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
                  <p className="text-sm font-bold text-slate-800 mt-0.5">{itemSizeLabel(it)}<span className="font-medium text-slate-500"> · Qty {it.approved_quantity || 1}</span></p>
                  <p className="text-[11px] text-blue-600 mt-0.5">{open ? 'Tap to close' : 'Tap for survey photo & to add photos'}</p>
                </div>
                <span className={`text-blue-600 text-lg transition-transform ${open ? 'rotate-45' : ''}`}>+</span>
              </button>
              {(it.excluded_from_calculations || (it.execution_state && it.execution_state !== 'active')) ? (
                <div className="mx-4 mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-1.5">
                  <p className="text-[11px] font-bold text-amber-900">NOT INSTALLED — excluded from totals</p>
                  <p className="text-[11px] text-amber-800 mt-0.5">Reason: {it.execution_reason || 'not given'}{it.execution_note ? ` · ${it.execution_note}` : ''}</p>
                  <button type="button" onClick={() => onRestore(it)} className="mt-1.5 text-xs font-semibold text-blue-700 underline">Restore availability</button>
                </div>
              ) : (
                <div className="px-4 pb-2.5 -mt-1 flex justify-end">
                  <button type="button" onClick={() => onMarkUnavailable(it)} className="text-[11px] font-medium text-slate-500 hover:text-amber-700 inline-flex items-center gap-1 rounded-md px-2 py-1 border border-transparent hover:border-amber-300 hover:bg-amber-50">⋯ Not Installed? Not available</button>
                </div>
              )}

              {open && (
                <div className="px-4 pb-4 space-y-3">
                  <div className="grid grid-cols-2 gap-2">
                    <div className="rounded-lg bg-white border border-slate-200 p-2.5"><p className="text-[10px] uppercase tracking-wide text-slate-400">Size</p><p className="text-xs font-semibold text-slate-800 mt-1">{itemSizeLabel(it)}</p></div>
                    <div className="rounded-lg bg-white border border-slate-200 p-2.5"><p className="text-[10px] uppercase tracking-wide text-slate-400">Quantity</p><p className="text-xs font-semibold text-slate-800 mt-1">{it.approved_quantity || 1}</p></div>

                  </div>
                  <div className="rounded-xl bg-white border border-slate-200 p-3">
                    <p className="text-[11px] font-bold tracking-wide text-slate-500 uppercase mb-2">Survey reference</p>
                    {itemPhotos.length > 0 ? (
                      <MarkedPhotoGrid photos={itemPhotos} markings={itemMarkings} workItems={[it]} />
                    ) : (
                      <div className="rounded-lg bg-slate-50 px-3 py-4 text-center text-xs text-slate-500">No survey photo is mapped to this work item.</div>
                    )}
                  </div>

                  {installedCount > 0 && <div className="rounded-xl bg-white border border-slate-200 p-3"><div className="flex items-center justify-between mb-2"><p className="text-[11px] font-bold tracking-wide text-slate-500 uppercase">Installation photos</p><span className="text-[10px] font-semibold text-emerald-700">{installedCount} added</span></div><div className="grid grid-cols-3 gap-2">{proofPhotos.filter((p) => p.workItemId === it.id).map((p, pi) => <div key={`${p.url}-${pi}`} className="relative aspect-[4/3] rounded-lg overflow-hidden bg-slate-100"><img src={p.url} alt={`${label} installation`} className="w-full h-full object-contain bg-slate-100"/></div>)}</div></div>}

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
  const [heightUnit, setHeightUnit] = useState('ft');
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
      if (error) throw new Error(`Could not load this Work Order's work items: ${error.message}`);
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

  const isAreaUom = selectedLineItem ? selectedLineItem.uom === 'sqft' : true;
  const widthNum = parseFloat(width) || 0;
  const heightNum = parseFloat(height) || 0;
  const qtyNum = Math.max(1, parseInt(quantity, 10) || 1);
  const computedArea = isAreaUom && widthNum > 0 && heightNum > 0 ? areaSqFt(widthNum, unit, heightNum, heightUnit) * qtyNum : 0;
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
        // Store canonical feet for owner-side tally, but retain the exact entered units for display.
        installed_width: isAreaUom ? toFeet(widthNum, unit) : null,
        installed_height: isAreaUom ? toFeet(heightNum, heightUnit) : null,
        installed_unit: isAreaUom ? 'ft' : null,
        entered_width: isAreaUom ? widthNum : null,
        entered_height: isAreaUom ? heightNum : null,
        entered_width_unit: isAreaUom ? unit : null,
        entered_height_unit: isAreaUom ? heightUnit : null,
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
      const photoGps = await capturePhotoLocation(gps);
      if (photoGps) { setGps(photoGps); setGpsStatus('captured'); }
      let uploadDataUrl = dataUrl;
      try {
        uploadDataUrl = await stampGeoTag(dataUrl, {
          siteName: shopName || siteName,
          addressLine: [address, city, state].filter(Boolean).join(', ') || null,
          lat: photoGps?.lat ?? null,
          lng: photoGps?.lng ?? null,
          accuracy: photoGps?.accuracy ?? null,
        });
      } catch (stampErr) {
        console.error('[DirectInstallWizard] geo-tag stamp failed (non-fatal, uploading unstamped):', stampErr);
      }

      const res = await fetch(uploadDataUrl);
      const blob = await res.blob();
      const file = new File([blob], fileName, { type: blob.type });
      const path = `${profile.organization_id}/${jobId}/direct-${angle}-${Date.now()}-${fileName}`;
      const { error: uploadError } = await supabase.storage.from('installation-proof').upload(path, file);
      if (uploadError) { fieldNotice('Photo upload failed: ' + uploadError.message); return; }
      const { data: urlData } = supabase.storage.from('installation-proof').getPublicUrl(path);

      const { error: insertError } = await supabase.from('installation_proofs').insert({
        organization_id: profile.organization_id,
        installation_job_id: jobId,
        shop_id: shopId,
        storage_path: path,
        photo_url: urlData.publicUrl,
        photo_type: 'installed',
        angle,
        gps_lat: photoGps?.lat ?? null,
        gps_lng: photoGps?.lng ?? null,
        gps_accuracy: photoGps?.accuracy ?? null,
      });
      if (insertError) { fieldNotice('Could not save the photo record: ' + insertError.message); return; }

      setPhotos((prev) => [...prev, { url: urlData.publicUrl, storagePath: path, angle }]);
      // Cycle front -> side -> other -> other..., matching Section 7's
      // "at least front + side" convention from the normal install flow.
      setNextAngle((a) => (a === 'front' ? 'side' : 'other'));
    } catch (err: any) {
      console.error('[DirectInstallWizard] handlePhotoCaptured failed:', err);
      fieldNotice(`Could not save that photo: ${err?.message || 'Unknown error'}. Please try again.`);
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
                <p className="text-sm font-medium text-slate-700 pt-2">Choose the assigned work type for this site</p>
                {(lineItems || []).length === 0 ? (
                  <p className="text-xs text-slate-400">Loading work items...</p>
                ) : (
                  <div className="space-y-2">
                    {(lineItems || []).map((li) => {
                      return (
                        <button
                          key={li.id}
                          onClick={() => setLineItemId(li.id)}
                          className={`w-full text-left p-3 rounded-xl border-2 transition ${lineItemId === li.id ? 'border-amber-500 bg-amber-50' : 'border-slate-200 bg-white'}`}
                        >
                          <p className="font-medium text-slate-900 text-sm">{li.description}</p>

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
                  <Select label="Width unit" value={unit} onChange={setUnit} options={LENGTH_UNIT_OPTIONS} />
                  <Input label="Height" type="number" value={height} onChange={setHeight} placeholder="0" />
                  <Select label="Height unit" value={heightUnit} onChange={setHeightUnit} options={LENGTH_UNIT_OPTIONS} />
                </div>
              ) : null}
              <div className="grid grid-cols-2 gap-2">
                <Input label="Quantity" type="number" value={quantity} onChange={setQuantity} placeholder="1" />
                {isAreaUom && (
                  <div className="flex flex-col justify-end">
                    <p className="text-xs text-slate-500 mb-1">Recorded measurements</p>
                    <p className="text-sm font-medium text-slate-900">{width || '—'} {unit} × {height || '—'} {heightUnit}</p>
                  </div>
                )}
              </div>



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
