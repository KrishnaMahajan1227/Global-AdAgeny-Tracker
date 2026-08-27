import { useEffect } from 'react';
import { useQueryClient, type QueryKey } from '@tanstack/react-query';
import { supabase } from './supabase';

/**
 * Subscribes to Postgres changes (via Supabase Realtime) for one or more
 * tables, scoped to the current organization, and invalidates the given
 * React Query keys whenever a row changes — so queue screens (Survey
 * Review, Design Queue, Production Queue, Dashboard, Shops list) update
 * live the moment a survey is submitted / a design is approved / etc,
 * instead of only showing stale data until the tab is manually reloaded.
 *
 * Also polls on an interval as a safety net: if Realtime is ever disabled
 * for the Supabase project (a per-project toggle, separate from the
 * `supabase_realtime` publication set up in migrations), this still
 * guarantees the screen catches up within `pollMs`.
 */
export function useRealtimeInvalidate(
  tables: string[],
  orgId: string | undefined,
  queryKeys: QueryKey[],
  pollMs: number = 15000
) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!orgId) return;

    const invalidateAll = () => {
      for (const key of queryKeys) {
        queryClient.invalidateQueries({ queryKey: key });
      }
    };

    const channel = supabase.channel(`rt-${tables.join('-')}-${orgId}`);
    for (const table of tables) {
      channel.on(
        'postgres_changes',
        { event: '*', schema: 'public', table, filter: `organization_id=eq.${orgId}` },
        invalidateAll
      );
    }
    channel.subscribe();

    const interval = setInterval(invalidateAll, pollMs);

    return () => {
      clearInterval(interval);
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tables.join(','), orgId, JSON.stringify(queryKeys), pollMs]);
}
