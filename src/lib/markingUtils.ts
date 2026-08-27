// Shared helpers for turning a set of tapped corner points into an actual
// visible marked image — used by the survey wizard's review step, the shop
// detail page, and the PDF/PPT report generators. Points are stored as
// PERCENTAGES (0-100) of image width/height so they stay correct no matter
// what size the image is later rendered/exported at.

export type MarkPoint = { x: number; y: number };

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // Needed so canvas.toDataURL() doesn't throw for cross-origin Supabase
    // Storage URLs (the buckets are public, so this just enables canvas read).
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

const POLYGON_COLORS = ['#2563eb', '#16a34a', '#d97706', '#db2777', '#7c3aed', '#0891b2'];

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Centroid of a polygon (simple average of its corners — good enough for label placement). */
function centroid(points: MarkPoint[]): MarkPoint {
  const n = points.length;
  const sum = points.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 });
  return { x: sum.x / n, y: sum.y / n };
}

/**
 * Draws the original photo plus marked polygon(s) (filled + outlined,
 * numbered corner dots) onto a canvas and returns it as a JPEG data URL.
 * This is the single source of truth for "what a marked photo looks like" —
 * used both for on-screen preview and for embedding into exports.
 *
 * Accepts either one board's points (`MarkPoint[]`, the common single-board
 * case) or several boards marked on the same photo (`MarkPoint[][]`). Each
 * set is drawn as its own closed, separately-colored polygon with its own
 * corner numbers — they are never merged into a single shape. Merging used
 * to be exactly what broke marking display whenever a photo had more than
 * one board marked on it: corner 4 of board 1 would get connected straight
 * to corner 1 of board 2, drawing one garbled shape instead of two boards.
 *
 * `labels`, if given, is a same-length array of caption strings (e.g. work
 * type + dimensions) drawn as a pill directly over each polygon's centroid
 * — so anyone looking at the photo later can tell at a glance which
 * measurement belongs to which marked area, without cross-referencing a
 * separate list. Pass `null` for a set that shouldn't get a label.
 */
