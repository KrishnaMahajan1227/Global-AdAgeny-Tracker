import { useEffect, useState } from 'react';
import { renderMarkedImage, buildBoardLabel } from '@/lib/markingUtils';
import type { SurveyPhoto, BoardMarking, WorkItem } from '@/lib/types';
import { ImageOff, Loader2 } from 'lucide-react';

// Renders survey photos with their board polygon(s) drawn on top, falling
// back to the plain photo for any photo that has no marking yet. Same
// canvas-based approach (and same visual result) as the agency side's own
// ShopsPages.tsx — pulled out here so the client portal shows the actual
// marked-up photo too, instead of a plain, unannotated one.
//
// IMPORTANT: each photo's marked-image render runs as its OWN independent
// async task, updating state as soon as THAT photo finishes — not a
// sequential for-loop that awaits one photo fully before starting the
// next. The old sequential version meant a single slow/hanging photo (a
// large image, a slow network) blocked every photo after it from even
// starting, which is exactly what "some photos in a multi-photo shop
// never show as marked" looks like from the outside. Now every photo's
// render kicks off immediately and independently, so one slow/failed
// photo can never hold up or hide the others.
//
// Three failure modes this component handles explicitly instead of leaving
// a mysterious blank/broken tile:
// 1. The photo URL itself fails to load (deleted file, storage/network
//    issue) — shows a small "Photo unavailable" placeholder instead of
//    the browser's default broken-image icon.
// 2. Markings exist for a photo but haven't finished rendering onto the
//    canvas yet — shows a brief loading spinner over the plain photo
//    instead of silently looking unmarked while the async render runs.
// 3. The marked-render itself fails or never settles (a CORS hiccup, a
//    slow/broken network loading the source image onto canvas, etc). This
//    used to leave the tile stuck under the loading spinner FOREVER —
//    `renderedById[photo.id]` never got set, so `hasPendingMark` (which
//    is only false once that id IS set) stayed true forever, even though
//    the plain photo underneath had loaded fine. Concretely: a shop with
//    2+ survey photos where one of them fails to render would show that
//    ONE tile permanently spinning while the rest displayed normally —
//    exactly "second photo doesn't show" from the outside. Fixed by
//    tracking failed/timed-out renders explicitly and having
//    `hasPendingMark` treat them the same as "done" (i.e. fall back to
//    the plain photo instead of spinning forever). A 12s per-photo
//    timeout guards the "never settles at all" case (promise neither
//    resolves nor rejects), on top of the existing `.catch`.
export function MarkedPhotoGrid({ photos, markings, workItems }: { photos: SurveyPhoto[]; markings: BoardMarking[]; workItems: WorkItem[] }) {
  const [renderedById, setRenderedById] = useState<Record<string, string>>({});
  const [failedIds, setFailedIds] = useState<Record<string, boolean>>({});
  const [renderFailedIds, setRenderFailedIds] = useState<Record<string, boolean>>({});
  const [lightbox, setLightbox] = useState<string | null>(null);

  const markingsByPhotoId = new Map<string, BoardMarking[]>();
  for (const m of markings) {
    const list = markingsByPhotoId.get(m.survey_photo_id) || [];
    list.push(m);
    markingsByPhotoId.set(m.survey_photo_id, list);
  }

  useEffect(() => {
    let cancelled = false;
    setRenderedById({});
    setFailedIds({});
    setRenderFailedIds({});

    // Fire off every photo's marked-render independently (Promise per
    // photo, not one shared await chain) and apply each result to state
    // the moment it's ready — a photo that renders in 200ms shows its
    // marks in 200ms even if another photo in the same shop takes 5s or
    // times out entirely.
    photos.forEach((photo) => {
      const photoMarkings = markingsByPhotoId.get(photo.id) || [];
      const allPoints = photoMarkings.map((m) => m.points);
      if (!allPoints.some((set) => set.length >= 3) || !photo.photo_url) return;

      const labels = photoMarkings.map((m) => boardLabelFor(m.work_item_id));

      // Race the actual render against a fixed timeout so a photo whose
      // render neither resolves nor rejects (a hung network request) can
      // still fall back instead of spinning forever — same outcome as an
      // explicit failure below.
      const timeout = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('marked-render timed out')), 12000);
      });

      Promise.race([renderMarkedImage(photo.photo_url, allPoints, { labels }), timeout])
        .then(({ dataUrl }) => {
          if (cancelled) return;
          setRenderedById((prev) => ({ ...prev, [photo.id]: dataUrl }));
        })
        .catch(() => {
          // Marking render failed (or timed out) for THIS photo only
          // (e.g. a CORS/network hiccup loading the source image onto
          // canvas) — every other photo's render is unaffected. Mark it
          // so the tile below actually falls back to the plain photo
          // instead of showing a loading spinner that never goes away.
          if (cancelled) return;
          setRenderFailedIds((prev) => ({ ...prev, [photo.id]: true }));
        });
    });

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photos, markings]);

  function workItemLabel(workItemId: string | null) {
    if (!workItemId) return null;
    return workItems.find((w) => w.id === workItemId)?.work_type_name || null;
  }
  function boardLabelFor(workItemId: string | null) {
    if (!workItemId) return null;
    const item = workItems.find((w) => w.id === workItemId);
    if (!item) return null;
    return buildBoardLabel({ workTypeName: item.work_type_name, width: item.survey_width, height: item.survey_height, unit: item.survey_unit });
  }

  if (photos.length === 0) return <p className="text-xs text-slate-400">None uploaded yet.</p>;

  return (
    <div>
      <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
        {photos.map((photo) => {
          const photoMarkings = markingsByPhotoId.get(photo.id) || [];
          const hasPendingMark = photoMarkings.some((m) => m.points.length >= 3) && !renderedById[photo.id] && !renderFailedIds[photo.id];
          const src = renderedById[photo.id] || photo.photo_url;
          const label = photoMarkings.map((m) => workItemLabel(m.work_item_id)).filter(Boolean).join(', ');
          const failed = failedIds[photo.id];
          // A photo whose marked-render failed still has real markings
          // (photoMarkings.length > 0), but since we're showing the plain
          // photo for it, it should read as "unmarked" here — not tagged
          // "Marked" while visually showing no outline.
          const markedBadge = renderedById[photo.id] != null;

          if (failed) {
            return (
              <div key={photo.id} className="rounded-lg overflow-hidden border border-slate-200 bg-slate-50 aspect-square flex flex-col items-center justify-center gap-1 text-slate-300">
                <ImageOff className="w-5 h-5" />
                <span className="text-[9px] text-slate-400 text-center px-1">Photo unavailable</span>
              </div>
            );
          }

          return (
            <button key={photo.id} onClick={() => setLightbox(src)} className="text-left">
              <div className="relative rounded-lg overflow-hidden border border-slate-200 bg-slate-100">
                <img
                  src={src}
                  alt="Survey"
                  className="w-full aspect-square object-cover"
                  onError={() => setFailedIds((prev) => ({ ...prev, [photo.id]: true }))}
                />
                {hasPendingMark && (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/20">
                    <Loader2 className="w-4 h-4 text-white animate-spin" />
                  </div>
                )}
                {markedBadge && !hasPendingMark && (
                  <span className="absolute top-1 right-1 bg-blue-600 text-white text-[9px] font-medium px-1.5 py-0.5 rounded">
                    Marked
                  </span>
                )}
              </div>
              {label && <p className="text-[10px] text-slate-500 mt-1 truncate">{label}</p>}
            </button>
          );
        })}
      </div>

      {lightbox && (
        <div onClick={() => setLightbox(null)} className="fixed inset-0 z-[100] bg-black/80 flex items-center justify-center p-4 cursor-zoom-out">
          <img src={lightbox} alt="Marked board" className="max-w-full max-h-full rounded-lg" />
        </div>
      )}
    </div>
  );
}
