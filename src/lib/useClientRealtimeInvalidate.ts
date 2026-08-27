import { useEffect } from 'react';
import { useQueryClient, type QueryKey } from '@tanstack/react-query';
import { supabase } from './supabase';

/**
 * Phase 6 — realtime polish for the Client Organization portal. Deliberately
 * NOT a reuse of lib/useRealtimeInvalidate.ts: that hook always filters
 * Postgres Changes by `organization_id=eq.<id>`, which on every table a
 * client portal page reads (purchase_orders, shops, invoices) is the
 * AGENCY's org id, not this client org's id — so it could never match for
 * a client_admin/client_viewer session no matter what id was passed in.
 *
 * purchase_orders is the one table in play that actually carries a
 * `client_org_id` column, so this subscribes to that instead. It was
 * already added to the `supabase_realtime` publication back in migration
 * 0020 (agency screens already rely on it), and Realtime only ever
 * broadcasts a row change to a client whose RLS SELECT policy would
 * return that row anyway — purchase_orders_select's client-org branch
 * (migration 0037) is exactly the condition being filtered on here, so
 * this can't leak another client org's POs.
 *
 * Deeper pipeline milestones (a specific site getting surveyed/installed,
 * an invoice being raised/paid) don't have a client_org_id column to
 * filter Realtime on directly — those reach the client via the
 * notification triggers added in migration 0042 instead (the
 * NotificationBell already has its own Realtime subscription, scoped by
 * user_id, which works for any role including a client). The 20-30s
 * polling every client query already uses (`refetchInterval`) is what
 * catches up the actual page data once that notification lands.
 */
export function useClientRealtimeInvalidate(clientOrgId: string | undefined, queryKeys: QueryKey[]) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!clientOrgId) return;

    const invalidateAll = () => {
      for (const key of queryKeys) {
        queryClient.invalidateQueries({ queryKey: key });
      }
    };

    const channel = supabase
      .channel(`rt-client-po-${clientOrgId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'purchase_orders', filter: `client_org_id=eq.${clientOrgId}` },
        invalidateAll
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientOrgId, JSON.stringify(queryKeys)]);
}
