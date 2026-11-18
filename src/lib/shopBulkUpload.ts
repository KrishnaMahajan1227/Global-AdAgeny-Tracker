// Shared between the per-Work-Order Shops tab and the top-level Shops
// page's Bulk Upload flow, so both behave identically.
//
// Every client builds their shop list a little differently — a title
// banner above the table, a different column order, "Contact Person"
// instead of "Owner Name", extra columns nobody else has. This handles
// all of that: it scans for the row that actually looks like a header
// (rather than assuming row 1), maps common header spellings onto the
// fixed field set, and reports back anything it couldn't map so the
// caller can ask the client whether those columns should be kept.

import { supabase } from './supabase';

export const SHOP_FIELD_ALIASES: Record<string, string[]> = {
  name: ['name', 'shop name', 'site name', 'store name', 'outlet name', 'retailer name', 'dealer name', 'shop', 'site', 'shop / site name', 'site / shop name'],
  owner_name: ['owner name', 'owner', 'shop owner'], // legacy owner name, never conflate with contact person
  contact_person_name: ['officer name', 'officer', 'officer contact', 'contact person', 'contact person name', 'contact name', 'contactperson', 'site contact person', 'person'],
  owner_phone: ['owner number', 'owner phone', 'owner mobile', 'owner mobile number', 'shop owner number', 'shop owner phone'],
  contact_phone: ['officer number', 'officer phone', 'officer mobile', 'officer mobile number', 'contact person number', 'contact person phone', 'contact person mobile', 'contact person mobile number', 'contact phone', 'contact', 'contact number', 'phone', 'phone no', 'phone no.', 'mobile', 'mobile no', 'mobile no.', 'phone number', 'mobile number', 'contact no', 'contact no.'],
  address: ['address', 'shop address', 'site address', 'full address', 'complete address', 'location address'],
  village: ['village', 'gaon', 'gram'],
  city: ['city', 'town'],
  taluka: ['taluka', 'taluk', 'tehsil', 'tahsil', 'mandal', 'subdistrict', 'sub district'],
  district: ['district', 'dist', 'district name'],
  pincode: ['pin code', 'pincode', 'pin', 'postal code', 'postcode', 'zip code', 'zip'],
  latitude: ['latitude', 'lat', 'gps latitude'],
  longitude: ['longitude', 'lng', 'lon', 'long', 'gps longitude'],
  zone: ['zone', 'region', 'area'],
  state: ['state'],
};

export interface ParsedKnownFields {
  name: string;
  owner_name: string;
  contact_person_name: string;
  owner_phone: string;
  contact_phone: string;
  address: string;
  village: string;
  city: string;
  district: string;
  taluka: string;
  pincode: string;
  latitude: string;
  longitude: string;
  zone: string;
  state: string;
}

export interface ParsedShopRow {
  known: ParsedKnownFields;
  extra: Record<string, string>;
  sourceRowNumber: number; // 1-based spreadsheet row for actionable validation errors
}

function normalizeHeader(h: string): string {
  return h.trim().toLowerCase().replace(/\s+/g, ' ');
}

function matchField(header: string): keyof ParsedKnownFields | null {
  const norm = normalizeHeader(header);
  for (const [field, aliases] of Object.entries(SHOP_FIELD_ALIASES)) {
    if (aliases.includes(norm)) return field as keyof ParsedKnownFields;
  }
  return null;
}

/**
 * Takes a sheet already read as an array-of-arrays (XLSX.utils.sheet_to_json
 * with {header: 1}) and finds the real header row — the first row, among
 * the first 15, that contains a cell recognizable as the "Name" column.
 * Rows above it (a title, instructions, a blank row) are ignored entirely
 * rather than being misread as data or as the header.
 */
export function findShopHeaderRow(aoa: unknown[][]): { headerRowIndex: number; headers: string[] } | null {
  const limit = Math.min(aoa.length, 100);
  for (let i = 0; i < limit; i++) {
    const row = aoa[i];
    if (!row) continue;
    const hasName = row.some((cell) => matchField(String(cell ?? '')) === 'name');
    if (hasName) {
      return { headerRowIndex: i, headers: row.map((c) => String(c ?? '').trim()) };
    }
  }
  return null;
}

