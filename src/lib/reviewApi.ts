import { supabase } from '@/lib/supabase';
import type { QueryClient } from '@tanstack/react-query';

export type ReviewStage = 'survey' | 'installation' | 'design';
export type ReviewEntity = { type: 'measurement' | 'survey_photo' | 'work_item' | 'installation_photo'; id: string };
export type ReviewResult = { finalized: boolean; left_review?: boolean; undecided?: number; needs_designer?: boolean; pending: number; redo: number; open_corrections: number };

const MIGRATION_HINT = 'Database update (0090) is not applied yet. Run RUN_THIS_FIRST.sql in the Supabase SQL Editor once.';

function explain(message: string): string {
  if (/review_apply|review_submit_corrections|schema cache|could not find the function/i.test(message)) return MIGRATION_HINT;
  return message;
}

/** One atomic server call: approve / redo the given entities (or ALL undecided ones when entities is empty). */
export async function reviewApply(args: {
  stage: ReviewStage; shopId: string; refId: string; entities?: ReviewEntity[];
  decision: 'approved' | 'redo'; note?: string; designerId?: string | null; variance?: Record<string, string>;
}): Promise<ReviewResult> {
  const { data, error } = await supabase.rpc('review_apply', {
    p_stage: args.stage, p_shop_id: args.shopId, p_ref_id: args.refId,
    p_entities: args.entities && args.entities.length ? args.entities : null,
    p_decision: args.decision, p_note: args.note?.trim() || null,
    p_designer_id: args.designerId || null, p_variance: args.variance || {},
  });
  if (error) throw new Error(explain(error.message));
  return data as ReviewResult;
}

/** Surveyor / installer finished the returned items -> back to the reviewer. */
export async function submitCorrections(stage: 'survey' | 'installation', shopId: string) {
  const { data, error } = await supabase.rpc('review_submit_corrections', { p_stage: stage, p_shop_id: shopId });
  if (error) throw new Error(explain(error.message));
  const paths: string[] = (data as any)?.storage_paths || [];
  if (paths.length) {
    await supabase.storage.from(stage === 'installation' ? 'installation-proof' : 'survey-photos').remove(paths).catch(() => undefined);
  }
  return data as { resubmitted: number };
}

export async function setAvailability(workItemId: string, unavailable: boolean, reason: string | null, note: string | null) {
  const { error } = await supabase.rpc('set_work_item_execution_availability', {
    p_work_item_id: workItemId, p_unavailable: unavailable, p_reason: reason, p_note: note,
  });
  if (error) throw new Error(explain(error.message));
}

/** Refresh every screen that shows review state, so approvals reflect immediately everywhere. */
export async function refreshReviewViews(qc: QueryClient, shopId?: string) {
  const keys = [
    'item-review-items', 'item-review-photos', 'item-review-decisions', 'inline-install-review-decisions', 'field-corrections',
    'surveyor-work', 'surveyor-open-corrections', 'installer-work', 'installer-open-corrections', 'installer-assignments',
    'survey-field-corrections', 'installation-field-corrections', 'surveys-review', 'survey-review-counts', 'installation-review',
    'installation-review-counts', 'shops', 'shop', 'shop-work-items', 'shop-surveys', 'shop-installations', 'shop-survey-photos',
    'shop-field-review-decisions', 'shop-field-corrections', 'shop-design-tasks', 'design-task-list', 'design-task-stats', 'design-task-detail',
    'dashboard-stats', 'nav-pending-counts', 'po-utilization', 'review-evidence-work-items', 'review-evidence-proofs',
  ];
  await Promise.all(keys.map((k) => qc.invalidateQueries({ queryKey: [k] })));
  if (shopId) await Promise.all([qc.invalidateQueries({ queryKey: ['shop', shopId] }), qc.invalidateQueries({ queryKey: ['shop-installations', shopId] })]);
}
