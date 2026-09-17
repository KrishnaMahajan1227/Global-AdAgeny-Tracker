// Owner/Admin "already done outside the app" data entry — writes exactly
// the same rows the real Survey Review / Designer / Production pages
// would write at each handoff (same status values, same tables), so a
// backfilled shop is indistinguishable from one that actually went
// through those screens. Used both from an existing shop's detail page
// and from the "Add Shop (Already In Progress)" flow that creates the
// shop first and then runs this immediately after.
import { supabase } from './supabase';
import { logAudit, createNotification } from './helpers';
import { areaSqFt } from './units';

export type BackfillStage = 'design_pending' | 'production_pending' | 'production_done' | 'dispatched';

/** A shop at or past this point has real, in-app progress worth
 *  protecting — Backfill (single or bulk) is offered only for shops
 *  still earlier than this, so it's never used to silently overwrite
 *  genuine production/installation history. Shared by the single-shop
 *  panel, the "Add Shop (In Progress)" flow's eligibility, and the Bulk
 *  Backfill template/upload. */
export const BACKFILL_INELIGIBLE_STATUSES = [
  'production_done', 'dispatched', 'installation_pending', 'installing',
  'installation_review', 'installed', 'billed', 'cancelled',
];

export interface BackfillItemInput {
  workTypeId: string;
  workTypeName: string;
  material: string;
  width: string;
  height: string;
  unit: string;
  quantity: string;
}

export interface BackfillParams {
  orgId: string;
  shopId: string;
  shopName: string;
  shopStatusBefore: string;
  actorId: string;
  stage: BackfillStage;
  items: BackfillItemInput[];
  surveyorId: string; // '' = use actorId
  designerId: string; // '' = unspecified
  productionId: string; // '' = unspecified
  installerId: string; // '' = don't assign
  note: string;
  workTypes: { id: string; name: string }[];
  /** Existing shop_assignments for this shop, so a surveyor/installer
   *  assignment is never inserted twice (a fresh shop passes []). */
  existingAssignments: { role: string; status: string }[];
  /** Site/board photos from the survey — uploaded to the same
   *  `survey-photos` bucket, same path convention, same DB row shape a
   *  real survey submission produces. Optional — a shop can be
   *  backfilled with no photos on hand. */
  surveyPhotos?: File[];
  /** Final design artwork — uploaded to `design-files`, inserted as an
   *  approved design_versions row (version 1) and linked to every
   *  backfilled work item, same as a real Designer upload+approval. Only
   *  used when the target stage includes design. */
  designFiles?: File[];
  designSource?: 'agency_designed' | 'client_provided';
}

