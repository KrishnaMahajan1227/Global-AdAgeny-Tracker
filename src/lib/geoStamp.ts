// Burns a "GPS Map Camera" style geo-tag stamp directly onto a captured
// photo — site name, address, lat/long, and timestamp, drawn as a
// semi-transparent bar across the bottom of the image itself — for every
// INSTALLATION proof photo in the app (both the normal Survey + Install
// pipeline's InstallationWizard, and the Direct Install flow), so the
// location is part of the photo everywhere it's ever displayed or
// exported (Installation Review, Client Portal, PDF/PPT reports),  not
// just a lat/lng pair sitting in a database column next to it that only
// shows up if a screen happens to render it.
//
// Deliberately NOT used for survey photos, design files, or the vehicle
// material-check photo — this is specifically for "proof the board/wall
// is installed, at this place, at this time", which is what an
// installation proof photo needs to hold up on its own.
import { loadImage } from './markingUtils';

export interface GeoStampInfo {
  /** Shop/site name — first line of the stamp. */
  siteName?: string | null;
  /** Address/city/state, already joined into one line by the caller. */
  addressLine?: string | null;
  lat: number | null;
  lng: number | null;
  accuracy?: number | null;
  /** Defaults to now() — pass the actual capture time if known. */
  timestamp?: Date;
}

/**
 * Draws the geo-tag bar onto a captured photo (data URL in, data URL
 * out) and returns the stamped image. Never throws for a missing GPS fix
 * — it stamps "Location unavailable" instead, since a field photo with no
 * signal is still real proof and shouldn't be blocked from uploading.
 */

/** Rotates portrait evidence into landscape without cropping. */
export async function ensureLandscape(dataUrl: string): Promise<string> {
  const img = await loadImage(dataUrl);
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  if (w >= h) return dataUrl;
  const canvas = document.createElement('canvas');
  canvas.width = h; canvas.height = w;
  const ctx = canvas.getContext('2d');
  if (!ctx) return dataUrl;
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate(Math.PI / 2);
  ctx.drawImage(img, -w / 2, -h / 2, w, h);
  return canvas.toDataURL('image/jpeg', 0.92);
}

export async function stampGeoTag(dataUrl: string, info: GeoStampInfo): Promise<string> {
  const img = await loadImage(dataUrl);
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth || img.width;
  canvas.height = img.naturalHeight || img.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return dataUrl; // Canvas unavailable — ship the unstamped photo rather than fail the upload.
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  const lines: string[] = [];
  if (info.siteName) lines.push(info.siteName);
  if (info.addressLine) lines.push(info.addressLine);
  lines.push(
    info.lat != null && info.lng != null
      ? `Lat ${info.lat.toFixed(6)}, Long ${info.lng.toFixed(6)}${info.accuracy ? ` (±${Math.round(info.accuracy)}m)` : ''}`
      : 'Location unavailable'
  );
  lines.push((info.timestamp || new Date()).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }));

  // Scale everything off the image's own width so the stamp reads
  // correctly whether it's a 720p phone photo or a 4K one.
  const fontSize = Math.max(16, Math.round(canvas.width * 0.024));
  const lineHeight = Math.round(fontSize * 1.35);
  const padding = Math.round(fontSize * 0.7);
  const barHeight = lines.length * lineHeight + padding * 2;

  ctx.fillStyle = 'rgba(0, 0, 0, 0.62)';
  ctx.fillRect(0, canvas.height - barHeight, canvas.width, barHeight);

  ctx.fillStyle = '#ffffff';
  ctx.font = `${fontSize}px -apple-system, Segoe UI, Roboto, Arial, sans-serif`;
  ctx.textBaseline = 'top';
  let y = canvas.height - barHeight + padding;
  const x = padding;
  for (const [i, line] of lines.entries()) {
    // First line (site name) drawn bold + a small pin marker, so the most
    // important line stands out at a glance in a thumbnail grid.
    if (i === 0 && info.siteName) {
      ctx.font = `bold ${fontSize}px -apple-system, Segoe UI, Roboto, Arial, sans-serif`;
      ctx.fillText(`📍 ${line}`, x, y);
      ctx.font = `${fontSize}px -apple-system, Segoe UI, Roboto, Arial, sans-serif`;
    } else {
      ctx.fillText(line, x, y);
    }
    y += lineHeight;
  }

  return canvas.toDataURL('image/jpeg', 0.92);
}
