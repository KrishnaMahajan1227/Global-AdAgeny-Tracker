import { useState, useEffect, useRef, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { Shop, WorkType, POLineItemWorkContext } from '@/lib/types';
import { Card, Input, Select, Textarea, StatusBadge } from '@/components/ui';
import { computePOVariance, findLineItemForWorkType } from '@/lib/poVariance';
import { useOnlineStatus } from '@/lib/useOnlineStatus';
import {
  getDraft, saveDraft, deleteDraft, listDraftsForSurveyor,
  newLocalId, type SurveyDraft, type DraftPhoto, type DraftWorkItem,
} from '@/lib/offlineDb';
import { syncAllPendingDrafts, syncDraft } from '@/lib/syncManager';
import { CameraCapture } from '@/components/CameraCapture';
import { BoardMarkerCanvas } from '@/components/BoardMarkerCanvas';
import { fillMissingShopCoordinates } from '@/lib/geocode';
import { renderMarkedImage, buildBoardLabel, type MarkPoint } from '@/lib/markingUtils';
import { useLiveLocationTracking, LocationShareIndicator } from '@/lib/locationTracking';
import { buildMultiStopNavigationUrl, formatDistance, formatDuration } from '@/lib/routeOptimization';
import {
  Home, Briefcase, MapPin, Bell, User, Camera, Navigation, CheckCircle2,
  ChevronLeft, FileText, AlertCircle, Map as MapIcon,
  Loader2, WifiOff, CloudUpload,
  Image, Square, Zap, Lightbulb, Flag, Signpost, PanelTop, Layers, Tag,
} from 'lucide-react';

type MobileTab = 'home' | 'work' | 'map' | 'notifications' | 'profile';

// Icon-tile mapping for the Work Type picker (§9.3 Step 4) — icons read
// faster than text for low-literacy field use. Work types are org-defined
// free text, so this is a best-effort keyword match against common signage
// terms with a generic fallback, not a DB-backed mapping.
const WORK_TYPE_ICON_RULES: [RegExp, typeof Tag][] = [
  [/flex/i, Image],
  [/acp/i, PanelTop],
  [/vinyl|sticker/i, Layers],
  [/neon/i, Zap],
  [/led|light/i, Lightbulb],
  [/banner/i, Flag],
  [/sign(board)?|board/i, Signpost],
  [/standee|poster/i, Square],
];
function iconForWorkType(name: string | null | undefined): typeof Tag {
  if (!name) return Tag;
  const rule = WORK_TYPE_ICON_RULES.find(([re]) => re.test(name));
  return rule ? rule[1] : Tag;
}

// Shop statuses in which a survey can still be started/continued by the
// surveyor. Once a shop moves past this (submitted for review, approved,
// or further down the design/production/installation pipeline), the job is
// done from the surveyor's side and must stay locked — they should not be
// able to open the wizard and re-survey it. The one way back into this set
// is Admin/Owner sending it back via "Reject" or "Request Correction" on
// the Survey Review page, which resets the shop to 'assigned'.
const SURVEYABLE_SHOP_STATUSES = ['pending', 'assigned', 'survey_started'];

/**
 * Opens Google Maps directions to a shop — if it doesn't have a pinned
 * lat/lng yet (very common right after a bulk address upload), this
 * geocodes it from address/city/district/state first and saves the
 * result, so "Navigate" works from the shop's address even when nobody
 * has walked in and pinned its exact GPS location yet. Previously this
 * button silently did nothing at all when coordinates were missing.
 */
export async function navigateToShop(shop: {
  id: string;
  latitude: number | null;
  longitude: number | null;
  address?: string | null;
  city?: string | null;
  district?: string | null;
  state?: string | null;
} | null | undefined) {
  if (!shop) return;
  if (shop.latitude != null && shop.longitude != null) {
    window.open(`https://www.google.com/maps/dir/?api=1&destination=${shop.latitude},${shop.longitude}`, '_blank');
    return;
  }
  try {
    const { resolved } = await fillMissingShopCoordinates([shop]);
    const updated = resolved[0];
    if (updated.latitude != null && updated.longitude != null) {
      window.open(`https://www.google.com/maps/dir/?api=1&destination=${updated.latitude},${updated.longitude}`, '_blank');
    } else {
      alert("Couldn't locate this shop on the map from its address. Ask your office to check the address on file.");
    }
  } catch {
    alert("Couldn't locate this shop on the map from its address. Ask your office to check the address on file.");
  }
}

function isShopSurveyable(status: string | null | undefined): boolean {  return SURVEYABLE_SHOP_STATUSES.includes(status || '');
}

export default function SurveyorPage() {
  const { profile, signOut } = useAuth();
  const [tab, setTab] = useState<MobileTab>('home');
  const [activeSurvey, setActiveSurvey] = useState<string | null>(null);
  const isOnline = useOnlineStatus();

  // Whenever the surveyor comes back online (or opens the app already
  // online with something queued from a previous offline session), push
  // any queued survey drafts up to Supabase automatically.
  useEffect(() => {
    if (!profile?.id || !isOnline) return;
    syncAllPendingDrafts(profile.id);
  }, [profile?.id, isOnline]);

  // Switching tabs while a survey is in progress just closes the wizard —
  // the draft is autosaved on every step change (see SurveyWizard) so
  // nothing is lost, and "Continue Survey" on Home picks it back up.
  function goToTab(nextTab: MobileTab) {
    if (activeSurvey) setActiveSurvey(null);
    setTab(nextTab);
  }

  return (
    <div className="min-h-screen bg-slate-50 pb-20 max-w-md mx-auto">
      {!isOnline && (
        <div className="bg-amber-500 text-white text-xs font-medium py-1.5 px-4 flex items-center justify-center gap-1.5 sticky top-0 z-50">
          <WifiOff className="w-3.5 h-3.5" /> Offline — your work is saved on this phone
        </div>
      )}
      {activeSurvey ? (
        <SurveyWizard
          shopId={activeSurvey}
          onExit={(nextShopId) => setActiveSurvey(nextShopId || null)}
        />
      ) : (
        <>
          {tab === 'home' && <SurveyorHome onStart={(shopId) => setActiveSurvey(shopId)} />}
          {tab === 'work' && <SurveyorWork onStart={(shopId) => setActiveSurvey(shopId)} />}
          {tab === 'map' && <FieldMapView />}
          {tab === 'notifications' && <NotificationsView />}
          {tab === 'profile' && <ProfileView onSignOut={signOut} />}
        </>
      )}

      {/* Always mounted — same bar on every screen, including mid-survey,
          so the surveyor never loses their place in the app. */}
      <div className="fixed bottom-0 left-0 right-0 max-w-md mx-auto bg-white border-t border-slate-200 flex items-center justify-around py-2 px-2 z-40">
        <TabButton icon={Home} label="Home" active={!activeSurvey && tab === 'home'} onClick={() => goToTab('home')} />
        <TabButton icon={Briefcase} label="My Work" active={!activeSurvey && tab === 'work'} onClick={() => goToTab('work')} />
        <TabButton icon={MapIcon} label="Map" active={!activeSurvey && tab === 'map'} onClick={() => goToTab('map')} />
        <TabButton icon={Bell} label="Alerts" active={!activeSurvey && tab === 'notifications'} onClick={() => goToTab('notifications')} />
        <TabButton icon={User} label="Profile" active={!activeSurvey && tab === 'profile'} onClick={() => goToTab('profile')} />
      </div>
    </div>
  );
}

// Shows the marked composite (photo + polygon overlay burned in) for a
// survey photo in the Review step, so what the surveyor sees before
// submitting matches exactly what gets saved and exported — not a plain,
// unmarked photo. Falls back to the plain photo while rendering, or if the
// photo has no marked boards on it.
function ReviewPhotoThumb({ src, boardPointSets, boardLabels, index }: { src: string; boardPointSets: MarkPoint[][]; boardLabels?: (string | null)[]; index: number }) {
  const [renderedSrc, setRenderedSrc] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (boardPointSets.every((set) => set.length < 3)) { setRenderedSrc(null); return; }
    // Pass every board's points as its own set — never flattened into one
    // array — so two boards marked on the same photo render as two
    // separate polygons instead of one garbled shape. Labels are passed
    // in the same order so each board's measurement/work-type caption
    // lands on the correct polygon.
    renderMarkedImage(src, boardPointSets, { labels: boardLabels })
      .then(({ dataUrl }) => { if (!cancelled) setRenderedSrc(dataUrl); })
      .catch(() => { if (!cancelled) setRenderedSrc(null); });
    return () => { cancelled = true; };
  }, [src, boardPointSets, boardLabels]);

  return (
    <div className="relative">
      <img src={renderedSrc || src} alt={`Photo ${index + 1}`} className="w-full h-20 object-cover rounded-lg" />
      {boardPointSets.length > 0 && (
        <span className="absolute top-1 right-1 bg-blue-600 text-white text-[9px] font-medium px-1 py-0.5 rounded">Marked</span>
      )}
    </div>
  );
}

