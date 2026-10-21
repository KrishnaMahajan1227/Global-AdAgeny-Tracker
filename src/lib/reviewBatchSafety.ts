/**
 * Review selection is separate from actual approval. This module never grants
 * permission or changes server-side review status. Company approval, item
 * evidence and organization checks remain enforced by the review RPCs.
 */
export function allInspected<T extends { id: string }>(selected: T[], inspected: ReadonlySet<string>): boolean {
  return selected.length > 0 && selected.every(row => inspected.has(row.id));
}

/** Only evidence-reviewed records may enter a batch decision. Unchecked shops stay in queue. */
export function reviewedTargets<T extends { id: string }>(selected: T[], inspected: ReadonlySet<string>): T[] {
  return selected.filter(row => inspected.has(row.id));
}

/** Finds the next unreviewed shop, wrapping around when necessary. */
export function nextUnreviewedIndex<T extends { id: string }>(
  items: T[], currentIndex: number, inspected: ReadonlySet<string>,
): number {
  if (!items.length) return -1;
  for (let step = 1; step < items.length; step++) {
    const index = (currentIndex + step) % items.length;
    if (!inspected.has(items[index].id)) return index;
  }
  return -1;
}

export type BatchResult<T> = {
  succeeded: T[];
  failed: { item: T; message: string }[];
};

/**
 * A small bounded pool avoids 100s of concurrent requests. Individual RPC
 * decisions stay atomic, and successes are never re-sent after a partial failure.
 */
export async function processReviewedBatch<T>(
  targets: readonly T[],
  apply: (item: T) => Promise<void>,
  onProgress?: (finished: number, total: number) => void,
  workers = 3,
): Promise<BatchResult<T>> {
  const successes: { index: number; item: T }[] = [];
  const errors: { index: number; item: T; message: string }[] = [];
  let cursor = 0;
  let finished = 0;
  const poolSize = Math.min(Math.max(1, Math.floor(workers) || 1), 4, targets.length);
  await Promise.all(Array.from({ length: poolSize }, async () => {
    while (cursor < targets.length) {
      const index = cursor++;
      try {
        await apply(targets[index]);
        successes.push({ index, item: targets[index] });
      } catch (error) {
        errors.push({ index, item: targets[index], message: error instanceof Error ? error.message : String(error) });
      }
      finished += 1;
      onProgress?.(finished, targets.length);
    }
  }));
  const byIndex = (a: { index: number }, b: { index: number }) => a.index - b.index;
  return {
    succeeded: successes.sort(byIndex).map(row => row.item),
    failed: errors.sort(byIndex).map(({ item, message }) => ({ item, message })),
  };
}
