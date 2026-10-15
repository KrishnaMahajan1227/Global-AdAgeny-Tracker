import { supabase } from './supabase';
import { offlineDb, pendingInstallationPhotos, type PendingInstallationPhoto } from './offlineDb';
import { hammingDistance, DUPLICATE_HASH_THRESHOLD } from './imageHash';
import { createNotification } from './helpers';

const inFlight = new Set<string>();
export function isInstallationPhotoSyncing(id: string) { return inFlight.has(id); }

export type SyncedInstallationPhoto = {
  id: string;
  url: string;
  storagePath: string;
  angle: 'front' | 'side' | 'other';
  workItemId?: string;
};

/** Photo capture first lands durably in IndexedDB. One immutable storage path
 * is used across reconnect retries. Before INSERT, reconcile the existing
 * proof by storage_path to avoid duplicate rows if a response was lost.
 * Never erase the local original unless the proof row is confirmed.
 */
export async function syncInstallationPhoto(photo: PendingInstallationPhoto): Promise<SyncedInstallationPhoto | null> {
  if (!navigator.onLine || inFlight.has(photo.id)) return null;
  inFlight.add(photo.id);
  try {
    const existing = await supabase.from('installation_proofs').select('id,photo_url,storage_path,work_item_id,angle')
      .eq('organization_id', photo.organizationId).eq('installation_job_id', photo.jobId)
      .eq('storage_path', photo.path).maybeSingle();
    if (existing.error) throw existing.error;
    let record = existing.data;
    const { data: publicUrl } = supabase.storage.from('installation-proof').getPublicUrl(photo.path);
    if (!record) {
      const blob = await (await fetch(photo.dataUrl)).blob();
      const upload = await supabase.storage.from('installation-proof').upload(photo.path, blob, { contentType: blob.type || 'image/jpeg', upsert: false });
      // A retry may find this file already uploaded, before a DB INSERT.
      if (upload.error && !/already exists|duplicate|409|resource exists/i.test(upload.error.message)) throw upload.error;
      // Re-check after upload in case previous request inserted the row.
      const checked = await supabase.from('installation_proofs').select('id,photo_url,storage_path,work_item_id,angle')
        .eq('organization_id', photo.organizationId).eq('installation_job_id', photo.jobId)
        .eq('storage_path', photo.path).maybeSingle();
      if (checked.error) throw checked.error;
      record = checked.data;
      if (!record) {
        let duplicateOf: string | null = null;
        if (photo.originalHash) {
          const { data: hashes } = await supabase.from('installation_proofs').select('id,phash')
            .eq('organization_id', photo.organizationId).neq('shop_id', photo.shopId)
            .not('phash','is',null).limit(500);
          for (const row of hashes || []) {
            if (row.phash && hammingDistance(photo.originalHash, row.phash) <= DUPLICATE_HASH_THRESHOLD) {
              duplicateOf = row.id; break;
            }
          }
        }
        const payload = {
          organization_id: photo.organizationId, installation_job_id: photo.jobId,
          shop_id: photo.shopId, storage_path: photo.path, photo_url: publicUrl.publicUrl,
          photo_type: 'installed', caption: photo.caption, work_item_id: photo.workItemId,
          angle: photo.angle, phash: photo.originalHash, duplicate_flag: !!duplicateOf,
          duplicate_of: duplicateOf, gps_lat: photo.gps?.lat ?? null,
          gps_lng: photo.gps?.lng ?? null, gps_accuracy: photo.gps?.accuracy ?? null,
        };
        let inserted = await supabase.from('installation_proofs').insert(payload).select('id,photo_url,storage_path,work_item_id,angle').single();
        if (inserted.error && /work_item_id|schema cache|column/i.test(inserted.error.message || '')) {
          const {work_item_id: _unused, ...legacyPayload} = payload;
          inserted = await supabase.from('installation_proofs').insert(legacyPayload)
            .select('id,photo_url,storage_path,angle').single();
        }
        if (inserted.error) {
          // Network response may be lost after a successful insert; retry read.
          const retry = await supabase.from('installation_proofs').select('id,photo_url,storage_path,work_item_id,angle')
            .eq('organization_id',photo.organizationId).eq('installation_job_id',photo.jobId)
            .eq('storage_path',photo.path).maybeSingle();
          if (retry.error || !retry.data) throw inserted.error;
          record = retry.data;
        } else record = inserted.data;
        if (duplicateOf) {
          const {data: admins} = await supabase.from('profiles').select('id').eq('organization_id',photo.organizationId).in('role',['agency_owner','admin']);
          for (const admin of admins || []) {
            await createNotification(admin.id,'Duplicate Installation Photo Suspected','An installation photo may have been reused — review before approving.','warning','/installation-review');
          }
        }
      }
    }
    if (!record?.id) throw new Error('Proof has not been confirmed by the server');
    await offlineDb.installationPhotos.delete(photo.id);
    return { id: record.id, url: record.photo_url || publicUrl.publicUrl,
      storagePath: record.storage_path || photo.path, angle: (record.angle || photo.angle) as SyncedInstallationPhoto['angle'],
      workItemId: record.work_item_id || photo.workItemId || undefined };
  } catch (error) {
    await offlineDb.installationPhotos.update(photo.id,{lastError: error instanceof Error ? error.message : String(error)});
    return null;
  } finally { inFlight.delete(photo.id); }
}

export async function syncInstallationPhotos(workerId: string) {
  if (!navigator.onLine) return [] as {localId: string; remote: SyncedInstallationPhoto}[];
  const pending = await pendingInstallationPhotos(workerId);
  const synced: {localId: string; remote: SyncedInstallationPhoto}[] = [];
  for (const item of pending) {
    const remote = await syncInstallationPhoto(item);
    if (remote) synced.push({localId: item.id, remote});
  }
  return synced;
}

/** Canonical proof hydration for both cached retry and freshly opened jobs. */
export async function loadInstallationProofs(jobId: string) {
  let response = await supabase.from('installation_proofs')
    .select('id,storage_path,photo_url,photo_type,angle,work_item_id')
    .eq('installation_job_id',jobId).order('captured_at');
  if (response.error && /work_item_id|schema cache|column/i.test(response.error.message)) {
    response = await supabase.from('installation_proofs')
      .select('id,storage_path,photo_url,photo_type,angle')
      .eq('installation_job_id',jobId).order('captured_at');
  }
  if (response.error) throw response.error;
  return (response.data||[]).map((row:any)=>({
    id:row.id,storagePath:row.storage_path,url:row.photo_url,
    type:row.photo_type||'installed', angle:(row.angle||'other') as 'front'|'side'|'other',
    workItemId:row.work_item_id||undefined,
  }));
}
