import Dexie, { type Table } from 'dexie';

// ── Offline survey storage ─────────────────────────────────────────────
// Field surveyors often work in shops/warehouses with weak or no signal.
// Everything captured in the survey wizard (photos, board measurements,
// GPS) is written to this local IndexedDB store as the surveyor moves
// through the wizard, so nothing is lost if the network drops, the tab
// is closed, or the phone loses signal mid-survey. When connectivity
// returns, `syncManager.ts` pushes any queued drafts up to Supabase.

export interface DraftPhoto {
  localId: string;
  dataUrl: string;
  fileName: string;
  photoType: 'survey';
  captureLat?: number | null;
  captureLng?: number | null;
  captureAccuracy?: number | null;
  capturedAt?: string;
  storagePath?: string;
  photoUrl?: string;
  photoId?: string;
  uploaded: boolean;
}

export interface DraftWorkItem {
  work_type_id: string;
  work_type_name: string;
  material: string;
  width: string;
  height: string;
  unit: string;
  // Height can be measured in a different unit than width (e.g. a board
  // that's "10 ft wide, 8 in deep" on an edge strip) — `unit` is the
  // width's unit; this is the height's. Falls back to `unit` when unset
  // so every existing draft/board still behaves exactly as before.
  heightUnit?: string;
  quantity: string;
  notes: string;
  // Which captured photo this board's corners were marked on, and the
  // marked corners themselves (percentages of that photo's rendered size).
  photoLocalId?: string;
  points?: { x: number; y: number }[];
  // Auto-resolved (Section 8) when the shop has a linked PO and the
  // selected work type matches exactly one of that PO's line items — lets
  // the live budget-comparison banner show while surveying, and gets
  // written onto work_items.po_line_item_id on submit so it's already
  // linked instead of needing a separate Admin step on the Shop Detail
  // page afterwards. Left null/undefined when there's no unique match;
  // Admin can still link it manually later either way.
  po_line_item_id?: string | null;
}

export type DraftStatus = 'draft' | 'pending_sync' | 'syncing' | 'sync_failed' | 'synced';

export interface SurveyDraft {
  id: string;
  shopId: string;
  shopName: string;
  organizationId: string;
  surveyorId: string;
  step: number;
  photos: DraftPhoto[];
  workItems: DraftWorkItem[];
  /** Resume the same photo/marking editor after an interruption. IndexedDB field is additive. */
  currentPhotoLocalId?: string | null;
  gps: { lat: number; lng: number; accuracy: number } | null;
  gpsStatus: 'idle' | 'capturing' | 'captured' | 'denied';
  status: DraftStatus;
  surveyId: string | null;
  isLocalSurveyId: boolean;
  // Checkpoints allow safe retry after a partial network response.
  syncedWorkItems?: Record<string, string>;
  syncError?: string;
  createdAt: string;
  updatedAt: string;
}


// Saved, read-only view of this worker's own assignments for weak-signal use.
// The server remains authoritative for permissions and status changes.
export interface FieldAssignmentSnapshot {
  id: string; // `${workerId}:${role}`
  workerId: string;
  role: 'surveyor' | 'installer';
  savedAt: string;
  assignments: any[];
}

// Installation photo capture is persisted BEFORE any network upload. The
// immutable storage path makes retries reconcilable with an existing proof.
export interface FieldWorkOrdersSnapshot {
  id: string;
  workerId: string;
  savedAt: string;
  orders: { id: string; name?: string | null; po_number: string }[];
}

export interface FieldReferenceSnapshot {
  id: string;
  workerId: string;
  updatedAt: string;
  value: unknown;
}

export interface PendingInstallationPhoto {
  id: string;
  workerId: string;
  organizationId: string;
  shopId: string;
  jobId: string;
  path: string;
  dataUrl: string;
  originalHash: string | null;
  angle: 'front' | 'side' | 'other';
  workItemId: string | null;
  caption: string | null;
  gps: { lat: number; lng: number; accuracy: number } | null;
  createdAt: string;
  lastError?: string;
}

