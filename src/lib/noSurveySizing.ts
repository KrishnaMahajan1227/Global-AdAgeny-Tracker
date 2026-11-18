/** A measured no-survey work item is an approved scope, not a completed survey.
 * Never auto-approve survey_install/direct_install or any progressed work item.
 * Keep production/installation gates and designer permissions unchanged.
 */
export type MeasuredWorkItem = {
  status?: string | null;
  approved_width?: number | null;
  approved_height?: number | null;
  approved_quantity?: number | null;
  po_line_item_id?: string | null;
};
export function usesPreDesignMeasurements(fulfillmentType: string | null | undefined): boolean {
  return fulfillmentType === 'production_install' || fulfillmentType === 'supply_only';
}
export function hasUsableApprovedSize(item: MeasuredWorkItem): boolean {
  const w = Number(item.approved_width), h = Number(item.approved_height), q = Number(item.approved_quantity);
  if (item.approved_quantity == null || !Number.isSafeInteger(q) || q <= 0) return false;
  // Physical dimensions are optional for piece/lot lines. The Owner/Admin
  // form enforces both dimensions for area-based (sqft) lines.
  if (item.approved_width == null && item.approved_height == null) return true;
  return item.approved_width != null && item.approved_height != null &&
    Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0;
}
export function sizeNeedsInput(item: MeasuredWorkItem): boolean {
  return item.status === 'pending' || !hasUsableApprovedSize(item);
}
export const MEASUREMENT_LOCKED_STATUSES = new Set([
  'designed', 'design_approved', 'in_production', 'produced', 'production_done',
  'installation_pending', 'installed', 'billed', 'cancelled', 'rejected',
]);
export function approvedStateAfterMeasurement(
  fulfillmentType: string | null | undefined,
  previousStatus: string | null | undefined,
): string | undefined {
  return usesPreDesignMeasurements(fulfillmentType) && previousStatus === 'pending' ? 'approved' : undefined;
}
