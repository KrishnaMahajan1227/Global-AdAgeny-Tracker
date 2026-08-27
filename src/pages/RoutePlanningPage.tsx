import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { Card, PageHeader, StatusBadge, EmptyState, Select, Input } from '@/components/ui';
import { logAudit, createNotification } from '@/lib/helpers';
import { useRealtimeInvalidate } from '@/lib/useRealtimeInvalidate';
import { loadGoogleMaps } from '@/lib/googleMapsLoader';
import { geocodeAddress } from '@/lib/geocode';
import {
  optimizeRoute, formatDistance, formatDuration, buildMultiStopNavigationUrl,
  type OptimizedRouteResult, type RouteStopPoint, type TravelMode,
} from '@/lib/routeOptimization';
import {
  Route as RouteIcon, MapPin, Navigation, Loader2, AlertCircle, CheckCircle2,
  Trash2, ListOrdered, Car, Footprints, Bike, Crosshair, Search, X,
} from 'lucide-react';

type ShopCandidate = {
  id: string; name: string; latitude: number; longitude: number;
  city: string | null; zone_id: string | null; status: string;
  assignment_id: string; assignment_status: string;
};

function todayISO() {
  return new Date().toISOString().split('T')[0];
}

const TRAVEL_MODE_OPTIONS: { value: TravelMode; label: string; icon: typeof Car }[] = [
  { value: 'DRIVING', label: 'Driving', icon: Car },
  { value: 'TWO_WHEELER', label: 'Two-wheeler', icon: Bike },
  { value: 'WALKING', label: 'Walking', icon: Footprints },
];

