/**
 * Canonical operational completion. Status and amount are deliberately separate:
 * a finalized shop is not evidence of recorded financial quantity/area.
 * Do NOT infer billable area or piece count from the number of shops.
 */
export type ShopProgressRow = { purchase_order_id?: string | null; status?: string | null };
export type OrderProgressRow = { id: string; fulfillment_type?: string | null; status?: string | null; assignment_status?: string | null; po_line_items?: StageRequirements[] | null };
export type StageBucket = 'pending' | 'survey' | 'design' | 'production' | 'dispatch' | 'installation' | 'review' | 'complete' | 'excluded';
const excluded = new Set(['cancelled', 'rejected']);
const installedStatuses = new Set(['installed', 'billed']);
const deliveredStatuses = new Set(['dispatched', 'delivered', 'billed']);

export function isShopFinished(type: string | null | undefined, status: string | null | undefined, requirements: StageRequirements[] = []): boolean {
  if (!status || excluded.has(status)) return false;
  if (installedStatuses.has(status)) return true;
  if (type === 'supply_only') return deliveredStatuses.has(status);
  if (type !== 'custom' || !requirements.length) return false;
  const need = (flag: keyof StageRequirements) => requirements.some(row => row[flag] !== false);
  // Mixed custom POs use the latest required stage; do not claim a site is
  // finished from production when any associated line still needs install.
  if (need('requires_installation')) return false;
  if (need('requires_production')) return ['production_done', 'dispatched', 'delivered'].includes(status);
  if (need('requires_design')) return ['design_approved','production_pending','production_done','dispatched','delivered'].includes(status);
  if (need('requires_survey')) return ['approved','design_pending','design_approved','production_pending','production_done','dispatched','delivered'].includes(status);
  return false;
}

export function shopStage(type: string | null | undefined, status: string | null | undefined, requirements: StageRequirements[] = []): StageBucket {
  if (!status || status === 'pending' || status === 'assigned') return 'pending';
  if (excluded.has(status)) return 'excluded';
  if (isShopFinished(type, status, requirements)) return 'complete';
  if (status === 'installation_review') return 'review';
  if (status === 'installation_pending' || status === 'installing') return 'installation';
  if (status === 'dispatched' || status === 'delivered') return 'dispatch';
  if (status.startsWith('production') || status === 'in_production' || status === 'design_approved') return 'production';
  if (status.startsWith('design') || status === 'designing' || status === 'in_review') return 'design';
  if (status.startsWith('survey') || ['surveyed','approval_pending','approved'].includes(status)) return 'survey';
  return 'pending';
}

export function getShopCompletion(shops: ShopProgressRow[], type: string | null | undefined, requirements: StageRequirements[] = []) {
  const counts: Record<StageBucket, number> = { pending: 0, survey: 0, design: 0, production: 0, dispatch: 0, installation: 0, review: 0, complete: 0, excluded: 0 };
  for (const shop of shops) counts[shopStage(type, shop.status, requirements)]++;
  const total = shops.length - counts.excluded;
  const completed = counts.complete;
  return { total, completed, pending: Math.max(0, total - completed), percentage: total ? Math.min(100, Math.max(0, Math.round(completed * 100 / total))) : 0, stages: counts };
}

export function groupShopCompletion(orders: OrderProgressRow[], shops: ShopProgressRow[]) {
  const byOrder = new Map<string, ShopProgressRow[]>();
  for (const shop of shops) {
    if (!shop.purchase_order_id) continue;
    const list = byOrder.get(shop.purchase_order_id) || [];
    list.push(shop);
    byOrder.set(shop.purchase_order_id, list);
  }
  return new Map(orders.map(order => [order.id, getShopCompletion(byOrder.get(order.id) || [], order.fulfillment_type, order.po_line_items || [])]));
}

/** An order with no linked shops is *unknown*, unless explicitly closed. */
export function orderOperationalPercent(order: OrderProgressRow, counts: ReturnType<typeof getShopCompletion> | undefined): number {
  if (counts?.total) return counts.percentage;
  return order.status === 'closed' || order.assignment_status === 'completed' ? 100 : 0;
}

export function orderOperationalDone(order: OrderProgressRow, counts: ReturnType<typeof getShopCompletion> | undefined): boolean {
  if (counts?.total) return counts.completed === counts.total;
  return order.status === 'closed' || order.assignment_status === 'completed';
}

export function ordersOperationalPercent(orders: OrderProgressRow[], progress: Map<string, ReturnType<typeof getShopCompletion>>): number {
  if (!orders.length) return 0;
  return Math.round(orders.reduce((total, order) => total + orderOperationalPercent(order, progress.get(order.id)), 0) / orders.length);
}

/**
 * Read-only milestone reconciliation. A downstream shop state is proof that
 * earlier *applicable* milestones have been passed for operational reporting.
 * It is not proof that historical survey/design approvals or quantities exist,
 * and deliberately never creates/backfills those records.
 */
export type OperationalMilestone = 'survey' | 'design' | 'production' | 'dispatch' | 'installation';
export type StageRequirements = Partial<Record<'requires_survey' | 'requires_design' | 'requires_production' | 'requires_installation', boolean>>;
const lifecycle: OperationalMilestone[] = ['survey', 'design', 'production', 'dispatch', 'installation'];

export function applicableMilestones(type: string | null | undefined, requirements: StageRequirements[] = []): OperationalMilestone[] {
  if (type === 'direct_install') return ['installation'];
  if (type === 'supply_only') return ['production', 'dispatch'];
  if (type !== 'custom' || !requirements.length) return lifecycle;
  const any = (key: keyof StageRequirements) => requirements.some(row => row[key] !== false);
  const survey = any('requires_survey');
  const design = any('requires_design');
  const production = any('requires_production');
  const installation = any('requires_installation');
  // Custom PO flags control the relevant stages; unlike supply-only,
  // dispatch is not presumed mandatory for a production-only assignment.
  return lifecycle.filter(stage => stage === 'survey' ? survey : stage === 'design' ? design
    : stage === 'production' ? production : stage === 'dispatch' ? false : installation);
}

/** Highest verifiable downstream milestone reached by this shop's current state. */
export function shopReachedMilestone(status: string | null | undefined): number {
  if (!status || excluded.has(status)) return -1;
  if (installedStatuses.has(status)) return 4;
  if (status === 'installation_review' || status === 'installation_pending' || status === 'installing') return 3;
  if (status === 'dispatched' || status === 'delivered') return 3;
  if (status === 'production_done' || status === 'produced') return 2;
  if (status === 'production_pending' || status === 'production_ready' || status === 'in_production' || status === 'design_approved') return 1;
  if (status === 'design_pending' || status === 'designing' || status === 'design_ready' || status === 'in_review') return 0;
  if (status === 'approved') return 0;
  // Survey submitted/review pending is not an approved validation yet.
  return -1;
}

export function milestoneProgress(shops: ShopProgressRow[], type: string | null | undefined, requirements: StageRequirements[] = []) {
  const active = shops.filter(shop => shop.status && !excluded.has(shop.status));
  const applicable = applicableMilestones(type, requirements);
  const milestones = applicable.map(stage => {
    const index = lifecycle.indexOf(stage);
    const reached = active.filter(shop => shopReachedMilestone(shop.status) >= index
      || (stage === 'dispatch' && type === 'supply_only' && isShopFinished(type, shop.status))).length;
    // Stage inference is based on shop state; detailed validation/evidence is a separate concern.
    return { stage, reached, total: active.length, percentage: active.length ? Math.round(reached * 100 / active.length) : null };
  });
  return { milestones, total: active.length };
}
