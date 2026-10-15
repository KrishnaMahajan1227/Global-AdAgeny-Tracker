import { useEffect, useRef, useState } from 'react';
import { X, ChevronLeft, ChevronRight, ExternalLink, ImageOff, FileText } from 'lucide-react';

export type Mark = { points: { x: number; y: number }[]; label: string; own: boolean };
export type Slide = { src: string; title: string; subtitle?: string; kind: 'survey' | 'design' | 'install'; marks?: Mark[]; isImage?: boolean };

export const isImageUrl = (url?: string | null) => !!url && /\.(png|jpe?g|webp|gif|bmp|avif)(\?|$)/i.test(url);
const centroid = (pts: { x: number; y: number }[]) => ({ x: pts.reduce((t, p) => t + p.x, 0) / pts.length, y: pts.reduce((t, p) => t + p.y, 0) / pts.length });
const KIND = {
  survey: { chip: 'bg-white/15', ring: '#2563eb', name: 'Survey' },
  design: { chip: 'bg-white/15', ring: '#2563eb', name: 'Design' },
  install: { chip: 'bg-white/15', ring: '#2563eb', name: 'Installation' },
} as const;

/** Board outlines drawn over the photo. Points are % of the image, so this works at any size. */
export function MarkOverlay({ marks, compact = false, showLabels = false }: { marks?: Mark[]; compact?: boolean; showLabels?: boolean }) {
  const valid = (marks || []).filter((m) => m.points && m.points.length >= 3);
  if (!valid.length) return null;
  return (
    <>
      <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 100 100" preserveAspectRatio="none">
        {valid.map((m, i) => (
          <polygon key={i} points={m.points.map((p) => `${p.x},${p.y}`).join(' ')}
            fill={m.own ? 'rgba(37,99,235,0.18)' : 'rgba(148,163,184,0.10)'} stroke={m.own ? '#2563eb' : '#94a3b8'}
            strokeWidth={m.own ? (compact ? 1.4 : 0.7) : 0.4} strokeDasharray={m.own ? undefined : '1.5 1'} vectorEffect="non-scaling-stroke" style={{ strokeWidth: m.own ? (compact ? 2.5 : 3) : 1.5 }} />
        ))}
      </svg>
      {showLabels && valid.map((m, i) => { const c = centroid(m.points); return (
        <span key={i} style={{ left: `${c.x}%`, top: `${c.y}%` }} className={`absolute -translate-x-1/2 -translate-y-1/2 pointer-events-none whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-semibold shadow ${m.own ? 'bg-blue-600 text-white' : 'bg-white/90 text-slate-700'}`}>{m.label}</span>
      ); })}
    </>
  );
}

export function EvidenceThumb({ slide, onOpen, onDelete, badge, badgeTone }: { slide: Slide; onOpen: () => void; onDelete?: () => void; badge?: string; badgeTone?: 'ok' | 'redo' | 'info' }) {
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => { setFailed(false); setLoaded(false); }, [slide.src]);
  const tone = badgeTone === 'ok' ? 'bg-emerald-600' : badgeTone === 'redo' ? 'bg-amber-600' : 'bg-slate-800/80';
  return (
    <div className="group relative min-w-0">
      <button type="button" onClick={onOpen} aria-label={`Inspect ${slide.title}`} title={`${slide.title} · Click for detailed review`} className="relative flex h-40 w-full items-center justify-center overflow-hidden rounded-lg border border-slate-200 bg-white p-1.5 transition hover:border-blue-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-600">
        {failed ? (
          <span className="flex flex-col items-center gap-1 text-slate-500"><ImageOff className="h-5 w-5" /><span className="text-[10px]">Image unavailable</span></span>
        ) : (
          <span className="relative inline-block max-h-full max-w-full">
            {!loaded && <span className="absolute inset-0 animate-pulse bg-slate-100" />}
            <img src={slide.src} alt={slide.subtitle || slide.title} loading="lazy" onLoad={() => setLoaded(true)} onError={() => setFailed(true)} className="block max-h-[148px] max-w-full object-contain" />
            <MarkOverlay marks={slide.marks} compact />
          </span>
        )}
        {badge && <span className={`absolute right-1 top-1 rounded px-1 py-0.5 text-[9px] font-bold text-white ${tone}`}>{badge}</span>}
        {slide.marks && slide.marks.some(m => m.points.length >= 3) && <span className="absolute left-1 top-1 rounded bg-slate-800/80 px-1 py-0.5 text-[9px] font-bold text-white">MARKED</span>}
      </button>
      <div className="mt-1 flex min-w-0 items-center justify-between gap-2 px-0.5">
        <p className="min-w-0 truncate text-[11px] text-slate-600" title={slide.subtitle || slide.title}>{slide.title}</p>
        {onDelete && <button type="button" onClick={onDelete} aria-label={`Delete ${slide.title}`} title="Delete photo (confirmation required)" className="shrink-0 rounded-md p-1 text-slate-400 hover:bg-red-50 hover:text-red-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-red-600"><X className="h-3.5 w-3.5" /></button>}
      </div>
    </div>
  );
}

