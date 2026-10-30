/**
 * Bounded, independent server actions for business batches.
 * Every row keeps its own backend RLS/approval gate and idempotency rules.
 * A failed row is retained for a deliberate retry rather than silently lost.
 */
export type WorkflowBatchFailure<T> = { item: T; message: string };
export type WorkflowBatchResult<T> = {
  completed: T[];
  failed: WorkflowBatchFailure<T>[];
  processed: number;
  total: number;
};

export async function runBoundedWorkflowBatch<T>(
  items: readonly T[],
  worker: (item: T) => Promise<void>,
  onProgress?: (processed: number, total: number) => void,
  concurrency = 3,
): Promise<WorkflowBatchResult<T>> {
  const completed: T[] = [];
  const failed: WorkflowBatchFailure<T>[] = [];
  let index = 0;
  let processed = 0;
  const total = items.length;
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), total) }, async () => {
    while (index < total) {
      const item = items[index++];
      try {
        await worker(item);
        completed.push(item);
      } catch (cause) {
        failed.push({ item, message: cause instanceof Error ? cause.message : String(cause) });
      } finally {
        processed += 1;
        onProgress?.(processed, total);
      }
    }
  }));
  return { completed, failed, processed, total };
}

export function summarizeWorkflowBatch<T>(result: WorkflowBatchResult<T>, label: string, name: (item: T) => string): string {
  const done = `${result.completed.length}/${result.total} ${label}`;
  if (!result.failed.length) return `${done}.`;
  const examples = result.failed.slice(0, 4).map(({item, message}) => `${name(item)}: ${message}`).join('; ');
  return `${done}. ${result.failed.length} need attention: ${examples}${result.failed.length > 4 ? ` (+${result.failed.length - 4} more)` : ''}`;
}
