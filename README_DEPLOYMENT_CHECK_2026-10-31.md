# Darshan Ad Agency — Verify that the correct source is LIVE

**Release marker:** `Work Orders · v2026.10.31.3`

## What the screenshot proves

The screenshot of the page titled **Campaigns**, with **Add Campaign** and a table showing **My Campaign / Client Campaign**, exactly matches the *previous* project source (`ShopsPages.tsx` previously contained the literal "Your own campaigns, plus every client campaign..."). It is absent from this source. Therefore the browser is running a different/older frontend build, or has an older PWA cached, or the host redeployed an outdated bundle. A ZIP in the chat **does not automatically replace a deployed website**.

## Deploy this release (Vite/React; Vercel-compatible)

1. Back up the working website deployment and DB. Preserve your real environment variables (`VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` or `VITE_SUPABASE_ANON_KEY`, and any Maps key). This ZIP deliberately contains no real `.env` or secrets.
2. Unzip **this release** into your actual production project/repository, replacing the old frontend source. Be sure the *hosting service* builds from this latest commit/folder, not an earlier repository branch or old deployment ID.
3. In a network-enabled CI/build machine run `npm ci`, then `npm run typecheck`, `npm run build`, `npm run verify:release` and `npm run verify:dist`. If any step fails, fix it first; do not deploy a failed build. This environment could not install dependencies, so the full build has **not** been verified here.
4. Deploy the newly generated `dist/` as the site's static frontend. For Vercel **Framework Preset: Vite**, **Build Command: `npm run build`**, **Output Directory: `dist`**, correct root directory, and same environment variables. If your hosting builds directly from Git, deploy the new commit rather than attempting to upload only the ZIP file.
5. Run `node scripts/verify-live-release.cjs https://YOUR-ACTUAL-DOMAIN` from the source directory. It fetches `/version.json` without credentials and requires `release: "2026.10.31.3"` and `features: { "directWorkOrders": true, "campaignsModule": false }`.
6. In browser, check the bottom of the agency and client sidebars for the small **Work Orders · v2026.10.31.3** marker. Verify `/campaigns` redirects to `/purchase-orders` and `/client/campaigns` redirects to `/client/work-orders`, then confirm the Campaigns option is absent in both navs.

## If screenshot still shows the old screen after the new release verifies

- Open in a private/incognito window to distinguish a stale local PWA from a still-old server build.
- Try a hard refresh (`Ctrl+Shift+R` / `Cmd+Shift+R`). If needed, use browser DevTools > Application > Service Workers > **Unregister** the old worker, then reload. Reopening an installed PWA may require closing its prior tab/window. **Do not indiscriminately click "Clear site data"**: survey or installation field workers may have unsynced offline drafts/photos in IndexedDB. First ensure offline uploads are successfully synced.
- Check that the actual domain routes to the same hosting project, branch and deployment; `/version.json` must be JSON, not fallback HTML. Check `sw.js` and `index.html` are served with no-cache headers as configured in `vercel.json`.
- If `/version.json` shows this release but a fresh incognito session still has Campaigns UI, treat that as an invalid/mixed deployment. Roll back to a consistent release and investigate CDN/asset mismatch before admitting new writes.

## Data preservation and limits

- No DB campaign, project, purchase-order, billing, historical record or storage data is deleted here.
- `campaign_id`/`project_id` fields are retained to keep historical records readable. Legacy route redirects do not modify data.
- Source syntax, JSX symbol, Campaign-removal and Production-completion checks pass offline. A full Vite build, live Supabase RLS and browser end-to-end tests are still **required** on staging before declaring production-ready.
- Do not apply migrations `0103`/`0104` twice: review your Supabase migration history first; follow the prior release README for those migrations.
