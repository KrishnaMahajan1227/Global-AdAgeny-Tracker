// Converts a board's width and height to a single common unit before
// multiplying them into an area — a survey measurement can legitimately
// mix units (e.g. a strip measured "10 ft wide, 6 in deep"), and
// multiplying raw numbers across different units without converting
// first silently produces a wrong area. Every length here funnels
// through feet, since that's the unit the rest of the platform (PO
// budgets, reports, billing) already assumes.

export const LENGTH_UNIT_OPTIONS = [
  { value: 'ft', label: 'Feet' },
  { value: 'in', label: 'Inch' },
  { value: 'm', label: 'Meter' },
  { value: 'cm', label: 'Centimeter' },
];

const TO_FEET: Record<string, number> = {
  ft: 1, feet: 1, foot: 1, "'": 1,
  in: 1 / 12, inch: 1 / 12, inches: 1 / 12, '"': 1 / 12,
  m: 3.280839895013123, meter: 3.280839895013123, meters: 3.280839895013123, metre: 3.280839895013123, metres: 3.280839895013123,
  cm: 0.03280839895013123, centimeter: 0.03280839895013123, centimeters: 0.03280839895013123, centimetre: 0.03280839895013123, centimetres: 0.03280839895013123,
  mm: 0.003280839895013123, millimeter: 0.003280839895013123, millimeters: 0.003280839895013123,
};

/** Rounds a measurement to the nearest whole number for DISPLAY only — the
 * database keeps the precise figure (area calculations, PO utilization,
 * etc. all still use the unrounded value); this is purely so a surveyor's
 * "4.5 ft" or a unit-converted "4.17 ft" reads as a clean whole number
 * everywhere a person actually looks at it — Survey Review, Shop detail,
 * Designer, Production, Installer specs, PDF/PPT exports, marked-photo
 * captions. Returns null (not 0) for a missing/invalid value so callers
 * can keep showing "—" instead of a false "0". */
export function formatDim(value: number | string | null | undefined): number | null {
  if (value == null || value === '') return null;
  const n = typeof value === 'string' ? parseFloat(value) : value;
  if (!Number.isFinite(n)) return null;
  return Math.round(n);
}

export function toFeet(value: number, unit: string): number {
  const normalized = String(unit || 'ft').trim().toLowerCase();
  const factor = TO_FEET[normalized] ?? 1;
  // Rounded to 2 decimals (about 1/8 inch) — the raw conversion factors
  // for inches (1/12), meters (3.28084) and centimeters essentially never
  // land on a clean number (e.g. "5 in" was saving as
  // 0.4166666666666667 ft), and that unrounded value flowed straight
  // through into survey_area, then got copied verbatim into
  // approved_width/height/area and installed_width/height/area — so the
  // long decimal showed up everywhere the measurement was later
  // displayed (Survey Review, Shop detail, Installer specs, PDF/PPT
  // exports), not just here. Rounding once, at the single point every
  // measurement funnels through, fixes all of those at once.
  return value * factor;
}

/** Area in sq ft from a width/height pair that may each be in a different unit. */
export function areaSqFt(width: number, widthUnit: string, height: number, heightUnit: string): number {
  return Math.round(toFeet(width, widthUnit) * toFeet(height, heightUnit) * 10000) / 10000;
}


// ─────────────────────────────────────────────────────────────────────────────
// SIZE DISPLAY vs CALCULATION
//  • Calculation base is ALWAYS feet / sq.ft (survey_*, approved_*, installed_*).
//  • People see the size exactly as the surveyor entered it (inch / ft / m / cm) — stored in entered_*.
//  • Totals (dashboard, progress, reports, billing) are shown in the WORK ORDER unit (sqft / piece / lot).
// ─────────────────────────────────────────────────────────────────────────────
const UNIT_SHORT: Record<string, string> = { ft: 'ft', feet: 'ft', foot: 'ft', in: 'in', inch: 'in', inches: 'in', m: 'm', meter: 'm', metre: 'm', cm: 'cm', mm: 'mm' };
export function unitShort(unit?: string | null): string { return UNIT_SHORT[String(unit || 'ft').trim().toLowerCase()] || String(unit || 'ft'); }
/** 10 -> "10", 4.5 -> "4.5", 4.1666 -> "4.17" (never a long decimal, never rounded to a whole number). */
export function trimNum(value: number | string | null | undefined, max = 2): string {
  if (value == null || value === '') return '—';
  const n = typeof value === 'string' ? parseFloat(value) : value;
  if (!Number.isFinite(n)) return '—';
  return String(Math.round(n * 10 ** max) / 10 ** max);
}
type SizeBasis = 'survey' | 'approved' | 'installed';
/** "10 ft × 6 in" — the size as it was surveyed. Falls back to feet when the original entry is unknown or was edited later. */
export function itemSizeLabel(it: any, basis: SizeBasis = 'approved'): string {
  if (!it) return '—';
  const pick = (k: 'width' | 'height') => (it[`${basis}_${k}`] ?? it[`approved_${k}`] ?? it[`survey_${k}`]) as number | null | undefined;
  const w = pick('width'), h = pick('height');
  if (w == null || h == null) return '—';
  const ew = it.entered_width, eh = it.entered_height, wu = it.entered_width_unit, hu = it.entered_height_unit;
  if (ew != null && eh != null && wu && hu && Math.abs(toFeet(Number(ew), wu) - Number(w)) < 0.05 && Math.abs(toFeet(Number(eh), hu) - Number(h)) < 0.05) {
    return unitShort(wu) === unitShort(hu) ? `${trimNum(ew)} × ${trimNum(eh)} ${unitShort(wu)}` : `${trimNum(ew)} ${unitShort(wu)} × ${trimNum(eh)} ${unitShort(hu)}`;
  }
  return `${trimNum(w)} × ${trimNum(h)} ft`;
}
/** Total area in the work-order unit. Area-based work orders (sqft) show sq.ft; piece / lot orders count quantity. */
export function totalInWorkOrderUnit(uom: string | null | undefined, areaSqFtValue: number | null | undefined, qty: number | null | undefined): { value: number; label: string } {
  if (!uom || uom === 'sqft') return { value: Math.round((Number(areaSqFtValue) || 0) * 100) / 100, label: 'sq.ft' };
  return { value: Number(qty) || 0, label: uom === 'piece' ? 'pcs' : uom };
}
