import { loadGoogleMaps } from './googleMapsLoader';
import { supabase } from './supabase';

export interface GeocodeResult {
  lat: number;
  lng: number;
  formattedAddress: string;
}

/**
 * Turns whatever address text we actually have on hand — shop address +
 * city + district + state, exactly what a surveyor types today or what
 * will come in from a bulk CSV upload later — into map coordinates.
 *
 * This is the one place that talks to the Geocoder, so both the "Add
 * Shop" form and any future bulk-import flow reuse the same lookup and
 * the same error handling instead of everyone typing lat/long by hand.
 */
export async function geocodeAddress(query: string): Promise<GeocodeResult> {
  const trimmed = query.trim();
  if (!trimmed) {
    throw new Error('Enter an address, city, or state first.');
  }

  await loadGoogleMaps();
  const geocoder = new window.google.maps.Geocoder();

  return new Promise((resolve, reject) => {
    geocoder.geocode({ address: trimmed }, (results: any, status: string) => {
      if (status === 'OK' && results && results[0]) {
        const loc = results[0].geometry.location;
        resolve({
          lat: loc.lat(),
          lng: loc.lng(),
          formattedAddress: results[0].formatted_address as string,
        });
      } else if (status === 'ZERO_RESULTS') {
        reject(new Error('Could not find that address on the map. Try adding a landmark or pincode and search again.'));
      } else {
        reject(new Error(`Could not locate that address (${status}). You can still enter latitude/longitude manually.`));
      }
    });
  });
}

/** Builds a single search string out of the separate address fields the shop form collects. */
export function buildAddressQuery(parts: {
  address?: string | null;
  city?: string | null;
  district?: string | null;
  state?: string | null;
}): string {
  return [parts.address, parts.district, parts.city, parts.state, 'India']
    .map((p) => (p || '').trim())
    .filter(Boolean)
    .join(', ');
}

export interface GeocodableShop {
  id: string;
  latitude: number | null;
  longitude: number | null;
  address?: string | null;
  city?: string | null;
  district?: string | null;
  state?: string | null;
}

/**
 * Geocodes every shop in the list that's missing latitude/longitude —
 * from whatever address/city/district/state it already has — and writes
 * the result straight back onto the `shops` row. This is what makes a
 * shop show up on the field map even when nobody ever pinned its exact
 * GPS location: bulk-uploaded shop lists routinely arrive with an
 * address but no coordinates, and without this, that shop would simply
 * never appear on the Surveyor/Installer map or be navigable to.
 *
 * The write-back matters as much as the geocode itself — it means this
 * only ever runs once per shop, not on every single map load, so it
 * stays fast and doesn't burn through geocoding quota repeatedly for a
 * list that never changes.
 */
export async function fillMissingShopCoordinates<T extends GeocodableShop>(
  shops: T[]
): Promise<{ resolved: T[]; failedIds: string[] }> {
  const needsGeocode = shops.filter((s) => s.latitude == null || s.longitude == null);
  if (needsGeocode.length === 0) return { resolved: shops, failedIds: [] };

  const resolvedById = new Map<string, { lat: number; lng: number }>();
  const failedIds: string[] = [];

  // Sequential with a small gap rather than Promise.all — a surveyor's
  // shop list can be a few dozen shops, and firing that many geocode
  // requests at once risks the Geocoder's OVER_QUERY_LIMIT far more than
  // a short queue does.
  for (const shop of needsGeocode) {
    const query = buildAddressQuery(shop);
    if (!query) { failedIds.push(shop.id); continue; }
    try {
      const result = await geocodeAddress(query);
      resolvedById.set(shop.id, { lat: result.lat, lng: result.lng });
    } catch {
      failedIds.push(shop.id);
    }
    await new Promise((r) => setTimeout(r, 180));
  }

  if (resolvedById.size > 0) {
    await Promise.all(
      [...resolvedById.entries()].map(([id, coords]) =>
        supabase.from('shops').update({ latitude: coords.lat, longitude: coords.lng }).eq('id', id)
      )
    );
  }

  const resolved = shops.map((s) => {
    const coords = resolvedById.get(s.id);
    return coords ? { ...s, latitude: coords.lat, longitude: coords.lng } : s;
  });

  return { resolved, failedIds };
}
