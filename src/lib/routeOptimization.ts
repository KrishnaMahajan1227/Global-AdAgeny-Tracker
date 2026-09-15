/*
  Route optimization + turn-by-turn navigation helpers.

  Wraps the Google Maps DirectionsService the same way geocode.ts wraps the
  Geocoder — one place that talks to the SDK, shared by the admin Route
  Planning screen and the field My Route panel, so both draw the exact same
  optimized order and the exact same turn-by-turn steps.

  This is what actually closes "sirf basic markers hain abhi" — Field Map
  and the mobile map previously only ever dropped pins. This module is what
  turns a list of shops into an ordered, distance/time-aware route with
  real driving directions.
*/
import { loadGoogleMaps } from './googleMapsLoader';

export interface RouteStopPoint {
  id: string; // shop id
  name: string;
  lat: number;
  lng: number;
}

export interface OptimizedLeg {
  distanceMeters: number;
  durationSeconds: number;
  distanceText: string;
  durationText: string;
  /** Turn-by-turn instructions for this leg, HTML stripped, in order. */
  steps: string[];
}

export interface OptimizedRouteResult {
  /** The input stops, reordered for the shortest overall trip. */
  orderedStops: RouteStopPoint[];
  /** One leg per hop: origin→stop1, stop1→stop2, ... */
  legs: OptimizedLeg[];
  totalDistanceMeters: number;
  totalDurationSeconds: number;
  /** Decoded path for drawing the route polyline on a map. */
  overviewPath: { lat: number; lng: number }[];
  /** Raw DirectionsResult, in case a caller wants to hand it straight to a DirectionsRenderer. */
  raw: any;
}

export type TravelMode = 'DRIVING' | 'WALKING' | 'BICYCLING' | 'TWO_WHEELER';

const MAX_WAYPOINTS_PER_REQUEST = 23; // Google's Directions API cap (25 minus origin/destination)

