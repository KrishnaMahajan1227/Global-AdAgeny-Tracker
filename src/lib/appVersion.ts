import { registerSW } from 'virtual:pwa-register';

/** Vercel emits a unique version.json per build; never read it from SW cache. */
type VersionPayload = { buildId?: string; builtAt?: string };

const CHECK_EVERY_MS = 30_000;
const IDLE_BEFORE_RELOAD_MS = 12_000;
const VERSION_URL = '/version.json';
const GUARD_KEY = 'adroute-deployment-attempts:';
let started = false;

/** Explicitly avoid replacing a running editor, unsent file or field capture.
 * A deployment may be waiting, but user data is more important than instant reload.
 */
export function deploymentIsSafeToApply(doc: Document, now: number, lastActivity: number): boolean {
  if (now - lastActivity < IDLE_BEFORE_RELOAD_MS) return false;
  if (doc.querySelector('[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]')) return false;
  if (doc.querySelector('input[type="file"]:not([disabled])') &&
      [...doc.querySelectorAll<HTMLInputElement>('input[type="file"]')].some(input => !!input.files?.length)) return false;
  if (doc.querySelector('[data-adroute-unsaved="true"], [data-adroute-uploading="true"]')) return false;
  const el = doc.activeElement;
  if (el instanceof HTMLElement && (el.isContentEditable || el.matches('textarea,input:not([type="search"]):not([type="checkbox"]),select'))) return false;
  // Active capture wizards carry data-adroute-unsaved=true even when blurred.
  // Their job queues may update automatically; active work never reloads.
  return true;
}

async function releaseOldAppShellCaches() {
  // Keep IndexedDB offline field queues untouched. SW app-shell caches alone
  // may otherwise serve the old index.html even though Vercel has deployed.
  try {
    const registrations = await navigator.serviceWorker?.getRegistrations?.();
    await Promise.all((registrations || []).filter(r => r.scope.startsWith(window.location.origin))
      .map(r => r.unregister().catch(() => false)));
  } catch { /* Safari/private mode may not expose SW APIs */ }
  try {
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith('workbox-precache-') || name === 'adroute-app-shell')
      .map(name => caches.delete(name)));
  } catch { /* Cache API might be unavailable */ }
}

/**
 * Works on any open online tab: poll noncached deployment ID, check on focus/
 * reconnect, then automatically navigate to the new build once work is safe.
 * Background Safari/PWA tabs are OS-throttled; they check upon waking.
 * A pending editing modal/file or a live field wizard is never discarded.
 */
export function startAppVersionWatcher() {
  if (!import.meta.env.PROD || started || typeof window === 'undefined') return () => undefined;
  started = true;
  let reloading = false;
  let lastActivity = Date.now();
  let pendingBuild: string | null = null;
  let checking = false;
  const bump = () => { lastActivity = Date.now(); };
  const events = ['pointerdown', 'keydown', 'touchstart', 'input', 'scroll'];
  events.forEach(event => window.addEventListener(event, bump, { passive: true }));
  // Prompt-mode SW does NOT activate/reload behind an in-progress edit.
  // The version watcher controls when a client navigates to a new deployment.
  registerSW({ immediate: true, onNeedRefresh: () => { void check(); } });

  const announcePending = () => {
    if (document.getElementById('adroute-deployment-pending')) return;
    const status = document.createElement('div');
    status.id = 'adroute-deployment-pending';
    status.setAttribute('role', 'status');
    status.textContent = 'AdRoute update ready. It will apply automatically after your current work is safe.';
    status.style.cssText = 'position:fixed;bottom:12px;left:12px;right:12px;max-width:440px;z-index:9999;background:#0f172a;color:white;padding:10px 14px;border-radius:10px;font:13px/1.45 system-ui;box-shadow:0 8px 24px #0002;pointer-events:none';
    document.body.appendChild(status);
  };

  async function applyIfSafe() {
    if (reloading || !pendingBuild || !navigator.onLine) return;
    if (!deploymentIsSafeToApply(document, Date.now(), lastActivity)) { announcePending(); return; }
    const build = pendingBuild;
    const attemptsKey = GUARD_KEY + build;
    const attempts = Number(sessionStorage.getItem(attemptsKey) || '0');
    if (attempts >= 3) return; // never enter an infinite SW/CDN loop
    reloading = true;
    sessionStorage.setItem(attemptsKey, String(attempts + 1));
    await releaseOldAppShellCaches();
    const url = new URL(window.location.href);
    url.searchParams.set('_v', build);
    window.location.replace(url.toString());
  }

  async function check() {
    if (checking || reloading || !navigator.onLine) return;
    checking = true;
    try {
      const response = await fetch(`${VERSION_URL}?t=${Date.now()}`, { cache: 'no-store', headers: { 'cache-control': 'no-cache' } });
      if (!response.ok) return;
      const remote = (await response.json()) as VersionPayload;
      const current = import.meta.env.VITE_APP_BUILD_ID as string | undefined;
      if (remote.buildId && current && remote.buildId !== current) pendingBuild = remote.buildId;
      else if (remote.buildId === current) pendingBuild = null;
    } catch { /* offline, or Vercel mid-deployment; try next time */ }
    finally { checking = false; }
    await applyIfSafe();
  }

  const versionInterval = window.setInterval(() => { void check(); }, CHECK_EVERY_MS);
  const safeInterval = window.setInterval(() => { void applyIfSafe(); }, 2_000);
  const onAwake = () => { if (document.visibilityState === 'visible') void check(); else void applyIfSafe(); };
  const onOnline = () => { void check(); };
  document.addEventListener('visibilitychange', onAwake);
  window.addEventListener('online', onOnline);
  window.addEventListener('focus', onOnline);
  window.setTimeout(() => { void check(); }, 2_000);

  return () => {
    started = false;
    window.clearInterval(versionInterval);
    window.clearInterval(safeInterval);
    events.forEach(event => window.removeEventListener(event, bump));
    document.removeEventListener('visibilitychange', onAwake);
    window.removeEventListener('online', onOnline);
    window.removeEventListener('focus', onOnline);
    document.getElementById('adroute-deployment-pending')?.remove();
  };
}
