/**
 * Shared GPS proof-photo renderer used by field survey, installation, direct
 * execution, returned evidence and manager-uploaded shop photos.
 *
 * A photograph's GPS must come from its own live device capture, NOT the shop
 * master pin / geocoded postal address. Imported photographs intentionally
 * display an unverified-GPS status; the browser cannot establish where an
 * old gallery image was taken merely by reading the device's current GPS.
 *
 * The small map is made from *actual* OpenStreetMap raster tiles (attribution
 * burned into the image). No synthetic roads or pretend pins are drawn.
 * Tiles are optional: offline/CORS/timeout must never block evidence saving.
 */
import { loadImage } from './markingUtils';

export interface GeoStampInfo {
  siteName?: string | null;
  addressLine?: string | null;
  lat: number | null;
  lng: number | null;
  /** Kept for caller / evidence metadata; not displayed in the compact badge. */
  accuracy?: number | null;
  timestamp?: Date;
  /** 'Imported' for gallery/manager uploads; never claim upload time is capture time. */
  timestampLabel?: 'Captured' | 'Imported';
}

/** The live camera is the only source we can reliably describe as a fresh capture. */
export type PhotoCaptureMeta = { source: 'camera' | 'gallery' | 'native-picker'; capturedAt: Date };

export function verifiedGeoPoint(lat: number | null | undefined, lng: number | null | undefined): boolean {
  return typeof lat === 'number' && typeof lng === 'number'
    && Number.isFinite(lat) && Number.isFinite(lng)
    && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
}

/** Avoid duplicating City/District if the street address already includes them. */
export function formatGeoStampAddress(shop: {
  address?: string | null; village?: string | null; taluka?: string | null;
  city?: string | null; district?: string | null; state?: string | null;
  pincode?: string | null;
} | null | undefined): string {
  if (!shop) return '';
  const output: string[] = [];
  for (const value of [shop.address, shop.village, shop.taluka, shop.city, shop.district, shop.state, shop.pincode]) {
    const cleaned = (value || '').trim();
    if (!cleaned) continue;
    const textSoFar = output.join(', ').toLocaleLowerCase();
    if (textSoFar.includes(cleaned.toLocaleLowerCase())) continue;
    output.push(cleaned);
  }
  return output.join(', ');
}

export function formatGeoStampTimestamp(date: Date): string {
  const safeDate = Number.isFinite(date.getTime()) ? date : new Date();
  return safeDate.toLocaleString('en-IN', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true, timeZoneName: 'shortOffset',
  });
}

/**
 * Keep source pixels in the entire 4:3 landscape frame (no cropping).
 * Do not flip/rotate images that are already oriented as landscape.
 */
export async function ensureLandscape(dataUrl: string): Promise<string> {
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
  if (portraitSensor) {
    ctx.save();
    ctx.translate(outW / 2, outH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.drawImage(img, -dh / 2, -dw / 2, dh, dw);
    ctx.restore();
  } else {
    ctx.drawImage(img, (outW - dw) / 2, (outH - dh) / 2, dw, dh);
  }
  return canvas.toDataURL('image/jpeg', 0.94);
}

function tileImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image();
    let settled = false;
    // Browser cache handles repeated field photos at the same location. Timeout
    // bounds offline delays and tile-provider outages for each capture.
    const timeout = setTimeout(() => finish(null), 2000);
    function finish(result: HTMLImageElement | null) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      image.onload = null;
      image.onerror = null;
      resolve(result);
    }
    image.crossOrigin = 'anonymous';
    image.onload = () => finish(image);
    image.onerror = () => finish(null);
    image.src = url;
  });
}

/**
 * Pre-render an exact, 256x256 GPS-centred view using up to 4 OSM tiles.
 * Return null if ANY tile fails or the canvas is tainted. No fake map.
 */
