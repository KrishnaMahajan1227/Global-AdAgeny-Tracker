/** Fetch all permitted rows without Supabase/PostgREST default page truncation. */
export async function fetchAllPages<T = any>(build: (start: number, end: number) => any, pageSize = 500): Promise<T[]> {
  const records: T[] = [];
  for (let start = 0; ; start += pageSize) {
    const { data, error } = await build(start, start + pageSize - 1);
    if (error) throw error;
    const page = (data || []) as T[];
    records.push(...page);
    if (page.length < pageSize) return records;
  }
}
export function validCoordinates(lat: unknown, lng: unknown): boolean {
  const latitude = Number(lat), longitude = Number(lng);
  return lat != null && lng != null && Number.isFinite(latitude) && Number.isFinite(longitude) && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180 && !(latitude === 0 && longitude === 0);
}
