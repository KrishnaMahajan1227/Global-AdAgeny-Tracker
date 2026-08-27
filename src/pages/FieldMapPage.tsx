import { useEffect, useState, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { Card, PageHeader, StatusBadge, EmptyState } from '@/components/ui';
import { MapPin, Clock, AlertCircle, Route as RouteIcon, Gauge, ChevronRight } from 'lucide-react';
import type { WorkerLocation, Profile } from '@/lib/types';
import { fetchDirectionsForOrderedStops } from '@/lib/routeOptimization';
import { loadGoogleMaps } from '@/lib/googleMapsLoader';
import { workloadLevel, initials } from '@/lib/helpers';

// A small fixed palette so each planned route on the map gets a visually
// distinct polyline color, cycling if there are more routes than colors.
const ROUTE_COLORS = ['#7c3aed', '#0891b2', '#dc2626', '#65a30d', '#ea580c', '#db2777'];

// Team Workload (Owner Console) is Owner/Admin-only by design — this map
// page is reachable by every office role (designer, printing, accounts,
// client_manager too), so the snapshot below only renders for the roles
// that are actually meant to see workload data. Nobody else's map view
// changes at all.
const WORKLOAD_VISIBLE_ROLES = ['agency_owner', 'admin', 'demo'];

export default function FieldMapPage() {
  const { profile } = useAuth();
  const orgId = profile?.organization_id;
  const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY || '';
  const mapRef = useRef<HTMLDivElement>(null);
  const [mapLoaded, setMapLoaded] = useState(false);
  const [workers, setWorkers] = useState<(WorkerLocation & { profiles: Profile })[]>([]);
  const [staleMap, setStaleMap] = useState<Record<string, boolean>>({});
  const [showRoutes, setShowRoutes] = useState(true);
  const routePolylinesRef = useRef<any[]>([]);
  const canSeeWorkload = !!profile && WORKLOAD_VISIBLE_ROLES.includes(profile.role);

  // Team Workload snapshot (§9.2's "also show a bit of it on the Map") —
  // reuses the exact same v_team_workload view Owner Console's own tab
  // reads, just a top-5-busiest slice of it. Gated off entirely for
  // roles that shouldn't see it (query never even fires), so nothing
  // extra loads or renders for designer/printing/accounts/client_manager.
  const { data: workloadRows } = useQuery({
    queryKey: ['field-map-workload', orgId],
    queryFn: async () => {
      const { data, error } = await supabase.from('v_team_workload').select('*');
      if (error) throw new Error(`Could not load team workload: ${error.message}`);
      return data as { user_id: string; full_name: string; role: string; assigned_open: number; in_progress: number; overdue: number }[];
    },
    enabled: !!orgId && canSeeWorkload,
    refetchInterval: 60000,
  });

  const topWorkloadRows = (workloadRows || [])
    .filter((r) => (r.assigned_open || 0) > 0)
    .sort((a, b) => (b.assigned_open || 0) - (a.assigned_open || 0))
    .slice(0, 5);

  const { data: shopList } = useQuery({
    queryKey: ['map-shops', orgId],
    queryFn: async () => {
      const { data } = await supabase.from('shops').select('id, name, latitude, longitude, status, city').eq('organization_id', orgId).not('latitude', 'is', null);
      return data;
    },
    enabled: !!orgId,
  });

  // Today's planned/active routes — this is what turns the map from "a pile
  // of pins" into an actual picture of who's going where, in what order,
  // by what road. Only planned/active (not completed) so the map doesn't
  // clutter up with yesterday's finished runs.
  const { data: todaysRoutes } = useQuery({
    queryKey: ['field-map-routes', orgId],
    queryFn: async () => {
      const today = new Date().toISOString().split('T')[0];
      const { data } = await supabase
        .from('routes')
        .select('id, name, status, origin_lat, origin_lng, profiles:user_id(full_name), route_stops(stop_order, status, shops(name, latitude, longitude))')
        .eq('organization_id', orgId)
        .eq('route_date', today)
        .in('status', ['planned', 'active'])
        .not('user_id', 'is', null);
      return data || [];
    },
    enabled: !!orgId,
  });

  // Load Google Maps script — shared loader so this never fights with the
  // Route Planning screen (or the shop form's geocoder) over which <script>
  // tag "wins"; everyone waits on the same promise.
  useEffect(() => {
    if (!apiKey) return;
    loadGoogleMaps().then(() => setMapLoaded(true)).catch(() => setMapLoaded(false));
  }, [apiKey]);

  // Fetch initial worker locations
  useEffect(() => {
    if (!orgId) return;
    async function loadWorkers() {
      const { data } = await supabase
        .from('worker_locations')
        .select('*, profiles(full_name, role)')
        .eq('organization_id', orgId)
        .order('recorded_at', { ascending: false });
      if (data) {
        // Get latest per user
        const latestByUser = new Map<string, any>();
        for (const loc of data) {
          if (!latestByUser.has(loc.user_id)) {
            latestByUser.set(loc.user_id, loc);
          }
        }
        setWorkers(Array.from(latestByUser.values()));
      }
    }
    loadWorkers();

    // Realtime subscription
    const channel = supabase
      .channel('worker_locations_changes')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'worker_locations', filter: `organization_id=eq.${orgId}` },
        (payload) => {
          setWorkers((prev) => {
            const newRow = payload.new as WorkerLocation;
            const previousEntry = prev.find((w) => w.user_id === newRow.user_id);
            const others = prev.filter((w) => w.user_id !== newRow.user_id);
            // Realtime INSERT payloads only carry the raw worker_locations
            // row, not the joined profile — reuse the profile we already
            // have for this worker so the marker's name/role don't flicker.
            const merged: WorkerLocation & { profiles: Profile } = {
              ...newRow,
              profiles: previousEntry?.profiles ?? ({} as Profile),
            };
            return [...others, merged];
          });
        }
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [orgId]);

  // Check for stale locations every 30s
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      const stale: Record<string, boolean> = {};
      for (const w of workers) {
        const age = now - new Date(w.recorded_at).getTime();
        stale[w.user_id] = age > 5 * 60 * 1000;
      }
      setStaleMap(stale);
    }, 30000);
    return () => clearInterval(interval);
  }, [workers]);

  // Initialize map
  useEffect(() => {
    if (!mapLoaded || !mapRef.current) return;
    const center = workers[0] ? { lat: workers[0].latitude, lng: workers[0].longitude } : { lat: 19.0760, lng: 72.8777 };
    const map = new window.google.maps.Map(mapRef.current, { zoom: 11, center });

    // Worker markers
    workers.forEach((w) => {
      const isStale = staleMap[w.user_id];
      const marker = new window.google.maps.Marker({
        position: { lat: w.latitude, lng: w.longitude },
        map,
        icon: {
          path: window.google.maps.SymbolPath.CIRCLE,
          scale: 10,
          fillColor: isStale ? '#94a3b8' : '#2563eb',
          fillOpacity: 1,
          strokeColor: '#ffffff',
          strokeWeight: 2,
        },
        title: w.profiles?.full_name || 'Worker',
      });

      const infoContent = `
        <div style="padding: 8px; min-width: 180px;">
          <p style="font-weight: bold; margin-bottom: 4px;">${w.profiles?.full_name || 'Unknown'}</p>
          <p style="font-size: 12px; color: #666; margin-bottom: 2px;">Role: ${w.profiles?.role || 'N/A'}</p>
          <p style="font-size: 12px; color: ${isStale ? '#ef4444' : '#16a34a'}; margin-bottom: 2px;">
            ${isStale ? 'Location stale' : 'Active'}
          </p>
          <p style="font-size: 12px; color: #999;">
            Updated: ${new Date(w.recorded_at).toLocaleTimeString('en-IN')}
          </p>
        </div>
      `;
      const infoWindow = new window.google.maps.InfoWindow({ content: infoContent });
      marker.addListener('click', () => infoWindow.open(map, marker));
    });

    // Shop markers
    (shopList || []).forEach((s) => {
      const colors: Record<string, string> = {
        pending: '#94a3b8', assigned: '#3b82f6', surveyed: '#06b6d4',
        approved: '#16a34a', installed: '#059669', billed: '#22c55e',
      };
      const color = colors[s.status] || '#94a3b8';
      new window.google.maps.Marker({
        position: { lat: s.latitude, lng: s.longitude },
        map,
        icon: { path: window.google.maps.SymbolPath.CIRCLE, scale: 6, fillColor: color, fillOpacity: 0.7, strokeColor: color, strokeWeight: 1 },
        title: s.name,
      });
    });

    // Planned/active route polylines — real driving directions, not just
    // straight lines between pins, so Admin/Owner can see the actual path
    // and stop order each field worker is running today.
    routePolylinesRef.current.forEach((p) => p.setMap(null));
    routePolylinesRef.current = [];

    if (showRoutes && todaysRoutes && todaysRoutes.length > 0) {
      todaysRoutes.forEach(async (route: any, idx: number) => {
        const stops = (route.route_stops || [])
          .sort((a: any, b: any) => a.stop_order - b.stop_order)
          .filter((s: any) => s.shops?.latitude != null)
          .map((s: any) => ({ id: s.stop_order, name: s.shops.name, lat: s.shops.latitude, lng: s.shops.longitude }));
        if (stops.length === 0) return;
        const origin = route.origin_lat != null
          ? { lat: route.origin_lat, lng: route.origin_lng }
          : { lat: stops[0].lat, lng: stops[0].lng };

        const directions = await fetchDirectionsForOrderedStops(origin, stops);
        if (!directions) return;
        const color = ROUTE_COLORS[idx % ROUTE_COLORS.length];
        const polyline = new window.google.maps.Polyline({
          path: directions.overviewPath,
          map,
          strokeColor: color,
          strokeWeight: 4,
          strokeOpacity: 0.8,
        });
        routePolylinesRef.current.push(polyline);
      });
    }
  }, [mapLoaded, workers, shopList, staleMap, showRoutes, todaysRoutes]);

  function timeAgo(date: string) {
    const seconds = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    return `${Math.floor(seconds / 3600)}h ago`;
  }

  return (
    <div>
      <PageHeader
        title="Live Field Map"
        subtitle="Real-time worker locations, shop coverage, and today's planned routes"
        action={
          <div className="flex items-center gap-3">
            <Link to="/route-planning" className="flex items-center gap-1.5 text-sm font-medium text-blue-600 hover:text-blue-700">
              <RouteIcon className="w-4 h-4" /> Plan a route
            </Link>
            <label className="flex items-center gap-1.5 text-sm text-slate-600 cursor-pointer">
              <input type="checkbox" checked={showRoutes} onChange={(e) => setShowRoutes(e.target.checked)} className="accent-blue-600" />
              Show routes
            </label>
          </div>
        }
      />

      {showRoutes && todaysRoutes && todaysRoutes.length > 0 && (
        <div className="flex flex-wrap gap-3 mb-4">
          {todaysRoutes.map((route: any, idx: number) => (
            <span key={route.id} className="flex items-center gap-1.5 text-xs font-medium text-slate-600 bg-white border border-slate-200 rounded-full px-3 py-1">
              <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: ROUTE_COLORS[idx % ROUTE_COLORS.length] }} />
              {route.profiles?.full_name || route.name || 'Route'} · {route.route_stops?.length || 0} stops
            </span>
          ))}
        </div>
      )}

      {!apiKey ? (
        <Card className="p-6">
          <div className="flex items-center gap-3 text-amber-600 mb-2">
            <AlertCircle className="w-5 h-5" />
            <p className="font-medium">Google Maps API key not configured</p>
          </div>
          <p className="text-sm text-slate-500">Set VITE_GOOGLE_MAPS_API_KEY in your environment to enable the live map. Below is a list of recent worker locations.</p>
        </Card>
      ) : (
        <Card className="overflow-hidden mb-6">
          <div ref={mapRef} className="w-full h-96" />
        </Card>
      )}

      {/* Team Snapshot — Owner/Admin only (§9.2). A quick "who's carrying
          the most right now" read alongside the map, not a duplicate of
          the full Team Workload tab (which stays in Owner Console with
          its search/sort/drill-down). Renders nothing at all for any
          other role, and nothing if nobody currently has open work. */}
      {canSeeWorkload && topWorkloadRows.length > 0 && (
        <Card className="p-4 mb-6">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-slate-900 flex items-center gap-1.5">
              <Gauge className="w-4 h-4 text-slate-400" /> Team Snapshot — who's carrying the most right now
            </h2>
            {profile?.role === 'agency_owner' && (
              <Link to="/owner" className="text-xs font-medium text-blue-600 hover:text-blue-700 flex items-center gap-0.5">
                Full breakdown <ChevronRight className="w-3.5 h-3.5" />
              </Link>
            )}
          </div>
          <div className="flex gap-3 overflow-x-auto pb-1">
            {topWorkloadRows.map((r) => {
              const level = workloadLevel(r.assigned_open || 0);
              return (
                <div key={`${r.user_id}-${r.role}`} className="flex items-center gap-2.5 border border-slate-200 rounded-lg px-3 py-2 shrink-0 min-w-[190px]">
                  <span className="w-8 h-8 rounded-full bg-indigo-100 text-indigo-700 text-xs font-semibold flex items-center justify-center shrink-0">
                    {initials(r.full_name)}
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-slate-900 truncate">{r.full_name}</p>
                    <p className="text-xs text-slate-500 capitalize flex items-center gap-1">
                      {r.role} · {r.assigned_open} open
                      {r.overdue > 0 && <span className="text-red-600 font-medium">· {r.overdue} overdue</span>}
                    </p>
                  </div>
                  <span className={`ml-auto w-2 h-2 rounded-full shrink-0 ${level.dot}`} title={level.label} />
                </div>
              );
            })}
          </div>
        </Card>
      )}

      <h2 className="text-lg font-semibold text-slate-900 mb-3">Active Workers ({workers.length})</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {workers.map((w) => {
          const isStale = staleMap[w.user_id];
          return (
            <Card key={w.user_id} className="p-4">
              <div className="flex items-start justify-between mb-2">
                <div className="flex items-center gap-2">
                  <div className={`w-3 h-3 rounded-full ${isStale ? 'bg-slate-400' : 'bg-green-500 animate-pulse'}`} />
                  <p className="font-medium text-slate-900">{w.profiles?.full_name || 'Unknown'}</p>
                </div>
                <span className={`text-xs font-medium ${isStale ? 'text-slate-400' : 'text-green-600'}`}>
                  {isStale ? 'Stale' : 'Active'}
                </span>
              </div>
              <div className="text-sm text-slate-500 space-y-1">
                <p className="capitalize">{w.profiles?.role?.replace(/_/g, ' ') || 'N/A'}</p>
                <p className="flex items-center gap-1"><MapPin className="w-3.5 h-3.5" /> {w.latitude.toFixed(4)}, {w.longitude.toFixed(4)}</p>
                <p className="flex items-center gap-1"><Clock className="w-3.5 h-3.5" /> {timeAgo(w.recorded_at)}</p>
                {w.accuracy && <p className="text-xs text-slate-400">Accuracy: {w.accuracy.toFixed(0)}m</p>}
              </div>
            </Card>
          );
        })}
        {workers.length === 0 && (
          <Card className="col-span-full">
            <EmptyState icon={<MapPin className="w-12 h-12" />} title="No worker locations yet" subtitle="Active field workers will appear here" />
          </Card>
        )}
      </div>

      <h2 className="text-lg font-semibold text-slate-900 mb-3 mt-6">Shop Coverage ({shopList?.length || 0})</h2>
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
        {(shopList || []).map((s) => (
          <Card key={s.id} className="p-3">
            <p className="text-sm font-medium text-slate-900 truncate">{s.name}</p>
            <p className="text-xs text-slate-500">{s.city}</p>
            <StatusBadge status={s.status} />
          </Card>
        ))}
      </div>
    </div>
  );
}
