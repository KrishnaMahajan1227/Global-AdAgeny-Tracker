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

/** Normalizes evidence to landscape without ever rotating already-oriented pixels. */
export async function ensureLandscape(dataUrl: string): Promise<string> {
  // Installation evidence is ALWAYS stored as a real 4:3 landscape JPEG.
  // Mobile browsers sometimes expose a landscape-held camera as portrait
  // sensor pixels (EXIF/orientation is not reliable after canvas). In that
  // case rotate the pixels 90° BEFORE composing the printable 4:3 frame.
  // For already-landscape images no crop/rotation is performed.
  const img = await loadImage(dataUrl);
  const sw = img.naturalWidth || img.width;
  const sh = img.naturalHeight || img.height;
  if (!sw || !sh) return dataUrl;

  const portraitSensor = sh > sw;
  const orientedW = portraitSensor ? sh : sw;
  const orientedH = portraitSensor ? sw : sh;
  const outW = Math.max(1600, orientedW);
  const outH = Math.round(outW * 3 / 4);
  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d');
  if (!ctx) return dataUrl;

  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, outW, outH);
  const scale = Math.min(outW / orientedW, outH / orientedH);
  const dw = orientedW * scale;
  const dh = orientedH * scale;
  const dx = (outW - dw) / 2;
  const dy = (outH - dh) / 2;

  if (portraitSensor) {
    // Rotate counter-clockwise (-90°) into landscape. Draw around the destination centre so
    // the COMPLETE frame is retained; there is no centre-crop.
    ctx.save();
    ctx.translate(outW / 2, outH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.drawImage(img, -dh / 2, -dw / 2, dh, dw);
    ctx.restore();
  } else {
    ctx.drawImage(img, dx, dy, dw, dh);
  }
  return canvas.toDataURL('image/jpeg', 0.95);
}

export async function stampGeoTag(dataUrl: string, info: GeoStampInfo): Promise<string> {
  const img = await loadImage(dataUrl);
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth || img.width;
  canvas.height = img.naturalHeight || img.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return dataUrl; // Canvas unavailable — ship the unstamped photo rather than fail the upload.
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  // Compact LANDSCAPE proof badge: two horizontal rows in the lower-left,
  // not a tall full-width banner. This keeps the installed work visible and
  // produces a clean printable proof image.
  const site = (info.siteName || 'Site').trim();
  const address = (info.addressLine || '').trim();
  const coords = info.lat != null && info.lng != null
    ? `${info.lat.toFixed(6)}, ${info.lng.toFixed(6)}`
    : 'Location unavailable';
  const when = (info.timestamp || new Date()).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });

  const fontSize = Math.max(18, Math.round(canvas.width * 0.019));
  const smallFont = Math.max(15, Math.round(fontSize * 0.82));
  const padX = Math.round(fontSize * 0.85);
  const padY = Math.round(fontSize * 0.62);
  const gap = Math.round(fontSize * 0.48);
  const badgeW = Math.min(Math.round(canvas.width * 0.62), canvas.width - padX * 2);
  const badgeH = Math.round(fontSize * 2.15 + padY * 2 + gap);
  const bx = Math.round(canvas.width * 0.018);
  const by = canvas.height - badgeH - Math.round(canvas.height * 0.025);

  // Rounded translucent panel.
  const radius = Math.round(fontSize * 0.55);
  ctx.beginPath();
  ctx.roundRect(bx, by, badgeW, badgeH, radius);
  ctx.fillStyle = 'rgba(10, 15, 25, 0.72)';
  ctx.fill();

  const maxTextW = badgeW - padX * 2;
  const fit = (value: string, font: string) => {
    ctx.font = font;
    if (ctx.measureText(value).width <= maxTextW) return value;
    let out = value;
    while (out.length > 3 && ctx.measureText(out + '…').width > maxTextW) out = out.slice(0, -1);
    return out + '…';
  };

  ctx.textBaseline = 'top';
  ctx.fillStyle = '#ffffff';
  const boldFont = `700 ${fontSize}px -apple-system, Segoe UI, Roboto, Arial, sans-serif`;
  const regularFont = `${smallFont}px -apple-system, Segoe UI, Roboto, Arial, sans-serif`;
  const row1 = `SITE: ${site}${address ? `  •  ${address}` : ''}`;
  ctx.font = boldFont;
  ctx.fillText(fit(row1, boldFont), bx + padX, by + padY);

  const row2 = `${coords}  •  ${when}`;
  ctx.font = regularFont;
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.fillText(fit(row2, regularFont), bx + padX, by + padY + fontSize + gap);

  return canvas.toDataURL('image/jpeg', 0.92);
}
