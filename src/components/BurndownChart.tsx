// Cumulative surveyed/approved/produced/installed vs budgeted-line chart
// (ARCHITECTURE doc Section 10, Phase I). Deliberately hand-rolled SVG
// instead of pulling in a charting library — this app has zero chart
// dependencies today and a burndown is just 4 polylines + a reference
// line, so a small self-contained component keeps the bundle untouched.
import { useMemo, useState } from 'react';
import type { BurndownPoint } from '@/lib/poBurndown';

const STAGE_META: { key: 'surveyed' | 'approved' | 'produced' | 'installed'; label: string; color: string }[] = [
  { key: 'surveyed', label: 'Surveyed', color: '#3b82f6' },   // blue-500
  { key: 'approved', label: 'Approved', color: '#8b5cf6' },   // violet-500
  { key: 'produced', label: 'Produced', color: '#f59e0b' },   // amber-500
  { key: 'installed', label: 'Installed', color: '#22c55e' }, // green-500
];

interface BurndownChartProps {
  points: BurndownPoint[];
  uom: string;
  height?: number;
}

export function BurndownChart({ points, uom, height = 220 }: BurndownChartProps) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const { width, padding, maxY, xFor, yFor } = useMemo(() => {
    const width = 640;
    const padding = { top: 16, right: 16, bottom: 28, left: 44 };
    const budgeted = points[0]?.budgeted ?? 0;
    const maxVal = Math.max(
      budgeted,
      ...points.map((p) => Math.max(p.surveyed, p.approved, p.produced, p.installed)),
      1
    );
    const maxY = maxVal * 1.1;
    const innerW = width - padding.left - padding.right;
    const innerH = height - padding.top - padding.bottom;
    const n = Math.max(points.length - 1, 1);
    const xFor = (i: number) => padding.left + (innerW * i) / n;
    const yFor = (v: number) => padding.top + innerH - (innerH * v) / maxY;
    return { width, padding, maxY, xFor, yFor };
  }, [points, height]);

  if (points.length === 0) {
    return (
      <div className="flex items-center justify-center text-sm text-slate-400 border border-dashed border-slate-200 rounded-lg" style={{ height }}>
        Abhi tak koi survey/production/installation activity nahi hui iss PO line item pe.
      </div>
    );
  }

  const budgeted = points[0]?.budgeted;
  const pathFor = (key: 'surveyed' | 'approved' | 'produced' | 'installed') =>
    points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${xFor(i)} ${yFor(p[key])}`).join(' ');

  const yTicks = 4;
  const active = hoverIdx != null ? points[hoverIdx] : null;

  return (
    <div>
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full" style={{ maxHeight: height }}>
        {/* horizontal gridlines + y-axis labels */}
        {Array.from({ length: yTicks + 1 }).map((_, i) => {
          const v = (maxY * i) / yTicks;
          const y = yFor(v);
          return (
            <g key={i}>
              <line x1={padding.left} x2={width - padding.right} y1={y} y2={y} stroke="#e2e8f0" strokeWidth={1} />
              <text x={padding.left - 6} y={y + 3} textAnchor="end" fontSize={9} fill="#94a3b8">
                {Math.round(v)}
              </text>
            </g>
          );
        })}

        {/* budgeted reference line */}
        {budgeted != null && budgeted > 0 && (
          <line
            x1={padding.left}
            x2={width - padding.right}
            y1={yFor(budgeted)}
            y2={yFor(budgeted)}
            stroke="#ef4444"
            strokeWidth={1.5}
            strokeDasharray="5 4"
          />
        )}

        {/* stage lines */}
        {STAGE_META.map((s) => (
          <path key={s.key} d={pathFor(s.key)} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        ))}

        {/* hover targets */}
        {points.map((p, i) => (
          <rect
            key={i}
            x={xFor(i) - (width / Math.max(points.length, 1)) / 2}
            y={padding.top}
            width={width / Math.max(points.length, 1)}
            height={height - padding.top - padding.bottom}
            fill="transparent"
            onMouseEnter={() => setHoverIdx(i)}
            onMouseLeave={() => setHoverIdx((cur) => (cur === i ? null : cur))}
          />
        ))}
        {hoverIdx != null && (
          <line
            x1={xFor(hoverIdx)}
            x2={xFor(hoverIdx)}
            y1={padding.top}
            y2={height - padding.bottom}
            stroke="#cbd5e1"
            strokeWidth={1}
          />
        )}
      </svg>

      <div className="flex flex-wrap items-center gap-4 mt-2 text-xs">
        {STAGE_META.map((s) => (
          <span key={s.key} className="flex items-center gap-1.5 text-slate-600">
            <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: s.color }} />
            {s.label}
          </span>
        ))}
        {budgeted != null && budgeted > 0 && (
          <span className="flex items-center gap-1.5 text-slate-600">
            <span className="w-3 border-t-2 border-dashed" style={{ borderColor: '#ef4444' }} />
            Budgeted ({Math.round(budgeted).toLocaleString('en-IN')} {uom})
          </span>
        )}
      </div>

      {active && (
        <div className="mt-2 text-xs bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 flex flex-wrap gap-x-4 gap-y-1">
          <span className="font-medium text-slate-700">{active.date}</span>
          {STAGE_META.map((s) => (
            <span key={s.key} style={{ color: s.color }}>
              {s.label}: {active[s.key].toLocaleString('en-IN')} {uom}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