export async function renderMarkedImage(
  photoSrc: string,
  pointsOrSets: MarkPoint[] | MarkPoint[][],
  opts?: { maxDim?: number; labels?: (string | null | undefined)[]; activeIndex?: number }
): Promise<{ dataUrl: string; width: number; height: number }> {
  const img = await loadImage(photoSrc);
  const maxDim = opts?.maxDim || 1600;
  const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
  const width = Math.round(img.naturalWidth * scale);
  const height = Math.round(img.naturalHeight * scale);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0, width, height);

  const pointSets: MarkPoint[][] = Array.isArray(pointsOrSets[0])
    ? (pointsOrSets as MarkPoint[][])
    : [pointsOrSets as MarkPoint[]];
  const labels = opts?.labels;
  // When set, every polygon except this index is drawn faded (fill/stroke
  // alpha reduced, no label) — used by the Design Approval export so a
  // photo with several boards marked on it still reads clearly as "this
  // is the board this slide is about," per Architecture v2.0 §9.5-B.
  // Undefined (the default) keeps every set at full opacity, unchanged
  // from before this option existed.
  const activeIndex = opts?.activeIndex;

  pointSets.forEach((points, setIndex) => {
    if (points.length < 3) return;
    const color = POLYGON_COLORS[setIndex % POLYGON_COLORS.length];
    const isDimmed = activeIndex != null && setIndex !== activeIndex;
    const fillAlpha = isDimmed ? 0.10 : 0.28;
    const strokeAlpha = isDimmed ? 0.35 : 1;

    ctx.beginPath();
    points.forEach((p, i) => {
      const px = (p.x / 100) * width;
      const py = (p.y / 100) * height;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    });
    ctx.closePath();
    ctx.fillStyle = hexToRgba(color, fillAlpha);
    ctx.fill();
    ctx.lineWidth = Math.max(2, width * 0.004);
    ctx.strokeStyle = hexToRgba(color, strokeAlpha);
    ctx.stroke();

    if (isDimmed) return; // no corner dots/numbers/label on dimmed boards

    points.forEach((p, i) => {
      const px = (p.x / 100) * width;
      const py = (p.y / 100) * height;
      const r = Math.max(6, width * 0.012);
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
      ctx.fillStyle = '#ffffff';
      ctx.font = `bold ${Math.max(9, r)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(i + 1), px, py);
    });

    const labelText = labels?.[setIndex];
    if (labelText) {
      const c = centroid(points);
      const cx = (c.x / 100) * width;
      const cy = (c.y / 100) * height;
      const fontSize = Math.max(12, width * 0.02);
      ctx.font = `bold ${fontSize}px sans-serif`;
      const textWidth = ctx.measureText(labelText).width;
      const padX = fontSize * 0.6;
      const padY = fontSize * 0.45;
      const boxW = textWidth + padX * 2;
      const boxH = fontSize + padY * 2;
      const boxX = cx - boxW / 2;
      const boxY = cy - boxH / 2;
      const radius = boxH * 0.25;

      ctx.beginPath();
      ctx.moveTo(boxX + radius, boxY);
      ctx.arcTo(boxX + boxW, boxY, boxX + boxW, boxY + boxH, radius);
      ctx.arcTo(boxX + boxW, boxY + boxH, boxX, boxY + boxH, radius);
      ctx.arcTo(boxX, boxY + boxH, boxX, boxY, radius);
      ctx.arcTo(boxX, boxY, boxX + boxW, boxY, radius);
      ctx.closePath();
      ctx.fillStyle = hexToRgba('#0f172a', 0.82);
      ctx.fill();
      ctx.lineWidth = Math.max(1, width * 0.0015);
      ctx.strokeStyle = color;
      ctx.stroke();

      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(labelText, cx, cy);
    }
  });

  return { dataUrl: canvas.toDataURL('image/jpeg', 0.9), width, height };
}

/**
 * Builds the on-photo caption for a marked board from its work type and
 * measurements — e.g. "Signboard — 4×3 ft" — used consistently everywhere
 * a marking gets a label burned onto the image (survey review, shop
 * detail, installer specs, exports) so the same board always reads the
 * same way no matter where it's viewed.
 */
export function buildBoardLabel(opts: {
  workTypeName?: string | null;
  width?: number | string | null;
  height?: number | string | null;
  unit?: string | null;
}): string | null {
  const w = typeof opts.width === 'string' ? parseFloat(opts.width) : opts.width;
  const h = typeof opts.height === 'string' ? parseFloat(opts.height) : opts.height;
  const dims = w && h ? `${w}×${h} ${opts.unit || 'ft'}` : '';
  const name = (opts.workTypeName || '').trim();
  if (!name && !dims) return null;
  return [name, dims].filter(Boolean).join(' — ');
}

export type MarkingRef = {
  survey_photo_id: string;
  work_item_id: string | null;
  points: MarkPoint[];
  created_at: string;
};

/**
 * Assigns a stable, human-readable marking number to every marking, scoped
 * per photo (Marking #1, #2, ... within that photo — not a global count).
 * This is THE single place that decides "which number is this marking" so
 * the designer's board list, the upload picker, the owner's view, and the
 * PDF/PPT exports never disagree with each other about which numbered
 * marking on a shared photo corresponds to which board/work item.
 *
 * Ordered by created_at (the order the surveyor actually drew them in) so
 * the numbering is deterministic and doesn't shuffle on re-fetch.
 *
 * Returns a Map keyed by work_item_id -> { number, total, photoId }.
 * Markings with no work_item_id or fewer than 3 points (i.e. not a real,
 * saved polygon) are skipped — there's nothing to number them against.
 */
export function numberMarkingsByPhoto<T extends MarkingRef>(
  markings: T[]
): Map<string, { number: number; total: number; photoId: string }> {
  const byPhoto = new Map<string, T[]>();
  for (const m of markings) {
    if (!m.work_item_id || !m.points || m.points.length < 3) continue;
    const list = byPhoto.get(m.survey_photo_id) || [];
    list.push(m);
    byPhoto.set(m.survey_photo_id, list);
  }
  const result = new Map<string, { number: number; total: number; photoId: string }>();
  for (const [photoId, list] of byPhoto) {
    const sorted = list.slice().sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
    sorted.forEach((m, idx) => {
      result.set(m.work_item_id as string, { number: idx + 1, total: sorted.length, photoId });
    });
  }
  return result;
}

/** Fetches any image URL (remote or data URL) and returns it as a data URL — needed because jsPDF/pptxgenjs need base64, not remote URLs. */
export async function toDataUrl(src: string): Promise<string> {
  if (src.startsWith('data:')) return src;
  const res = await fetch(src);
  const blob = await res.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/**
 * Fetches any image (remote URL or data URL) and re-encodes it as a JPEG
 * data URL via canvas. This is what PDF/PPT exports should always use when
 * embedding a photo, because jsPDF/pptxgenjs need the format they're told
 * an image is in to actually match its bytes — a phone photo saved as PNG
 * or WEBP but declared "JPEG" on `addImage` renders corrupted, partially
 * blank, or gets clipped by the reader, which is exactly the "photo looks
 * cut off in the exported PDF" symptom. Normalizing every photo to JPEG
 * here, once, means every export always declares the format it actually
 * used, regardless of what the camera/browser originally saved.
 */
export async function toJpegDataUrl(src: string): Promise<string> {
  const img = await loadImage(src);
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d')!;
  // Fill white first — JPEG has no alpha channel, so a transparent PNG
  // would otherwise composite onto whatever the canvas defaults to (black
  // in most browsers), turning transparent areas into a black block.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0);
  return canvas.toDataURL('image/jpeg', 0.92);
}
