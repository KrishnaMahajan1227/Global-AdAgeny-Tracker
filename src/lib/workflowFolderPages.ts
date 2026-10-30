/** Fetch complete lightweight folder rows instead of silently truncating at PostgREST max_rows=1000. */
export async function fetchWorkflowFolderPages<T>(
  fetchPage: (from: number, to: number) => Promise<readonly T[]>,
  pageSize = 500,
): Promise<T[]> {
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000) throw new Error('Invalid folder page size');
  const all: T[] = [];
  // Deliberate ceiling: never show falsely complete folder totals at extreme scales.
  for (let page = 0; page < 200; page++) {
    const rows = await fetchPage(page * pageSize, (page + 1) * pageSize - 1);
    all.push(...rows);
    if (rows.length < pageSize) return all;
  }
  throw new Error('Too many folder entries to enumerate safely; narrow your filters or Work Order.');
}
