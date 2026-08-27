import { useState, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { Bell, CheckCheck } from 'lucide-react';

/**
 * The bell in the desktop header used to be a plain, unwired <button> — it
 * never showed anything, even though survey/design/production events were
 * already being written to `notifications` for Owner/Admin (see
 * syncManager.ts, DesignerPage.tsx, ProductionPage.tsx). So the moment a
 * survey was submitted, a real notification row existed in the database
 * but there was nowhere in the Admin/Owner UI that ever displayed it —
 * the only way to find out was to already know to check /survey-review.
 *
 * This makes the bell functional: live unread count (Realtime + a short
 * poll fallback, same pattern as useRealtimeInvalidate), a dropdown list,
 * and clicking a notification marks it read and navigates to its `link`
 * (e.g. /survey-review) if it has one.
 */
export function NotificationBell() {
  const { profile } = useAuth();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const { data: notifications } = useQuery({
    queryKey: ['admin-notifications', profile?.id],
    queryFn: async () => {
      const { data } = await supabase
        .from('notifications')
        .select('*')
        .eq('user_id', profile!.id)
        .order('created_at', { ascending: false })
        .limit(30);
      return data || [];
    },
    enabled: !!profile?.id,
    refetchInterval: 20000,
  });

  useEffect(() => {
    if (!profile?.id) return;
    const channel = supabase
      .channel(`notif-bell-${profile.id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'notifications', filter: `user_id=eq.${profile.id}` },
        () => queryClient.invalidateQueries({ queryKey: ['admin-notifications', profile.id] })
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [profile?.id, queryClient]);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  const markReadMutation = useMutation({
    mutationFn: async (id: string) => {
      await supabase.from('notifications').update({ is_read: true }).eq('id', id);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin-notifications', profile?.id] }),
  });

  const markAllReadMutation = useMutation({
    mutationFn: async () => {
      const unreadIds = (notifications || []).filter((n) => !n.is_read).map((n) => n.id);
      if (unreadIds.length === 0) return;
      await supabase.from('notifications').update({ is_read: true }).in('id', unreadIds);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin-notifications', profile?.id] }),
  });

  const unreadCount = (notifications || []).filter((n) => !n.is_read).length;

  function handleClick(n: any) {
    if (!n.is_read) markReadMutation.mutate(n.id);
    setOpen(false);
    if (n.link) navigate(n.link);
  }

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="relative p-2 text-slate-400 hover:text-slate-600"
        aria-label="Notifications"
      >
        <Bell className="w-5 h-5" />
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-80 max-h-96 overflow-y-auto bg-white rounded-xl shadow-lg border border-slate-200 z-50">
          <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100 sticky top-0 bg-white">
            <p className="font-semibold text-slate-900 text-sm">Notifications</p>
            {unreadCount > 0 && (
              <button
                onClick={() => markAllReadMutation.mutate()}
                className="flex items-center gap-1 text-xs text-blue-600 hover:underline"
              >
                <CheckCheck className="w-3.5 h-3.5" /> Mark all read
              </button>
            )}
          </div>
          <div className="divide-y divide-slate-100">
            {(notifications || []).map((n) => (
              <button
                key={n.id}
                onClick={() => handleClick(n)}
                className={`w-full text-left px-4 py-3 hover:bg-slate-50 transition ${!n.is_read ? 'bg-blue-50/50' : ''}`}
              >
                <div className="flex items-start gap-2">
                  {!n.is_read && <span className="w-1.5 h-1.5 rounded-full bg-blue-600 mt-1.5 flex-shrink-0" />}
                  <div className="flex-1 min-w-0">
                    <p className={`text-sm ${!n.is_read ? 'font-semibold text-slate-900' : 'text-slate-700'}`}>{n.title}</p>
                    <p className="text-xs text-slate-500 mt-0.5">{n.message}</p>
                    <p className="text-[11px] text-slate-400 mt-1">{new Date(n.created_at).toLocaleString('en-IN')}</p>
                  </div>
                </div>
              </button>
            ))}
            {(!notifications || notifications.length === 0) && (
              <div className="px-4 py-8 text-center">
                <Bell className="w-8 h-8 text-slate-300 mx-auto mb-2" />
                <p className="text-sm text-slate-400">No notifications yet</p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
