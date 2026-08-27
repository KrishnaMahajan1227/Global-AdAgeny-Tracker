import { supabase } from './supabase';
import { logAudit, createNotification } from './helpers';
import { offlineDb, type SurveyDraft, listDraftsForSurveyor } from './offlineDb';

// Converts a base64 data URL (captured offline) back into a File so it can
// be uploaded to Supabase Storage exactly like an online-captured photo.
function dataUrlToFile(dataUrl: string, fileName: string): File {
  const [header, base64] = dataUrl.split(',');
  const mimeMatch = header.match(/data:(.*);base64/);
  const mime = mimeMatch ? mimeMatch[1] : 'image/jpeg';
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new File([bytes], fileName, { type: mime });
}

let syncInFlight = false;

/**
 * Pushes a single queued draft to Supabase: creates the `surveys` row if it
 * was only created locally, uploads any photos still sitting as local
 * base64 data, writes work_items + their board_markings (the tapped/dragged
 * corner points, linked to the exact photo they were marked on), and flips
 * the shop/assignment status — i.e. the same end state as an online submit,
 * just delayed.
 */
export async function syncDraft(draft: SurveyDraft): Promise<{ ok: boolean; error?: string }> {
  try {
    let surveyId = draft.surveyId;

    // 1) Create the survey row now if it only ever existed locally.
    if (!surveyId || draft.isLocalSurveyId) {
      const { data, error } = await supabase
        .from('surveys')
        .insert({
          organization_id: draft.organizationId,
          shop_id: draft.shopId,
          surveyor_id: draft.surveyorId,
          status: 'draft',
        })
        .select()
        .single();
      if (error || !data) throw new Error(error?.message || 'Could not create survey record');
      surveyId = data.id;
      await supabase.from('shops').update({ status: 'survey_started' }).eq('id', draft.shopId);
    }

    // 2) Upload any photos that are still only local (captured offline, or
    // captured online — uploads are always deferred to submit time now so
    // there's a single reliable code path). Track each uploaded photo's
    // real database row id, keyed by its local id, so board_markings can
    // reference the correct survey_photo_id below.
    const uploadedPhotoIdByLocalId = new Map<string, string>();
    for (const photo of draft.photos) {
      if (photo.uploaded && photo.storagePath && photo.photoId) {
        uploadedPhotoIdByLocalId.set(photo.localId, photo.photoId);
        continue;
      }
      const file = dataUrlToFile(photo.dataUrl, photo.fileName);
      const path = `${draft.organizationId}/${surveyId}/${Date.now()}-${photo.fileName}`;
      const { error: uploadError } = await supabase.storage.from('survey-photos').upload(path, file);
      if (uploadError) throw new Error(`Photo upload failed: ${uploadError.message}`);
      const { data: urlData } = supabase.storage.from('survey-photos').getPublicUrl(path);
      const { data: photoRow, error: photoInsertError } = await supabase
        .from('survey_photos')
        .insert({
          organization_id: draft.organizationId,
          survey_id: surveyId,
          shop_id: draft.shopId,
          storage_path: path,
          photo_url: urlData.publicUrl,
          photo_type: 'survey',
        })
        .select()
        .single();
      if (photoInsertError || !photoRow) throw new Error(photoInsertError?.message || 'Could not save photo record');
      photo.uploaded = true;
      photo.storagePath = path;
      photo.photoUrl = urlData.publicUrl;
      photo.photoId = photoRow.id;
      uploadedPhotoIdByLocalId.set(photo.localId, photoRow.id);
    }

    // 3) Work items — and, for any board that was marked, its
    // board_markings row (points as % of the image, linked to the exact
    // survey_photo it was drawn on).
    for (const item of draft.workItems) {
      const w = parseFloat(item.width) || 0;
      const h = parseFloat(item.height) || 0;
      const qty = parseInt(item.quantity) || 1;
      const { data: workItemRow, error: workItemError } = await supabase
        .from('work_items')
        .insert({
          organization_id: draft.organizationId,
          shop_id: draft.shopId,
          survey_id: surveyId,
          work_type_id: item.work_type_id || null,
          work_type_name: item.work_type_name || 'Other',
          material: item.material || null,
          survey_width: w,
          survey_height: h,
          survey_unit: item.unit,
          survey_quantity: qty,
          survey_area: w * h * qty,
          survey_notes: item.notes || null,
          status: 'surveyed',
          // Section 8 — auto-resolved in the wizard when the shop's PO has
          // exactly one line item for this work type, so the PO-aware
          // budget comparison (live in the wizard, and again on Survey
          // Review) has something to compare against from the moment the
          // work item exists, without waiting on a separate manual link.
          po_line_item_id: item.po_line_item_id || null,
        })
        .select()
        .single();
      if (workItemError) throw new Error(workItemError.message);

      // Auto-seed the BOM/consumables checklist from this work type's
      // default consumables (Owner Console template) — same pattern
      // SupplyOrdersPage.tsx already uses for supply_only jobs (migration
      // 0024), just applied here too so survey_install boards don't start
      // Production with an empty checklist either. Scaled by qty, tagged
      // source='consumable' so Production can group/label them apart from
      // hand-added components while using the exact same ready/pending
      // gate (migration 0028).
      if (item.work_type_id && workItemRow) {
        const { data: defaultConsumables, error: consumablesError } = await supabase
          .from('work_type_consumables')
          .select('consumable_name, qty_per_unit')
          .eq('work_type_id', item.work_type_id);
        // Non-fatal: a missing/failed consumables lookup shouldn't block
        // the survey submission itself — production can still add items
        // to the checklist by hand if this didn't seed.
        if (!consumablesError && defaultConsumables && defaultConsumables.length > 0) {
          const consumableRows = defaultConsumables.map((c) => ({
            organization_id: draft.organizationId,
            work_item_id: workItemRow.id,
            component_name: c.consumable_name,
            required_qty: c.qty_per_unit != null ? c.qty_per_unit * qty : null,
            status: 'pending' as const,
            source: 'consumable' as const,
          }));
          await supabase.from('work_item_components').insert(consumableRows);
        }
      }

      if (item.points && item.points.length >= 3 && item.photoLocalId) {
        const surveyPhotoId = uploadedPhotoIdByLocalId.get(item.photoLocalId);
        if (surveyPhotoId) {
          // image_width/image_height are informational only — every
          // consumer (review screen, shop page, PDF/PPT exports) re-loads
          // the actual photo and computes its real dimensions at render
          // time, so we don't need to (and shouldn't block submission to)
          // measure it here.
          await supabase.from('board_markings').insert({
            organization_id: draft.organizationId,
            survey_photo_id: surveyPhotoId,
            work_item_id: workItemRow?.id || null,
            points: item.points,
            version: 1,
          });
        }
      }
    }

    // 4) Finalize survey + shop + assignment status.
    //
    // IMPORTANT: every one of these calls used to be fired without checking
    // `.error` — Supabase's client never throws on a rejected UPDATE (RLS
    // denial, bad constraint, whatever), it just resolves with an `error`
    // field and zero rows changed. Not checking it meant a survey could
    // finish its work_items/photos fine, then silently fail to flip to
    // 'submitted' — while the code carried on regardless and flipped
    // `shops.status` to 'surveyed' anyway. That's exactly how a shop can end
    // up showing "Surveyed" with real work items, but with literally no row
    // in `surveys` and nothing ever appearing on the Survey Review queue:
    // the queue reads survey status, not shop status. Now every step here
    // is checked, and the whole sync is reported as failed (and retried) if
    // any of it doesn't actually persist.
    const { error: surveyUpdateError } = await supabase
      .from('surveys')
      .update({
        status: 'submitted',
        gps_lat: draft.gps?.lat ?? null,
        gps_lng: draft.gps?.lng ?? null,
        gps_accuracy: draft.gps?.accuracy ?? null,
        gps_captured_at: draft.gps ? draft.updatedAt : null,
        submitted_at: new Date().toISOString(),
      })
      .eq('id', surveyId)
      .select('id');
    if (surveyUpdateError) throw new Error(`Could not finalize survey: ${surveyUpdateError.message}`);

    const { error: shopUpdateError } = await supabase.from('shops').update({ status: 'surveyed' }).eq('id', draft.shopId).select('id');
    if (shopUpdateError) throw new Error(`Could not update shop status: ${shopUpdateError.message}`);

    const { error: assignmentUpdateError } = await supabase
      .from('shop_assignments')
      .update({ status: 'completed', completed_at: new Date().toISOString() })
      .eq('shop_id', draft.shopId)
      .eq('user_id', draft.surveyorId)
      .eq('role', 'surveyor')
      .select('id');
    // Not fatal on its own (the survey itself is already saved and will show
    // up for review) but worth knowing about if it ever happens.
    if (assignmentUpdateError) console.error('[syncDraft] could not update shop_assignments:', assignmentUpdateError.message);

    await logAudit('surveys', surveyId, 'submit', null, null, null, `Survey synced (offline capture) for shop ${draft.shopName}`);

    const { data: admins } = await supabase
      .from('profiles')
      .select('id')
      .eq('organization_id', draft.organizationId)
      .in('role', ['agency_owner', 'admin']);
    if (admins) {
      for (const admin of admins) {
        await createNotification(admin.id, 'Survey Submitted', `Survey for ${draft.shopName} is ready for review`, 'info', '/survey-review');
      }
    }

    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message || 'Unknown sync error' };
  }
}

/**
 * Syncs every queued draft for a surveyor. Safe to call repeatedly (e.g. on
 * the browser 'online' event and once on app load) — it no-ops if nothing
 * is queued or a sync is already running.
 */
export async function syncAllPendingDrafts(surveyorId: string) {
  if (syncInFlight || !navigator.onLine) return;
  syncInFlight = true;
  try {
    const drafts = await listDraftsForSurveyor(surveyorId);
    const pending = drafts.filter((d) => d.status === 'pending_sync' || d.status === 'sync_failed');
    for (const draft of pending) {
      await offlineDb.surveyDrafts.update(draft.id, { status: 'syncing' });
      const result = await syncDraft(draft);
      if (result.ok) {
        await offlineDb.surveyDrafts.delete(draft.id);
      } else {
        await offlineDb.surveyDrafts.update(draft.id, { status: 'sync_failed', syncError: result.error });
      }
    }
  } finally {
    syncInFlight = false;
  }
}
