import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { StatusBadge } from '@/components/ui';
import type { SharedShopView } from '@/lib/types';
import { CheckCircle2, MapPin, Loader2, ImageOff } from 'lucide-react';

// Architecture v2.0 §6/§8 item 8 — the client-shareable, no-login public
// link. Deliberately outside <ProtectedRoute> (see App.tsx) and only ever
// talks to the database through the get_shared_shop_view RPC (migration
// 0049) — never a direct table query, so there's no way for this page to
// accidentally leak more than the curated fields that RPC returns
// (explicitly: no rate/₹, no PO number, no contact info, no GPS).
export default function PublicShopSharePage() {
  const { token } = useParams<{ token: string }>();

  const { data, isLoading, error } = useQuery({
    queryKey: ['shared-shop-view', token],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_shared_shop_view', { p_token: token });
      if (error) throw new Error(error.message);
      // The RPC returns a table (0 or 1 rows) — an invalid/revoked token
      // resolves to an empty result set, not a database error.
      return (data && data.length > 0 ? data[0] : null) as SharedShopView | null;
    },
    enabled: !!token,
    retry: false,
  });

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="w-8 h-8 text-blue-600 animate-spin" />
          </div>
        ) : error || !data ? (
          <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-8 text-center">
            <ImageOff className="w-10 h-10 text-slate-300 mx-auto mb-3" />
            <h1 className="text-lg font-semibold text-slate-900 mb-1">Link not found</h1>
            <p className="text-sm text-slate-500">This link may have been revoked, or the address was typed incorrectly.</p>
          </div>
        ) : (
          <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
            {data.photo_url ? (
              <img src={data.photo_url} alt={data.shop_name} className="w-full h-56 object-cover" />
            ) : (
              <div className="w-full h-32 bg-slate-100 flex items-center justify-center">
                <p className="text-sm text-slate-400">No photo yet</p>
              </div>
            )}
            <div className="p-6">
              <h1 className="text-xl font-bold text-slate-900">{data.shop_name}</h1>
              <p className="text-sm text-slate-500 flex items-center gap-1 mt-1">
                <MapPin className="w-3.5 h-3.5" /> {[data.city, data.state].filter(Boolean).join(', ') || 'Location not set'}
                {data.zone_name ? ` · ${data.zone_name}` : ''}
              </p>

              <div className="mt-5">
                <StatusBadge status={data.status} />
              </div>

              {data.total_boards > 0 && (
                <div className="mt-5">
                  <div className="flex items-center justify-between text-sm mb-1.5">
                    <span className="text-slate-500 flex items-center gap-1">
                      <CheckCircle2 className="w-4 h-4 text-green-500" /> Boards installed
                    </span>
                    <span className="font-medium text-slate-900">{data.installed_boards} / {data.total_boards}</span>
                  </div>
                  <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                    <div
                      className="h-2 bg-green-500 rounded-full transition-all"
                      style={{ width: `${Math.round((data.installed_boards / data.total_boards) * 100)}%` }}
                    />
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
        <p className="text-center text-xs text-slate-400 mt-4">Shared read-only view — no login required.</p>
      </div>
    </div>
  );
}
