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
  name: ['name', 'shop name', 'site name', 'shop', 'site', 'shop / site name'],
  owner_name: ['owner name', 'owner', 'contact person', 'contact name', 'person', 'shop owner'],
  contact_phone: ['contact phone', 'contact', 'phone', 'mobile', 'phone number', 'mobile number', 'contact no', 'contact no.'],
  address: ['address', 'shop address', 'site address', 'full address'],
  village: ['village', 'gaon', 'gram'],
  city: ['city', 'town'],
  district: ['district', 'taluka', 'tehsil'],
  zone: ['zone', 'region', 'area'],
  state: ['state'],
};

export interface ParsedKnownFields {
  name: string;
  owner_name: string;
  contact_phone: string;
  address: string;
  village: string;
  city: string;
  district: string;
  zone: string;
  state: string;
}

export interface ParsedShopRow {
  known: ParsedKnownFields;
  extra: Record<string, string>;
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
  const limit = Math.min(aoa.length, 15);
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

/** Which of the found headers don't map to a known field. */
export function findExtraHeaders(headers: string[]): string[] {
  return headers.filter((h) => h && matchField(h) === null);
}

/**
 * Builds row objects from the data rows below the header row, mapping
 * known columns onto the fixed field set and collecting any
 * caller-approved extra columns into a per-row `extra` object. Rows with
 * no Name value are dropped.
 */
export function buildShopRows(aoa: unknown[][], headerRowIndex: number, headers: string[], includeExtraKeys: Set<string>): ParsedShopRow[] {
  const nameHeaderIdx = headers.findIndex((h) => matchField(h) === 'name');
  if (nameHeaderIdx === -1) return [];

  const rows: ParsedShopRow[] = [];
  for (let r = headerRowIndex + 1; r < aoa.length; r++) {
    const dataRow = aoa[r];
    if (!dataRow || dataRow.every((c) => !String(c ?? '').trim())) continue;
    const nameValue = String(dataRow[nameHeaderIdx] ?? '').trim();
    if (!nameValue) continue;

    const known: ParsedKnownFields = {
      name: '', owner_name: '', contact_phone: '', address: '', village: '', city: '', district: '', zone: '', state: '',
    };
    const extra: Record<string, string> = {};

    headers.forEach((h, idx) => {
      if (!h) return;
      const value = String(dataRow[idx] ?? '').trim();
      const field = matchField(h);
      if (field) {
        known[field] = value;
      } else if (includeExtraKeys.has(h) && value) {
        extra[h] = value;
      }
    });

    rows.push({ known, extra });
  }
  return rows;
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
    new Set(zoneNames.map((z) => (z || '').trim()).filter((z) => z !== ''))
  );
  const result = new Map<string, string>();
  if (distinctNames.length === 0) return result;

  const { data: existingZones, error: selectError } = await supabase
    .from('zones')
    .select('id, name, project_id')
    .eq('organization_id', organizationId);
  if (selectError) throw selectError;

  const existingByKey = new Map<string, string>();
  for (const z of existingZones || []) {
    const key = `${z.project_id || ''}::${z.name.trim().toLowerCase()}`;
    existingByKey.set(key, z.id);
  }

  const toCreate: string[] = [];
  for (const name of distinctNames) {
    const key = `${projectId || ''}::${name.toLowerCase()}`;
    const existingId = existingByKey.get(key);
    if (existingId) {
      result.set(name.toLowerCase(), existingId);
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
      const { data: retryZones, error: retryError } = await supabase
        .from('zones')
        .select('id, name')
        .eq('organization_id', organizationId)
        .in('name', toCreate);
      if (retryError || !retryZones || retryZones.length === 0) throw insertError;
      for (const z of retryZones) result.set(z.name.toLowerCase(), z.id);
    } else {
      for (const z of created || []) result.set(z.name.toLowerCase(), z.id);
    }
  }

  return result;
}