export default function RoutePlanningPage() {
  const { profile } = useAuth();
  const orgId = profile?.organization_id;
  const queryClient = useQueryClient();
  const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY || '';

  const [workerId, setWorkerId] = useState('');
  const [routeDate, setRouteDate] = useState(todayISO());
  const [zoneFilter, setZoneFilter] = useState('');
  const [selectedIds, setSelectedIds] = useState<string[]>([]); // ordered by selection click
  const [travelMode, setTravelMode] = useState<TravelMode>('DRIVING');
  const [routeName, setRouteName] = useState('');
  const [originMode, setOriginMode] = useState<'live' | 'address'>('live');
  const [originAddress, setOriginAddress] = useState('');
  const [resolvedOrigin, setResolvedOrigin] = useState<{ lat: number; lng: number; label: string } | null>(null);
  const [locatingOrigin, setLocatingOrigin] = useState(false);
  const [optimizing, setOptimizing] = useState(false);
  const [optimized, setOptimized] = useState<OptimizedRouteResult | null>(null);
  const [error, setError] = useState('');
  const [showSteps, setShowSteps] = useState(false);
  const [mapLoaded, setMapLoaded] = useState(false);
  const mapDivRef = useRef<HTMLDivElement>(null);
  const mapObjRef = useRef<any>(null);
  const rendererRef = useRef<any>(null);
  const markersRef = useRef<any[]>([]);

  useRealtimeInvalidate(['shop_assignments', 'routes', 'route_stops'], orgId, [
    ['route-planning-candidates', orgId, workerId],
    ['route-planning-existing', orgId, workerId, routeDate],
  ]);

  const { data: zones } = useQuery({
    queryKey: ['zones', orgId],
    queryFn: async () => {
      const { data } = await supabase.from('zones').select('id, name').eq('organization_id', orgId).order('name');
      return data || [];
    },
    enabled: !!orgId,
  });

  const { data: fieldWorkers } = useQuery({
    queryKey: ['route-planning-workers', orgId],
    queryFn: async () => {
      const { data } = await supabase
        .from('profiles')
        .select('id, full_name, role')
        .eq('organization_id', orgId)
        .in('role', ['surveyor', 'installer'])
        .eq('is_active', true)
        .order('full_name');
      return (data || []) as { id: string; full_name: string; role: string }[];
    },
    enabled: !!orgId,
  });

  const selectedWorker = fieldWorkers?.find((w) => w.id === workerId);

  // Shops assigned to this worker (in their surveyor/installer role) that
  // still need a visit — the pool a route can be built from. Not filtered
  // to a single "surveyable" status list here on purpose: an installer's
  // candidates look different from a surveyor's, and the admin building
  // the route is in the best position to judge which of their assigned
  // shops belong on today's run.
  const { data: candidates, isLoading: candidatesLoading } = useQuery({
    queryKey: ['route-planning-candidates', orgId, workerId],
    queryFn: async () => {
      const { data, error: qErr } = await supabase
        .from('shop_assignments')
        .select('id, status, shops(id, name, latitude, longitude, city, zone_id, status)')
        .eq('organization_id', orgId)
        .eq('user_id', workerId)
        .not('status', 'in', '("completed","declined")');
      if (qErr) throw qErr;
      return (data || [])
        .filter((a: any) => a.shops && a.shops.latitude != null && a.shops.longitude != null)
        .map((a: any) => ({
          id: a.shops.id, name: a.shops.name, latitude: a.shops.latitude, longitude: a.shops.longitude,
          city: a.shops.city, zone_id: a.shops.zone_id, status: a.shops.status,
          assignment_id: a.id, assignment_status: a.status,
        })) as ShopCandidate[];
    },
    enabled: !!orgId && !!workerId,
  });

  const filteredCandidates = useMemo(() => {
    if (!candidates) return [];
    return zoneFilter ? candidates.filter((c) => c.zone_id === zoneFilter) : candidates;
  }, [candidates, zoneFilter]);

  const { data: latestLocation } = useQuery({
    queryKey: ['route-planning-latest-location', orgId, workerId],
    queryFn: async () => {
      const { data } = await supabase
        .from('worker_locations')
        .select('latitude, longitude, recorded_at')
        .eq('organization_id', orgId)
        .eq('user_id', workerId)
        .order('recorded_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      return data;
    },
    enabled: !!orgId && !!workerId,
  });

  const { data: existingRoutes } = useQuery({
    queryKey: ['route-planning-existing', orgId, workerId, routeDate],
    queryFn: async () => {
      const { data } = await supabase
        .from('routes')
        .select('*, profiles:user_id(full_name), route_stops(id, shop_id, stop_order, status, leg_distance_meters, leg_duration_seconds, shops(name, latitude, longitude, city))')
        .eq('organization_id', orgId)
        .eq('route_date', routeDate)
        .not('user_id', 'is', null)
        .order('created_at', { ascending: false });
      return data || [];
    },
    enabled: !!orgId && !!routeDate,
  });

  // Reset selection whenever the worker or date changes — a stale
  // selection from a different worker's shop list is worse than an empty one.
  useEffect(() => {
    setSelectedIds([]);
    setOptimized(null);
    setError('');
  }, [workerId, routeDate]);

  // Default the origin to the worker's most recent live location whenever
  // it changes, unless the admin has switched to manual address mode.
  useEffect(() => {
    if (originMode !== 'live') return;
    if (latestLocation) {
      const ageMs = Date.now() - new Date(latestLocation.recorded_at).getTime();
      const stale = ageMs > 12 * 60 * 60 * 1000; // 12h
      setResolvedOrigin({
        lat: latestLocation.latitude, lng: latestLocation.longitude,
        label: `${selectedWorker?.full_name || 'Worker'}'s ${stale ? 'last known' : 'current'} location`,
      });
    } else {
      setResolvedOrigin(null);
    }
  }, [latestLocation, originMode, selectedWorker]);

  async function handleLocateOrigin() {
    setError('');
    setLocatingOrigin(true);
    try {
      const result = await geocodeAddress(originAddress);
      setResolvedOrigin({ lat: result.lat, lng: result.lng, label: result.formattedAddress });
    } catch (e: any) {
      setError(e.message || 'Could not find that starting address.');
    } finally {
      setLocatingOrigin(false);
    }
  }

  function toggleShop(id: string) {
    setOptimized(null);
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  async function handleOptimize() {
    setError('');
    if (!resolvedOrigin) {
      setError(originMode === 'live'
        ? "This worker has no recorded location yet — switch to 'Start from an address' below."
        : 'Locate a starting address first.');
      return;
    }
    if (selectedIds.length === 0) {
      setError('Select at least one shop to include in the route.');
      return;
    }
    const stops: RouteStopPoint[] = selectedIds
      .map((id) => filteredCandidates.find((c) => c.id === id) || candidates?.find((c) => c.id === id))
      .filter(Boolean)
      .map((c: any) => ({ id: c.id, name: c.name, lat: c.latitude, lng: c.longitude }));

    setOptimizing(true);
    try {
      const result = await optimizeRoute({ lat: resolvedOrigin.lat, lng: resolvedOrigin.lng }, stops, travelMode);
      setOptimized(result);
    } catch (e: any) {
      setError(e.message || 'Could not optimize this route.');
    } finally {
      setOptimizing(false);
    }
  }

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!optimized || !workerId) throw new Error('Optimize a route first.');
      const zoneIds = new Set(optimized.orderedStops.map((s) => candidates?.find((c) => c.id === s.id)?.zone_id).filter(Boolean));
      const zoneId = zoneIds.size === 1 ? Array.from(zoneIds)[0] as string : null;

      const { data: route, error: routeError } = await supabase.from('routes').insert({
        organization_id: orgId,
        user_id: workerId,
        name: routeName.trim() || `${selectedWorker?.full_name || 'Route'} — ${new Date(routeDate).toLocaleDateString('en-IN')}`,
        route_date: routeDate,
        status: 'planned',
        zone_id: zoneId,
        optimized: true,
        total_distance_meters: optimized.totalDistanceMeters,
        total_duration_seconds: optimized.totalDurationSeconds,
        origin_lat: resolvedOrigin!.lat,
        origin_lng: resolvedOrigin!.lng,
        origin_label: resolvedOrigin!.label,
      }).select().single();
      if (routeError) throw new Error(`Could not create route: ${routeError.message}`);

      const stopsPayload = optimized.orderedStops.map((stop, i) => ({
        organization_id: orgId,
        route_id: route.id,
        shop_id: stop.id,
        stop_order: i + 1,
        status: 'pending',
        leg_distance_meters: optimized.legs[i]?.distanceMeters ?? null,
        leg_duration_seconds: optimized.legs[i]?.durationSeconds ?? null,
      }));
      const { error: stopsError } = await supabase.from('route_stops').insert(stopsPayload);
      if (stopsError) throw new Error(`Could not save stops: ${stopsError.message}`);

      await logAudit('routes', route.id, 'insert', null, null, null,
        `Optimized route built for ${selectedWorker?.full_name || 'worker'}: ${stopsPayload.length} stop(s), ${formatDistance(optimized.totalDistanceMeters)}`);
      await createNotification(
        workerId, 'New route planned',
        `${stopsPayload.length} stop(s) planned for ${new Date(routeDate).toLocaleDateString('en-IN')} — ${formatDistance(optimized.totalDistanceMeters)}, about ${formatDuration(optimized.totalDurationSeconds)}.`,
        'info', '/mobile'
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['route-planning-existing', orgId, workerId, routeDate] });
      setSelectedIds([]);
      setOptimized(null);
      setRouteName('');
    },
    onError: (e: any) => setError(e.message),
  });

  const deleteRouteMutation = useMutation({
    mutationFn: async (routeId: string) => {
      const { error: delErr } = await supabase.from('routes').delete().eq('id', routeId);
      if (delErr) throw new Error(delErr.message);
      await logAudit('routes', routeId, 'delete', null, null, null, 'Route deleted from Route Planning');
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['route-planning-existing', orgId, workerId, routeDate] }),
  });

  const updateStatusMutation = useMutation({
    mutationFn: async ({ routeId, status }: { routeId: string; status: string }) => {
      const { error: updErr } = await supabase.from('routes').update({ status }).eq('id', routeId);
      if (updErr) throw new Error(updErr.message);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['route-planning-existing', orgId, workerId, routeDate] }),
  });

  // ===== Map: load SDK, render candidate + selected markers, draw the optimized route =====
  useEffect(() => {
    if (!apiKey) return;
    loadGoogleMaps().then(() => setMapLoaded(true)).catch(() => setMapLoaded(false));
  }, [apiKey]);

  useEffect(() => {
    if (!mapLoaded || !mapDivRef.current || mapObjRef.current) return;
    mapObjRef.current = new window.google.maps.Map(mapDivRef.current, {
      zoom: 11,
      center: { lat: 19.0760, lng: 72.8777 },
    });
    rendererRef.current = new window.google.maps.DirectionsRenderer({ suppressMarkers: false, map: mapObjRef.current });
  }, [mapLoaded]);

  useEffect(() => {
    if (!mapLoaded || !mapObjRef.current) return;
    const map = mapObjRef.current;

    markersRef.current.forEach((m) => m.setMap(null));
    markersRef.current = [];

    if (optimized) {
      rendererRef.current?.setDirections(optimized.raw);
      return;
    }
    rendererRef.current?.set('directions', null);

    const bounds = new window.google.maps.LatLngBounds();
    let any = false;

    if (resolvedOrigin) {
      const m = new window.google.maps.Marker({
        position: { lat: resolvedOrigin.lat, lng: resolvedOrigin.lng }, map,
        icon: { path: window.google.maps.SymbolPath.CIRCLE, scale: 9, fillColor: '#0f172a', fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2 },
        title: `Start: ${resolvedOrigin.label}`,
      });
      markersRef.current.push(m);
      bounds.extend(m.getPosition());
      any = true;
    }

    filteredCandidates.forEach((c) => {
      const isSelected = selectedIds.includes(c.id);
      const m = new window.google.maps.Marker({
        position: { lat: c.latitude, lng: c.longitude }, map,
        icon: {
          path: window.google.maps.SymbolPath.CIRCLE, scale: isSelected ? 9 : 6,
          fillColor: isSelected ? '#2563eb' : '#94a3b8', fillOpacity: isSelected ? 1 : 0.7,
          strokeColor: '#fff', strokeWeight: isSelected ? 2 : 1,
        },
        title: c.name,
      });
      markersRef.current.push(m);
      bounds.extend(m.getPosition());
      any = true;
    });

    if (any) map.fitBounds(bounds, 60);
  }, [mapLoaded, filteredCandidates, selectedIds, resolvedOrigin, optimized]);

  return (
    <div>
      <PageHeader
        title="Route Planning"
        subtitle="Build optimized multi-stop routes with real turn-by-turn directions for surveyors and installers"
      />

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        {/* ===== Left: builder controls ===== */}
        <div className="space-y-4">
          <Card className="p-4 space-y-3">
            <Select
              label="Field worker" value={workerId} onChange={setWorkerId} required
              options={(fieldWorkers || []).map((w) => ({ value: w.id, label: `${w.full_name} (${w.role})` }))}
            />
            <Input label="Route date" type="date" value={routeDate} onChange={setRouteDate} required />
            <Select
              label="Filter shops by zone" value={zoneFilter} onChange={setZoneFilter}
              options={(zones || []).map((z: any) => ({ value: z.id, label: z.name }))}
            />
          </Card>

          {workerId && (
            <Card className="p-4 space-y-3">
              <p className="text-sm font-medium text-slate-700">Start point</p>
              <div className="flex gap-2">
                <button
                  onClick={() => setOriginMode('live')}
                  className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg text-xs font-medium border ${originMode === 'live' ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-600 border-slate-200'}`}
                >
                  <Crosshair className="w-3.5 h-3.5" /> Worker's location
                </button>
                <button
                  onClick={() => setOriginMode('address')}
                  className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg text-xs font-medium border ${originMode === 'address' ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-600 border-slate-200'}`}
                >
                  <Search className="w-3.5 h-3.5" /> Address
                </button>
              </div>

              {originMode === 'live' ? (
                latestLocation ? (
                  <p className="text-xs text-slate-500 flex items-center gap-1.5">
                    <MapPin className="w-3.5 h-3.5 text-slate-400" />
                    Last seen {new Date(latestLocation.recorded_at).toLocaleString('en-IN')}
                  </p>
                ) : (
                  <p className="text-xs text-amber-600 flex items-center gap-1.5">
                    <AlertCircle className="w-3.5 h-3.5" /> No recorded location for this worker yet — use an address instead.
                  </p>
                )
              ) : (
                <div className="flex gap-2">
                  <div className="flex-1">
                    <input
                      value={originAddress}
                      onChange={(e) => setOriginAddress(e.target.value)}
                      placeholder="e.g. Agency office, Nagpur"
                      className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                  <button
                    onClick={handleLocateOrigin}
                    disabled={locatingOrigin || !originAddress.trim()}
                    className="px-3 py-2 bg-slate-900 text-white rounded-lg text-xs font-medium disabled:opacity-50"
                  >
                    {locatingOrigin ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Locate'}
                  </button>
                </div>
              )}
              {resolvedOrigin && (
                <p className="text-xs text-emerald-700 bg-emerald-50 rounded-lg px-2 py-1.5 flex items-center gap-1.5">
                  <CheckCircle2 className="w-3.5 h-3.5 shrink-0" /> {resolvedOrigin.label}
                </p>
              )}

              <p className="text-sm font-medium text-slate-700 pt-1">Travel mode</p>
              <div className="flex gap-2">
                {TRAVEL_MODE_OPTIONS.map((opt) => {
                  const Icon = opt.icon;
                  return (
                    <button
                      key={opt.value}
                      onClick={() => { setTravelMode(opt.value); setOptimized(null); }}
                      className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg text-xs font-medium border ${travelMode === opt.value ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-600 border-slate-200'}`}
                    >
                      <Icon className="w-3.5 h-3.5" /> {opt.label}
                    </button>
                  );
                })}
              </div>
            </Card>
          )}

          {workerId && (
            <Card className="p-4">
              <div className="flex items-center justify-between mb-3">
                <p className="text-sm font-medium text-slate-700">
                  Shops to visit {selectedIds.length > 0 && <span className="text-blue-600">({selectedIds.length} selected)</span>}
                </p>
                {selectedIds.length > 0 && (
                  <button onClick={() => { setSelectedIds([]); setOptimized(null); }} className="text-xs text-slate-400 hover:text-slate-600 flex items-center gap-1">
                    <X className="w-3 h-3" /> Clear
                  </button>
                )}
              </div>
              {candidatesLoading ? (
                <div className="flex justify-center py-6"><Loader2 className="w-5 h-5 animate-spin text-slate-400" /></div>
              ) : filteredCandidates.length === 0 ? (
                <p className="text-sm text-slate-400 py-4 text-center">No pending shops assigned to this worker{zoneFilter ? ' in this zone' : ''}.</p>
              ) : (
                <div className="space-y-1.5 max-h-80 overflow-y-auto">
                  {filteredCandidates.map((c) => {
                    const order = selectedIds.indexOf(c.id);
                    return (
                      <label key={c.id} className={`flex items-center gap-2.5 px-2.5 py-2 rounded-lg border cursor-pointer text-sm ${order >= 0 ? 'bg-blue-50 border-blue-200' : 'border-slate-100 hover:bg-slate-50'}`}>
                        <input type="checkbox" checked={order >= 0} onChange={() => toggleShop(c.id)} className="accent-blue-600" />
                        <div className="flex-1 min-w-0">
                          <p className="font-medium text-slate-900 truncate">{c.name}</p>
                          <p className="text-xs text-slate-500">{c.city || '—'}</p>
                        </div>
                        <StatusBadge status={c.status} />
                        {order >= 0 && <span className="w-5 h-5 rounded-full bg-blue-600 text-white text-[11px] font-bold flex items-center justify-center shrink-0">{order + 1}</span>}
                      </label>
                    );
                  })}
                </div>
              )}
            </Card>
          )}

          {error && (
            <div className="flex items-start gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" /> {error}
            </div>
          )}

          {workerId && (
            <button
              onClick={handleOptimize}
              disabled={optimizing || selectedIds.length === 0}
              className="w-full flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-medium py-2.5 rounded-lg transition"
            >
              {optimizing ? <Loader2 className="w-4 h-4 animate-spin" /> : <RouteIcon className="w-4 h-4" />}
              {optimizing ? 'Optimizing…' : 'Optimize route'}
            </button>
          )}

          {optimized && (
            <Card className="p-4 space-y-3">
              <div className="flex items-center justify-between">
                <p className="font-semibold text-slate-900">Optimized order</p>
                <div className="text-right text-xs text-slate-500">
                  <p className="font-medium text-slate-900">{formatDistance(optimized.totalDistanceMeters)} · {formatDuration(optimized.totalDurationSeconds)}</p>
                </div>
              </div>

              <ol className="space-y-2">
                {optimized.orderedStops.map((s, i) => (
                  <li key={s.id} className="flex items-center gap-2.5 text-sm">
                    <span className="w-6 h-6 rounded-full bg-slate-900 text-white text-[11px] font-bold flex items-center justify-center shrink-0">{i + 1}</span>
                    <span className="flex-1 truncate text-slate-800">{s.name}</span>
                    <span className="text-xs text-slate-400 shrink-0">{formatDistance(optimized.legs[i]?.distanceMeters)} · {formatDuration(optimized.legs[i]?.durationSeconds)}</span>
                  </li>
                ))}
              </ol>

              <button onClick={() => setShowSteps((v) => !v)} className="flex items-center gap-1.5 text-xs font-medium text-blue-600">
                <ListOrdered className="w-3.5 h-3.5" /> {showSteps ? 'Hide' : 'Show'} turn-by-turn directions
              </button>
              {showSteps && (
                <div className="space-y-3 max-h-64 overflow-y-auto bg-slate-50 rounded-lg p-3">
                  {optimized.legs.map((leg, i) => (
                    <div key={i}>
                      <p className="text-xs font-semibold text-slate-700 mb-1">
                        Leg {i + 1}: {i === 0 ? resolvedOrigin?.label : optimized.orderedStops[i - 1].name} → {optimized.orderedStops[i].name}
                      </p>
                      <ol className="list-decimal list-inside space-y-0.5">
                        {leg.steps.map((step, j) => (
                          <li key={j} className="text-xs text-slate-600">{step}</li>
                        ))}
                      </ol>
                    </div>
                  ))}
                </div>
              )}

              <Input label="Route name (optional)" value={routeName} onChange={setRouteName} placeholder={`${selectedWorker?.full_name || 'Route'} — ${new Date(routeDate).toLocaleDateString('en-IN')}`} />

              <div className="flex gap-2">
                <button
                  onClick={() => saveMutation.mutate()}
                  disabled={saveMutation.isPending}
                  className="flex-1 flex items-center justify-center gap-2 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white font-medium py-2.5 rounded-lg transition"
                >
                  {saveMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                  Save route
                </button>
                <a
                  href={buildMultiStopNavigationUrl(optimized.orderedStops, resolvedOrigin, travelMode === 'WALKING' ? 'walking' : travelMode === 'TWO_WHEELER' ? 'two-wheeler' : 'driving')}
                  target="_blank" rel="noreferrer"
                  className="flex items-center justify-center gap-2 px-4 bg-slate-100 hover:bg-slate-200 text-slate-700 font-medium py-2.5 rounded-lg transition text-sm"
                >
                  <Navigation className="w-4 h-4" /> Preview
                </a>
              </div>
            </Card>
          )}
        </div>

        {/* ===== Right: map + existing routes ===== */}
        <div className="xl:col-span-2 space-y-6">
          {!apiKey ? (
            <Card className="p-6">
              <div className="flex items-center gap-3 text-amber-600 mb-2">
                <AlertCircle className="w-5 h-5" />
                <p className="font-medium">Google Maps API key not configured</p>
              </div>
              <p className="text-sm text-slate-500">Set VITE_GOOGLE_MAPS_API_KEY to enable route optimization and the map.</p>
            </Card>
          ) : (
            <Card className="overflow-hidden">
              <div ref={mapDivRef} className="w-full h-[420px]" />
            </Card>
          )}

          <div>
            <h2 className="text-lg font-semibold text-slate-900 mb-3">
              Routes for {new Date(routeDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
            </h2>
            {(!existingRoutes || existingRoutes.length === 0) ? (
              <Card className="p-4">
                <EmptyState icon={<RouteIcon className="w-10 h-10" />} title="No routes yet for this date" subtitle="Build one on the left to get started" />
              </Card>
            ) : (
              <div className="space-y-3">
                {existingRoutes.map((route: any) => (
                  <Card key={route.id} className="p-4">
                    <div className="flex items-start justify-between gap-3 mb-2">
                      <div>
                        <p className="font-semibold text-slate-900">{route.name || 'Unnamed route'}</p>
                        <p className="text-xs text-slate-500">
                          {route.profiles?.full_name || 'Unassigned'} · {route.route_stops?.length || 0} stop(s)
                          {route.total_distance_meters != null && <> · {formatDistance(route.total_distance_meters)} · {formatDuration(route.total_duration_seconds)}</>}
                        </p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <StatusBadge status={route.status} />
                        <select
                          value={route.status}
                          onChange={(e) => updateStatusMutation.mutate({ routeId: route.id, status: e.target.value })}
                          className="text-xs border border-slate-200 rounded-lg px-1.5 py-1 outline-none"
                        >
                          <option value="planned">Planned</option>
                          <option value="active">Active</option>
                          <option value="completed">Completed</option>
                        </select>
                        <button onClick={() => deleteRouteMutation.mutate(route.id)} className="text-slate-400 hover:text-red-600">
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                    <ol className="space-y-1 mb-2">
                      {(route.route_stops || []).sort((a: any, b: any) => a.stop_order - b.stop_order).map((stop: any) => (
                        <li key={stop.id} className="flex items-center gap-2 text-sm">
                          <span className="w-5 h-5 rounded-full bg-slate-100 text-slate-600 text-[10px] font-bold flex items-center justify-center shrink-0">{stop.stop_order}</span>
                          <span className="flex-1 truncate text-slate-700">{stop.shops?.name || 'Shop'}</span>
                          {stop.leg_distance_meters != null && (
                            <span className="text-xs text-slate-400 shrink-0">{formatDistance(stop.leg_distance_meters)}</span>
                          )}
                          <StatusBadge status={stop.status} />
                        </li>
                      ))}
                    </ol>
                    {route.route_stops?.length > 0 && (
                      <a
                        href={buildMultiStopNavigationUrl(
                          (route.route_stops || []).sort((a: any, b: any) => a.stop_order - b.stop_order)
                            .map((s: any) => ({ id: s.shop_id, name: s.shops?.name || '', lat: s.shops?.latitude, lng: s.shops?.longitude })),
                          route.origin_lat != null ? { lat: route.origin_lat, lng: route.origin_lng } : null
                        )}
                        target="_blank" rel="noreferrer"
                        className="inline-flex items-center gap-1.5 text-xs font-medium text-blue-600 hover:text-blue-700 mt-1"
                      >
                        <Navigation className="w-3.5 h-3.5" /> Open turn-by-turn in Google Maps
                      </a>
                    )}
                  </Card>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
