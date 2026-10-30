import type { WorkItem } from '@/lib/types';
import { itemSizeLabel, trimNum } from '@/lib/units';

/** Display business scope before filenames. Never modify source measurements. */
export function designWorkDisplay(item: WorkItem) {
  const work = item.work_type_name?.trim() || 'Work item';
  const size = itemSizeLabel(item);
  const qty = item.approved_quantity ?? item.survey_quantity;
  const meta = [item.material?.trim(), qty == null ? null : `Qty ${trimNum(qty)}`].filter(Boolean).join(' · ');
  return { work, size: size === '—' ? 'Size not recorded' : size, meta };
}

type Ref = { number: number } | null;
export function designArtworkDisplayName(
  ids: string[], items: WorkItem[], refFor?: (id: string) => Ref,
): string {
  if (!ids.length) return 'Choose Work Item / size';
  const matched = ids.map(id => items.find(item => item.id === id)).filter((item): item is WorkItem => !!item);
  if (!matched.length) return 'Unknown item · refresh mapping';
  if (matched.length > 1) {
    const names = [...new Set(matched.map(item => designWorkDisplay(item).work))];
    const sizes = [...new Set(matched.map(item => designWorkDisplay(item).size))];
    return `${names.length === 1 ? names[0] : 'Shared artwork'} · ${sizes.length === 1 ? sizes[0] : 'mixed sizes'} · ${matched.length} work items`;
  }
  const item = matched[0];
  const d = designWorkDisplay(item);
  const ref = refFor?.(item.id);
  return `${d.work} · ${d.size}${ref ? ` · M${ref.number}` : ''}`;
}

/** Human-friendly storage object name; original filename remains in DB for audit. */
export function designArtworkStorageStem(ids: string[], items: WorkItem[]): string {
  const label = designArtworkDisplayName(ids, items)
    .normalize('NFKD')
    .replace(/[^\x00-\x7F]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '').slice(0, 85);
  return label || 'Artwork';
}