function stripHtml(html: string): string {
  return (html || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Optimizes stop order (a lightweight traveling-salesman pass, delegated to
 * Google's own waypoint optimizer) and returns real driving directions —
 * per-leg distance/duration and turn-by-turn steps — for the optimized
 * order. `origin` is normally the field worker's current/last known
 * location; the last stop in the optimized order becomes the destination.
 */
export async function optimizeRoute(
  origin: { lat: number; lng: number },
  stops: RouteStopPoint[],
  travelMode: TravelMode = 'DRIVING'
): Promise<OptimizedRouteResult> {
  if (stops.length === 0) {
    throw new Error('Add at least one stop to build a route.');
  }
  if (stops.length > MAX_WAYPOINTS_PER_REQUEST + 1) {
    throw new Error(`Too many stops in one route (max ${MAX_WAYPOINTS_PER_REQUEST + 1}). Split into two routes/days.`);
  }

  await loadGoogleMaps();
  const directionsService = new window.google.maps.DirectionsService();

  const destination = stops[stops.length - 1];
  const waypointStops = stops.slice(0, -1);

  const request = {
    origin,
    destination: { lat: destination.lat, lng: destination.lng },
    waypoints: waypointStops.map((s) => ({ location: { lat: s.lat, lng: s.lng }, stopover: true })),
    optimizeWaypoints: true,
    travelMode: window.google.maps.TravelMode[travelMode] || window.google.maps.TravelMode.DRIVING,
  };

  const result: any = await new Promise((resolve, reject) => {
    directionsService.route(request, (res: any, status: string) => {
      if (status === 'OK' && res) {
        resolve(res);
      } else {
        reject(new Error(mapsErrorMessage(status)));
      }
    });
  });

  const route = result.routes[0];
  const order: number[] = route.waypoint_order && route.waypoint_order.length === waypointStops.length
    ? route.waypoint_order
    : waypointStops.map((_, i) => i);

  const orderedStops: RouteStopPoint[] = [...order.map((i) => waypointStops[i]), destination];

  const legs: OptimizedLeg[] = (route.legs || []).map((leg: any) => ({
    distanceMeters: leg.distance?.value || 0,
    durationSeconds: leg.duration?.value || 0,
    distanceText: leg.distance?.text || '',
    durationText: leg.duration?.text || '',
    steps: (leg.steps || []).map((step: any) => stripHtml(step.instructions)),
  }));

  const totalDistanceMeters = legs.reduce((sum: number, l: OptimizedLeg) => sum + l.distanceMeters, 0);
  const totalDurationSeconds = legs.reduce((sum: number, l: OptimizedLeg) => sum + l.durationSeconds, 0);
  const overviewPath = (route.overview_path || []).map((p: any) => ({ lat: p.lat(), lng: p.lng() }));

  return { orderedStops, legs, totalDistanceMeters, totalDurationSeconds, overviewPath, raw: result };
}

/**
 * Same as optimizeRoute but keeps the given stop order fixed (no
 * reordering) — used to render an already-saved route's actual driving
 * path on a map (Field Map overlay), rather than to plan a new one.
 */
export async function fetchDirectionsForOrderedStops(
  origin: { lat: number; lng: number },
  orderedStops: RouteStopPoint[],
  travelMode: TravelMode = 'DRIVING'
): Promise<{ overviewPath: { lat: number; lng: number }[]; raw: any } | null> {
  if (orderedStops.length === 0) return null;
  await loadGoogleMaps();
  const directionsService = new window.google.maps.DirectionsService();
  const destination = orderedStops[orderedStops.length - 1];
  const waypoints = orderedStops.slice(0, -1).map((s) => ({ location: { lat: s.lat, lng: s.lng }, stopover: true }));

  const request = {
    origin,
    destination: { lat: destination.lat, lng: destination.lng },
    waypoints,
    optimizeWaypoints: false,
    travelMode: window.google.maps.TravelMode[travelMode] || window.google.maps.TravelMode.DRIVING,
  };

  try {
    const result: any = await new Promise((resolve, reject) => {
      directionsService.route(request, (res: any, status: string) => {
        if (status === 'OK' && res) resolve(res);
        else reject(new Error(status));
      });
    });
    const overviewPath = (result.routes[0]?.overview_path || []).map((p: any) => ({ lat: p.lat(), lng: p.lng() }));
    return { overviewPath, raw: result };
  } catch {
    return null;
  }
}

function mapsErrorMessage(status: string): string {
  switch (status) {
    case 'ZERO_RESULTS':
      return 'Google could not find driving directions between these stops — check their coordinates.';
    case 'MAX_WAYPOINTS_EXCEEDED':
      return 'Too many stops for one route. Split into smaller routes.';
    case 'NOT_FOUND':
      return 'One of the stops could not be located — check its coordinates.';
    case 'OVER_QUERY_LIMIT':
      return 'Google Maps quota reached for this key — try again shortly.';
    default:
      return `Could not calculate the route (${status}).`;
  }
}

export function formatDistance(meters: number | null | undefined): string {
  if (!meters && meters !== 0) return '—';
  return meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${Math.round(meters)} m`;
}

export function formatDuration(seconds: number | null | undefined): string {
  if (!seconds && seconds !== 0) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/**
 * Builds a Google Maps multi-stop turn-by-turn navigation deep link.
 * Opens the Google Maps app on mobile (or maps.google.com in a browser)
 * with the whole stop order preserved as waypoints — actual turn-by-turn
 * navigation across the field worker's full day, not one shop at a time.
 */
export function buildMultiStopNavigationUrl(
  stops: RouteStopPoint[],
  origin?: { lat: number; lng: number } | null,
  travelMode: 'driving' | 'walking' | 'bicycling' | 'two-wheeler' = 'driving'
): string {
  if (stops.length === 0) return '';
  const destination = stops[stops.length - 1];
  const waypoints = stops.slice(0, -1).map((s) => `${s.lat},${s.lng}`).join('|');
  const params = new URLSearchParams();
  params.set('api', '1');
  if (origin) params.set('origin', `${origin.lat},${origin.lng}`);
  params.set('destination', `${destination.lat},${destination.lng}`);
  if (waypoints) params.set('waypoints', waypoints);
  params.set('travelmode', travelMode);
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

/** Single-destination nav link — kept for parity with the existing per-shop "Navigate" buttons. */
export function buildSingleStopNavigationUrl(
  lat: number,
  lng: number,
  travelMode: 'driving' | 'walking' | 'bicycling' | 'two-wheeler' = 'driving'
): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=${travelMode}`;
}
