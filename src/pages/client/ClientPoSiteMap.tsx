import { useEffect, useMemo, useRef, useState } from 'react';
import { MarkerClusterer } from '@googlemaps/markerclusterer';
import { Card, EmptyState } from '@/components/ui';
import { loadGoogleMaps } from '@/lib/googleMapsLoader';
import { STATUS_LABELS } from '@/lib/types';
import { mapPinBucket, MAP_PIN_COLORS, MAP_PIN_LABELS, MapPinBucket } from '@/lib/clientPortal';
import { AlertCircle, MapPin, X, Image as ImageIcon, Loader2 } from 'lucide-react';
import { supabase } from '@/lib/supabase';

type MapShop = {
  id: string; name: string; address: string | null; city: string | null; state: string | null;
  status: string; latitude: number | null; longitude: number | null;
};
type PhotoRow = { id: string; photo_url: string; caption: string | null; photo_type: string };

// Client portal — per-PO site map. Was previously a single cross-agency
// "Map Feed" top-level nav item (ClientMapFeedPage.tsx); moved to live
// scoped inside each PO's own detail page instead, on request — a client
// wants "where are the sites on THIS campaign", not a mixed-agency map by
// default. No agency filter here since a PO only ever has one agency.
export function ClientPoSiteMap({ shops }: { shops: MapShop[] }) {
  const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY || '';
  const mapContainerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- window.google has no real typings in this project (see google-maps.d.ts)
  const mapRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- window.google has no real typings in this project (see google-maps.d.ts)
  const markersRef = useRef<any[]>([]);
  const clustererRef = useRef<MarkerClusterer | null>(null);
  const [mapLoaded, setMapLoaded] = useState(false);
  const [selectedShopId, setSelectedShopId] = useState<string | null>(null);

  useEffect(() => {
    if (!apiKey) return;
    loadGoogleMaps().then(() => setMapLoaded(true)).catch(() => setMapLoaded(false));
  }, [apiKey]);

  const geoShops = useMemo(() => shops.filter((s) => s.latitude != null && s.longitude != null), [shops]);
  const selectedShop = geoShops.find((s) => s.id === selectedShopId) || null;

  const { data: selectedPhotos, isLoading: photosLoading } = useQueryShopPhotos(selectedShopId);

  useEffect(() => {
    if (!mapLoaded || !mapContainerRef.current || mapRef.current) return;
    mapRef.current = new window.google.maps.Map(mapContainerRef.current, {
      zoom: 11,
      center: { lat: 19.076, lng: 72.8777 },
      streetViewControl: false,
    });
  }, [mapLoaded]);

  useEffect(() => {
    if (!mapLoaded || !mapRef.current) return;
    const map = mapRef.current;

    clustererRef.current?.clearMarkers();
    markersRef.current.forEach((m) => m.setMap(null));
    markersRef.current = [];

    const bounds = new window.google.maps.LatLngBounds();
    const newMarkers = geoShops.map((s) => {
      const bucket = mapPinBucket(s.status);
      const position = { lat: s.latitude as number, lng: s.longitude as number };
      bounds.extend(position);
      const marker = new window.google.maps.Marker({
        position,
        icon: {
          path: window.google.maps.SymbolPath.CIRCLE,
          scale: 9,
          fillColor: MAP_PIN_COLORS[bucket],
          fillOpacity: 1,
          strokeColor: '#ffffff',
          strokeWeight: 2,
        },
        title: s.name,
      });
      marker.addListener('click', () => setSelectedShopId(s.id));
      return marker;
    });

    markersRef.current = newMarkers;
    clustererRef.current = new MarkerClusterer({ map, markers: newMarkers });
    if (!bounds.isEmpty()) map.fitBounds(bounds, 60);
  }, [mapLoaded, geoShops]);

  const legendItems: MapPinBucket[] = ['pending', 'in_progress', 'completed', 'issue'];

  if (!apiKey) {
    return (
      <Card className="p-6">
        <div className="flex items-center gap-3 text-amber-600 mb-2">
          <AlertCircle className="w-5 h-5" />
          <p className="font-medium">Map isn't configured</p>
        </div>
        <p className="text-sm text-slate-500">Ask your agency to configure the map for this platform.</p>
      </Card>
    );
  }

  return (
    <div className="flex flex-col sm:flex-row gap-4">
      <div className="sm:w-48 shrink-0">
        <Card className="p-3">
          <p className="text-xs font-medium text-slate-500 mb-2">Legend</p>
          <div className="space-y-1.5">
            {legendItems.map((b) => (
              <div key={b} className="flex items-center gap-2 text-sm text-slate-600">
                <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: MAP_PIN_COLORS[b] }} />
                {MAP_PIN_LABELS[b]}
              </div>
            ))}
          </div>
          <p className="text-xs text-slate-400 pt-2 mt-2 border-t border-slate-100">{geoShops.length} of {shops.length} sites plotted</p>
        </Card>
      </div>

      <div className="flex-1 min-w-0 relative">
        <Card className="overflow-hidden">
          <div ref={mapContainerRef} className="w-full" style={{ height: 420 }} />
          {!mapLoaded && (
            <div className="absolute inset-0 flex items-center justify-center bg-white/60">
              <Loader2 className="w-6 h-6 text-blue-600 animate-spin" />
            </div>
          )}
          {mapLoaded && geoShops.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center bg-white/80">
              <EmptyState icon={<MapPin className="w-10 h-10" />} title="No sites with a location match these filters" />
            </div>
          )}
        </Card>

        {selectedShop && (
          <div className="absolute top-3 right-3 w-72 max-w-[calc(100%-1.5rem)] z-10">
            <Card className="p-4 shadow-lg">
              <div className="flex items-start justify-between gap-2 mb-2">
                <h3 className="font-semibold text-slate-900 leading-tight text-sm">{selectedShop.name}</h3>
                <button onClick={() => setSelectedShopId(null)} className="text-slate-400 hover:text-slate-600 shrink-0">
                  <X className="w-4 h-4" />
                </button>
              </div>
              {(selectedShop.address || selectedShop.city) && (
                <p className="text-xs text-slate-500 flex items-start gap-1 mb-3">
                  <MapPin className="w-3 h-3 mt-0.5 shrink-0" /> {[selectedShop.address, selectedShop.city, selectedShop.state].filter(Boolean).join(', ')}
                </p>
              )}
              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium mb-3" style={{ backgroundColor: `${MAP_PIN_COLORS[mapPinBucket(selectedShop.status)]}1a`, color: MAP_PIN_COLORS[mapPinBucket(selectedShop.status)] }}>
                {STATUS_LABELS[selectedShop.status] || selectedShop.status}
              </span>
              <div>
                <p className="text-xs font-medium text-slate-500 flex items-center gap-1 mb-1.5"><ImageIcon className="w-3.5 h-3.5" /> Photos</p>
                {photosLoading ? (
                  <div className="flex items-center gap-2 text-xs text-slate-400 py-2"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading...</div>
                ) : (
                  <div className="grid grid-cols-4 gap-1.5">
                    {[...(selectedPhotos?.survey || []), ...(selectedPhotos?.installation || [])].slice(0, 8).map((p) => (
                      <a key={p.id} href={p.photo_url} target="_blank" rel="noopener noreferrer" className="block aspect-square rounded overflow-hidden bg-slate-100">
                        <img src={p.photo_url} alt={p.caption || p.photo_type} className="w-full h-full object-cover" />
                      </a>
                    ))}
                    {!photosLoading && (selectedPhotos?.survey.length || 0) + (selectedPhotos?.installation.length || 0) === 0 && (
                      <p className="col-span-4 text-xs text-slate-400 py-2">No photos uploaded yet.</p>
                    )}
                  </div>
                )}
              </div>
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}

// Small local hook (not @tanstack/react-query's top-level import duplication
// concern — this file already needs the same lazy per-shop photo fetch
// ClientMapFeedPage.tsx used) kept inline since it's only used here.
function useQueryShopPhotos(shopId: string | null) {
  const [data, setData] = useState<{ survey: PhotoRow[]; installation: PhotoRow[] } | undefined>(undefined);
  const [isLoading, setIsLoading] = useState(false);
  useEffect(() => {
    if (!shopId) { setData(undefined); return; }
    setIsLoading(true);
    Promise.all([
      supabase.from('survey_photos').select('id, photo_url, caption, photo_type').eq('shop_id', shopId).limit(4),
      supabase.from('installation_proofs').select('id, photo_url, caption, photo_type').eq('shop_id', shopId).limit(4),
    ]).then(([surveyRes, installRes]) => {
      setData({ survey: (surveyRes.data || []) as PhotoRow[], installation: (installRes.data || []) as PhotoRow[] });
      setIsLoading(false);
    });
  }, [shopId]);
  return { data, isLoading };
}