/** Throws with a user-facing message on the first failed write. */
export async function runBackfillPipeline(params: BackfillParams): Promise<void> {
  const { orgId, shopId, shopName, shopStatusBefore, actorId, stage, items, note: rawNote, workTypes, existingAssignments } = params;

  const validItems = items.filter((it) => it.width.trim() && it.height.trim() && it.quantity.trim());
  if (validItems.length === 0) throw new Error('Add at least one board/item with width, height and quantity.');

  const now = new Date().toISOString();
  const note = rawNote.trim() || 'Backfilled by Owner/Admin — work already completed outside the app.';
  const surveyorId = params.surveyorId || actorId;

  const { data: surveyRow, error: surveyError } = await supabase.from('surveys').insert({
    organization_id: orgId,
    shop_id: shopId,
    surveyor_id: surveyorId,
    status: 'approved',
    notes: note,
    submitted_at: now,
    reviewed_at: now,
    reviewed_by: actorId,
    review_note: note,
  }).select('id').single();
  if (surveyError) throw new Error(`Could not create survey record: ${surveyError.message}`);

  // Survey photos — same bucket, same "{org}/{survey}/{ts}-{name}" path
  // convention, same survey_photos row shape a real survey submission
  // writes (syncManager.ts), tagged photo_type 'survey' so they render
  // in the same gallery as an in-app capture would.
  for (const file of params.surveyPhotos || []) {
    const path = `${orgId}/${surveyRow.id}/${Date.now()}-${file.name}`;
    const { error: uploadError } = await supabase.storage.from('survey-photos').upload(path, file);
    if (uploadError) throw new Error(`Could not upload photo "${file.name}": ${uploadError.message}`);
    const { data: urlData } = supabase.storage.from('survey-photos').getPublicUrl(path);
    const { error: photoInsertError } = await supabase.from('survey_photos').insert({
      organization_id: orgId, survey_id: surveyRow.id, shop_id: shopId,
      storage_path: path, photo_url: urlData.publicUrl, photo_type: 'survey',
      caption: 'Backfilled — from outside the app',
    });
    if (photoInsertError) throw new Error(`Could not save photo record for "${file.name}": ${photoInsertError.message}`);
  }

  const itemStatus = stage === 'design_pending' ? 'approved' : stage === 'production_pending' ? 'design_approved' : 'production_done';
  const insertedItems: { id: string; quantity: number }[] = [];
  for (const it of validItems) {
    const width = parseFloat(it.width) || 0;
    const height = parseFloat(it.height) || 0;
    const quantity = Math.max(1, parseInt(it.quantity, 10) || 1);
    const area = areaSqFt(width, it.unit, height, it.unit) * quantity;
    const payload: Record<string, unknown> = {
      organization_id: orgId,
      shop_id: shopId,
      survey_id: surveyRow.id,
      work_type_id: it.workTypeId || null,
      work_type_name: it.workTypeName.trim() || workTypes.find((w) => w.id === it.workTypeId)?.name || null,
      material: it.material.trim() || null,
      survey_width: width, survey_height: height, survey_unit: it.unit, survey_quantity: quantity, survey_area: area,
      approved_width: width, approved_height: height, approved_unit: it.unit, approved_quantity: quantity, approved_area: area,
      status: itemStatus,
    };
    if (itemStatus === 'production_done') {
      payload.produced_quantity = quantity;
      payload.produced_notes = note;
      payload.produced_at = now;
    }
    const { data: wi, error: wiError } = await supabase.from('work_items').insert(payload).select('id').single();
    if (wiError) throw new Error(`Could not save a board/item: ${wiError.message}`);
    insertedItems.push({ id: wi.id, quantity });
  }

  let shopStatus = 'design_pending';
  let designTaskId: string | null = null;

  if (stage !== 'design_pending') {
    const { data: taskRow, error: taskError } = await supabase.from('design_tasks').insert({
      organization_id: orgId,
      shop_id: shopId,
      designer_id: params.designerId || null,
      status: 'ready_for_production',
      notes: note,
      assigned_at: now,
      completed_at: now,
    }).select('id').single();
    if (taskError) throw new Error(`Could not create design task: ${taskError.message}`);
    designTaskId = taskRow.id;
    shopStatus = 'production_pending';

    // Design artwork — same bucket/path convention and design_versions
    // shape DesignerPage's own upload writes, saved straight in as an
    // already-approved version 1 and linked to every backfilled board,
    // exactly like an uploaded-then-approved batch would end up.
    const designFiles = params.designFiles || [];
    if (designFiles.length > 0) {
      const newVersionIds: string[] = [];
      for (let i = 0; i < designFiles.length; i++) {
        const file = designFiles[i];
        const versionNum = i + 1;
        const path = `${orgId}/${designTaskId}/v${versionNum}-${file.name}`;
        const { error: uploadError } = await supabase.storage.from('design-files').upload(path, file);
        if (uploadError) throw new Error(`Could not upload design file "${file.name}": ${uploadError.message}`);
        const { data: urlData } = supabase.storage.from('design-files').getPublicUrl(path);
        const { data: versionRow, error: versionError } = await supabase.from('design_versions').insert({
          organization_id: orgId, design_task_id: designTaskId, version_number: versionNum,
          storage_path: path, file_url: urlData.publicUrl, file_name: file.name,
          uploaded_by: actorId, notes: note, status: 'approved',
          source: params.designSource || 'agency_designed',
        }).select('id').single();
        if (versionError) throw new Error(`Could not save design version for "${file.name}": ${versionError.message}`);
        newVersionIds.push(versionRow.id);
      }
      const links = newVersionIds.flatMap((versionId) =>
        insertedItems.map((it) => ({ organization_id: orgId, design_version_id: versionId, work_item_id: it.id }))
      );
      if (links.length > 0) {
        const { error: linkError } = await supabase.from('design_version_items').insert(links);
        if (linkError) throw new Error(`Could not link design file to boards: ${linkError.message}`);
      }
    }

    if (stage === 'production_done' || stage === 'dispatched') {
      const { data: orderRow, error: orderError } = await supabase.from('production_orders').insert({
        organization_id: orgId,
        shop_id: shopId,
        design_task_id: designTaskId,
        assigned_to: params.productionId || null,
        status: 'completed',
        notes: note,
      }).select('id').single();
      if (orderError) throw new Error(`Could not create production order: ${orderError.message}`);

      for (const it of insertedItems) {
        const { error: piError } = await supabase.from('production_items').insert({
          organization_id: orgId,
          production_order_id: orderRow.id,
          work_item_id: it.id,
          requested_qty: it.quantity,
          approved_qty: it.quantity,
          produced_qty: it.quantity,
          notes: note,
        });
        if (piError) throw new Error(`Could not save a production record: ${piError.message}`);
      }
      shopStatus = stage === 'dispatched' ? 'dispatched' : 'production_done';
    }
  }

  const { error: shopError } = await supabase.from('shops').update({ status: shopStatus }).eq('id', shopId).select('id');
  if (shopError) throw new Error(`Could not update shop status: ${shopError.message}`);

  const hasSurveyorAssignment = existingAssignments.some((a) => a.role === 'surveyor' && a.status !== 'declined');
  if (!hasSurveyorAssignment) {
    await supabase.from('shop_assignments').insert({
      organization_id: orgId, shop_id: shopId, user_id: surveyorId, role: 'surveyor', status: 'completed', completed_at: now,
    });
  }

  if ((stage === 'production_done' || stage === 'dispatched') && params.installerId) {
    const hasInstallerAssignment = existingAssignments.some((a) => a.role === 'installer' && a.status !== 'declined');
    if (!hasInstallerAssignment) {
      const { error: assignError } = await supabase.from('shop_assignments').insert({
        organization_id: orgId, shop_id: shopId, user_id: params.installerId, role: 'installer', status: 'assigned',
      });
      if (assignError) throw new Error(`Could not assign installer: ${assignError.message}`);
      await createNotification(params.installerId, 'New Assignment', `You've been assigned as installer for ${shopName}`, 'info', '/mobile');
    }
  }

  await logAudit(
    'shops', shopId, 'backfill', 'status', shopStatusBefore, shopStatus,
    `Backfilled ${stage === 'design_pending' ? 'survey' : stage === 'production_pending' ? 'survey + design' : 'survey + design + production'} data for ${shopName} — work already completed outside the app`
  );
}
