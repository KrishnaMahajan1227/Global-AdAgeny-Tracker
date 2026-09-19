import { registerSW } from 'virtual:pwa-register';

type VersionPayload = { buildId?: string; builtAt?: string };

const CHECK_EVERY_MS = 30_000;
const IDLE_BEFORE_RELOAD_MS = 8_000;
const VERSION_URL = '/version.json';
const GUARD_KEY = 'adroute-reload-attempts';
let reloading = false;
let lastActivity = Date.now();

async function wipeCachesAndWorkers() {
  try {
    const regs = await navigator.serviceWorker?.getRegistrations?.();
    await Promise.all((regs || []).map((r) => r.unregister().catch(() => false)));
  } catch { /* ignore */ }
  try {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
  } catch { /* ignore */ }
}

/**
 * Keeps every open client (browser tab or installed PWA) on the newest deployed build, with no manual refresh:
 *  - the service worker skips waiting and claims clients immediately,
 *  - /version.json (never cached) is polled every 30 s and on focus / reconnect,
 *  - when a newer build exists: all caches + old workers are wiped and the page reloads with a cache-busting URL.
 * The reload waits until the user has been idle for a few seconds so a form/photo in progress is not interrupted.
 */
export function startAppVersionWatcher() {
  if (!import.meta.env.PROD) return () => undefined;

  const bump = () => { lastActivity = Date.now(); };
  ['pointerdown', 'keydown', 'touchstart', 'input', 'scroll'].forEach((e) => window.addEventListener(e, bump, { passive: true }));

  const updateSW = registerSW({
    immediate: true,
    onRegisteredSW(_swUrl, registration) {
      window.setInterval(() => registration?.update().catch(() => undefined), CHECK_EVERY_MS);
    },
    onNeedRefresh() { void reloadWhenIdle('sw'); },
  });

  async function reloadWhenIdle(build: string) {
    if (reloading) return;
    const attempts = Number(sessionStorage.getItem(GUARD_KEY + build) || '0');
    if (attempts >= 3) return; // never loop
    const wait = () => new Promise<void>((resolve) => {
      const t = window.setInterval(() => {
        if (Date.now() - lastActivity >= IDLE_BEFORE_RELOAD_MS || document.visibilityState === 'hidden') { window.clearInterval(t); resolve(); }
      }, 1000);
    });
    await wait();
    reloading = true;
    sessionStorage.setItem(GUARD_KEY + build, String(attempts + 1));
    await updateSW(true).catch(() => undefined);
    await wipeCachesAndWorkers();
    const url = new URL(window.location.href);
    url.searchParams.set('_v', build);
    window.location.replace(url.toString());
  }

  const check = async () => {
    if (reloading || !navigator.onLine) return;
    try {
      const response = await fetch(`${VERSION_URL}?t=${Date.now()}`, { cache: 'no-store', headers: { 'cache-control': 'no-cache' } });
      if (!response.ok) return;
      const remote = (await response.json()) as VersionPayload;
      const current = import.meta.env.VITE_APP_BUILD_ID as string | undefined;
      if (!remote.buildId || !current || remote.buildId === current) return;
      void reloadWhenIdle(remote.buildId);
    } catch { /* offline / mid-deploy: retry next tick */ }
  };

  const interval = window.setInterval(check, CHECK_EVERY_MS);
  const onVisible = () => document.visibilityState === 'visible' && void check();
  const onOnline = () => void check();
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('online', onOnline);
  window.addEventListener('focus', onOnline);
  window.setTimeout(check, 2_000);

  return () => {
    window.clearInterval(interval);
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('online', onOnline);
    window.removeEventListener('focus', onOnline);
  };
}
