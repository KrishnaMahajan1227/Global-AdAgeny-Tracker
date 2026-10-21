import { ChevronLeft, ChevronRight, CheckCircle2, AlertTriangle } from 'lucide-react';

export type ReviewBatchItem = { id: string; name: string; subtitle?: string; flagged?: boolean };

type Props = {
  items: ReviewBatchItem[];
  index: number;
  onIndexChange: (index: number) => void;
  inspected: ReadonlySet<string>;
};

/**
 * Scales to 100+ shops without rendering a row of numbered buttons.
 * Navigation NEVER records a review: only the deliberate Reviewed & Next
 * action after the evidence records the current shop as inspected.
 */
export function ReviewBatchStepper({ items, index, onIndexChange, inspected }: Props) {
  if (!items.length) return <p className="text-sm text-slate-500">No shops selected.</p>;
  const currentIndex = Math.min(Math.max(index, 0), items.length - 1);
  const current = items[currentIndex];
  const completed = items.filter(item => inspected.has(item.id)).length;
  return <div className="space-y-2 rounded-xl border border-blue-200 bg-blue-50/60 p-3">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0 flex-1">
        <p className="text-xs font-semibold text-blue-900">Review {currentIndex + 1} / {items.length} · {completed} reviewed</p>
        <p className="truncate text-sm font-semibold text-slate-900" title={current.name}>{current.name}</p>
        {current.subtitle && <p className="truncate text-xs text-slate-600" title={current.subtitle}>{current.subtitle}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <button type="button" aria-label="Previous shop" disabled={currentIndex === 0} onClick={() => onIndexChange(currentIndex - 1)} className="rounded-lg border border-slate-300 bg-white p-2 text-slate-700 disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-blue-500"><ChevronLeft className="h-4 w-4" /></button>
        <button type="button" aria-label="Next shop" disabled={currentIndex === items.length - 1} onClick={() => onIndexChange(currentIndex + 1)} className="rounded-lg border border-slate-300 bg-white p-2 text-slate-700 disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-blue-500"><ChevronRight className="h-4 w-4" /></button>
      </div>
    </div>
    {current.flagged && <p className="flex items-center gap-1 text-xs font-semibold text-amber-800"><AlertTriangle className="h-3.5 w-3.5" /> Evidence flags: inspect carefully before confirming.</p>}
    <div className="flex flex-wrap items-center gap-2 border-t border-blue-100 pt-2">
      <label htmlFor="batch-shop-jump" className="shrink-0 text-xs font-medium text-slate-600">Jump to shop</label>
      <select id="batch-shop-jump" aria-label="Jump to selected shop" value={currentIndex} onChange={event => onIndexChange(Number(event.target.value))} className="min-w-0 max-w-full flex-1 rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-800 focus-visible:ring-2 focus-visible:ring-blue-500">
        {items.map((item, i) => <option key={item.id} value={i}>{i + 1}. {item.name}{inspected.has(item.id) ? ' ✓ Reviewed' : ''}</option>)}
      </select>
      <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-emerald-700" role="status"><CheckCircle2 className="h-3.5 w-3.5" /> {completed}/{items.length}</span>
    </div>
    <div role="progressbar" aria-label="Shops reviewed" aria-valuemin={0} aria-valuemax={items.length} aria-valuenow={completed} className="h-1.5 overflow-hidden rounded-full bg-blue-100">
      <div className="h-full bg-emerald-500 transition-[width]" style={{ width: `${100 * completed / items.length}%` }} />
    </div>
  </div>;
}
