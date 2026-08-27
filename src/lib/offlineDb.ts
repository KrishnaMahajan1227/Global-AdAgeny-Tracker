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
  gps: { lat: number; lng: number; accuracy: number } | null;
  gpsStatus: 'idle' | 'capturing' | 'captured' | 'denied';
  status: DraftStatus;
  surveyId: string | null;
  isLocalSurveyId: boolean;
  syncError?: string;
  createdAt: string;
  updatedAt: string;
}

class OfflineDB extends Dexie {
  surveyDrafts!: Table<SurveyDraft, string>;

  constructor() {
    super('darshan_field_ops');
    this.version(1).stores({
      surveyDrafts: 'id, shopId, surveyorId, status, updatedAt',
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