export function FileTile({ url, label, tone }: { url: string; label: string; tone: string }) {
  const ext = (url.split('?')[0].split('.').pop() || 'file').slice(0, 4).toUpperCase();
  return (
    <a href={url} target="_blank" rel="noreferrer" className={`relative flex h-40 min-w-0 flex-col items-center justify-center gap-1 rounded-lg border bg-white p-2 transition hover:border-blue-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-600 ${tone}`}>
      <FileText className="w-6 h-6 text-slate-500" /><span className="text-[11px] font-bold">{ext}</span><span className="text-[10px] text-slate-500">{label}</span>
    </a>
  );
}

/** Full-screen gallery: arrows / keyboard, zoom-to-fit, all board outlines with names, item highlighted. */
export function EvidenceViewer({ slides, index, onClose, onIndex }: { slides: Slide[]; index: number; onClose: () => void; onIndex: (i: number) => void }) {
  const s = slides[index];
  const [failed, setFailed] = useState(false);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButtonRef.current?.focus();
    return () => { previous?.focus(); };
  }, []);
  useEffect(() => { setFailed(false); }, [index]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Tab' && dialogRef.current) {
        const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled])'));
        if (focusable.length) {
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
      }
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowRight' && index < slides.length - 1) onIndex(index + 1);
      if (e.key === 'ArrowLeft' && index > 0) onIndex(index - 1);
    };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow; document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [index, slides.length, onClose, onIndex]);
  if (!s) return null;
  const k = KIND[s.kind];
  const markCount = (s.marks || []).filter((m) => m.points.length >= 3).length;
  return (
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="Evidence photo viewer" className="fixed inset-0 z-[100] bg-slate-950/95 flex flex-col" onClick={onClose}>
      <div className="flex items-center justify-between gap-3 px-4 py-3 text-white" onClick={(e) => e.stopPropagation()}>
        <div className="min-w-0 flex items-center gap-3">
          <span className={`rounded px-2 py-0.5 text-[10px] font-bold uppercase ${k.chip}`}>{k.name}</span>
          <div className="min-w-0"><p className="text-sm font-semibold truncate">{s.title}</p>{s.subtitle && <p className="text-xs text-slate-300 truncate">{s.subtitle}</p>}</div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-xs text-slate-300">{index + 1} / {slides.length}</span>
          <a href={s.src} target="_blank" rel="noreferrer" className="p-2 rounded-lg hover:bg-white/10" title="Open original"><ExternalLink className="w-4 h-4" /></a>
          <button type="button" ref={closeButtonRef} onClick={onClose} aria-label="Close photo viewer" className="p-2 rounded-lg hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white" title="Close (Esc)"><X className="w-5 h-5" /></button>
        </div>
      </div>
      <div className="relative flex-1 min-h-0 flex items-center justify-center px-14" onClick={(e) => e.stopPropagation()}>
        {index > 0 && <button type="button" aria-label="Previous photo" onClick={() => onIndex(index - 1)} className="absolute left-2 top-1/2 -translate-y-1/2 p-2.5 rounded-full bg-white/10 hover:bg-white/20 text-white"><ChevronLeft className="w-6 h-6" /></button>}
        {failed ? <div className="text-slate-300 flex flex-col items-center gap-2"><ImageOff className="w-10 h-10" /><p className="text-sm">Unable to load photo</p><a href={s.src} target="_blank" rel="noreferrer" className="text-xs underline">Open original image</a></div> : (
          <div className="relative inline-block max-h-full max-w-full">
            <img src={s.src} alt={s.title} onError={() => setFailed(true)} className="block max-h-[calc(100vh-190px)] max-w-full rounded-lg object-contain" />
            <MarkOverlay marks={s.marks} showLabels />
          </div>
        )}
        {index < slides.length - 1 && <button type="button" aria-label="Next photo" onClick={() => onIndex(index + 1)} className="absolute right-2 top-1/2 -translate-y-1/2 p-2.5 rounded-full bg-white/10 hover:bg-white/20 text-white"><ChevronRight className="w-6 h-6" /></button>}
      </div>
      <div className="px-4 pb-4 pt-2" onClick={(e) => e.stopPropagation()}>
        {markCount > 0 && <p className="text-center text-xs text-slate-300 mb-2">{markCount} board marking(s) on this photo — <span className="text-blue-300 font-semibold">blue</span> = this work item, grey dashed = other items</p>}
        <div className="flex gap-2 overflow-x-auto justify-center">
          {slides.map((sl, i) => <button key={i} type="button" aria-label={`View photo ${i + 1}: ${sl.title}`} aria-current={i === index ? 'true' : undefined} onClick={() => onIndex(i)} className={`shrink-0 h-12 w-16 rounded-md overflow-hidden border-2 ${i === index ? 'border-blue-400' : 'border-transparent opacity-60 hover:opacity-100'}`}><img src={sl.src} alt="" className="h-full w-full bg-slate-900 object-contain" /></button>)}
        </div>
      </div>
    </div>
  );
}