function TabButton({ icon: Icon, label, active, onClick }: { icon: any; label: string; active: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} className={`flex flex-col items-center gap-1 px-3 py-1.5 rounded-lg transition ${active ? 'text-blue-600' : 'text-slate-400'}`}>
      <Icon className="w-5 h-5" />
      <span className="text-xs font-medium">{label}</span>
    </button>
  );
}

function SurveyorHome({ onStart }: { onStart: (shopId: string) => void }) {
  const { profile } = useAuth();
  const isOnline = useOnlineStatus();

  const { data: assignments } = useQuery({
    queryKey: ['surveyor-assignments', profile?.id],
    queryFn: async () => {
      const { data } = await supabase
        .from('shop_assignments')
        .select('*, shops(*, clients(name))')
        .eq('user_id', profile!.id)
        .eq('role', 'surveyor')
        .order('assigned_at', { ascending: false });
      return data;
    },
    enabled: !!profile?.id,
  });

  const { data: drafts, refetch: refetchDrafts } = useQuery({
    queryKey: ['survey-drafts', profile?.id],
    queryFn: () => listDraftsForSurveyor(profile!.id),
    enabled: !!profile?.id,
    refetchInterval: 5000,
  });

  const inProgressDraft = (drafts || []).find((d) => d.status === 'draft');
  const pendingSyncCount = (drafts || []).filter((d) => d.status === 'pending_sync' || d.status === 'syncing').length;
  const failedDrafts = (drafts || []).filter((d) => d.status === 'sync_failed');

  // Every assignment that hasn't been declined counts as "assigned" — a
  // freshly-created assignment starts life with status 'assigned' (not
  // 'accepted'), so filtering only for 'accepted' was hiding brand-new
  // work from the surveyor's own dashboard until something else changed it.
  const activeAssignments = (assignments || []).filter((a) => a.status !== 'declined');
  const assigned = activeAssignments.length;
  const completed = activeAssignments.filter((a) => a.status === 'completed').length;
  const pending = assigned - completed;
  const nextJob = activeAssignments.find((a) => a.status !== 'completed' && isShopSurveyable(a.shops?.status));

  return (
    <div className="p-4">
      <div className="mb-6">
        <h1 className="text-xl font-bold text-slate-900">Hello, {profile?.full_name?.split(' ')[0]}</h1>
        <p className="text-sm text-slate-500">Today's survey work</p>
      </div>

      {inProgressDraft && (
        <Card className="mb-4 p-4 border-amber-300 bg-amber-50">
          <div className="flex items-center gap-2 mb-1">
            <AlertCircle className="w-4 h-4 text-amber-600" />
            <p className="font-medium text-amber-800 text-sm">Unfinished survey</p>
          </div>
          <p className="text-xs text-amber-700 mb-3">{inProgressDraft.shopName} — Step {Math.min(inProgressDraft.step, 4)} of 4 saved on this phone</p>
          <button onClick={() => onStart(inProgressDraft.shopId)} className="w-full bg-amber-600 text-white text-sm font-medium py-2.5 rounded-lg">
            Continue Survey
          </button>
        </Card>
      )}

      {pendingSyncCount > 0 && (
        <Card className="mb-4 p-3 flex items-center gap-2 border-blue-200 bg-blue-50">
          <CloudUpload className="w-4 h-4 text-blue-600 flex-shrink-0" />
          <p className="text-xs text-blue-700">
            {pendingSyncCount} survey{pendingSyncCount > 1 ? 's' : ''} {isOnline ? 'syncing…' : 'waiting to sync — will upload automatically once you\'re back online'}
          </p>
        </Card>
      )}

      {failedDrafts.length > 0 && isOnline && (
        <Card className="mb-4 p-3 border-red-200 bg-red-50">
          <p className="text-xs text-red-700 mb-2">{failedDrafts.length} survey{failedDrafts.length > 1 ? 's' : ''} failed to sync.</p>
          <button
            onClick={async () => { await syncAllPendingDrafts(profile!.id); refetchDrafts(); }}
            className="text-xs font-medium text-red-700 underline"
          >
            Retry Sync Now
          </button>
        </Card>
      )}

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
          <Navigation className="w-5 h-5" />
          START NEXT JOB
        </button>
      ) : (
        <Card className="p-6 text-center">
          <CheckCircle2 className="w-12 h-12 text-green-500 mx-auto mb-2" />
          <p className="text-slate-700 font-medium">All caught up!</p>
          <p className="text-sm text-slate-400">No pending surveys assigned</p>
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

function SurveyorWork({ onStart }: { onStart: (shopId: string) => void }) {
  const { profile } = useAuth();

  const { data: assignments } = useQuery({
    queryKey: ['surveyor-work', profile?.id],
    queryFn: async () => {
      const { data } = await supabase
        .from('shop_assignments')
        .select('*, shops(*, clients(name))')
        .eq('user_id', profile!.id)
        .eq('role', 'surveyor')
        .order('assigned_at', { ascending: false });
      return data;
    },
    enabled: !!profile?.id,
  });

  return (
    <div className="p-4">
      <h1 className="text-xl font-bold text-slate-900 mb-4">My Work</h1>
      <div className="space-y-3">
        {(assignments || []).map((a) => {
          // "Done" is judged off the shop's own status, not just the
          // assignment row — this is what actually re-locks (or re-opens)
          // consistently with Admin/Owner's Approve / Reject / Request
          // Correction actions on Survey Review, which move shop.status
          // back to 'assigned' to intentionally re-open the job.
          const jobDone = !isShopSurveyable(a.shops?.status);
          return (
          <Card key={a.id} className={`p-4 ${jobDone ? 'border-green-200 bg-green-50/40' : ''}`}>
            <div className="flex items-start justify-between mb-3">
              <div>
                <p className="font-semibold text-slate-900">{a.shops?.name}</p>
                <p className="text-sm text-slate-500">{a.shops?.clients?.name}</p>
                <p className="text-sm text-slate-500 flex items-center gap-1 mt-1">
                  <MapPin className="w-3.5 h-3.5" /> {a.shops?.city}
                </p>
              </div>
              <StatusBadge status={a.shops?.status || 'pending'} />
            </div>
            {jobDone && (
              <p className="flex items-center gap-1.5 text-xs font-medium text-green-700 mb-3">
                <CheckCircle2 className="w-3.5 h-3.5" /> Job done — submitted for review. You can't edit this unless Admin/Owner sends it back for correction.
              </p>
            )}
            <div className="flex gap-2">
              <button
                onClick={() => navigateToShop(a.shops)}
                className="flex-1 flex items-center justify-center gap-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 font-medium py-2.5 rounded-lg text-sm transition"
              >
                <Navigation className="w-4 h-4" /> Navigate
              </button>
              <button
                onClick={() => onStart(a.shop_id)}
                disabled={jobDone}
                className="flex-1 flex items-center justify-center gap-1.5 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-200 disabled:text-slate-400 text-white font-medium py-2.5 rounded-lg text-sm transition"
              >
                {jobDone ? (
                  <><CheckCircle2 className="w-4 h-4" /> Job Done</>
                ) : (
                  'Start Survey'
                )}
              </button>
            </div>
          </Card>
          );
        })}
        {(!assignments || assignments.length === 0) && (
          <Card className="p-8 text-center">
            <Briefcase className="w-10 h-10 text-slate-300 mx-auto mb-2" />
            <p className="text-sm text-slate-400">No work assigned yet</p>
          </Card>
        )}
      </div>
    </div>
  );
}

// ===== Survey Wizard (4 steps: Shop, Photos & Boards, Review, Submit) =====
type WorkItemDraft = DraftWorkItem;

const BLANK_WORK_ITEM: WorkItemDraft = { work_type_id: '', work_type_name: '', material: '', width: '', height: '', unit: 'ft', quantity: '1', notes: '', photoLocalId: undefined, points: [], po_line_item_id: null };

function SurveyWizard({ shopId, onExit }: { shopId: string; onExit: (nextShopId?: string) => void }) {
  const { profile } = useAuth();
  const queryClient = useQueryClient();
  const isOnline = useOnlineStatus();
  const [step, setStep] = useState(1);
  const [photos, setPhotos] = useState<DraftPhoto[]>([]);
  const [workItems, setWorkItems] = useState<WorkItemDraft[]>([]);
  const [gps, setGps] = useState<{ lat: number; lng: number; accuracy: number } | null>(null);
  const [gpsStatus, setGpsStatus] = useState<'idle' | 'capturing' | 'captured' | 'denied'>('idle');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [submittedOffline, setSubmittedOffline] = useState(false);
  const [surveyId, setSurveyId] = useState<string | null>(null);
  const [isLocalSurveyId, setIsLocalSurveyId] = useState(false);
  const [draftReady, setDraftReady] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Which photo is currently open for marking + measurements on the
  // Photos & Boards step. null means "show the photo gallery / take a new
  // photo" rather than an open photo. Every photo the surveyor takes opens
  // straight into this so marking + details happen right there before
  // moving on — instead of taking every photo first and only marking them
  // afterwards in a separate step, which is what made it easy to forget a
  // photo (or accidentally leave two different boards' points combined on
  // one photo's marking).
  const [currentPhotoLocalId, setCurrentPhotoLocalId] = useState<string | null>(null);

  // Live location sharing: active for the whole time the surveyor has this
  // job's wizard open (On Route / At Shop / Working), pinged to
  // worker_locations so the Owner/Admin Live Field Map shows movement.
  const { status: locStatus, lastSentAt } = useLiveLocationTracking(true, profile?.id, profile?.organization_id);

  const { data: shop } = useQuery({
    queryKey: ['shop', shopId],
    queryFn: async () => {
      const { data } = await supabase.from('shops').select('*, clients(name)').eq('id', shopId).maybeSingle();
      return data as Shop & { clients?: { name: string } };
    },
  });

  // §9.3 Step 6 — "today's queue" progress strip + auto-advance to the
  // next shop on submit. Reuses the exact same shop_assignments query
  // SurveyorWork's "My Work" list uses (same query key, so this shares
  // its cache instead of double-fetching), and the same jobDone logic —
  // "today" here means "still open," not a literal calendar filter,
  // since nothing in this schema tracks a per-assignment due date.
  const { data: pendingAssignments } = useQuery({
    queryKey: ['surveyor-work', profile?.id],
    queryFn: async () => {
      const { data } = await supabase
        .from('shop_assignments')
        .select('shop_id, shops(status)')
        .eq('user_id', profile!.id)
        .eq('role', 'surveyor')
        .order('assigned_at', { ascending: false });
      return (data || []) as unknown as { shop_id: string; shops: { status: string | null } | null }[];
    },
    enabled: !!profile?.id,
  });
  const pendingQueue = (pendingAssignments || []).filter((a) => isShopSurveyable(a.shops?.status));
  const queuePosition = pendingQueue.findIndex((a) => a.shop_id === shopId);
  const queueTotal = pendingQueue.length;
  const nextShopId = queuePosition >= 0 ? pendingQueue.find((a, i) => i !== queuePosition)?.shop_id : undefined;

  const { data: workTypes } = useQuery({
    queryKey: ['work-types', profile?.organization_id],
    queryFn: async () => {
      const { data } = await supabase.from('work_types').select('*').eq('organization_id', profile!.organization_id).eq('is_active', true).order('name');
      return data as WorkType[];
    },
    enabled: !!profile?.organization_id,
  });

  // Section 8 — PO-aware live survey comparison. Only fetched when this
  // shop actually has a linked PO. Uses v_po_line_item_work_context, the
  // non-financial view (migration 0029) — carries budgeted_qty/area but
  // never `rate`, so this is safe for the surveyor role even though the
  // base po_line_items table is now locked down to financial roles only.
  const { data: poLineItemsForShop } = useQuery({
    queryKey: ['survey-po-line-items', shop?.purchase_order_id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('v_po_line_item_work_context')
        .select('*')
        .eq('purchase_order_id', shop!.purchase_order_id);
      if (error) throw error;
      return data as POLineItemWorkContext[];
    },
    enabled: !!shop?.purchase_order_id,
  });

  // How much of each of this PO's line items is already surveyed on OTHER
  // shops (work_items is org-wide readable regardless of role — no RLS
  // change needed for this sum). Excludes this shop so a redo/correction
  // survey doesn't double-count its own earlier attempt.
  const lineItemIds = (poLineItemsForShop || []).map((li) => li.id);
  const { data: elsewhereSums } = useQuery({
    queryKey: ['survey-po-elsewhere', shopId, lineItemIds.join(',')],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('work_items')
        .select('po_line_item_id, survey_area, survey_quantity')
        .in('po_line_item_id', lineItemIds)
        .neq('shop_id', shopId);
      if (error) throw error;
      const sums: Record<string, { area: number; qty: number }> = {};
      for (const row of data || []) {
        if (!row.po_line_item_id) continue;
        const cur = sums[row.po_line_item_id] || { area: 0, qty: 0 };
        cur.area += row.survey_area || 0;
        cur.qty += row.survey_quantity || 0;
        sums[row.po_line_item_id] = cur;
      }
      return sums;
    },
    enabled: lineItemIds.length > 0,
  });

  // Persist the wizard's current state to IndexedDB so nothing is lost if
  // the network drops, the tab is closed, or the phone loses signal.
  //
  // Guarded on `draftReady` (not just profile/shop): without this, a fast
  // GPS fix could resolve and call persistDraft() *before* the init effect
  // below had finished assigning a real surveyId, writing a draft with
  // surveyId: null to IndexedDB. That corrupted draft would then be picked
  // up as the "existing" draft on every future load of this shop's survey,
  // permanently stuck with a null surveyId and unable to submit — no data
  // was lost in the meantime (React state still has it), it's just not
  // written to disk until initialization has something valid to write.
  const persistDraft = useCallback(async (overrides?: Partial<SurveyDraft>) => {
    if (!profile || !shop || !draftReady) return;
    const draft: SurveyDraft = {
      id: `${profile.id}__${shopId}`,
      shopId,
      shopName: shop.name,
      organizationId: profile.organization_id,
      surveyorId: profile.id,
      step,
      photos,
      workItems,
      gps,
      gpsStatus,
      status: 'draft',
      surveyId,
      isLocalSurveyId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...overrides,
    };
    await saveDraft(draft);
  }, [profile, shop, shopId, step, photos, workItems, gps, gpsStatus, surveyId, isLocalSurveyId, draftReady]);

  // Creates a real survey id: an actual `surveys` row if online, or a local
  // placeholder id if offline (synced for real later). Shared by both the
  // fresh-start path and the draft-repair path below.
  const createSurveyId = useCallback(async (): Promise<{ id: string; isLocal: boolean }> => {
    if (navigator.onLine && profile) {
      const { data, error } = await supabase.from('surveys').insert({
        organization_id: profile.organization_id,
        shop_id: shopId,
        surveyor_id: profile.id,
        status: 'draft',
      }).select().single();
      if (data && !error) {
        const { error: shopStatusError } = await supabase.from('shops').update({ status: 'survey_started' }).eq('id', shopId).select('id');
        if (shopStatusError) console.error('[createSurveyId] could not set shop to survey_started:', shopStatusError.message);
        return { id: data.id, isLocal: false };
      }
      if (error) console.error('[createSurveyId] online insert failed, falling back to local id:', error.message);
    }
    // Offline (or the insert failed) — start the survey purely locally;
    // the real `surveys` row is created during sync.
    return { id: newLocalId(), isLocal: true };
  }, [profile, shopId]);

  // On mount: resume a local draft if one exists (offline capture or an
  // interrupted session); otherwise start a fresh survey — online if
  // possible, or purely local if there's no connection right now.
  const initStartedRef = useRef(false);

  useEffect(() => {
    async function init() {
      if (!profile || !shop || draftReady || initStartedRef.current) return;
      initStartedRef.current = true;
      const existing = await getDraft(profile.id, shopId);
      if (existing) {
        // Map an older draft's step number (from the previous 6-step wizard)
        // onto the new 4-step one, so a survey left mid-way before this
        // update doesn't land on a step that no longer exists: old steps
        // 2-4 (Photos / Mark Board / Measure) all fold into new step 2, old
        // step 5 (Review) becomes new step 3, old step 6 (Submit) becomes 4.
        const stepMap: Record<number, number> = { 1: 1, 2: 2, 3: 2, 4: 2, 5: 3, 6: 4 };
        setStep(stepMap[existing.step] || Math.min(existing.step, 4));
        setPhotos(existing.photos);
        setWorkItems(existing.workItems);
        setGps(existing.gps);
        setGpsStatus(existing.gpsStatus);

        if (existing.surveyId) {
          setSurveyId(existing.surveyId);
          setIsLocalSurveyId(existing.isLocalSurveyId);
          setDraftReady(true);
          return;
        }

        // A draft saved before a survey id was ever assigned (the race
        // described above, from an earlier version of the app) — repair it
        // now instead of getting permanently stuck: assign a real id and
        // re-save, same as a fresh start.
        console.warn('[SurveyWizard] found a saved draft with no surveyId — repairing it');
        const { id, isLocal } = await createSurveyId();
        setSurveyId(id);
        setIsLocalSurveyId(isLocal);
        setDraftReady(true);
        await saveDraft({ ...existing, surveyId: id, isLocalSurveyId: isLocal, updatedAt: new Date().toISOString() });
        return;
      }

      const { id, isLocal } = await createSurveyId();
      setSurveyId(id);
      setIsLocalSurveyId(isLocal);
      setDraftReady(true);
    }
    init();
  }, [profile, shop, shopId, draftReady, createSurveyId]);

  // Once the wizard is initialized, save the draft on every step change so
  // progress survives an app close / signal loss between steps. Intentionally
  // scoped to [draftReady, step] only — persistDraft reads the latest state
  // via closure each render, so re-running this on every keystroke isn't needed.
  useEffect(() => {
    if (draftReady) persistDraft();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftReady, step]);

  // Capture GPS
  useEffect(() => {
    if (step >= 1 && gpsStatus === 'idle') {
      setGpsStatus('capturing');
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const captured = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy };
          setGps(captured);
          setGpsStatus('captured');
          persistDraft({ gps: captured, gpsStatus: 'captured' });
        },
        () => { setGpsStatus('denied'); persistDraft({ gpsStatus: 'denied' }); },
        { enableHighAccuracy: true, timeout: 10000 }
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, gpsStatus]);

  const totalArea = workItems.reduce((sum, item) => {
    const w = parseFloat(item.width) || 0;
    const h = parseFloat(item.height) || 0;
    return sum + (w * h * (parseInt(item.quantity) || 1));
  }, 0);

  // Whenever a board doesn't have a photo picked yet (can happen on an
  // older resumed draft), default it to a photo so it never ends up
  // orphaned and invisible on the Photos & Boards step.
  useEffect(() => {
    if (photos.length === 0) return;
    setWorkItems((prev) => {
      let changed = false;
      const next = prev.map((w, i) => {
        if (w.photoLocalId && photos.some((p) => p.localId === w.photoLocalId)) return w;
        changed = true;
        return { ...w, photoLocalId: photos[Math.min(i, photos.length - 1)].localId };
      });
      return changed ? next : prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photos, workItems.length]);

  // Photos are always captured to local storage first (data URL in the
  // draft) and uploaded together at submit time via syncDraft — this keeps
  // a single, reliable upload code path whether the surveyor is online or
  // offline, and means the same draft photo id can be matched up with its
  // eventual board_markings row (see syncManager.ts).
  //
  // Every new photo immediately gets one blank board attached to it and
  // opens straight into the marking + measurement view for that photo
  // (see currentPhotoLocalId) — so marking a board happens right after
  // taking its photo, not as a separate step the surveyor has to remember
  // to come back and do for every photo.
  function handlePhotoCaptured(dataUrl: string, fileName: string) {
    const draftPhoto: DraftPhoto = {
      localId: newLocalId(),
      dataUrl,
      fileName,
      photoType: 'survey',
      uploaded: false,
    };
    const nextPhotos = [...photos, draftPhoto];
    const nextWorkItems = [...workItems, { ...BLANK_WORK_ITEM, photoLocalId: draftPhoto.localId, points: [] }];
    setPhotos(nextPhotos);
    setWorkItems(nextWorkItems);
    setCurrentPhotoLocalId(draftPhoto.localId);
    persistDraft({ photos: nextPhotos, workItems: nextWorkItems });
  }

  // Adds another board (a fresh, independent set of corner points +
  // measurements) tied to whichever photo is currently open — this is how
  // the surveyor marks more than one board on the same photo, e.g. two
  // separate signboards visible in one shot.
  function addBoardToCurrentPhoto() {
    if (!currentPhotoLocalId) return;
    setWorkItems([...workItems, { ...BLANK_WORK_ITEM, photoLocalId: currentPhotoLocalId, points: [] }]);
  }

  function removeBoard(idx: number) {
    setWorkItems(workItems.filter((_, i) => i !== idx));
  }

  async function submitSurvey() {
    console.log('[submitSurvey] clicked', { hasProfile: !!profile, surveyId, hasShop: !!shop, isOnline: navigator.onLine });

    // This used to `return` here with zero feedback if any of these were
    // momentarily missing (e.g. the shop query hadn't resolved yet) — the
    // button would look pressed but nothing would ever happen and nothing
    // would be logged, which is exactly the "submit does nothing" symptom.
    // Now it always tells the surveyor (and the console) what's wrong
    // instead of silently doing nothing.
    if (!profile || !surveyId || !shop) {
      const reason = !profile ? 'not signed in' : !shop ? 'shop details still loading' : 'survey not initialized yet';
      console.error('[submitSurvey] blocked:', reason);
      setSubmitError(`Couldn't submit — ${reason}. Please wait a moment and try again.`);
      return;
    }

    setSubmitting(true);
    setSubmitError(null);

    try {
      const finalDraft: SurveyDraft = {
        id: `${profile.id}__${shopId}`,
        shopId,
        shopName: shop.name,
        organizationId: profile.organization_id,
        surveyorId: profile.id,
        step,
        photos,
        workItems,
        gps,
        gpsStatus,
        status: 'pending_sync',
        surveyId,
        isLocalSurveyId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      // Offline (or working with a local-only survey created while offline):
      // queue the complete survey locally and stop — syncManager pushes it
      // up automatically the moment connectivity returns.
      if (!navigator.onLine) {
        await saveDraft(finalDraft);
        console.log('[submitSurvey] offline — queued locally');
        setSubmittedOffline(true);
        setSubmitted(true);
        return;
      }

      const result = await syncDraft(finalDraft);
      console.log('[submitSurvey] syncDraft result', result);
      if (!result.ok) throw new Error(result.error);

      await deleteDraft(profile.id, shopId);
      queryClient.invalidateQueries();
      setSubmittedOffline(false);
      setSubmitted(true);
    } catch (err: any) {
      // The request failed mid-flight (e.g. signal dropped while
      // submitting, or a real backend error) — don't lose the survey,
      // queue it for retry, but also surface what actually went wrong
      // instead of silently pretending everything is fine.
      console.error('[submitSurvey] failed:', err);
      setSubmitError(err?.message || 'Something went wrong while submitting.');
      try {
        const finalDraft: SurveyDraft = {
          id: `${profile.id}__${shopId}`,
          shopId,
          shopName: shop.name,
          organizationId: profile.organization_id,
          surveyorId: profile.id,
          step,
          photos,
          workItems,
          gps,
          gpsStatus,
          status: 'pending_sync',
          surveyId,
          isLocalSurveyId,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        await saveDraft(finalDraft);
      } catch (saveErr) {
        console.error('[submitSurvey] could not even save draft locally:', saveErr);
      }
      setSubmittedOffline(true);
      setSubmitted(true);
    } finally {
      setSubmitting(false);
    }
  }

  // Safety net behind the "Job Done" lock on the My Work / Home lists:
  // even if the wizard somehow got opened for a shop whose survey is
  // already submitted/approved/further along the pipeline (a stale list,
  // a resumed "Continue Survey" draft after someone else reviewed it,
  // etc.), don't let the surveyor edit or resubmit it here. Only a fresh
  // survey they haven't submitted yet (isLocalSurveyId / no submission)
  // should ever reach the form — once `shop` has actually loaded and its
  // status is out of the surveyable set, show a locked message instead.
  if (shop && !isShopSurveyable(shop.status) && !submitted) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4 pb-24 max-w-md mx-auto">
        <Card className="p-8 text-center">
          <CheckCircle2 className="w-16 h-16 text-green-500 mx-auto mb-4" />
          <h2 className="text-xl font-bold text-slate-900 mb-2">Job Already Done</h2>
          <p className="text-sm text-slate-500 mb-6">
            The survey for {shop.name} has already been submitted{shop.status === 'surveyed' || shop.status === 'approval_pending' ? ' and is awaiting review' : ''}.
            You can't edit it again unless Admin/Owner sends it back for correction or rejection.
          </p>
          <button onClick={() => onExit()} className="w-full bg-blue-600 text-white font-medium py-3 rounded-lg">
            Back
          </button>
        </Card>
      </div>
    );
  }

  if (submitted) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4 pb-24 max-w-md mx-auto">
        <Card className="p-8 text-center">
          {submittedOffline ? (
            <>
              <CloudUpload className="w-16 h-16 text-amber-500 mx-auto mb-4" />
              <h2 className="text-xl font-bold text-slate-900 mb-2">Saved — Waiting to Sync</h2>
              <p className="text-sm text-slate-500 mb-6">
                Your survey for {shop?.name} is saved on this phone and will upload automatically once you're back online.
              </p>
              {submitError && (
                <p className="text-xs text-red-500 bg-red-50 border border-red-200 rounded-lg p-2 mb-6 text-left">
                  Upload attempt failed: {submitError} — it'll retry automatically, but if this keeps happening, screenshot this message for support.
                </p>
              )}
            </>
          ) : (
            <>
              <CheckCircle2 className="w-16 h-16 text-green-500 mx-auto mb-4" />
              <h2 className="text-xl font-bold text-slate-900 mb-2">Survey Submitted!</h2>
              <p className="text-sm text-slate-500 mb-6">Your survey for {shop?.name} has been submitted for review.</p>
            </>
          )}
          <button onClick={() => onExit(nextShopId)} className="w-full bg-blue-600 text-white font-medium py-3 rounded-lg">
            {nextShopId ? 'Next Shop' : 'Done'}
          </button>
          {nextShopId && (
            <button onClick={() => onExit()} className="w-full text-sm text-slate-500 font-medium py-2.5 mt-1">
              Done for now
            </button>
          )}
        </Card>
      </div>
    );
  }

  const steps = ['Shop', 'Photos & Boards', 'Review', 'Submit'];

  return (
    <div className="min-h-screen bg-slate-50 pb-24 max-w-md mx-auto">
      {!isOnline && (
        <div className="bg-amber-500 text-white text-xs font-medium py-1.5 px-4 flex items-center justify-center gap-1.5">
          <WifiOff className="w-3.5 h-3.5" /> Offline — saving to this phone, will sync later
        </div>
      )}
      {/* Header with progress */}
      <div className="bg-white border-b border-slate-200 sticky top-0 z-30">
        <div className="flex items-center justify-between p-4">
          <button onClick={() => onExit()} className="text-sm text-slate-500">Cancel</button>
          <p className="font-semibold text-slate-900">Step {step} of 4</p>
          <span className="text-xs text-slate-400">{steps[step - 1]}</span>
        </div>
        {/* §9.3 — "Shop N of M today" so the surveyor always knows how much
            is left in their day, doubling as their own Work Ledger view. */}
        {queuePosition >= 0 && queueTotal > 0 && (
          <p className="px-4 pb-1 text-xs text-blue-600 font-medium">Shop {queuePosition + 1} of {queueTotal} today</p>
        )}
        <div className="flex px-4 pb-3 gap-1">
          {[1, 2, 3, 4].map((s) => (
            <div key={s} className={`h-1.5 flex-1 rounded-full ${s <= step ? 'bg-blue-600' : 'bg-slate-200'}`} />
          ))}
        </div>
        <div className="px-4 pb-3">
          <LocationShareIndicator status={locStatus} lastSentAt={lastSentAt} />
        </div>
      </div>

      <CameraCapture
        open={cameraOpen}
        onClose={() => setCameraOpen(false)}
        onCapture={handlePhotoCaptured}
        title="Survey Photo"
      />

      <div className="p-4">
        {/* Step 1: Shop */}
        {step === 1 && shop && (
          <div className="space-y-4">
            <Card className="p-4">
              <h2 className="font-bold text-slate-900 text-lg mb-3">{shop.name}</h2>
              <div className="space-y-2 text-sm text-slate-600">
                <p>Client: {shop.clients?.name}</p>
                <p>Owner: {shop.owner_name || 'N/A'}</p>
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
                <div className="text-sm text-green-600 flex items-center gap-1">
                  <CheckCircle2 className="w-4 h-4" /> Location captured (accuracy: {gps.accuracy.toFixed(0)}m)
                </div>
              ) : gpsStatus === 'capturing' ? (
                <div className="text-sm text-blue-600 flex items-center gap-1">
                  <Loader2 className="w-4 h-4 animate-spin" /> Capturing location...
                </div>
              ) : gpsStatus === 'denied' ? (
                <div className="text-sm text-amber-600 flex items-center gap-1">
                  <AlertCircle className="w-4 h-4" /> Location unavailable - check permissions
                </div>
              ) : (
                <p className="text-sm text-slate-400">Waiting to capture...</p>
              )}
            </Card>

            <button
              onClick={() => navigateToShop(shop)}
              className="w-full flex items-center justify-center gap-2 bg-blue-600 text-white font-bold py-4 rounded-xl text-lg transition"
            >
              <Navigation className="w-5 h-5" /> Navigate to Shop
            </button>

            <button onClick={() => setStep(2)} className="w-full bg-slate-900 text-white font-medium py-3 rounded-lg">
              Continue
            </button>
          </div>
        )}

        {/* Step 2: Photos & Boards — take a photo, mark its board(s), fill
            in its measurements, then move to the next photo. Everything
            for one photo happens together instead of three separate passes
            over the whole photo set. */}
        {step === 2 && (
          <div className="space-y-4">
            {!currentPhotoLocalId && (
              <p className="text-sm text-slate-600">
                {photos.length === 0
                  ? 'Take a photo of the shop front or a board — you\'ll mark it and fill in its details right after.'
                  : 'Take another photo, or tap one below to review or edit its markings.'}
              </p>
            )}

            {photos.length > 0 && (
              <div className="flex gap-2 overflow-x-auto pb-1">
                {photos.map((p, i) => {
                  const boardCount = workItems.filter((w) => w.photoLocalId === p.localId).length;
                  const markedCount = workItems.filter((w) => w.photoLocalId === p.localId && (w.points?.length || 0) >= 3).length;
                  return (
                    <button
                      key={p.localId}
                      onClick={() => setCurrentPhotoLocalId(p.localId)}
                      className={`relative flex-shrink-0 rounded-lg overflow-hidden border-2 ${currentPhotoLocalId === p.localId ? 'border-blue-600' : 'border-transparent'}`}
                    >
                      <img src={p.photoUrl || p.dataUrl} alt={`Photo ${i + 1}`} className="w-16 h-16 object-cover" />
                      <span className="absolute bottom-0 inset-x-0 bg-black/60 text-white text-[9px] text-center py-0.5">Photo {i + 1}</span>
                      {boardCount > 0 && (
                        <span className={`absolute top-0.5 right-0.5 text-white text-[9px] font-medium px-1 rounded ${markedCount === boardCount ? 'bg-green-600' : 'bg-amber-500'}`}>
                          {markedCount}/{boardCount}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}

            {!currentPhotoLocalId && (
              <button onClick={() => setCameraOpen(true)} className="w-full flex items-center justify-center gap-2 bg-blue-600 text-white font-bold py-4 rounded-xl text-lg">
                <Camera className="w-6 h-6" /> {photos.length === 0 ? 'Take Photo' : 'Take Another Photo'}
              </button>
            )}

            {currentPhotoLocalId && (() => {
              const photo = photos.find((p) => p.localId === currentPhotoLocalId);
              const photoIndex = photos.findIndex((p) => p.localId === currentPhotoLocalId);
              const boardsForPhoto = workItems
                .map((w, idx) => ({ w, idx }))
                .filter(({ w }) => w.photoLocalId === currentPhotoLocalId);
              if (!photo) return null;

              return (
                <div className="space-y-4">
                  {boardsForPhoto.map(({ w: item, idx }, n) => {
                    const area = (parseFloat(item.width) || 0) * (parseFloat(item.height) || 0) * (parseInt(item.quantity) || 1);
                    return (
                      <Card key={idx} className="p-4 space-y-3">
                        <div className="flex items-center justify-between">
                          <span className="font-medium text-slate-900">
                            Marking {n + 1} of {boardsForPhoto.length} — Photo {photoIndex + 1}
                          </span>
                          {boardsForPhoto.length > 1 && (
                            <button onClick={() => removeBoard(idx)} className="text-sm text-red-500">Remove</button>
                          )}
                        </div>

                        <BoardMarkerCanvas
                          photoUrl={photo.photoUrl || photo.dataUrl}
                          points={item.points || []}
                          onChange={(pts) => setWorkItems(workItems.map((w, i) => (i === idx ? { ...w, points: pts } : w)))}
                          polygonLabel={buildBoardLabel({ workTypeName: item.work_type_name, width: item.width, height: item.height, unit: item.unit })}
                          colorIndex={n}
                        />

                        <div className="space-y-3 pt-1 border-t border-slate-100">
                          {/* Icon tiles instead of a dropdown (§9.3 Step 4) —
                              icons read faster than text for field staff who
                              may not be fluent in reading app UI text. */}
                          <div>
                            <label className="block text-sm font-medium text-slate-700 mb-1.5">Work Type</label>
                            <div className="grid grid-cols-3 gap-2">
                              {(workTypes || []).map((wt) => {
                                const WtIcon = iconForWorkType(wt.name);
                                const selected = item.work_type_id === wt.id;
                                return (
                                  <button
                                    key={wt.id}
                                    type="button"
                                    onClick={() => {
                                      const matchedLineItem = findLineItemForWorkType(poLineItemsForShop || [], wt.id);
                                      setWorkItems(workItems.map((w, i) => i === idx ? { ...w, work_type_id: wt.id, work_type_name: wt.name, po_line_item_id: matchedLineItem?.id || null } : w));
                                    }}
                                    className={`flex flex-col items-center justify-center gap-1 py-3 rounded-xl border-2 text-center ${
                                      selected ? 'bg-blue-50 border-blue-500 text-blue-700' : 'bg-slate-50 border-slate-200 text-slate-600'
                                    }`}
                                  >
                                    <WtIcon className="w-5 h-5" />
                                    <span className="text-[11px] font-medium leading-tight px-1">{wt.name}</span>
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                          <Input label="Material" value={item.material} onChange={(v) => setWorkItems(workItems.map((w, i) => i === idx ? { ...w, material: v } : w))} placeholder="e.g. ACP Sheet" />
                          <div className="grid grid-cols-2 gap-3">
                            <Input label="Width" type="number" value={item.width} onChange={(v) => setWorkItems(workItems.map((w, i) => i === idx ? { ...w, width: v } : w))} step="any" />
                            <Input label="Height" type="number" value={item.height} onChange={(v) => setWorkItems(workItems.map((w, i) => i === idx ? { ...w, height: v } : w))} step="any" />
                          </div>
                          <div className="grid grid-cols-2 gap-3">
                            <Select label="Unit" value={item.unit} onChange={(v) => setWorkItems(workItems.map((w, i) => i === idx ? { ...w, unit: v } : w))} options={[{ value: 'ft', label: 'Feet' }, { value: 'in', label: 'Inch' }, { value: 'm', label: 'Meter' }, { value: 'cm', label: 'Centimeter' }]} />
                            <Input label="Quantity" type="number" value={item.quantity} onChange={(v) => setWorkItems(workItems.map((w, i) => i === idx ? { ...w, quantity: v } : w))} />
                          </div>
                          <Textarea label="Notes" value={item.notes} onChange={(v) => setWorkItems(workItems.map((w, i) => i === idx ? { ...w, notes: v } : w))} rows={2} />
                          <div className="bg-blue-50 rounded-lg p-3 text-center">
                            <p className="text-xs text-blue-600">Calculated Area</p>
                            <p className="text-lg font-bold text-blue-700">{area.toFixed(2)} sq {item.unit}</p>
                          </div>
                          {(() => {
                            const lineItem = poLineItemsForShop?.find((li) => li.id === item.po_line_item_id);
                            if (!lineItem) return null;
                            const elsewhere = elsewhereSums?.[lineItem.id];
                            const areaBased = lineItem.uom === 'sqft';
                            const surveyedElsewhere = areaBased ? (elsewhere?.area || 0) : (elsewhere?.qty || 0);
                            const thisMeasurement = areaBased ? area : (parseInt(item.quantity) || 1);
                            const fig = computePOVariance(lineItem, surveyedElsewhere, thisMeasurement);
                            const unitLabel = areaBased ? 'sqft' : lineItem.uom;
                            return (
                              <div className={`rounded-lg p-3 text-xs space-y-1 border ${fig.exceeds ? 'bg-amber-50 border-amber-300' : 'bg-slate-50 border-slate-200'}`}>
                                <p className="font-medium text-slate-700">
                                  {lineItem.name ? `${lineItem.name} (${lineItem.po_number})` : `PO ${lineItem.po_number}`} — {lineItem.description || 'Line item'} budget: {fig.budgeted != null ? `${fig.budgeted} ${unitLabel}` : 'not set'}
                                </p>
                                <p className="text-slate-500">Already surveyed elsewhere on this PO: {fig.surveyedElsewhere.toFixed(2)} {unitLabel}</p>
                                <p className="text-slate-500">This shop's measurement: {fig.thisMeasurement.toFixed(2)} {unitLabel}</p>
                                <p className={fig.exceeds ? 'text-amber-700 font-semibold' : 'text-slate-700 font-medium'}>
                                  Running total: {fig.runningTotal.toFixed(2)}{fig.budgeted != null ? ` / ${fig.budgeted} ${unitLabel} (${fig.pct?.toFixed(0)}%)` : ` ${unitLabel}`}
                                </p>
                                {fig.exceeds && (
                                  <p className="text-amber-700 flex items-center gap-1">
                                    <AlertCircle className="w-3.5 h-3.5" /> Exceeds PO budget by {fig.exceedsBy.toFixed(2)} {unitLabel}
                                  </p>
                                )}
                              </div>
                            );
                          })()}
                        </div>
                      </Card>
                    );
                  })}

                  <button
                    onClick={addBoardToCurrentPhoto}
                    className="w-full flex items-center justify-center gap-2 border-2 border-dashed border-blue-300 text-blue-600 font-medium py-3 rounded-lg"
                  >
                    + Add Another Marking on This Photo
                  </button>

                  <button
                    onClick={() => { persistDraft(); setCurrentPhotoLocalId(null); }}
                    className="w-full bg-slate-900 text-white font-medium py-3 rounded-lg"
                  >
                    Done with This Photo
                  </button>
                </div>
              );
            })()}

            <div className="flex gap-2">
              <button onClick={() => setStep(1)} className="flex items-center justify-center gap-1 bg-slate-200 text-slate-700 font-medium py-3 rounded-lg flex-1">
                <ChevronLeft className="w-4 h-4" /> Back
              </button>
              <button
                onClick={() => { persistDraft(); setCurrentPhotoLocalId(null); setStep(3); }}
                disabled={photos.length === 0}
                className="bg-slate-900 text-white font-medium py-3 rounded-lg flex-1 disabled:opacity-50"
              >
                Continue to Review
              </button>
            </div>
          </div>
        )}


        {/* Step 3: Review — lets the surveyor see exactly what they marked
            and filled in, per photo, before submitting; tapping "Edit"
            jumps straight back into that photo on the Photos & Boards step. */}
        {step === 3 && (() => {
          const unmarkedCount = workItems.filter((w) => (w.points?.length || 0) < 3).length;
          return (
            <div className="space-y-4">
              <Card className="p-4">
                <h2 className="font-semibold text-slate-900 mb-3">Review Summary</h2>
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between"><span className="text-slate-500">Shop:</span><span className="text-slate-900 font-medium">{shop?.name}</span></div>
                  <div className="flex justify-between"><span className="text-slate-500">Photos:</span><span className="text-slate-900 font-medium">{photos.length}</span></div>
                  <div className="flex justify-between"><span className="text-slate-500">Boards:</span><span className="text-slate-900 font-medium">{workItems.length}</span></div>
                  <div className="flex justify-between"><span className="text-slate-500">Total Area:</span><span className="text-slate-900 font-medium">{totalArea.toFixed(2)} sq ft</span></div>
                  <div className="flex justify-between items-center">
                    <span className="text-slate-500">GPS:</span>
                    {gpsStatus === 'captured' ? (
                      <span className="text-green-600 flex items-center gap-1"><CheckCircle2 className="w-4 h-4" /> Captured</span>
                    ) : (
                      <span className="text-amber-600">Unavailable</span>
                    )}
                  </div>
                </div>
              </Card>

              {unmarkedCount > 0 && (
                <Card className="p-3 border-amber-300 bg-amber-50 flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 text-amber-600 flex-shrink-0" />
                  <p className="text-xs text-amber-700">
                    {unmarkedCount} board{unmarkedCount > 1 ? 's are' : ' is'} missing its corner marking — tap it below to fix before submitting.
                  </p>
                </Card>
              )}

              <p className="text-xs text-slate-400">Check each photo below — tap Edit if anything looks wrong.</p>

              {photos.map((p, i) => {
                const boards = workItems
                  .map((w, idx) => ({ w, idx }))
                  .filter(({ w }) => w.photoLocalId === p.localId);
                const markedBoards = boards.filter(({ w }) => w.points && w.points.length >= 3);
                const boardPointSets = markedBoards.map(({ w }) => w.points as MarkPoint[]);
                const boardLabels = markedBoards.map(({ w }) => buildBoardLabel({ workTypeName: w.work_type_name, width: w.width, height: w.height, unit: w.unit }));
                return (
                  <Card key={p.localId} className="p-3">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm font-medium text-slate-900">Photo {i + 1}</span>
                      <button
                        onClick={() => { setCurrentPhotoLocalId(p.localId); setStep(2); }}
                        className="text-xs font-medium text-blue-600"
                      >
                        Edit
                      </button>
                    </div>
                    <ReviewPhotoThumb src={p.photoUrl || p.dataUrl} boardPointSets={boardPointSets} boardLabels={boardLabels} index={i} />
                    {boards.length === 0 ? (
                      <p className="text-xs text-slate-400 mt-2">No boards marked on this photo.</p>
                    ) : (
                      <div className="mt-2 space-y-1">
                        {boards.map(({ w }, n) => {
                          const marked = (w.points?.length || 0) >= 3;
                          const area = (parseFloat(w.width) || 0) * (parseFloat(w.height) || 0) * (parseInt(w.quantity) || 1);
                          return (
                            <div key={n} className="flex items-center justify-between text-xs">
                              <span className={marked ? 'text-slate-600' : 'text-amber-600'}>
                                {!marked && '⚠ '}{w.work_type_name || 'Board'} {n + 1}{w.material ? ` — ${w.material}` : ''}
                              </span>
                              <span className="text-slate-500">{w.width || '0'}×{w.height || '0'} {w.unit} = {area.toFixed(1)} sq {w.unit}</span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </Card>
                );
              })}

              <div className="flex gap-2">
                <button onClick={() => setStep(2)} className="flex items-center justify-center gap-1 bg-slate-200 text-slate-700 font-medium py-3 rounded-lg flex-1">
                  <ChevronLeft className="w-4 h-4" /> Back
                </button>
                <button onClick={() => setStep(4)} className="bg-slate-900 text-white font-medium py-3 rounded-lg flex-1">
                  Continue to Submit
                </button>
              </div>
            </div>
          );
        })()}

        {/* Step 4: Submit */}
        {step === 4 && (
          <div className="space-y-4">
            <Card className="p-6 text-center">
              <FileText className="w-12 h-12 text-blue-500 mx-auto mb-3" />
              <h2 className="text-lg font-bold text-slate-900 mb-2">Ready to Submit</h2>
              <p className="text-sm text-slate-500 mb-4">
                {shop?.name} - {photos.length} photos, {workItems.length} boards, {totalArea.toFixed(2)} sq ft
              </p>
              {submitError && (
                <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg p-2 mb-4 text-left">
                  {submitError}
                </p>
              )}
              <button
                onClick={submitSurvey}
                disabled={submitting}
                className="w-full bg-green-600 hover:bg-green-700 text-white font-bold py-4 rounded-xl text-lg disabled:opacity-50"
              >
                {submitting ? 'Submitting...' : isOnline ? 'SUBMIT SURVEY' : 'SAVE SURVEY (OFFLINE)'}
              </button>
            </Card>
            <button onClick={() => setStep(3)} className="w-full flex items-center justify-center gap-1 bg-slate-200 text-slate-700 font-medium py-3 rounded-lg">
              <ChevronLeft className="w-4 h-4" /> Back to Review
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ===== Shared mobile components =====

// "My Route" — today's admin-planned, optimized stop order for this field
// worker (see Route Planning, admin side). Separate from the plain
// shop_assignments list below it: that list is "everything assigned to
// me, ever"; this is "what order to visit things in today, with real
// turn-by-turn navigation across the whole run" — the piece that was
// missing when the map only ever dropped one pin at a time.
function MyRoutePanel() {
  const { profile } = useAuth();

  const { data: route } = useQuery({
    queryKey: ['my-route', profile?.id],
    queryFn: async () => {
      const today = new Date().toISOString().split('T')[0];
      const { data } = await supabase
        .from('routes')
        .select('id, name, status, origin_lat, origin_lng, total_distance_meters, total_duration_seconds, route_stops(id, stop_order, status, shops(id, name, latitude, longitude, city))')
        .eq('user_id', profile!.id)
        .eq('route_date', today)
        .in('status', ['planned', 'active'])
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      return data;
    },
    enabled: !!profile?.id,
  });

  const queryClient = useQueryClient();
  const markStopMutation = async (stopId: string, status: 'visited' | 'skipped') => {
    await supabase.from('route_stops').update({ status }).eq('id', stopId);
    queryClient.invalidateQueries({ queryKey: ['my-route', profile?.id] });
  };

  if (!route || !route.route_stops || route.route_stops.length === 0) return null;

  const stops = [...route.route_stops].sort((a: any, b: any) => a.stop_order - b.stop_order);
  const stopPoints = stops
    .filter((s: any) => s.shops?.latitude != null)
    .map((s: any) => ({ id: s.shops.id, name: s.shops.name, lat: s.shops.latitude, lng: s.shops.longitude }));
  const origin = route.origin_lat != null ? { lat: route.origin_lat, lng: route.origin_lng } : null;
  const navUrl = buildMultiStopNavigationUrl(stopPoints, origin);
  const visitedCount = stops.filter((s: any) => s.status !== 'pending').length;

  return (
    <Card className="p-4 mb-4">
      <div className="flex items-center justify-between mb-1">
        <p className="font-semibold text-slate-900">Today's route</p>
        {route.total_distance_meters != null && (
          <p className="text-xs text-slate-500">{formatDistance(route.total_distance_meters)} · {formatDuration(route.total_duration_seconds)}</p>
        )}
      </div>
      <p className="text-xs text-slate-400 mb-3">{visitedCount}/{stops.length} stops done</p>

      <ol className="space-y-2 mb-3">
        {stops.map((stop: any) => (
          <li key={stop.id} className="flex items-center gap-2.5">
            <span className={`w-6 h-6 rounded-full text-white text-[11px] font-bold flex items-center justify-center shrink-0 ${stop.status === 'visited' ? 'bg-emerald-600' : stop.status === 'skipped' ? 'bg-slate-400' : 'bg-slate-900'}`}>
              {stop.stop_order}
            </span>
            <span className={`flex-1 text-sm truncate ${stop.status !== 'pending' ? 'text-slate-400 line-through' : 'text-slate-800'}`}>
              {stop.shops?.name || 'Shop'}
            </span>
            {stop.status === 'pending' && stop.shops?.latitude != null && (
              <div className="flex gap-1 shrink-0">
                <button
                  onClick={() => window.open(`https://www.google.com/maps/dir/?api=1&destination=${stop.shops.latitude},${stop.shops.longitude}`, '_blank')}
                  className="text-blue-600 text-xs font-medium"
                >
                  Go
                </button>
                <button onClick={() => markStopMutation(stop.id, 'visited')} className="text-emerald-600 text-xs font-medium">✓</button>
                <button onClick={() => markStopMutation(stop.id, 'skipped')} className="text-slate-400 text-xs font-medium">Skip</button>
              </div>
            )}
          </li>
        ))}
      </ol>

      {navUrl && (
        <a
          href={navUrl} target="_blank" rel="noreferrer"
          className="w-full flex items-center justify-center gap-2 bg-blue-600 text-white text-sm font-medium py-2.5 rounded-lg"
        >
          <Navigation className="w-4 h-4" /> Start turn-by-turn navigation
        </a>
      )}
    </Card>
  );
}

export function FieldMapView() {
  const { profile } = useAuth();
  const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY || '';
  const [resolvedShops, setResolvedShops] = useState<any[] | null>(null);
  const [geocoding, setGeocoding] = useState(false);
  const [geocodeFailedCount, setGeocodeFailedCount] = useState(0);

  const { data: assignments } = useQuery({
    queryKey: ['field-map', profile?.id],
    queryFn: async () => {
      const { data } = await supabase
        .from('shop_assignments')
        .select('shops(id, name, latitude, longitude, city, district, state, address, status)')
        .eq('user_id', profile!.id);
      return data;
    },
    enabled: !!profile?.id,
  });

  const rawShops = (assignments || []).map((a: any) => a.shops).filter(Boolean);

  // Shops with a pinned lat/lng already are fine as-is. Anything missing
  // coordinates (very common straight after a bulk address upload) gets
  // geocoded from its address/city/district/state and written back —
  // this is what turns "No shops with coordinates assigned" into an
  // actual map with every assigned shop on it.
  useEffect(() => {
    let cancelled = false;
    if (rawShops.length === 0) { setResolvedShops([]); return; }
    const allHaveCoords = rawShops.every((s: any) => s.latitude != null && s.longitude != null);
    if (allHaveCoords) { setResolvedShops(rawShops); return; }

    setGeocoding(true);
    fillMissingShopCoordinates(rawShops).then(({ resolved, failedIds }) => {
      if (cancelled) return;
      setResolvedShops(resolved);
      setGeocodeFailedCount(failedIds.length);
      setGeocoding(false);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(rawShops.map((s: any) => s.id))]);

  const shops = (resolvedShops ?? rawShops).filter((s: any) => s?.latitude != null && s?.longitude != null);

  return (
    <div className="p-4">
      <h1 className="text-xl font-bold text-slate-900 mb-4">Map</h1>
      <MyRoutePanel />
      {geocoding && (
        <p className="text-xs text-slate-500 mb-3 flex items-center gap-1.5">
          <span className="w-3 h-3 border-2 border-slate-300 border-t-blue-600 rounded-full animate-spin inline-block" />
          Locating shops on the map from their address...
        </p>
      )}
      {apiKey && shops.length > 0 ? (
        <SimpleMap apiKey={apiKey} shops={shops} />
      ) : (
        <Card className="p-4">
          <p className="text-sm text-slate-600 mb-3">Your assigned shops:</p>
          <div className="space-y-2">
            {shops.map((s: any) => (
              <div key={s.id} className="flex items-center justify-between text-sm border-b border-slate-100 pb-2">
                <div>
                  <p className="font-medium text-slate-900">{s.name}</p>
                  <p className="text-xs text-slate-500">{s.city}</p>
                </div>
                <button
                  onClick={() => window.open(`https://www.google.com/maps/dir/?api=1&destination=${s.latitude},${s.longitude}`, '_blank')}
                  className="text-blue-600 text-xs font-medium"
                >
                  Navigate →
                </button>
              </div>
            ))}
            {!geocoding && shops.length === 0 && rawShops.length === 0 && (
              <p className="text-sm text-slate-400">No shops assigned to you yet.</p>
            )}
            {!geocoding && shops.length === 0 && rawShops.length > 0 && (
              <p className="text-sm text-amber-600">
                Couldn't locate any of your {rawShops.length} assigned shop(s) on the map — their addresses may be incomplete. Ask your office to check the address/city/state on file.
              </p>
            )}
          </div>
          {!geocoding && geocodeFailedCount > 0 && shops.length > 0 && (
            <p className="text-xs text-amber-600 mt-2">
              {geocodeFailedCount} shop(s) couldn't be located from their address and aren't shown above.
            </p>
          )}
          {!apiKey && <p className="text-xs text-amber-600 mt-3">Set VITE_GOOGLE_MAPS_API_KEY to enable the map view.</p>}
        </Card>
      )}
    </div>
  );
}

function SimpleMap({ apiKey, shops }: { apiKey: string; shops: any[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (window.google?.maps) { setLoaded(true); return; }
    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}`;
    script.async = true;
    script.onload = () => setLoaded(true);
    document.head.appendChild(script);
  }, [apiKey]);

  useEffect(() => {
    if (!loaded || !ref.current || shops.length === 0) return;
    const center = { lat: shops[0].latitude, lng: shops[0].longitude };
    const map = new window.google.maps.Map(ref.current, { zoom: 12, center });
    shops.forEach((s) => {
      new window.google.maps.Marker({
        position: { lat: s.latitude, lng: s.longitude },
        map,
        title: s.name,
      });
    });
  }, [loaded, shops]);

  return <div ref={ref} className="w-full h-96 rounded-lg" />;
}

export function NotificationsView() {
  const { profile } = useAuth();

  const { data: notifications } = useQuery({
    queryKey: ['notifications', profile?.id],
    queryFn: async () => {
      const { data } = await supabase
        .from('notifications')
        .select('*')
        .eq('user_id', profile!.id)
        .order('created_at', { ascending: false });
      return data;
    },
    enabled: !!profile?.id,
  });

  return (
    <div className="p-4">
      <h1 className="text-xl font-bold text-slate-900 mb-4">Notifications</h1>
      <div className="space-y-2">
        {(notifications || []).map((n) => (
          <Card key={n.id} className={`p-4 ${!n.is_read ? 'border-blue-300' : ''}`}>
            <p className="font-medium text-slate-900 text-sm">{n.title}</p>
            <p className="text-sm text-slate-500 mt-1">{n.message}</p>
            <p className="text-xs text-slate-400 mt-1">{new Date(n.created_at).toLocaleString('en-IN')}</p>
          </Card>
        ))}
        {(!notifications || notifications.length === 0) && (
          <Card className="p-8 text-center">
            <Bell className="w-10 h-10 text-slate-300 mx-auto mb-2" />
            <p className="text-sm text-slate-400">No notifications</p>
          </Card>
        )}
      </div>
    </div>
  );
}

export function ProfileView({ onSignOut }: { onSignOut: () => void }) {
  const { profile } = useAuth();
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [pwMsg, setPwMsg] = useState('');

  async function changePassword() {
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    if (error) { setPwMsg('Failed: ' + error.message); } else { setPwMsg('Password updated!'); setNewPassword(''); setOldPassword(''); }
  }

  return (
    <div className="p-4">
      <h1 className="text-xl font-bold text-slate-900 mb-4">Profile</h1>
      <Card className="p-4 mb-4">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-14 h-14 rounded-full bg-blue-100 flex items-center justify-center text-blue-600 font-bold text-xl">
            {profile?.full_name?.charAt(0)}
          </div>
          <div>
            <p className="font-semibold text-slate-900">{profile?.full_name}</p>
            <p className="text-sm text-slate-500 capitalize">{profile?.role.replace(/_/g, ' ')}</p>
            {profile?.phone && <p className="text-sm text-slate-500">{profile.phone}</p>}
          </div>
        </div>
      </Card>

      <Card className="p-4 mb-4">
        <h2 className="font-semibold text-slate-900 mb-3">Change Password</h2>
        <div className="space-y-3">
          <Input label="New Password" type="password" value={newPassword} onChange={setNewPassword} />
          <button onClick={changePassword} className="w-full bg-blue-600 text-white font-medium py-2.5 rounded-lg">
            Update Password
          </button>
          {pwMsg && <p className="text-sm text-center text-slate-600">{pwMsg}</p>}
        </div>
      </Card>

      <button onClick={onSignOut} className="w-full bg-red-50 text-red-600 font-medium py-3 rounded-lg border border-red-200">
        Sign Out
      </button>
    </div>
  );
}