/** Select the first worksheet that really contains a shop table (not a cover/instructions tab). */
export function findShopWorkbookTable(
  sheetNames: string[],
  readSheet: (sheetName: string) => unknown[][]
): { sheetName: string; aoa: unknown[][]; headerRowIndex: number; headers: string[] } | null {
  for (const sheetName of sheetNames) {
    const aoa = readSheet(sheetName);
    const found = findShopHeaderRow(aoa);
    if (found) return { sheetName, aoa, ...found };
  }
  return null;
}

/** Common columns stay simple; any additional client-specific columns are saved
 * as shop.extra_details (JSONB). Do NOT dynamically modify SQL schema for
 * untrusted workbook headings or allow spreadsheets to override scope IDs.
 * Officer Name is distinct from the historical owner_name field. */
export const NEW_SHOP_TEMPLATE_FIELDS = [
  'Shop Name', 'Address', 'Owner Number', 'Officer Name', 'Officer Number',
  'Zone', 'State', 'Village', 'Taluka', 'City', 'District',
] as const;

export function validateNewShopBulkHeaders(headers: string[]): void {
  const seen = new Set<string>();
  let hasName = false;
  let hasAddress = false;
  for (const raw of headers) {
    const header = raw.trim();
    if (!header) continue;
    if (header.length > 120) throw new Error(`Excel header is too long: ${header.slice(0, 50)}…`);
    if (/^(?:__proto__|prototype|constructor)$/i.test(header)) {
      throw new Error(`Unsafe Excel header: ${header}. Rename that column.`);
    }
    const field = matchField(header);
    const key = field ? `field:${field}` : `extra:${normalizeHeader(header)}`;
    if (seen.has(key)) throw new Error(`Duplicate Excel column: ${header}. Keep one copy of each field.`);
    seen.add(key);
    if (field === 'name') hasName = true;
    if (field === 'address') hasAddress = true;
  }
  if (!hasName || !hasAddress) {
    throw new Error('Excel must contain Shop Name and Address columns. Other columns are optional.');
  }
  if (seen.size > 120) throw new Error('Maximum 120 populated Excel column headers per upload.');
}

/** Which of the found headers don't map to a known field. */
export function findExtraHeaders(headers: string[], aoa?: unknown[][], headerRowIndex = 0): string[] {
  // A fillable template may contain pre-titled custom columns with no data.
  // Ask Keep/Skip only when at least one shop row actually supplies that field.
  const included = headers.filter((header, colIndex) => {
    if (!header || matchField(header) !== null) return false;
    if (!aoa) return true; // preserve header-only discovery for callers
    return aoa.slice(headerRowIndex + 1).some((row) => {
      const hasShopName = headers.some((h, i) => matchField(h) === 'name' && String(row?.[i] ?? '').trim());
      return hasShopName && !!String(row?.[colIndex] ?? '').trim();
    });
  });
  return Array.from(new Set(included));
}

/**
 * Builds row objects from the data rows below the header row, mapping
 * known columns onto the fixed field set and collecting any
 * caller-approved extra columns into a per-row `extra` object. Rows with
 * no Name value are dropped.
 */
export function buildShopRows(aoa: unknown[][], headerRowIndex: number, headers: string[], includeExtraKeys: Set<string>): ParsedShopRow[] {
  const nameHeaderIndices = headers.flatMap((h, idx) => matchField(h) === 'name' ? [idx] : []);
  if (nameHeaderIndices.length === 0) return [];

  const rows: ParsedShopRow[] = [];
  for (let r = headerRowIndex + 1; r < aoa.length; r++) {
    const dataRow = aoa[r];
    if (!dataRow || dataRow.every((c) => !String(c ?? '').trim())) continue;
    const nameValue = nameHeaderIndices.map((idx) => String(dataRow[idx] ?? '').trim()).find(Boolean);
    if (!nameValue) continue;

    const known: ParsedKnownFields = {
      name: '', owner_name: '', contact_person_name: '', owner_phone: '', contact_phone: '', address: '', village: '', city: '', district: '', taluka: '', pincode: '', latitude: '', longitude: '', zone: '', state: '',
    };
    const extra: Record<string, string> = Object.create(null);

    headers.forEach((h, idx) => {
      if (!h) return;
      const value = String(dataRow[idx] ?? '').trim();
      const field = matchField(h);
      if (field) {
        // Multiple known aliases can coexist; a later empty column must not erase an earlier value.
        if (value && !known[field]) known[field] = value;
      } else if (includeExtraKeys.has(h) && value) {
        extra[h] = value;
      }
    });

    rows.push({ known, extra, sourceRowNumber: r + 1 });
  }
  return rows;
}