async function renderRealMap(lat: number, lng: number): Promise<HTMLCanvasElement | null> {
  if (!verifiedGeoPoint(lat, lng)) return null;
  try {
    const z = 15;
    const n = 2 ** z;
    const clampedLat = Math.max(-85.0511, Math.min(85.0511, lat));
    const latitude = clampedLat * Math.PI / 180;
    const px = (lng + 180) / 360 * n * 256;
    const py = (1 - Math.log(Math.tan(latitude) + 1 / Math.cos(latitude)) / Math.PI) / 2 * n * 256;
    const minX = px - 128;
    const minY = py - 128;
    const tileLeft = Math.floor(minX / 256);
    const tileTop = Math.floor(minY / 256);
    const tileRight = Math.floor((minX + 255.999) / 256);
    const tileBottom = Math.floor((minY + 255.999) / 256);
    const tiles: { x: number; y: number; url: string }[] = [];
    for (let y = tileTop; y <= tileBottom; y++) for (let x = tileLeft; x <= tileRight; x++) {
      if (y >= 0 && y < n) tiles.push({ x, y, url: `https://tile.openstreetmap.org/${z}/${((x % n) + n) % n}/${y}.png` });
    }
    if (!tiles.length || tiles.length > 4) return null;
    const images = await Promise.all(tiles.map((t) => tileImage(t.url)));
    if (images.some((img) => !img)) return null;
    const canvas = document.createElement('canvas');
    canvas.width = 256; canvas.height = 256;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = '#e2e8f0'; ctx.fillRect(0, 0, 256, 256);
    tiles.forEach((tile, i) => ctx.drawImage(images[i]!, tile.x * 256 - minX, tile.y * 256 - minY, 256, 256));
    // Pin placed at the *mathematically exact centre*, independent of tile boundaries.
    ctx.beginPath(); ctx.arc(128, 124, 10, 0, Math.PI * 2);
    ctx.fillStyle = '#ef4444'; ctx.fill();
    ctx.lineWidth = 3; ctx.strokeStyle = '#ffffff'; ctx.stroke();
    ctx.beginPath(); ctx.arc(128, 124, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff'; ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.74)'; ctx.fillRect(0, 236, 256, 20);
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.font = '12px sans-serif'; ctx.fillStyle = '#ffffff';
    ctx.fillText('© OpenStreetMap contributors', 7, 246);
    // Reject tainted remote images before copying them into the proof canvas.
    canvas.toDataURL('image/png');
    return canvas;
  } catch {
    return null;
  }
}

/** Layout constants exported for deterministic automated format checks. */
export const GEO_STAMP_LAYOUT_VERSION = 'map-left-text-right-v2';

/**
 * Burns a four-field geotag directly onto evidence so every downstream
 * preview/export displays the same information. Does not mutate the original.
 */
export async function stampGeoTag(dataUrl: string, info: GeoStampInfo): Promise<string> {
  const img = await loadImage(dataUrl);
  const width = img.naturalWidth || img.width;
  const height = img.naturalHeight || img.height;
  if (!width || !height) return dataUrl;
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return dataUrl;
  ctx.drawImage(img, 0, 0, width, height);

  const margin = Math.max(8, Math.round(width * 0.014));
  const padding = Math.max(8, Math.round(width * 0.010));
  // 4:3 photo: lower 27%. Portrait / smaller images get a proportional badge.
  const badgeH = Math.min(Math.round(height * 0.34), Math.max(120, Math.round(height * 0.27)));
  const badgeW = width - margin * 2;
  const bx = margin;
  const by = height - badgeH - margin;
  const mapSize = Math.min(badgeH - padding * 2, Math.round(width * 0.24));
  const mx = bx + padding;
  const my = by + (badgeH - mapSize) / 2;
  const contentX = mx + mapSize + padding * 1.4;
  const contentWidth = Math.max(50, bx + badgeW - padding - contentX);
  const pointValid = verifiedGeoPoint(info.lat, info.lng);
  // Only a live photograph's *captured* coordinates are eligible for a map.
  const map = pointValid ? await renderRealMap(info.lat!, info.lng!) : null;

  ctx.save();
  ctx.beginPath(); ctx.roundRect(bx, by, badgeW, badgeH, Math.max(8, Math.round(width * 0.014)));
  ctx.fillStyle = 'rgba(12, 19, 29, 0.83)'; ctx.fill();
  ctx.beginPath(); ctx.roundRect(mx, my, mapSize, mapSize, Math.max(4, Math.round(padding * 0.5)));
  ctx.fillStyle = '#293847'; ctx.fill(); ctx.clip();
  if (map) {
    ctx.drawImage(map, mx, my, mapSize, mapSize);
  } else {
    // Never fabricate map imagery or a location pin when no verified tile/GPS exists.
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = '#cbd5e1';
    ctx.font = `600 ${Math.max(11, Math.round(mapSize * 0.077))}px sans-serif`;
    ctx.fillText(pointValid ? 'MAP UNAVAILABLE' : 'GPS UNAVAILABLE', mx + mapSize / 2, my + mapSize / 2);
  }
  ctx.restore();

  const name = (info.siteName || '').trim();
  const address = (info.addressLine || '').trim() || 'Address not recorded';
  const coordinates = pointValid
    ? `Lat ${info.lat!.toFixed(6)}°   Long ${info.lng!.toFixed(6)}°`
    : 'GPS location not captured / verified';
  const dateText = `${info.timestampLabel === 'Imported' ? 'Imported' : 'Captured'}: ${formatGeoStampTimestamp(info.timestamp || new Date())}`;

  // Text is always aligned in a single right column; no overlap with map.
  const titleSize = Math.max(12, Math.round(width * 0.024));
  const regularSize = Math.max(10, Math.round(width * 0.018));
  const lineHeight = Math.max(12, Math.round(regularSize * 1.22));
  const titleHeight = Math.round(titleSize * 1.35);
  const fontTitle = `700 ${titleSize}px system-ui, 'Noto Sans Devanagari', Arial, sans-serif`;
  const fontRegular = `${regularSize}px system-ui, 'Noto Sans Devanagari', Arial, sans-serif`;
  const fontMeta = `600 ${regularSize}px system-ui, 'Noto Sans Devanagari', Arial, sans-serif`;
  ctx.textAlign = 'left'; ctx.textBaseline = 'top';

  const shorten = (value: string, font: string): string => {
    ctx.font = font;
    if (ctx.measureText(value).width <= contentWidth) return value;
    let result = value;
    while (result.length && ctx.measureText(result + '…').width > contentWidth) result = result.slice(0, -1);
    return result ? `${result}…` : '…';
  };
  const wrap = (value: string, font: string, maxLines: number): string[] => {
    ctx.font = font;
    const words = value.split(/\s+/).filter(Boolean);
    const rows: string[] = [];
    let pending = '';
    for (const word of words) {
      const proposed = pending ? `${pending} ${word}` : word;
      if (ctx.measureText(proposed).width <= contentWidth) { pending = proposed; continue; }
      if (pending) rows.push(pending);
      pending = word;
      if (rows.length >= maxLines) break;
    }
    if (rows.length < maxLines && pending) rows.push(pending);
    const usedWords = rows.join(' ').split(/\s+/).length;
    const clipped = usedWords < words.length;
    if (clipped && rows.length) rows[rows.length - 1] = shorten(rows[rows.length - 1] + '…', font);
    return rows.map((row) => shorten(row, font));
  };

  // Reserve two metadata rows. Address gets remaining space (up to 3 rows).
  const availableText = badgeH - padding * 2;
  const addressRowsMax = Math.max(1, Math.min(3, Math.floor((availableText - titleHeight - 2 * lineHeight - lineHeight * 0.3) / lineHeight)));
  const addressLines = wrap(address, fontRegular, addressRowsMax);
  const totalHeight = (name ? titleHeight : 0) + addressLines.length * lineHeight + 2 * lineHeight + lineHeight * 0.25;
  let ty = by + Math.max(padding, (badgeH - totalHeight) / 2);
  if (name) {
    ctx.fillStyle = '#ffffff'; ctx.font = fontTitle;
    ctx.fillText(shorten(name, fontTitle), contentX, ty); ty += titleHeight;
  }
  ctx.fillStyle = '#f1f5f9'; ctx.font = fontRegular;
  for (const line of addressLines) { ctx.fillText(line, contentX, ty); ty += lineHeight; }
  ty += lineHeight * 0.25;
  ctx.fillStyle = '#ffffff'; ctx.font = fontMeta;
  ctx.fillText(shorten(coordinates, fontMeta), contentX, ty); ty += lineHeight;
  ctx.font = fontRegular; ctx.fillStyle = '#e2e8f0';
  ctx.fillText(shorten(dateText, fontRegular), contentX, ty);

  return canvas.toDataURL('image/jpeg', 0.92);
}

/** Manager/gallery uploads are stamped without assigning the office's GPS to the image. */
export async function stampImportedShopPhoto(file: File, shop: {
  name?: string | null; address?: string | null; village?: string | null;
  taluka?: string | null; city?: string | null; district?: string | null;
  state?: string | null; pincode?: string | null;
}): Promise<File> {
  const source = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error || new Error('Unable to read photo'));
    reader.readAsDataURL(file);
  });
  const stamped = await stampGeoTag(await ensureLandscape(source), {
    siteName: shop.name, addressLine: formatGeoStampAddress(shop),
    lat: null, lng: null, timestamp: new Date(), timestampLabel: 'Imported',
  });
  const blob = await (await fetch(stamped)).blob();
  return new File([blob], (file.name.replace(/\.[^.]+$/, '') || 'shop-photo') + '-geotag.jpg', { type: 'image/jpeg' });
}
