import { registerSW } from 'virtual:pwa-register';

type VersionPayload = { buildId?: string; builtAt?: string };

const CHECK_EVERY_MS = 60_000;
const VERSION_URL = '/version.json';
let reloading = false;

/**
 * Keeps already-open clients on the newest deployed bundle.
 * version.json is deliberately fetched with no-store and is not precached by Workbox.
 * A changed build id triggers one controlled reload; the sessionStorage guard prevents loops.
 */
export function startAppVersionWatcher() {
  if (!import.meta.env.PROD) return () => undefined;

  const updateSW = registerSW({
    immediate: true,
    onOfflineReady() {
      console.info('AdRoute is ready for offline use.');
    },
    onRegisteredSW(_swUrl, registration) {
      // Ask the browser for a fresh service worker periodically as well.
      window.setInterval(() => registration?.update().catch(() => undefined), CHECK_EVERY_MS);
    },
  });

  const check = async () => {
    if (reloading || !navigator.onLine) return;
    try {
      const response = await fetch(`${VERSION_URL}?t=${Date.now()}`, {
        cache: 'no-store',
        headers: { 'cache-control': 'no-cache' },
      });
      if (!response.ok) return;
      const remote = (await response.json()) as VersionPayload;
      if (!remote.buildId) return;

      const current = import.meta.env.VITE_APP_BUILD_ID as string | undefined;
      if (!current || remote.buildId === current) {
        sessionStorage.removeItem('adroute-reload-for-build');
        return;
      }

      // Never reload twice for the same deployment, even if the old SW briefly serves again.
      if (sessionStorage.getItem('adroute-reload-for-build') === remote.buildId) return;
      sessionStorage.setItem('adroute-reload-for-build', remote.buildId);
      reloading = true;

      // Activate a waiting SW first, then load the new hashed JS/CSS bundle.
      await updateSW(true).catch(() => undefined);
      window.location.reload();
    } catch {
      // Offline / transient deployment window: keep current app and retry later.
    }
  };

  const interval = window.setInterval(check, CHECK_EVERY_MS);
  const onVisible = () => document.visibilityState === 'visible' && void check();
  const onOnline = () => void check();
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('online', onOnline);
  window.setTimeout(check, 4_000);

  return () => {
    window.clearInterval(interval);
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('online', onOnline);
  };
}
