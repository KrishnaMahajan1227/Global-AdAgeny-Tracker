import { loadGoogleMaps } from './googleMapsLoader';

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
  address?: string;
  city?: string;
  district?: string;
  state?: string;
}): string {
  return [parts.address, parts.district, parts.city, parts.state, 'India']
    .map((p) => (p || '').trim())
    .filter(Boolean)
    .join(', ');
}
