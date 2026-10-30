import { useEffect, useState } from 'react';
import { ImageIcon } from 'lucide-react';
import { renderMarkedImage, type MarkPoint } from '@/lib/markingUtils';

// Small in-memory cache so re-rendering the same board's marking (e.g. once
// in the collapsed board list, once again inside the upload picker) never
// re-runs the canvas draw twice in the same session.
const cache = new Map<string, string>();

/**
 * A designer must be able to see exactly which surveyed area — polygon and
 * all — a board's size comes from before they design it, not just a plain
 * unmarked survey photo. This renders the *single* marking that belongs to
 * one board, burned onto the photo (via markingUtils' shared canvas
 * renderer), so it reads as "this exact outline, this exact size" rather
 * than a generic shop photo the designer has to guess at.
 *
 * The plain photo is the base layer and renders the instant `photoUrl` is
 * available — it never waits on the canvas step. The outlined/labeled
 * version is computed in the background and swapped in once ready, which
 * is what makes this reliable: if the canvas render is slow (large photo),
 * blocked (a storage bucket without permissive CORS, which breaks
 * `crossOrigin="anonymous"` canvas reads specifically, not plain <img>
 * display), or fails outright, the designer still sees a real photo
 * immediately instead of a spinner that can hang indefinitely. The only
 * case this ever shows a placeholder icon is a genuinely broken photo URL
 * (the <img> itself fails to load).
 */
export function DesignMarkingPreview({
  photoUrl,
  points,
  label,
  className = 'w-16 h-16',
  onClick,
}: {
  photoUrl: string | null | undefined;
  points: MarkPoint[] | null | undefined;
  label?: string | null;
  className?: string;
  onClick?: (src: string) => void;
}) {
  const hasMarking = !!photoUrl && !!points && points.length >= 3;
  const key = hasMarking ? `${photoUrl}::${JSON.stringify(points)}::${label || ''}` : null;
  const [markedImage, setMarkedImage] = useState<{ key: string; src: string } | null>(
    key && cache.has(key) ? { key, src: cache.get(key)! } : null
  );
  const [photoFailed, setPhotoFailed] = useState(false);

  useEffect(() => {
    setPhotoFailed(false);
  }, [photoUrl]);

  useEffect(() => {
    let cancelled = false;
    if (!key || !photoUrl || !points) return;
    const hit = cache.get(key);
    if (hit) {
      setMarkedImage({ key, src: hit });
      return;
    }
    renderMarkedImage(photoUrl, points, { labels: [label], maxDim: 350 })
      .then(({ dataUrl }) => {
        if (cancelled) return;
        // Bound memory usage in a 100+ shop session. The current thumbnail
        // remains rendered even if its cached data is later evicted.
        if (cache.size >= 120) cache.delete(cache.keys().next().value!);
        cache.set(key, dataUrl);
        setMarkedImage({ key, src: dataUrl });
      })
      .catch(() => {
        // Canvas render failed (slow/blocked/CORS) — the plain photo is
        // already showing below, so there's nothing more to do here.
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Prefer the outlined version once it's ready; otherwise show the raw
  // photo right away rather than waiting.
  // When switching shops, never flash the previous shop's marked image.
  const shown = (hasMarking && markedImage?.key === key ? markedImage.src : null) || photoUrl || null;

  if (!shown || photoFailed) {
    return (
      <div className={`shrink-0 rounded-lg bg-slate-100 border border-slate-200 flex items-center justify-center ${className}`}>
        <ImageIcon className="w-4 h-4 text-slate-300" />
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => onClick?.(shown)}
      className={`shrink-0 rounded-lg overflow-hidden border border-slate-200 bg-slate-100 ${className} ${onClick ? 'cursor-zoom-in' : 'cursor-default'}`}
    >
      <img src={shown} alt={label || 'Survey marking'} onError={() => setPhotoFailed(true)} className="w-full h-full object-cover" />
    </button>
  );
}
