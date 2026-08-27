import { useRef, useState } from 'react';
import { Undo2, RotateCcw } from 'lucide-react';
import type { MarkPoint } from '@/lib/markingUtils';

// Tap up to 4 corners to mark a board's outline on its photo. Once placed,
// each corner can be dragged to fine-tune it. Points are stored as
// PERCENTAGES of the image's rendered size, so the same marking stays
// correct at any zoom/display size and survives being re-rendered later
// (review screen, PDF/PPT export) against the full-resolution photo.
interface BoardMarkerCanvasProps {
  photoUrl: string;
  points: MarkPoint[];
  onChange: (points: MarkPoint[]) => void;
  label?: string;
  /** Live caption (work type + dimensions) shown as a floating tag right
   *  over the marked polygon as the surveyor fills in its details — so
   *  it's obvious at a glance which measurement belongs to this exact
   *  marked area, not just a plain outline. */
  polygonLabel?: string | null;
  /** Distinguishes this board's polygon color when more than one board is
   *  marked on the same photo (matches the color used in the burned-in
   *  review/export image). */
  colorIndex?: number;
}

const POLYGON_COLORS = ['#2563eb', '#16a34a', '#d97706', '#db2777', '#7c3aed', '#0891b2'];

export function BoardMarkerCanvas({ photoUrl, points, onChange, label, polygonLabel, colorIndex = 0 }: BoardMarkerCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const color = POLYGON_COLORS[colorIndex % POLYGON_COLORS.length];

  function coordsFromEvent(e: { clientX: number; clientY: number }) {
    const rect = containerRef.current!.getBoundingClientRect();
    const x = Math.min(100, Math.max(0, ((e.clientX - rect.left) / rect.width) * 100));
    const y = Math.min(100, Math.max(0, ((e.clientY - rect.top) / rect.height) * 100));
    return { x, y };
  }

  function handleContainerClick(e: React.MouseEvent) {
    if (dragIndex !== null) return; // was a drag release, not a new tap
    if (points.length >= 4) return;
    onChange([...points, coordsFromEvent(e)]);
  }

  function handlePointerDown(i: number, e: React.PointerEvent) {
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    setDragIndex(i);
  }

  function handlePointerMove(e: React.PointerEvent) {
    if (dragIndex === null || !containerRef.current) return;
    const { x, y } = coordsFromEvent(e);
    const next = points.map((p, i) => (i === dragIndex ? { x, y } : p));
    onChange(next);
  }

  function handlePointerUp() {
    // Small timeout so the subsequent container click (from the same
    // gesture) doesn't add a stray 5th point.
    setTimeout(() => setDragIndex(null), 0);
  }

  function undo() {
    onChange(points.slice(0, -1));
  }

  function reset() {
    onChange([]);
  }

  const centroid = points.length >= 3
    ? { x: points.reduce((s, p) => s + p.x, 0) / points.length, y: points.reduce((s, p) => s + p.y, 0) / points.length }
    : null;

  return (
    <div>
      {label && <p className="text-sm font-medium text-slate-700 mb-2">{label}</p>}
      <div
        ref={containerRef}
        onClick={handleContainerClick}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        className="relative rounded-lg overflow-hidden cursor-crosshair select-none touch-none"
      >
        <img src={photoUrl} alt="Mark board" className="w-full pointer-events-none" draggable={false} />
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 w-full h-full pointer-events-none">
          {points.length >= 3 && (
            <polygon
              points={points.map((p) => `${p.x},${p.y}`).join(' ')}
              fill={`${color}4D`}
              stroke={color}
              strokeWidth="0.6"
              vectorEffect="non-scaling-stroke"
            />
          )}
          {points.length === 2 && (
            <line x1={points[0].x} y1={points[0].y} x2={points[1].x} y2={points[1].y} stroke={color} strokeWidth="0.6" vectorEffect="non-scaling-stroke" />
          )}
        </svg>
        {points.map((p, i) => (
          <div
            key={i}
            onPointerDown={(e) => handlePointerDown(i, e)}
            className="absolute w-6 h-6 -ml-3 -mt-3 rounded-full border-2 border-white shadow flex items-center justify-center text-white text-[10px] font-bold cursor-grab active:cursor-grabbing"
            style={{ left: `${p.x}%`, top: `${p.y}%`, backgroundColor: color }}
          >
            {i + 1}
          </div>
        ))}
        {/* Live label right on the marked area — same measurement/work-type
            text that ends up burned into the reviewed/exported photo, so
            what the surveyor sees while marking already matches what
            everyone downstream will see. */}
        {centroid && polygonLabel && (
          <div
            className="absolute -translate-x-1/2 -translate-y-1/2 px-2 py-1 rounded-md text-white text-[11px] font-semibold shadow pointer-events-none max-w-[85%] text-center leading-tight"
            style={{ left: `${centroid.x}%`, top: `${centroid.y}%`, backgroundColor: 'rgba(15, 23, 42, 0.85)', border: `1px solid ${color}` }}
          >
            {polygonLabel}
          </div>
        )}
      </div>
      <div className="flex items-center justify-between mt-2">
        <p className="text-xs text-slate-500">
          {points.length < 4 ? `Tap to place corner ${points.length + 1} of 4 — drag a dot to adjust` : 'Board marked! Drag a dot to fine-tune.'}
        </p>
        <div className="flex gap-3">
          {points.length > 0 && (
            <button type="button" onClick={undo} className="flex items-center gap-1 text-xs text-slate-500 font-medium">
              <Undo2 className="w-3.5 h-3.5" /> Undo
            </button>
          )}
          {points.length > 0 && (
            <button type="button" onClick={reset} className="flex items-center gap-1 text-xs text-blue-600 font-medium">
              <RotateCcw className="w-3.5 h-3.5" /> Reset
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

