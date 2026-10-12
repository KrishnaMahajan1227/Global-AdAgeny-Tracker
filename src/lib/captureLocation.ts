/** Obtain the device position at photo time, never substitute a saved site pin. */
export type PhotoLocation = { lat: number; lng: number; accuracy: number };
export async function capturePhotoLocation(fallback?: PhotoLocation | null): Promise<PhotoLocation | null> {
  if (!('geolocation' in navigator)) return fallback ?? null;
  try {
    const position = await new Promise<GeolocationPosition>((resolve, reject) =>
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: true, timeout: 12000, maximumAge: 0,
      })
    );
    return { lat: position.coords.latitude, lng: position.coords.longitude, accuracy: position.coords.accuracy };
  } catch {
    // An earlier genuine device fix is preferable to no location. Site master
    // coordinates must NEVER be presented as the photo's capture position.
    return fallback ?? null;
  }
}
