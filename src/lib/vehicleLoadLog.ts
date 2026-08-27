import { supabase } from '@/lib/supabase';
import { VehicleLoadLogRow } from '@/lib/types';

// How far back the log/report pulls by default. Kept bounded so the
// query stays fast on large orgs — callers needing an older window can
// pass an explicit `since`.
const DEFAULT_LOOKBACK_DAYS = 180;

export async function fetchVehicleLoadLog(orgId: string, since?: Date): Promise<VehicleLoadLogRow[]> {
  const cutoff = since ?? new Date(Date.now() - DEFAULT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const { data, error } = await supabase
    .from('v_vehicle_load_log')
    .select('*')
    .eq('organization_id', orgId)
    .gte('loaded_at', cutoff.toISOString())
    .order('loaded_at', { ascending: false });
  if (error) throw new Error(error.message || 'Could not load the vehicle load log.');
  return (data || []) as VehicleLoadLogRow[];
}

// One row per board -> one card per shop-load -> one group per trip.
export interface VehicleLoadLogBoardRow {
  item_id: string;
  work_type_name: string | null;
  material: string | null;
  qty_ready: number;
  qty_loaded: number;
}

export interface VehicleLoadLogShopCard {
  vehicle_load_id: string;
  shop_id: string;
  shop_name: string;
  shop_city: string | null;
  installer_id: string;
  installer_name: string | null;
  status: 'loaded' | 'delivered' | 'cancelled';
  delivered_at: string | null;
  delivered_by_name: string | null;
  notes: string | null;
  boards: VehicleLoadLogBoardRow[];
  total_ready_qty: number;
  total_loaded_qty: number;
}

export interface VehicleLoadTripGroup {
  // vehicle_trip_id when it's a multi-shop trip, otherwise the lone
  // vehicle_load_id — either way, a stable unique key for the group.
  key: string;
  is_multi_shop: boolean;
  vehicle_number: string;
  driver_name: string | null;
  loaded_at: string;
  loaded_by_name: string | null;
  shops: VehicleLoadLogShopCard[];
  total_ready_qty: number;
  total_loaded_qty: number;
  // Material-wise totals across every shop in this trip — "kis material ka
  // kitna load hua", the number people actually check, without having to
  // open every shop's board list and add it up by hand. Sorted by
  // qty_loaded, highest first.
  materials: VehicleLoadLogMaterialTotal[];
}

export interface VehicleLoadLogMaterialTotal {
  name: string;
  qty_ready: number;
  qty_loaded: number;
}

export function groupVehicleLoadLog(rows: VehicleLoadLogRow[]): VehicleLoadTripGroup[] {
  const byLoad = new Map<string, { meta: VehicleLoadLogRow; boards: VehicleLoadLogBoardRow[] }>();
  for (const r of rows) {
    let entry = byLoad.get(r.vehicle_load_id);
    if (!entry) { entry = { meta: r, boards: [] }; byLoad.set(r.vehicle_load_id, entry); }
    entry.boards.push({ item_id: r.item_id, work_type_name: r.work_type_name, material: r.material, qty_ready: r.qty_ready, qty_loaded: r.qty_loaded });
  }

  const byTripKey = new Map<string, VehicleLoadTripGroup>();
  // Per-trip material accumulator, keyed by trip key then material label.
  const materialsByTrip = new Map<string, Map<string, VehicleLoadLogMaterialTotal>>();

  for (const { meta, boards } of byLoad.values()) {
    const key = meta.vehicle_trip_id || meta.vehicle_load_id;
    const total_ready_qty = boards.reduce((s, b) => s + (b.qty_ready || 0), 0);
    const total_loaded_qty = boards.reduce((s, b) => s + (b.qty_loaded || 0), 0);
    const shopCard: VehicleLoadLogShopCard = {
      vehicle_load_id: meta.vehicle_load_id,
      shop_id: meta.shop_id,
      shop_name: meta.shop_name,
      shop_city: meta.shop_city,
      installer_id: meta.installer_id,
      installer_name: meta.installer_name,
      status: meta.status,
      delivered_at: meta.delivered_at,
      delivered_by_name: meta.delivered_by_name,
      notes: meta.notes,
      boards,
      total_ready_qty,
      total_loaded_qty,
    };

    let trip = byTripKey.get(key);
    if (!trip) {
      trip = {
        key,
        is_multi_shop: !!meta.vehicle_trip_id,
        vehicle_number: meta.vehicle_number,
        driver_name: meta.driver_name,
        loaded_at: meta.loaded_at,
        loaded_by_name: meta.loaded_by_name,
        shops: [],
        total_ready_qty: 0,
        total_loaded_qty: 0,
        materials: [],
      };
      byTripKey.set(key, trip);
      materialsByTrip.set(key, new Map());
    }
    trip.shops.push(shopCard);
    trip.total_ready_qty += total_ready_qty;
    trip.total_loaded_qty += total_loaded_qty;
    // Earliest-loaded row's timestamp represents the trip; keep the min.
    if (new Date(meta.loaded_at).getTime() < new Date(trip.loaded_at).getTime()) trip.loaded_at = meta.loaded_at;

    // Cancelled shop-loads don't count toward "what actually went out" —
    // skip them so the material totals match what's physically on the truck.
    if (meta.status === 'cancelled') continue;
    const matMap = materialsByTrip.get(key)!;
    for (const b of boards) {
      const label = b.work_type_name || b.material || 'Item';
      const existing = matMap.get(label);
      if (existing) { existing.qty_ready += b.qty_ready || 0; existing.qty_loaded += b.qty_loaded || 0; }
      else matMap.set(label, { name: label, qty_ready: b.qty_ready || 0, qty_loaded: b.qty_loaded || 0 });
    }
  }

  for (const trip of byTripKey.values()) {
    trip.materials = Array.from(materialsByTrip.get(trip.key)?.values() || []).sort((a, b) => b.qty_loaded - a.qty_loaded);
  }

  return Array.from(byTripKey.values()).sort((a, b) => new Date(b.loaded_at).getTime() - new Date(a.loaded_at).getTime());
}
