# Automatic deployment refresh

- Every production build emits `/version.json` with a unique build id.
- The same build id is compiled into the running app.
- Open clients check the deployment version every 60 seconds, when the tab becomes visible, and when connectivity returns.
- On a real version change the waiting service worker is activated and the page reloads once automatically.
- A session guard prevents reload loops.
- `version.json` is fetched with `no-store` and is intentionally excluded from Workbox precache.
- Supabase storage changed from CacheFirst/30 days to NetworkFirst/1 day so newly replaced evidence is not hidden behind stale media cache while offline fallback remains available.
- Service workers are disabled in Vite development to prevent stale local bundles.
