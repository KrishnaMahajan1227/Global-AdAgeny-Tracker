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

export async function resolveSecureUrl(src: string): Promise<string> {
  const parsed = parsePrivateStorageUrl(src);
  if (!parsed) return src;
  const { data: auth } = await supabase.auth.getUser();
  const user = auth.user;
  if (!user) throw new Error('Sign in required to view private evidence');
  const key = `${user.id}:${parsed.bucket}:${parsed.path}`;
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

/** Drop-in <img> replacement for DB evidence URLs, preserving native image props. */
export const SecureImage = forwardRef<HTMLImageElement, ImgHTMLAttributes<HTMLImageElement>>(
  function SecureImage({ src, ...props }, ref) {
    const safeSrc = useSecureMediaUrl(src);
    return <img ref={ref} src={safeSrc} {...props} />;
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