/** The only shop-mapping payload accepted by all three bulk upload entry points. */
export interface BulkShopScope {
  organizationId: string;
  clientId: string;
  projectId: string | null;
  purchaseOrderId: string | null;
}

export interface BulkProjectRef { id: string; client_id: string }
export interface BulkWorkOrderRef { id: string; client_id: string; project_id: string | null }

/** Reject stale client/project/WO choices before writing anything. The WO is canonical. */
export function validateBulkShopScope(
  scope: BulkShopScope,
  projects: BulkProjectRef[],
  workOrders: BulkWorkOrderRef[]
): BulkShopScope {
  if (!scope.organizationId || !scope.clientId) throw new Error('Select a valid client first.');
  const project = scope.projectId ? projects.find((p) => p.id === scope.projectId) : null;
  if (scope.projectId && (!project || project.client_id !== scope.clientId)) {
    throw new Error('The selected project does not belong to this client. Re-select the project.');
  }
  const workOrder = scope.purchaseOrderId ? workOrders.find((po) => po.id === scope.purchaseOrderId) : null;
  if (scope.purchaseOrderId && (!workOrder || workOrder.client_id !== scope.clientId)) {
    throw new Error('The selected Work Order does not belong to this client. Re-select the Work Order.');
  }
  if (workOrder?.project_id && scope.projectId && workOrder.project_id !== scope.projectId) {
    throw new Error('The Work Order belongs to a different project. Select the Work Order project.');
  }
  const resolvedProjectId = workOrder?.project_id || scope.projectId || null;
  if (resolvedProjectId && !projects.some((p) => p.id === resolvedProjectId && p.client_id === scope.clientId)) {
    throw new Error('The Work Order project could not be verified for this client. Refresh and try again.');
  }
  return { ...scope, projectId: resolvedProjectId };
}

/** Excel duplicates are blocked only when another identifying value matches as well. */
export function findDuplicateBulkShopRows(rows: ParsedShopRow[]): Array<{ first: number; repeated: number }> {
  const seen = new Map<string, number>();
  const duplicates: Array<{ first: number; repeated: number }> = [];
  for (const row of rows) {
    const fields = row.known;
    // A chain can legitimately have multiple shops with the same name.
    const identifying = [fields.address, fields.owner_phone, fields.contact_phone, fields.city, fields.village, fields.district, fields.taluka, fields.pincode, fields.zone]
      .some((v) => !!v.trim());
    if (!identifying) continue;
    const key = JSON.stringify([
      fields.name, fields.address, fields.contact_phone, fields.village, fields.city,
      fields.district, fields.taluka, fields.pincode, fields.zone, fields.state, fields.latitude, fields.longitude, fields.owner_name, fields.owner_phone, row.extra,
    ].map((v) => typeof v === 'string' ? v.trim().toLocaleLowerCase() : v));
    const first = seen.get(key);
    if (first) duplicates.push({ first, repeated: row.sourceRowNumber });
    else seen.set(key, row.sourceRowNumber);
  }
  return duplicates;
}

/** Reject empty/placeholder addresses; the precise physical pin still needs verification. */
export function isUsableShopAddress(value: string | null | undefined): boolean {
  const address = (value || '').trim();
  return !!address && !/^(n\/?a|none|unknown|not known|tbd|pending|[-.]+)$/i.test(address);
}

