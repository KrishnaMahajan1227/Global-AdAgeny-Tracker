/**
 * Private Supabase Storage media compatibility layer. Existing database URLs
 * remain unchanged, but private evidence is served only via short-lived signed
 * URLs checked against storage.objects RLS at issuance time. Never cache in
 * service workers or localStorage. These URLs are bearer capabilities until
 * expiry: avoid copying/sharing them outside the authorized workspace.
 */
import { forwardRef, useEffect, useState, type AnchorHTMLAttributes, type ImgHTMLAttributes } from 'react';
import { supabase } from './supabase';

const PRIVATE_BUCKETS = new Set(['survey-photos', 'design-files', 'installation-proof', 'purchase-orders']);
const SIGNED_TTL_SECONDS = 60;
const cache = new Map<string, { url: string; expires: number }>();
const pending = new Map<string, Promise<string>>();
let currentIdentity: string | null = null;

supabase.auth.onAuthStateChange((_event, session) => {
  const next = session?.user?.id ?? null;
  if (currentIdentity !== next) {
    currentIdentity = next;
    cache.clear();
    pending.clear();
  }
});

function parsePrivateStorageUrl(src: string): { bucket: string; path: string } | null {
  if (!src || src.startsWith('data:') || src.startsWith('blob:')) return null;
  try {
    const url = new URL(src, typeof window !== 'undefined' ? window.location.origin : 'https://invalid.local');
    const endpoint = new URL(import.meta.env.VITE_SUPABASE_URL);
    // Never pass arbitrary third-party URLs to the Supabase signer.
    if (url.origin !== endpoint.origin) return null;
    const match = url.pathname.match(/\/storage\/v1\/object\/(?:public|sign|authenticated)\/([^/]+)\/(.+)$/);
    if (!match) return null;
    const bucket = decodeURIComponent(match[1]);
    const path = match[2].split('/').map(decodeURIComponent).join('/');
    if (!PRIVATE_BUCKETS.has(bucket) || !path || path.includes('..')) return null;
    return { bucket, path };
  } catch { return null; }
}

/** Identifies an authenticated Supabase asset, even when its URL is a legacy public URL. */
export function isPrivateStorageUrl(src: string): boolean {
  return parsePrivateStorageUrl(src) !== null;
}

/** Prefer storage_path for legacy proofs whose persisted photo_url became stale.
 * The returned URL is NOT public access: SecureImage signs it against RLS.
 */
export function evidenceStorageUrl(bucket: 'survey-photos' | 'design-files' | 'installation-proof', storagePath?: string | null): string | null {
  if (!storagePath || storagePath.includes('..') || storagePath.startsWith('/') || /^(https?:|data:|blob:)/i.test(storagePath)) return null;
  return supabase.storage.from(bucket).getPublicUrl(storagePath).data.publicUrl;
}

export async function resolveSecureUrl(src: string, forceRefresh = false): Promise<string> {
  const parsed = parsePrivateStorageUrl(src);
  if (!parsed) return src;
  const { data: auth } = await supabase.auth.getUser();
  const user = auth.user;
  if (!user) throw new Error('Sign in required to view private evidence');
  const key = `${user.id}:${parsed.bucket}:${parsed.path}`;
  if (forceRefresh) {
    cache.delete(key);
    pending.delete(key);
  }
  const cached = cache.get(key);
  if (cached && cached.expires > Date.now()) return cached.url;
  let request = pending.get(key);
  if (!request) {
    request = (async () => {
      const { data, error } = await supabase.storage.from(parsed.bucket)
        .createSignedUrl(parsed.path, SIGNED_TTL_SECONDS);
      if (error || !data?.signedUrl) throw new Error('You do not have access to this file');
      const signedUrl = data.signedUrl;
      cache.set(key, { url: signedUrl, expires: Date.now() + 40_000 });
      return signedUrl;
    })();
    pending.set(key, request);
    void request.finally(() => { pending.delete(key); }).catch(() => undefined);
  }
  return request;
}

export function useSecureMediaUrl(src?: string | null): string | undefined {
  const [resolved, setResolved] = useState<string | undefined>(() => src && !parsePrivateStorageUrl(src) ? src : undefined);
  useEffect(() => {
    if (!src) { setResolved(undefined); return; }
    const parsed = parsePrivateStorageUrl(src);
    if (!parsed) { setResolved(src); return; }
    let live = true;
    setResolved(undefined);
    void resolveSecureUrl(src).then(url => { if (live) setResolved(url); })
      .catch(() => { if (live) setResolved(undefined); });
    return () => { live = false; };
  }, [src]);
  return resolved;
}

// A genuine missing or inaccessible file must never render as a broken-image icon.
// A lightweight local SVG fallback requires no network and discloses no private URL.
const PHOTO_UNAVAILABLE = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240" viewBox="0 0 320 240"><rect width="320" height="240" rx="12" fill="#f1f5f9"/><rect x="105" y="71" width="110" height="77" rx="8" fill="none" stroke="#94a3b8" stroke-width="5"/><path d="M115 133l27-27 20 20 15-16 28 23" fill="none" stroke="#94a3b8" stroke-width="5"/><text x="160" y="177" font-family="Arial,sans-serif" font-size="13" fill="#64748b" text-anchor="middle">Preview unavailable</text></svg>'
)}`;

const PHOTO_LOADING = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><rect width="320" height="240" fill="#f8fafc"/><text x="160" y="125" font-family="Arial,sans-serif" font-size="13" fill="#64748b" text-anchor="middle">Loading preview…</text></svg>'
)}`;

/** Signed evidence images retry once with a fresh token when a signed URL
 * expires (a common reason an approved proof looks broken later in review).
 * A genuinely missing file displays a clear fallback, not a broken icon.
 */
export const SecureImage = forwardRef<HTMLImageElement, ImgHTMLAttributes<HTMLImageElement>>(
  function SecureImage({ src, onError, ...props }, ref) {
    const safeSrc = useSecureMediaUrl(src);
    const [reissuedSrc, setReissuedSrc] = useState<string | null>(null);
    const [unavailable, setUnavailable] = useState(false);
    const [retrying, setRetrying] = useState(false);
    useEffect(() => { setReissuedSrc(null); setUnavailable(false); setRetrying(false); }, [src]);
    const activeSrc = unavailable ? PHOTO_UNAVAILABLE : reissuedSrc || safeSrc;
    return <img ref={ref} src={activeSrc || (src ? PHOTO_LOADING : undefined)} {...props} onError={event => {
      if (unavailable) return;
      if (src && isPrivateStorageUrl(src) && !retrying) {
        setRetrying(true);
        void resolveSecureUrl(src, true).then(setReissuedSrc).catch(() => { setUnavailable(true); onError?.(event); });
      } else { setUnavailable(true); onError?.(event); }
    }} />;
  }
);

/** Drop-in external/file link replacement. Non-storage URLs are unchanged. */
export const SecureAnchor = forwardRef<HTMLAnchorElement, AnchorHTMLAttributes<HTMLAnchorElement>>(
  function SecureAnchor({ href, ...props }, ref) {
    const safeHref = useSecureMediaUrl(href);
    return <a ref={ref} href={safeHref} {...props} aria-disabled={href && !safeHref ? true : props['aria-disabled']} onClick={event => {
      if (href && !safeHref) { event.preventDefault(); return; }
      props.onClick?.(event);
    }} />;
  }
);
