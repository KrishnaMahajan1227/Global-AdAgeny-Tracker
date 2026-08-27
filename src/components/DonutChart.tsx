// Multi-segment donut/pie chart — hand-rolled SVG, same zero-dependency
// convention as BurndownChart.tsx / LineItemProgressChart.tsx (this app
// has no charting library and a donut is just a handful of arcs). Unlike
// LineItemProgressChart's single-ring "% of one thing" donut, this one
// splits the ring into several colored segments (e.g. Pending / In
// Progress / Completed site counts) with an optional number in the
// center — the standard "status breakdown at a glance" chart.
import { useState } from 'react';

export interface DonutSegment {
  key: string;
  label: string;
  value: number;
  color: string;
}

interface DonutChartProps {
  segments: DonutSegment[];
  size?: number;
  strokeWidth?: number;
  centerValue?: string;
  centerLabel?: string;
}

export function DonutChart({ segments, size = 176, strokeWidth = 22, centerValue, centerLabel }: DonutChartProps) {
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const center = size / 2;
  const total = segments.reduce((sum, s) => sum + s.value, 0);

  // Nothing to show yet — a single flat gray ring reads more honestly
  // than an empty <svg>, and matches the "quiet, not broken" feel the
  // rest of this app's empty states go for.
  if (total === 0) {
    return (
      <div className="relative shrink-0" style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
          <circle cx={center} cy={center} r={radius} fill="none" stroke="#e2e8f0" strokeWidth={strokeWidth} />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-lg font-semibold text-slate-300">—</span>
        </div>
      </div>
    );
  }

  let cumulative = 0;
  const arcs = segments
    .filter((s) => s.value > 0)
    .map((s) => {
      const fraction = s.value / total;
      const dash = fraction * circumference;
      const gap = circumference - dash;
      const offset = -cumulative * circumference;
      cumulative += fraction;
      return { ...s, dash, gap, offset, fraction };
    });

  const hovered = hoverKey ? arcs.find((a) => a.key === hoverKey) : null;

  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={center} cy={center} r={radius} fill="none" stroke="#f1f5f9" strokeWidth={strokeWidth} />
        {arcs.map((a) => (
          <circle
            key={a.key}
            cx={center}
            cy={center}
            r={radius}
            fill="none"
            stroke={a.color}
            strokeWidth={hoverKey === a.key ? strokeWidth + 4 : strokeWidth}
            strokeDasharray={`${a.dash} ${a.gap}`}
            strokeDashoffset={a.offset}
            strokeLinecap="butt"
            transform={`rotate(-90 ${center} ${center})`}
            className="transition-all duration-150 cursor-default"
            onMouseEnter={() => setHoverKey(a.key)}
            onMouseLeave={() => setHoverKey((cur) => (cur === a.key ? null : cur))}
          />
        ))}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
        {hovered ? (
          <>
            <span className="text-xl font-bold text-slate-900">{hovered.value}</span>
            <span className="text-[10px] text-slate-500 mt-0.5 text-center px-2 leading-tight">{hovered.label}</span>
          </>
        ) : (
          <>
            <span className="text-xl font-bold text-slate-900">{centerValue ?? total}</span>
            {centerLabel && <span className="text-[10px] text-slate-400 mt-0.5 text-center px-2 leading-tight">{centerLabel}</span>}
          </>
        )}
      </div>
    </div>
  );
}