export function assertBulkShopRows(rows: ParsedShopRow[]): void {
  if (!rows.length) throw new Error('No valid shop rows found in this file. Fill the first sheet, not the example sheet.');
  for (const { known, sourceRowNumber } of rows) {
    if (!known.name.trim()) throw new Error(`Shop Name is required in spreadsheet row ${sourceRowNumber}.`);
    if (!isUsableShopAddress(known.address)) {
      throw new Error(`Full Address is required in spreadsheet row ${sourceRowNumber}. Add the shop/building, road/locality and landmark or PIN if available.`);
    }
    const hasLat = known.latitude.trim() !== '';
    const hasLng = known.longitude.trim() !== '';
    if (hasLat !== hasLng) throw new Error(`Spreadsheet row ${sourceRowNumber}: enter both Latitude and Longitude, or leave both blank.`);
    if (hasLat) {
      const lat = Number(known.latitude);
      const lng = Number(known.longitude);
      if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) {
        throw new Error(`Spreadsheet row ${sourceRowNumber}: GPS latitude must be -90 to 90 and longitude -180 to 180.`);
      }
    }
  }
  const duplicates = findDuplicateBulkShopRows(rows);
  if (duplicates.length) {
    const match = duplicates[0];
    throw new Error(`Duplicate shop rows ${match.first} and ${match.repeated} in the uploaded file. Remove duplicates before importing.`);
  }
}

export function findMissingShopNames(
  aoa: unknown[][], headerRowIndex: number, headers: string[]
): number[] {
  const nameHeaderIndices = headers.flatMap((h, idx) => matchField(h) === 'name' ? [idx] : []);
  if (nameHeaderIndices.length === 0) return [];
  const missing: number[] = [];
  for (let r = headerRowIndex + 1; r < aoa.length; r++) {
    const cells = aoa[r] || [];
    if (cells.some((cell) => String(cell ?? '').trim()) && !nameHeaderIndices.some((idx) => String(cells[idx] ?? '').trim())) {
      missing.push(r + 1);
    }
  }
  return missing;
}

export function buildBulkShopRecords(
  rows: ParsedShopRow[],
  scope: BulkShopScope,
  zoneIds: Map<string, string>
) {
  assertBulkShopRows(rows);
  return rows.map(({ known, extra, sourceRowNumber }) => {
    const zoneName = known.zone.trim();
    const zoneId = zoneName ? zoneIds.get(zoneName.toLocaleLowerCase()) : null;
    if (zoneName && !zoneId) {
      throw new Error(`Zone "${zoneName}" in row ${sourceRowNumber} could not be mapped. Nothing was uploaded.`);
    }
    return {
      organization_id: scope.organizationId,
      client_id: scope.clientId,
      project_id: scope.projectId,
      purchase_order_id: scope.purchaseOrderId,
      name: known.name.trim(),
      owner_name: known.owner_name || null,
      contact_person_name: known.contact_person_name || null,
      owner_phone: known.owner_phone || null,
      contact_phone: known.contact_phone || null,
      address: known.address || null,
      village: known.village || null,
      city: known.city || null,
      district: known.district || null,
      taluka: known.taluka || null,
      pincode: known.pincode || null,
      latitude: known.latitude.trim() ? Number(known.latitude) : null,
      longitude: known.longitude.trim() ? Number(known.longitude) : null,
      zone: zoneName || null,
      zone_id: zoneId,
      state: known.state || null,
      status: 'pending',
      extra_details: extra,
    };
  });
}

/** GPS is authoritative only when user supplied it. Without GPS this link searches
 * the entered postal address; it is not an automatically verified site pin. */
