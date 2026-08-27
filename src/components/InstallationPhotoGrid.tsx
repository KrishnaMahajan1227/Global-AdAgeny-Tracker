import { useState } from 'react';
import { ImageOff } from 'lucide-react';

export interface InstallationPhotoRow {
  id: string;
  photo_url: string;
  caption: string | null;
  photo_type: string; // 'before' | 'after' | 'installed'
  angle?: string | null; // 'front' | 'side' | 'other'
}

const GROUP_ORDER: { key: string; label: string }[] = [
  { key: 'before', label: 'Before' },
  { key: 'after', label: 'After' },
  { key: 'installed', label: 'Installed' },
];

// Installation photos grouped by stage (Before / After / Installed —
// matches installation_proofs.photo_type) instead of one flat grid, so a
// client can actually tell which photos are "before work started" vs the
// final installed result, rather than a jumble. Each photo also handles
// its own broken-image state (deleted file, storage hiccup) with a small
// placeholder instead of the browser's default broken-image icon, so a
// real problem is visible rather than silently looking like there are no
// photos at all.
export function InstallationPhotoGrid({ photos }: { photos: InstallationPhotoRow[] }) {
  const [failedIds, setFailedIds] = useState<Record<string, boolean>>({});
  const [lightbox, setLightbox] = useState<string | null>(null);

  if (photos.length === 0) return <p className="text-xs text-slate-400">None uploaded yet.</p>;

  const grouped = GROUP_ORDER.map((g) => ({ ...g, photos: photos.filter((p) => p.photo_type === g.key) })).filter((g) => g.photos.length > 0);
  // Any photo_type this app adds later that isn't in GROUP_ORDER yet still
  // shows up here instead of silently disappearing.
  const knownTypes = new Set(GROUP_ORDER.map((g) => g.key));
  const other = photos.filter((p) => !knownTypes.has(p.photo_type));
  if (other.length > 0) grouped.push({ key: 'other', label: 'Other', photos: other });

  return (
    <div className="space-y-3">
      {grouped.map((group) => (
        <div key={group.key}>
          <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-1.5">{group.label} ({group.photos.length})</p>
          <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
            {group.photos.map((p) => {
              const failed = failedIds[p.id];
              if (failed) {
                return (
                  <div key={p.id} className="rounded-lg overflow-hidden border border-slate-200 bg-slate-50 aspect-square flex flex-col items-center justify-center gap-1 text-slate-300">
                    <ImageOff className="w-5 h-5" />
                    <span className="text-[9px] text-slate-400 text-center px-1">Photo unavailable</span>
                  </div>
                );
              }
              return (
                <button key={p.id} onClick={() => setLightbox(p.photo_url)} className="relative block aspect-square rounded-lg overflow-hidden border border-slate-200 bg-slate-100 text-left">
                  <img
                    src={p.photo_url}
                    alt={p.caption || p.photo_type}
                    className="w-full h-full object-cover"
                    onError={() => setFailedIds((prev) => ({ ...prev, [p.id]: true }))}
                  />
                  {p.angle && p.angle !== 'other' && (
                    <span className="absolute bottom-1 left-1 bg-black/60 text-white text-[9px] font-medium px-1.5 py-0.5 rounded capitalize">
                      {p.angle}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      ))}

      {lightbox && (
        <div onClick={() => setLightbox(null)} className="fixed inset-0 z-[100] bg-black/80 flex items-center justify-center p-4 cursor-zoom-out">
          <img src={lightbox} alt="Installation" className="max-w-full max-h-full rounded-lg" />
        </div>
      )}
    </div>
  );
}
