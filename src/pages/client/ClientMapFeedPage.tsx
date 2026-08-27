import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { MarkerClusterer } from '@googlemaps/markerclusterer';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { Card, EmptyState, PageHeader } from '@/components/ui';
import { loadGoogleMaps } from '@/lib/googleMapsLoader';
import { STATUS_LABELS, type PurchaseOrder } from '@/lib/types';
import {
  mapPinBucket, MAP_PIN_COLORS, MAP_PIN_LABELS, MapPinBucket,
} from '@/lib/clientPortal';
import {
  AlertCircle, MapPin, Search, X, Building2, ShoppingCart, Image as ImageIcon, ImageOff, Loader2,
} from 'lucide-react';

type PoRow = PurchaseOrder & { agency_org: { name: string } | null };
type ShopRow = {
  id: string; name: string; address: string | null; city: string | null; state: string | null;
  status: string; purchase_order_id: string | null; latitude: number | null; longitude: number | null;
};
type PhotoRow = { id: string; photo_url: string; caption: string | null; photo_type: string };

// Doc section 4.4 — Map Feed. All of a client's sites, across every linked
// agency, on one map: color-coded pins (grey/yellow/green/red per
// mapPinBucket), clustering when zoomed out, a side filter panel (Agency /
// Status / City — Work Type and Date Range are deferred, see comment
// below), and a click-through popup with site/agency/PO info, current
// stage, and before/after photos. Billing status was removed from this
// popup — a Client Organization user never sees payment data anywhere in
// this portal. Route/heat view is explicitly "optional" in the doc and is
// skipped for now.
//
// Work Type filtering is deferred: a shop can carry several work_items of
// different work types at once (foam sheet + pole, say), so "this site's
// work type" isn't a single value the way status/city are — doing it
// properly needs a per-site work-type rollup, which is a reasonable next
// increment rather than something to rush into this pass.
export default function ClientMapFeedPage() {
  const { profile } = useAuth();
  const orgId = profile?.organization_id;
  const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY || '';
  const mapContainerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- window.google has no real typings in this project (see google-maps.d.ts), same as FieldMapPage.tsx
  const mapRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- window.google has no real typings in this project (see google-maps.d.ts), same as FieldMapPage.tsx
  const markersRef = useRef<any[]>([]);
  const clustererRef = useRef<MarkerClusterer | null>(null);
  const [mapLoaded, setMapLoaded] = useState(false);

  const [search, setSearch] = useState('');
  const [agencyFilter, setAgencyFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<MapPinBucket | ''>('');
  const [cityFilter, setCityFilter] = useState('');
  const [selectedShopId, setSelectedShopId] = useState<string | null>(null);
  const [failedPhotoIds, setFailedPhotoIds] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!apiKey) return;
    loadGoogleMaps().then(() => setMapLoaded(true)).catch(() => setMapLoaded(false));
  }, [apiKey]);

  const { data: pos } = useQuery({
    queryKey: ['client-map-pos', orgId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('purchase_orders')
        .select('*, agency_org:organizations!purchase_orders_assigned_agency_id_fkey(name)')
        .eq('client_org_id', orgId);
      if (error) throw error;
      return data as PoRow[];
    },
    enabled: !!orgId,
    refetchInterval: 30000,
  });

  const { data: shops, isLoading: shopsLoading } = useQuery({
    queryKey: ['client-map-shops', orgId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('shops')
        .select('id, name, address, city, state, status, purchase_order_id, latitude, longitude')
        .not('latitude', 'is', null)
        .not('longitude', 'is', null);
      if (error) throw error;
      return data as ShopRow[];
    },
    enabled: !!orgId,
    refetchInterval: 30000,
  });

  const { data: selectedPhotos, isLoading: photosLoading } = useQuery({
    queryKey: ['client-map-shop-photos', selectedShopId],
    queryFn: async () => {
      const [surveyRes, installRes] = await Promise.all([
        supabase.from('survey_photos').select('id, photo_url, caption, photo_type').eq('shop_id', selectedShopId).limit(4),
        supabase.from('installation_proofs').select('id, photo_url, caption, photo_type').eq('shop_id', selectedShopId).limit(4),
      ]);
      return {
        survey: (surveyRes.data || []) as PhotoRow[],
        installation: (installRes.data || []) as PhotoRow[],
      };
    },
    enabled: !!selectedShopId,
  });

  const poById = useMemo(() => new Map((pos || []).map((p) => [p.id, p])), [pos]);

  const agencyOptions = useMemo(
    () => Array.from(new Map((pos || []).filter((p) => p.assigned_agency_id).map((p) => [p.assigned_agency_id as string, p.agency_org?.name || 'Agency'])).entries()),
    [pos]
  );
  const cityOptions = useMemo(
    () => Array.from(new Set((shops || []).map((s) => s.city).filter(Boolean))) as string[],
    [shops]
  );

  const filteredShops = useMemo(() => {
    return (shops || []).filter((s) => {
      if (search && !s.name.toLowerCase().includes(search.toLowerCase())) return false;
      if (cityFilter && s.city !== cityFilter) return false;
      const po = s.purchase_order_id ? poById.get(s.purchase_order_id) : null;
      if (agencyFilter && po?.assigned_agency_id !== agencyFilter) return false;
      if (statusFilter && mapPinBucket(s.status) !== statusFilter) return false;
      return true;
    });
  }, [shops, search, cityFilter, agencyFilter, statusFilter, poById]);

  const selectedShop = filteredShops.find((s) => s.id === selectedShopId) || (shops || []).find((s) => s.id === selectedShopId) || null;
  const selectedPo = selectedShop?.purchase_order_id ? poById.get(selectedShop.purchase_order_id) : null;

  // Initialize the map once
  useEffect(() => {
    if (!mapLoaded || !mapContainerRef.current || mapRef.current) return;
    mapRef.current = new window.google.maps.Map(mapContainerRef.current, {
      zoom: 11,
      center: { lat: 19.076, lng: 72.8777 },
      streetViewControl: false,
    });
  }, [mapLoaded]);

  // Rebuild pins whenever the filtered set changes
  useEffect(() => {
    if (!mapLoaded || !mapRef.current) return;
    const map = mapRef.current;

    clustererRef.current?.clearMarkers();
    markersRef.current.forEach((m) => m.setMap(null));
    markersRef.current = [];

    const bounds = new window.google.maps.LatLngBounds();
    const newMarkers = filteredShops
      .filter((s) => s.latitude != null && s.longitude != null)
      .map((s) => {
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

    if (!bounds.isEmpty()) {
      map.fitBounds(bounds, 60);
    }
  }, [mapLoaded, filteredShops]);

  const legendItems: MapPinBucket[] = ['pending', 'in_progress', 'completed', 'issue'];

  return (
    <div>
      <PageHeader title="Map Feed" subtitle="Every site across your linked agencies, on one map" />

      <div className="flex flex-col lg:flex-row gap-4">
        <div className="lg:w-72 shrink-0 space-y-4">
          <Card className="p-4 space-y-3">
            <div className="relative">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search site name..."
                className="w-full pl-9 pr-3 py-2 border border-slate-300 rounded-lg text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <select value={agencyFilter} onChange={(e) => setAgencyFilter(e.target.value)} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500">
              <option value="">All Agencies</option>
              {agencyOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </select>
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as MapPinBucket | '')} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500">
              <option value="">All Statuses</option>
              {legendItems.map((b) => <option key={b} value={b}>{MAP_PIN_LABELS[b]}</option>)}
            </select>
            <select value={cityFilter} onChange={(e) => setCityFilter(e.target.value)} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500">
              <option value="">All Cities</option>
              {cityOptions.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            {(search || agencyFilter || statusFilter || cityFilter) && (
              <button onClick={() => { setSearch(''); setAgencyFilter(''); setStatusFilter(''); setCityFilter(''); }} className="text-sm text-slate-500 hover:text-slate-700 flex items-center gap-1">
                <X className="w-3.5 h-3.5" /> Clear filters
              </button>
            )}
            <p className="text-xs text-slate-400 pt-1 border-t border-slate-100">{filteredShops.length} of {(shops || []).length} sites shown</p>
          </Card>

          <Card className="p-4">
            <p className="text-xs font-medium text-slate-500 mb-2">Legend</p>
            <div className="space-y-1.5">
              {legendItems.map((b) => (
                <div key={b} className="flex items-center gap-2 text-sm text-slate-600">
                  <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: MAP_PIN_COLORS[b] }} />
                  {MAP_PIN_LABELS[b]}
                </div>
              ))}
            </div>
          </Card>
        </div>

        <div className="flex-1 min-w-0 relative">
          {!apiKey ? (
            <Card className="p-6">
              <div className="flex items-center gap-3 text-amber-600 mb-2">
                <AlertCircle className="w-5 h-5" />
                <p className="font-medium">Map isn't configured</p>
              </div>
              <p className="text-sm text-slate-500">Ask your agency to configure the map for this platform.</p>
            </Card>
          ) : (
            <Card className="overflow-hidden">
              <div ref={mapContainerRef} className="w-full" style={{ height: 'calc(100vh - 230px)', minHeight: 440 }} />
              {!mapLoaded && (
                <div className="absolute inset-0 flex items-center justify-center bg-white/60">
                  <Loader2 className="w-6 h-6 text-blue-600 animate-spin" />
                </div>
              )}
              {mapLoaded && !shopsLoading && filteredShops.length === 0 && (
                <div className="absolute inset-0 flex items-center justify-center bg-white/80">
                  <EmptyState icon={<MapPin className="w-10 h-10" />} title="No sites match these filters" />
                </div>
              )}
            </Card>
          )}

          {/* Site detail popup — overlays the map, doc section 4.4's "click pin -> popup card" */}
          {selectedShop && (
            <div className="absolute top-3 right-3 w-80 max-w-[calc(100%-1.5rem)] z-10">
              <Card className="p-4 shadow-lg">
                <div className="flex items-start justify-between gap-2 mb-2">
                  <h3 className="font-semibold text-slate-900 leading-tight">{selectedShop.name}</h3>
                  <button onClick={() => setSelectedShopId(null)} className="text-slate-400 hover:text-slate-600 shrink-0">
                    <X className="w-4 h-4" />
                  </button>
                </div>
                {(selectedShop.address || selectedShop.city) && (
                  <p className="text-xs text-slate-500 flex items-start gap-1 mb-3">
                    <MapPin className="w-3 h-3 mt-0.5 shrink-0" /> {[selectedShop.address, selectedShop.city, selectedShop.state].filter(Boolean).join(', ')}
                  </p>
                )}

                <div className="space-y-1.5 text-xs mb-3">
                  {selectedPo && (
                    <div className="flex items-center gap-1.5 text-slate-600">
                      <Building2 className="w-3.5 h-3.5 text-slate-400" /> {selectedPo.agency_org?.name || 'Agency'}
                    </div>
                  )}
                  {selectedPo && (
                    <div className="flex items-center gap-1.5 text-slate-600">
                      <ShoppingCart className="w-3.5 h-3.5 text-slate-400" /> {selectedPo.name ? `${selectedPo.name} (${selectedPo.po_number})` : `PO ${selectedPo.po_number}`}
                    </div>
                  )}
                </div>

                <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium mb-3`} style={{ backgroundColor: `${MAP_PIN_COLORS[mapPinBucket(selectedShop.status)]}1a`, color: MAP_PIN_COLORS[mapPinBucket(selectedShop.status)] }}>
                  {STATUS_LABELS[selectedShop.status] || selectedShop.status}
                </span>

                <div>
                  <p className="text-xs font-medium text-slate-500 flex items-center gap-1 mb-1.5"><ImageIcon className="w-3.5 h-3.5" /> Photos</p>
                  {photosLoading ? (
                    <div className="flex items-center gap-2 text-xs text-slate-400 py-2"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading...</div>
                  ) : (
                    <div className="grid grid-cols-4 gap-1.5">
                      {[...(selectedPhotos?.survey || []), ...(selectedPhotos?.installation || [])].slice(0, 8).map((p) =>
                        failedPhotoIds[p.id] ? (
                          <div key={p.id} className="aspect-square rounded bg-slate-50 border border-slate-100 flex items-center justify-center">
                            <ImageOff className="w-3.5 h-3.5 text-slate-300" />
                          </div>
                        ) : (
                          <a key={p.id} href={p.photo_url} target="_blank" rel="noopener noreferrer" className="block aspect-square rounded overflow-hidden bg-slate-100">
                            <img
                              src={p.photo_url}
                              alt={p.caption || p.photo_type}
                              className="w-full h-full object-cover"
                              onError={() => setFailedPhotoIds((prev) => ({ ...prev, [p.id]: true }))}
                            />
                          </a>
                        )
                      )}
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
    </div>
  );
}
