/**
 * Shared design review evidence rule: compare each work item with its newest
 * still-usable explicitly mapped artwork. Rejected/deleted versions never
 * count as coverage, and a file for another board cannot cover this board.
 */
export type DesignReviewFile = {
  id: string; version_number: number; status: string;
  upload_batch_id?: string | null;
  file_url: string | null; file_name?: string | null;
};
export type DesignReviewLink = { design_version_id: string; work_item_id: string };
export type DesignReviewItem = { id: string };

export function latestReviewArtworkByItem(
  files: readonly DesignReviewFile[], links: readonly DesignReviewLink[],
): Map<string, DesignReviewFile> {
  const usable = new Map(files
    .filter(file => file.file_url?.trim() && !['rejected', 'deleted'].includes(file.status))
    .map(file => [file.id, file]));
  const result = new Map<string, DesignReviewFile>();
  for (const link of links) {
    const file = usable.get(link.design_version_id);
    if (!file) continue;
    const current = result.get(link.work_item_id);
    if (!current || file.version_number > current.version_number) result.set(link.work_item_id, file);
  }
  return result;
}

export function reviewArtworkCoverage(
  items: readonly DesignReviewItem[], artwork: ReadonlyMap<string, DesignReviewFile>,
) {
  const missing = items.filter(item => !artwork.has(item.id)).map(item => item.id);
  return { ready: items.length > 0 && missing.length === 0, missing };
}

export function validateDesignCorrection(items: readonly DesignReviewItem[], ids: readonly string[], note: string) {
  if (!ids.length) return 'Select at least one work item that needs changes.';
  if (!note.trim()) return 'Write a correction note so the designer knows what to change.';
  const permitted = new Set(items.map(item => item.id));
  if (new Set(ids).size !== ids.length || ids.some(id => !permitted.has(id))) {
    return 'Invalid work item selection. Reopen this review and try again.';
  }
  return null;
}

/** A selected review batch has distinct shop tasks; no implicit cross-shop decisions. */
export type DesignReviewQueueEntry = { design_task_id: string; status: string };

export function reviewQueueFromSelection<T extends DesignReviewQueueEntry>(rows: readonly T[]): T[] {
  const seen = new Set<string>();
  return rows.filter(row => {
    if (row.status !== 'in_review' || !row.design_task_id || seen.has(row.design_task_id)) return false;
    seen.add(row.design_task_id);
    return true;
  });
}

export function reviewQueueRemaining<T extends DesignReviewQueueEntry>(rows: readonly T[], decidedTaskId: string): T[] {
  return rows.filter(row => row.design_task_id !== decidedTaskId && row.status === 'in_review');
}

/**
 * Multiple files submitted together for the SAME board are complementary
 * artwork, not successive revisions. Return only that board's most recent
 * upload batch. Legacy files with no batch ID are treated as one-file batches.
 * Data is scoped by the caller to one design task, never grouped across shops.
 */
export function latestReviewArtworkGroupByItem(
  files: readonly DesignReviewFile[], links: readonly DesignReviewLink[],
): Map<string, DesignReviewFile[]> {
  const usable = new Map(files
    .filter(file => file.file_url?.trim() && !['rejected', 'deleted'].includes(file.status))
    .map(file => [file.id, file]));
  const byBoard = new Map<string, Map<string, DesignReviewFile>>();
  for (const link of links) {
    const file = usable.get(link.design_version_id);
    if (!file) continue;
    let board = byBoard.get(link.work_item_id);
    if (!board) { board = new Map(); byBoard.set(link.work_item_id, board); }
    board.set(file.id, file); // same link can never create duplicate thumbnails
  }
  const result = new Map<string, DesignReviewFile[]>();
  for (const [boardId, fileMap] of byBoard) {
    const ordered = [...fileMap.values()].sort((a, b) =>
      b.version_number - a.version_number || b.id.localeCompare(a.id));
    if (!ordered.length) continue;
    const currentBatch = ordered[0].upload_batch_id || ordered[0].id;
    result.set(boardId, ordered.filter(file => (file.upload_batch_id || file.id) === currentBatch));
  }
  return result;
}
