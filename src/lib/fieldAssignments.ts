import { supabase } from './supabase';
import { loadFieldAssignments as loadCachedFieldAssignments, saveFieldAssignments } from './offlineDb';

export type FieldRole = 'surveyor' | 'installer';
export function isConnectivityFailure(error: unknown) {
  return typeof navigator !== 'undefined' && !navigator.onLine ||
    /network|failed to fetch|fetch failed|timeout|connection|offline/i.test(
      error instanceof Error ? error.message : String(error || ''));
}

/**
 * Canonical assignment read for the two field roles. Always filters to the
 * authenticated user and organization on the server, including pagination.
 * A local snapshot is ONLY for offline browsing; server-side permissions on
 * every photo/submission remain authoritative when connectivity returns.
 */
export async function fetchMyFieldAssignments(workerId: string, organizationId: string, role: FieldRole) {
  try {
    const all: any[] = [];
    const size = 500;
    for (let start = 0; ; start += size) {
      const { data, error } = await supabase.from('shop_assignments')
        .select('*, shops(*, clients(name))')
        .eq('organization_id', organizationId)
        .eq('user_id', workerId)
        .eq('role', role)
        .order('assigned_at', { ascending: false })
        .range(start, start + size - 1);
      if (error) throw error;
      all.push(...(data || []));
      if (!data || data.length < size) break;
    }
    // Reassignments can create historical rows. Show the latest non-declined
    // record for each shop only; historical/declined work isn't actionable.
    const latest = new Map<string, any>();
    for (const row of all) {
      if (!row.shops || latest.has(row.shop_id)) continue;
      latest.set(row.shop_id, row);
    }
    const result = Array.from(latest.values()).filter(row => row.status !== 'declined');
    try { await saveFieldAssignments(workerId, role, result); } catch (error) { console.warn('Could not cache assigned shops for offline browsing', error); }
    return result;
  } catch (error) {
    if (isConnectivityFailure(error)) {
      const saved = await loadCachedFieldAssignments(workerId, role);
      if (saved) return saved.assignments;
    }
    throw error;
  }
}


/** Apply non-financial Work Order names only to shops already assigned to this user. */
export async function loadFieldAssignments(workerId: string, organizationId: string, role: FieldRole) {
  const assignments = await fetchMyFieldAssignments(workerId, organizationId, role);
  const ids = Array.from(new Set(assignments.map((a) => a.shops?.purchase_order_id).filter(Boolean))) as string[];
  if (!ids.length) return assignments;
  const context = new Map<string, { name: string | null; po_number: string | null }>();
  try {
    for (let i = 0; i < ids.length; i += 150) {
      const { data, error } = await supabase.from('v_po_work_context').select('id,name,po_number')
        .eq('organization_id', organizationId).in('id', ids.slice(i, i + 150));
      if (error) throw error;
      for (const po of data || []) context.set(po.id, { name: po.name, po_number: po.po_number });
    }
  } catch (error) {
    if (!isConnectivityFailure(error)) throw error;
    // Preserve previously cached names if the connection drops between requests.
    const cached = await loadCachedFieldAssignments(workerId, role);
    for (const a of cached?.assignments || []) if (a.shops?.purchase_order_id && a.shops?.purchase_orders) {
      context.set(a.shops.purchase_order_id, a.shops.purchase_orders);
    }
  }
  const enriched = assignments.map((a) => ({ ...a, shops: a.shops ? {
    ...a.shops, purchase_orders: context.get(a.shops.purchase_order_id) || a.shops.purchase_orders || null,
  } : null }));
  try { await saveFieldAssignments(workerId, role, enriched); } catch { /* cache is best effort */ }
  return enriched;
}

export async function loadAssignedFieldShop(shopId: string, workerId: string, organizationId: string, role: FieldRole) {
  const assignments = await loadFieldAssignments(workerId, organizationId, role);
  const assigned = assignments.find((a) => a.shop_id === shopId);
  if (!assigned?.shops) throw new Error('This shop is not assigned to your account');
  return assigned.shops;
}
