import { useEffect, useRef, useState } from 'react';
import { supabase } from './supabase';

// Pushes the field worker's device location to `worker_locations` every
// ~45s while `active` is true (i.e. while they have a survey/installation
// job open), so the Owner/Admin Live Field Map shows real, moving markers
// via the Supabase Realtime subscription already set up in FieldMapPage.
// This previously didn't exist anywhere in the app, which is why live
// tracking never showed anything on the owner's map.
export type LocationShareStatus = 'idle' | 'requesting' | 'sharing' | 'denied' | 'error';

const PING_INTERVAL_MS = 45_000;

export function useLiveLocationTracking(
  active: boolean,
  userId: string | undefined,
  organizationId: string | undefined
) {
  const [status, setStatus] = useState<LocationShareStatus>('idle');
  const [lastSentAt, setLastSentAt] = useState<Date | null>(null);
  const timerRef = useRef<number | null>(null);
  const stoppedRef = useRef(false);

  useEffect(() => {
    if (!active || !userId || !organizationId) {
      setStatus('idle');
      return;
    }

    stoppedRef.current = false;

    async function sendPing() {
      if (stoppedRef.current) return;
      setStatus((s) => (s === 'idle' ? 'requesting' : s));
      navigator.geolocation.getCurrentPosition(
        async (pos) => {
          if (stoppedRef.current) return;
          const { error } = await supabase.from('worker_locations').insert({
            organization_id: organizationId,
            user_id: userId,
            latitude: pos.coords.latitude,
            longitude: pos.coords.longitude,
            accuracy: pos.coords.accuracy,
            recorded_at: new Date().toISOString(),
          });
          if (!error) {
            setStatus('sharing');
            setLastSentAt(new Date());
          } else {
            setStatus('error');
          }
        },
        () => { if (!stoppedRef.current) setStatus('denied'); },
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 20000 }
      );
    }

    // Fire immediately, then on an interval — respects battery by using a
    // single fresh-position request every 45s rather than continuous
    // watchPosition, which is plenty for "where is this worker right now"
    // without draining the phone in the background.
    sendPing();
    timerRef.current = window.setInterval(sendPing, PING_INTERVAL_MS);

    return () => {
      stoppedRef.current = true;
      if (timerRef.current) window.clearInterval(timerRef.current);
      timerRef.current = null;
    };
  }, [active, userId, organizationId]);

  return { status, lastSentAt };
}

export function LocationShareIndicator({ status, lastSentAt }: { status: LocationShareStatus; lastSentAt: Date | null }) {
  if (status === 'idle') return null;
  const label =
    status === 'sharing' ? 'Location sharing active' :
    status === 'requesting' ? 'Getting location…' :
    status === 'denied' ? 'Location permission denied — sharing paused' :
    'Location sharing error — retrying';
  const color =
    status === 'sharing' ? 'bg-green-50 text-green-700 border-green-200' :
    status === 'requesting' ? 'bg-blue-50 text-blue-700 border-blue-200' :
    'bg-amber-50 text-amber-700 border-amber-200';
  return (
    <div className={`flex items-center gap-2 text-xs font-medium px-3 py-1.5 rounded-lg border ${color}`}>
      <span className={`w-2 h-2 rounded-full ${status === 'sharing' ? 'bg-green-500 animate-pulse' : 'bg-current'}`} />
      {label}
      {status === 'sharing' && lastSentAt && (
        <span className="text-[10px] opacity-70 ml-auto">Last sent {lastSentAt.toLocaleTimeString('en-IN')}</span>
      )}
    </div>
  );
}