class OfflineDB extends Dexie {
  surveyDrafts!: Table<SurveyDraft, string>;
  fieldAssignments!: Table<FieldAssignmentSnapshot, string>;
  fieldWorkOrders!: Table<FieldWorkOrdersSnapshot, string>;
  fieldReferences!: Table<FieldReferenceSnapshot, string>;
  installationPhotos!: Table<PendingInstallationPhoto, string>;
  fieldRedoDrafts!: Table<{id:string;userId:string;shopId:string;stage:string;correctionId:string;payload:Record<string,unknown>;status:string;updatedAt:string},string>;

  constructor() {
    super('darshan_field_ops');
    this.version(1).stores({
      surveyDrafts: 'id, shopId, surveyorId, status, updatedAt',
    });
    // Version 2 ADDS tables; never resets existing survey drafts/markings.
    this.version(2).stores({
      surveyDrafts: 'id, shopId, surveyorId, status, updatedAt',
      fieldAssignments: 'id, workerId, role, savedAt',
      fieldWorkOrders: 'id, workerId, savedAt',
      fieldReferences: 'id, workerId, updatedAt',
      installationPhotos: 'id, workerId, shopId, jobId, createdAt',
    });
    // Additive redo queue. The previous survey, installer and assignment stores are retained.
    this.version(3).stores({
      surveyDrafts: 'id, shopId, surveyorId, status, updatedAt',
      fieldAssignments: 'id, workerId, role, savedAt',
      fieldWorkOrders: 'id, workerId, savedAt',
      fieldReferences: 'id, workerId, updatedAt',
      installationPhotos: 'id, workerId, shopId, jobId, createdAt',
      fieldRedoDrafts: 'id, userId, shopId, stage, status, updatedAt',
    });
  }
}

export const offlineDb = new OfflineDB();

export function makeDraftId(surveyorId: string, shopId: string) {
  return `${surveyorId}__${shopId}`;
}

export async function saveDraft(draft: SurveyDraft) {
  draft.updatedAt = new Date().toISOString();
  await offlineDb.surveyDrafts.put(draft);
  return draft;
}

export async function getDraft(surveyorId: string, shopId: string) {
  return offlineDb.surveyDrafts.get(makeDraftId(surveyorId, shopId));
}

export async function deleteDraft(surveyorId: string, shopId: string) {
  await offlineDb.surveyDrafts.delete(makeDraftId(surveyorId, shopId));
}

export async function listDraftsForSurveyor(surveyorId: string) {
  return offlineDb.surveyDrafts.where('surveyorId').equals(surveyorId).toArray();
}

export function newLocalId() {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `local-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export async function loadFieldAssignments(workerId: string, role: 'surveyor' | 'installer') {
  return offlineDb.fieldAssignments.get(`${workerId}:${role}`);
}

export async function saveFieldAssignments(workerId: string, role: 'surveyor' | 'installer', assignments: any[]) {
  // Read-only cache only, keyed by authenticated worker. No cross-user access.
  await offlineDb.fieldAssignments.put({
    id: `${workerId}:${role}`, workerId, role, savedAt: new Date().toISOString(), assignments,
  });
}

export async function pendingInstallationPhotos(workerId: string, shopId?: string) {
  const photos = await offlineDb.installationPhotos.where('workerId').equals(workerId).toArray();
  return shopId ? photos.filter((photo) => photo.shopId === shopId) : photos;
}

export async function saveFieldWorkOrders(workerId: string, orders: FieldWorkOrdersSnapshot['orders']) {
  await offlineDb.fieldWorkOrders.put({id:workerId,workerId,savedAt:new Date().toISOString(),orders});
}
export async function loadFieldWorkOrders(workerId: string) {
  return (await offlineDb.fieldWorkOrders.get(workerId))?.orders || [];
}

// Only cache reference data actually fetched for this worker. Server RLS is
// rechecked for every real operation and reconnect fetch remains authoritative.
export async function loadFieldReference<T>(workerId: string, key: string): Promise<T | null> {
  return ((await offlineDb.fieldReferences.get(`${workerId}:${key}`))?.value as T) ?? null;
}
export async function saveFieldReference<T>(workerId: string, key: string, value: T) {
  await offlineDb.fieldReferences.put({id:`${workerId}:${key}`,workerId,updatedAt:new Date().toISOString(),value});
}
