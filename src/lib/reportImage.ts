/** Evidence loading for document exports. Never silently drop photographic proof. */
import { supabase } from './supabase';
import { isPrivateStorageUrl } from './secureMedia';
import { renderMarkedImage, toJpegDataUrl, type MarkPoint } from './markingUtils';

const blobCache = new Map<string, Promise<string>>();
// Clear all decrypted evidence when a session ends or switches identities.
let lastIdentity: string | null = null;
supabase.auth.onAuthStateChange((_event, session) => {
  const next = session?.user?.id || null;
  if (next !== lastIdentity) { blobCache.clear(); lastIdentity = next; }
});
const STORAGE_PATTERN = /\/storage\/v1\/object\/(?:public|sign|authenticated)\/([^/?#]+)\/([^?#]+)/;

async function toDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error || new Error('Could not read image bytes'));
    reader.readAsDataURL(blob);
  });
}

/** Fetch a storage file as an authenticated Blob if a browser CORS read fails.
 * A public URL that displays in an <img> is not automatically canvas-readable.
 */
export async function loadEvidenceDataUrl(src: string): Promise<string> {
  if (!src) throw new Error('Missing evidence URL');
  // Isolate in-memory proof bytes by authenticated identity: switching account
  // in the same browser must never reuse a prior user's private image cache.
  let cacheKey = src;
  if (isPrivateStorageUrl(src)) {
    const { data: identity, error: authError } = await supabase.auth.getUser();
    if (authError || !identity.user) throw new Error('Sign in to export private evidence');
    cacheKey = `${identity.user.id}:${src}`;
  }
  const cached = blobCache.get(cacheKey);
  if (cached) return cached;
  const p = (async () => {
    if (src.startsWith('data:image/')) return src;
    try {
      const url = new URL(src, window.location.origin);
      const res = await fetch(url.href, { mode: 'cors', credentials: 'omit' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      if (!blob.type.startsWith('image/')) throw new Error('Storage response was not an image');
      return toDataUrl(blob);
    } catch (firstError) {
      const match = src.match(STORAGE_PATTERN);
      if (!match) throw new Error(`Image unavailable: ${src.slice(0, 80)} (${String(firstError)})`);
      const bucket = decodeURIComponent(match[1]);
      const objectPath = match[2].split('/').map(decodeURIComponent).join('/');
      const { data, error } = await supabase.storage.from(bucket).download(objectPath);
      if (error || !data) throw new Error(`Cannot download ${bucket}/${objectPath}: ${error?.message || String(firstError)}`);
      return toDataUrl(data);
    }
  })();
  blobCache.set(cacheKey, p);
  try { return await p; } catch (error) { blobCache.delete(cacheKey); throw error; }
}

export type EvidenceMark = { points: MarkPoint[]; label: string };
export interface PreparedEvidence { dataUrl: string; width: number; height: number }

/** Compose once per original photo. Multi-board polygons remain on the SAME image. */
export async function prepareEvidenceImage(src: string, marks: EvidenceMark[] = []): Promise<PreparedEvidence> {
  const dataUrl = await loadEvidenceDataUrl(src);
  const valid = marks.filter(mark => Array.isArray(mark.points) && mark.points.length >= 3);
  if (valid.length) {
    return renderMarkedImage(dataUrl, valid.map(mark => mark.points), {
      labels: valid.map(mark => mark.label), maxDim: 1800,
    });
  }
  const jpeg = await toJpegDataUrl(dataUrl);
  // Also limit unmarked evidence to print-friendly dimensions; huge phone
  // photos otherwise make browser PDF/PPT/Excel generation run out of memory.
  return renderMarkedImage(jpeg, [], { maxDim: 1800 });
}
