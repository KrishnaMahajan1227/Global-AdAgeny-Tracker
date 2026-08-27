// Replaces the time-series Burndown chart in the client portal with
// something quicker to read at a glance: a donut showing overall %
// complete for one line item, plus a small per-stage breakdown underneath.
// Hand-rolled SVG, same convention as BurndownChart.tsx — no charting
// library, this app has none and a single-ring donut is only a handful of
// arcs.
const STAGE_COLORS: Record<string, string> = {
  surveyed: '#3b82f6',  // blue-500
  approved: '#8b5cf6',  // violet-500
  produced: '#f59e0b',  // amber-500
  installed: '#22c55e', // green-500
};

interface StageValue {
  key: 'surveyed' | 'approved' | 'produced' | 'installed';
  label: string;
  pct: number | null; // 0-100
}

interface LineItemProgressChartProps {
  /** 0-100, or null if there's no budget to measure against yet. */
  completionPct: number | null;
  completionLabel: string; // e.g. "Installed" or "Produced"
  stages: StageValue[];
  size?: number;
}

export function LineItemProgressChart({ completionPct, completionLabel, stages, size = 168 }: LineItemProgressChartProps) {
  const radius = size / 2 - 14;
  const circumference = 2 * Math.PI * radius;
  const pct = completionPct ?? 0;
  const dash = (pct / 100) * circumference;
  const center = size / 2;
  const ringColor = pct >= 100 ? '#16a34a' : pct >= 60 ? '#22c55e' : pct >= 30 ? '#eab308' : '#94a3b8';

  return (
    <div className="flex flex-col sm:flex-row items-center gap-6">
      <div className="relative shrink-0" style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
          <circle cx={center} cy={center} r={radius} fill="none" stroke="#e2e8f0" strokeWidth={14} />
          {completionPct != null && (
            <circle
              cx={center}
              cy={center}
              r={radius}
              fill="none"
              stroke={ringColor}
              strokeWidth={14}
              strokeDasharray={`${dash} ${circumference - dash}`}
              strokeLinecap="round"
              transform={`rotate(-90 ${center} ${center})`}
            />
          )}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-2xl font-bold text-slate-900">{completionPct != null ? `${Math.round(completionPct)}%` : '—'}</span>
          <span className="text-[11px] text-slate-400 mt-0.5">{completionLabel}</span>
        </div>
      </div>

      <div className="flex-1 w-full space-y-2.5">
        {stages.map((s) => (
          <div key={s.key}>
            <div className="flex items-center justify-between text-xs mb-1">
              <span className="flex items-center gap-1.5 text-slate-600">
                <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: STAGE_COLORS[s.key] }} />
                {s.label}
              </span>
              <span className="text-slate-500">{s.pct != null ? `${Math.round(s.pct)}%` : '—'}</span>
            </div>
            <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
              <div
                className="h-full rounded-full transition-all"
                style={{ width: `${Math.min(s.pct ?? 0, 100)}%`, backgroundColor: STAGE_COLORS[s.key] }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