export function shopMapsUrl(shop: {
  latitude?: number | null; longitude?: number | null;
  address?: string | null; village?: string | null; taluka?: string | null;
  city?: string | null; district?: string | null; state?: string | null;
  pincode?: string | null;
}): string | null {
  if (shop.latitude != null && shop.longitude != null &&
      Number.isFinite(shop.latitude) && Number.isFinite(shop.longitude) &&
      Math.abs(shop.latitude) <= 90 && Math.abs(shop.longitude) <= 180) {
    return `https://www.google.com/maps/search/?api=1&query=${shop.latitude},${shop.longitude}`;
  }
  const address = [shop.address, shop.village, shop.taluka, shop.city, shop.district, shop.state, shop.pincode]
    .map((part) => (part || '').trim()).filter(Boolean).join(', ');
  return address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}` : null;
}

/**
 * A bulk-uploaded sheet's "Zone" column is free text — but shops are
 * filtered/reported by `zone_id`, a real foreign key into the `zones`
 * table (migration 0021). Without resolving text -> zone_id at upload
 * time, every bulk-uploaded shop silently falls outside zone filtering
 * forever, even though the zone name still *looks* right on the shop
 * card (it falls back to displaying the free-text column). This finds
 * an existing zone for each distinct name (matched case-insensitively
 * within the same organization + project), or creates one — exactly
 * what the manual "Add Shop" form's zone dropdown + "Add Zone" flow
 * already does, just applied to a whole sheet at once.
 *
 * `organizationId` is whichever org the shops themselves are being
 * inserted under (the agency's org, even when a client is the one
 * uploading — see migration 0065 for the matching RLS exception that
 * makes that cross-org read/create possible for a client_admin).
 *
 * Returns a Map keyed by the zone name lowercased/trimmed -> its id, so
 * callers can do `zoneIds.get(known.zone.trim().toLowerCase())`.
 */
export async function resolveZoneIds(
  organizationId: string,
  projectId: string | null,
  zoneNames: (string | null | undefined)[]
): Promise<Map<string, string>> {
  const distinctNames = Array.from(
    new Map(zoneNames.map((z) => (z || '').trim()).filter(Boolean).map((z) => [z.toLocaleLowerCase(), z])).values()
  );
  const result = new Map<string, string>();
  if (distinctNames.length === 0) return result; // Missing Zone remains NULL (No Zone), not a made-up zone.

  const existingZones: { id: string; name: string; project_id: string | null }[] = [];
  for (let from = 0; ; from += 500) {
    const { data, error } = await supabase.from('zones').select('id,name,project_id')
      .eq('organization_id', organizationId).order('id').range(from, from + 499);
    if (error) throw error;
    existingZones.push(...(data || []));
    if (!data || data.length < 500) break;
  }

  const existingByKey = new Map<string, string>();
  for (const z of existingZones || []) {
    const key = `${z.project_id || ''}::${z.name.trim().toLocaleLowerCase()}`;
    existingByKey.set(key, z.id);
  }

  const toCreate: string[] = [];
  for (const name of distinctNames) {
    const key = `${projectId || ''}::${name.toLocaleLowerCase()}`;
    const existingId = existingByKey.get(key);
    if (existingId) {
      result.set(name.toLocaleLowerCase(), existingId);
    } else {
      toCreate.push(name);
    }
  }

  if (toCreate.length > 0) {
    const { data: created, error: insertError } = await supabase
      .from('zones')
      .insert(toCreate.map((name) => ({ organization_id: organizationId, project_id: projectId, name })))
      .select('id, name');

    if (insertError) {
      // Most likely a unique-constraint race (someone else created the
      // same zone name a moment earlier) rather than a real failure —
      // re-fetch and use whatever's there now instead of failing the
      // whole upload over it.
      if (insertError.code !== '23505') throw insertError;
      // Scope the retry to the SAME project. A name match in another project
      // would silently attach these shops to the wrong zone.
      let retryQuery = supabase.from('zones').select('id, name, project_id')
        .eq('organization_id', organizationId);
      retryQuery = projectId ? retryQuery.eq('project_id', projectId) : retryQuery.is('project_id', null);
      const { data: retryZones, error: retryError } = await retryQuery;
      if (retryError) throw retryError;
      for (const z of retryZones || []) {
        const normalized = z.name.trim().toLocaleLowerCase();
        if (toCreate.some((name) => name.toLocaleLowerCase() === normalized)) result.set(normalized, z.id);
      }
      // If the batch only partially exists after a concurrent insert, retrying
      // all would hide a failed upload. Explicitly fail instead.
      if (toCreate.some((name) => !result.has(name.toLocaleLowerCase()))) throw insertError;
    } else {
      for (const z of created || []) result.set(z.name.toLocaleLowerCase(), z.id);
    }
  }

  return result;
}
