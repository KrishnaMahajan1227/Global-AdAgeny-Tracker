import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, CheckCircle2, AlertTriangle, Search } from 'lucide-react';
import { nextUnreviewedIndex } from '@/lib/reviewBatchSafety';

export type ReviewBatchItem = { id: string; name: string; subtitle?: string; flagged?: boolean };

type Props = {
  items: ReviewBatchItem[];
  index: number;
  onIndexChange: (index: number) => void;
  inspected: ReadonlySet<string>;
  disabled?: boolean;
  decisionLabels?: Readonly<Record<string, string>>;
};

/**
 * Bounded workset navigator. Large agency queues stay server-paginated; only
 * the selected current-page workset is rendered here. Search is local, and
 * navigation is NOT an approval or an evidence-review confirmation.
 */
export function ReviewBatchStepper({ items, index, onIndexChange, inspected, disabled = false, decisionLabels = {} }: Props) {
  const [search, setSearch] = useState('');
  const searchTerm = search.trim().toLocaleLowerCase();
  const matches = useMemo(() => items.map((item, i) => ({ item, i })).filter(({ item }) =>
    !searchTerm || `${item.name} ${item.subtitle || ''}`.toLocaleLowerCase().includes(searchTerm),
  ), [items, searchTerm]);
  if (!items.length) return <p className="text-sm text-slate-500">No shops selected.</p>;
  const currentIndex = Math.min(Math.max(index, 0), items.length - 1);
  const current = items[currentIndex];
  const completed = items.filter(item => inspected.has(item.id)).length;
  const flagged = items.filter(item => item.flagged && !inspected.has(item.id)).length;
  const nextPending = nextUnreviewedIndex(items, currentIndex, inspected);
  return <div className="space-y-2 rounded-xl border border-slate-200 bg-slate-50 p-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="min-w-0 flex-1">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Shop {currentIndex + 1} of {items.length} · {completed} queued · {items.length - completed} remaining</p>
        <h3 className="truncate text-base font-bold text-slate-900" title={current.name}>{current.name}</h3>
        {current.subtitle && <p className="truncate text-xs text-slate-600" title={current.subtitle}>{current.subtitle}</p>}
      </div>
      <div className="flex shrink-0 gap-1.5">
        <button type="button" aria-label="Previous shop" title="Previous shop" disabled={disabled || currentIndex === 0} onClick={() => onIndexChange(currentIndex - 1)} className="rounded-lg border border-slate-300 bg-white p-2 disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-blue-500"><ChevronLeft className="h-4 w-4" /></button>
        <button type="button" aria-label="Next shop" title="Next shop" disabled={disabled || currentIndex === items.length - 1} onClick={() => onIndexChange(currentIndex + 1)} className="rounded-lg border border-slate-300 bg-white p-2 disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-blue-500"><ChevronRight className="h-4 w-4" /></button>
        <button type="button" disabled={disabled || nextPending === -1} onClick={() => onIndexChange(nextPending)} className="rounded-lg border border-blue-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-blue-700 disabled:opacity-40">Next pending</button>
      </div>
    </div>
    {current.flagged && <p className="flex items-center gap-1 text-xs font-semibold text-amber-800"><AlertTriangle className="h-3.5 w-3.5" /> Evidence flags: inspect carefully.</p>}
    <div role="progressbar" aria-label="Shop decisions queued" aria-valuemin={0} aria-valuemax={items.length} aria-valuenow={completed} className="h-1.5 overflow-hidden rounded-full bg-slate-200"><div className="h-full rounded-full bg-emerald-500" style={{ width: `${100 * completed / items.length}%` }} /></div>
    <div className="flex flex-wrap items-center gap-2">
      <label htmlFor="batch-shop-search" className="relative min-w-[100px] flex-1"><Search aria-hidden="true" className="pointer-events-none absolute left-2 top-2 h-3.5 w-3.5 text-slate-400" /><span className="sr-only">Find a shop within selected batch</span><input id="batch-shop-search" type="search" disabled={disabled} value={search} onChange={e => setSearch(e.target.value)} placeholder="Find shop, city or PO…" className="w-full rounded-lg border border-slate-300 bg-white py-1.5 pl-7 pr-2 text-xs focus-visible:ring-2 focus-visible:ring-blue-500" /></label>
      <label htmlFor="batch-shop-jump" className="sr-only">Jump to selected shop</label>
      <select id="batch-shop-jump" aria-label="Jump to selected shop" disabled={disabled} value={matches.some(row => row.i === currentIndex) ? currentIndex : ''} onChange={event => { if (event.target.value !== '') onIndexChange(Number(event.target.value)); }} className="min-w-0 max-w-full flex-[2_1_180px] rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs focus-visible:ring-2 focus-visible:ring-blue-500">
        {!matches.some(row => row.i === currentIndex) && <option value="">Choose matching shop…</option>}
        {matches.map(({ item, i }) => <option key={item.id} value={i}>{i + 1}. {item.name}{decisionLabels[item.id] ? ` · ${decisionLabels[item.id]}` : inspected.has(item.id) ? ' ✓' : ''}{item.flagged ? ' ⚠' : ''}</option>)}
        {!matches.length && <option value="">No matching shops</option>}
      </select>
      <span className="inline-flex shrink-0 items-center gap-1 text-xs font-semibold text-emerald-700" role="status"><CheckCircle2 className="h-3.5 w-3.5" /> {completed}/{items.length}</span>
    </div>
    {flagged > 0 && <button type="button" disabled={disabled} onClick={() => { const i = items.findIndex(item => item.flagged && !inspected.has(item.id)); if (i >= 0) onIndexChange(i); }} className="text-left text-xs font-semibold text-amber-800 hover:underline">{flagged} flagged, unchecked · Open first issue →</button>}
  </div>;
}
