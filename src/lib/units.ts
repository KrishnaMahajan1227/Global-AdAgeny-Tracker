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
  ft: 1,
  in: 1 / 12,
  m: 3.28084,
  cm: 3.28084 / 100,
};

export function toFeet(value: number, unit: string): number {
  const factor = TO_FEET[unit] ?? 1;
  return value * factor;
}

/** Area in sq ft from a width/height pair that may each be in a different unit. */
export function areaSqFt(width: number, widthUnit: string, height: number, heightUnit: string): number {
  return toFeet(width, widthUnit) * toFeet(height, heightUnit);
}
