/**
 * Bulk review applies ONLY to shops explicitly reviewed after their evidence
 * was loaded. Opening a shop, jumping to it, or selecting it in the queue
 * does not count as reviewing its evidence.
 */
export function allInspected<T extends { id: string }>(selected: T[], inspected: ReadonlySet<string>): boolean {
  return selected.length > 0 && selected.every(row => inspected.has(row.id));
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
