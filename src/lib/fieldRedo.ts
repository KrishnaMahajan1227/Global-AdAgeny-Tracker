import { offlineDb } from './offlineDb';
import { supabase } from './supabase';

export type RedoDraft = {
  id: string; userId: string; shopId: string; stage: 'survey' | 'installation'; correctionId: string;
  payload: Record<string, unknown>; status: 'queued' | 'failed'; updatedAt: string;
};

/** Queue first, then sync. Never drop a captured image until the server RPC acknowledges it. */
export async function queueRedoDraft(draft: RedoDraft) {
  await offlineDb.fieldRedoDrafts.put(draft);
}

export async function syncRedoDraft(draft: RedoDraft) {
  if (typeof navigator !== 'undefined' && !navigator.onLine) throw new Error('Offline — replacement saved on this device');
  if (draft.payload.ready !== true) throw new Error('Finish the replacement before syncing');
  const payload = { ...draft.payload };
  delete payload.ready;
  let newPath: string | null = null;
  if (typeof payload.dataUrl === 'string') {
    const dataUrl = payload.dataUrl;
    const blob = await (await fetch(dataUrl)).blob();
    const bucket = draft.stage === 'survey' ? 'survey-photos' : 'installation-proof';
    const fileName = String(payload.fileName || 'redo.jpg').replace(/[^a-zA-Z0-9._-]/g, '_');
    // Stable path makes lost HTTP responses safe to retry without duplicate uploads.
    const stamp = draft.updatedAt.replace(/[^0-9]/g, '');
    newPath = `${String(payload.organizationId)}/${draft.shopId}/redo-${draft.correctionId}-${stamp}-${fileName}`;
    const { error: uploadError } = await supabase.storage.from(bucket).upload(newPath, blob, { contentType: blob.type || 'image/jpeg' });
    if (uploadError && !/already exists|duplicate|409|resource exists/i.test(uploadError.message)) throw uploadError;
    payload.storage_path = newPath;
    payload.photo_url = supabase.storage.from(bucket).getPublicUrl(newPath).data.publicUrl;
    delete payload.dataUrl;
    delete payload.fileName;
    delete payload.organizationId;
  }
  try {
    const { error } = await supabase.rpc('field_redo_save', { p_correction_id: draft.correctionId, p_payload: payload });
    if (error) throw error;
    await offlineDb.fieldRedoDrafts.delete(draft.id);
  } catch (error) {
    // The RPC may have committed while the response was lost. NEVER delete
    // the uploaded object here: it may already be the Owner's current proof.
    // Keep the unchanged draft/path so a retry is idempotent.
    await offlineDb.fieldRedoDrafts.put({ ...draft, status: 'failed' });
    throw error;
  }
}

export async function loadRedoDrafts(userId: string, shopId: string, stage: 'survey' | 'installation') {
  return (await offlineDb.fieldRedoDrafts.where('userId').equals(userId).toArray()).filter((d) => d.shopId === shopId && d.stage === stage) as RedoDraft[];
}

export function redoDraftId(userId: string, correctionId: string) { return `${userId}:${correctionId}`; }
