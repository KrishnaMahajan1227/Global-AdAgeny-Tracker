import { GOOGLE_MAPS_API_KEY } from './supabase';

let loadingPromise: Promise<void> | null = null;

/**
 * Loads the Google Maps JavaScript SDK exactly once, no matter how many
 * places in the app ask for it (shop form geocoding, Field Map, Surveyor
 * map, future bulk-import geocoding, etc). Safe to call multiple times —
 * everyone shares the same <script> tag and the same promise.
 */
export function loadGoogleMaps(): Promise<void> {
  if (window.google?.maps) return Promise.resolve();
  if (loadingPromise) return loadingPromise;

  loadingPromise = new Promise((resolve, reject) => {
    if (!GOOGLE_MAPS_API_KEY) {
      loadingPromise = null;
      reject(new Error('Google Maps API key is not configured (VITE_GOOGLE_MAPS_API_KEY in .env).'));
      return;
    }

    const existing = document.querySelector('script[data-google-maps-loader]') as HTMLScriptElement | null;
    if (existing) {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('Failed to load Google Maps script.')));
      return;
    }

    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?key=${GOOGLE_MAPS_API_KEY}&libraries=places`;
    script.async = true;
    script.defer = true;
    script.dataset.googleMapsLoader = 'true';
    script.onload = () => resolve();
    script.onerror = () => {
      loadingPromise = null;
      reject(new Error('Failed to load Google Maps script.'));
    };
    document.head.appendChild(script);
  });

  return loadingPromise;
}
