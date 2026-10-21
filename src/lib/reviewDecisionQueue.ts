/** Client-side queue only. Authorization, evidence and approval gates remain in the review RPC. */
export type ShopReviewAction = 'approve' | 'redo' | 'reject';
export type ShopReviewDecision = { action: ShopReviewAction; note: string };
export type ShopDecisionMap = Record<string, ShopReviewDecision>;

export function decisionCounts(ids: readonly string[], decisions: Readonly<ShopDecisionMap>) {
  return ids.reduce((counts, id) => {
    const decision = decisions[id];
    if (decision) counts[decision.action] += 1;
    return counts;
  }, { approve: 0, redo: 0, reject: 0 });
}

export function decisionTargets<T extends { id: string }>(rows: readonly T[], decisions: Readonly<ShopDecisionMap>): T[] {
  return rows.filter(row => !!decisions[row.id]);
}

export function validateShopDecision(decision: ShopReviewDecision, stage: 'survey' | 'installation', evidenceReady: boolean): string | null {
  if (decision.action === 'approve' && !evidenceReady) return 'Evidence not ready for approval. Inspect linked photos and measurements or request redo.';
  if (decision.action === 'reject' && stage !== 'survey') return 'Final rejection is available for surveys only. For installation, request redo.';
  if (decision.action !== 'approve' && !decision.note.trim()) return 'A clear correction/rejection reason is required.';
  return null;
}

export function nextUnqueued<T extends { id: string }>(rows: readonly T[], current: number, decisions: Readonly<ShopDecisionMap>): number {
  if (!rows.length) return -1;
  for (let offset = 1; offset < rows.length; offset++) {
    const index = (current + offset) % rows.length;
    if (!decisions[rows[index].id]) return index;
  }
  return -1;
}
