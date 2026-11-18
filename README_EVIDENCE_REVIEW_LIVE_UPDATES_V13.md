# AdRoute — Installation Evidence, Design Review & Live Deployment v13

Base: AdRoute_Design_Review_Multishop_Full_Updated_Project.zip (includes migrations through 0120).
Release marker: 2026.11.18.2. No NEW database schema migration is included in v13.

## What changed

1. **Installation Detail:** One work-item card combines size, linked survey, all CURRENT approved design files (including front/back PDFs and image artwork from the same upload batch), and linked installation proofs. The exact work-item/approved-batch selection rule matches Production. An old shared design remains on a board only where it is still the latest approved mapping.
2. **No duplicate approval overlays:** Approved work-item status stays on the work-item heading; individual photo thumbnails do not also display APPROVED. Targeted photo Redo is still available. Non-required historical company approval panel is hidden, without removing mandatory approval gates.
3. **Missing image / signed token:** Prefer correct storage path where present, sign through Supabase Storage/RLS, refresh expired signed URLs on error and show a readable preview fallback if inaccessible. PDF artwork opens as a file rather than a broken image. Missing files cannot be recovered by UI code; investigate Storage/RLS if fallback persists.
4. **Designer review:** Correction checkbox is visually aligned with the same board's mapped artwork and size; artwork previews don't disappear on the first expired signed URL.
5. **Performance:** Stable installation thumbnails avoid remounting the entire evidence grid when the reviewer changes a selection. The installation design query requests approved versions and required columns only.
6. **Live deployments:** A new Vercel build is detected via no-cache /version.json polling every 30 seconds and upon focus/online. App shell is refreshed automatically once idle; modals, selected files, active field survey/installer capture and focused editors block unsafe reload. Offline IndexedDB evidence is retained. A banner informs the user while a safe point is pending.

## Important limitations

- Browsers can suspend background tabs/PWAs and offline clients cannot receive a deployment immediately. They check on foreground/reconnect. No browser can guarantee instant updates to a suspended device.
- The automatic update avoids interrupting open work. A field wizard or modal must finish/close before the updated build is applied. Never force reload with unsaved evidence.
- Some legacy photo files may actually be missing from Storage or blocked by Supabase RLS; those require investigation in the real environment.
- Source-level and mocked runtime tests passed. `npm run build` was not verified here: the environment lacks Vite, and npm dependency install failed. Real-browser Vercel + Supabase end-to-end checks remain mandatory.
- The broader `npm run verify:release` suite retains 4 historical Campaign/deployment source-pattern failures unrelated to this change. Don't claim that it passes.

## Deployment — Windows PowerShell

1. Make a Git backup/commit of your current live source. Extract the FULL ZIP, then copy its CONTENTS into `D:\DarshanAdField` (not a second nested project directory). Or extract the Patch ZIP directly into that project root and overwrite matching paths. Do not copy a `.env` from this archive: local environment variables belong in your existing secure environment.
2. In PowerShell:

```powershell
cd D:\DarshanAdField
npm ci
npm run typecheck
npm run build
node scripts/verify-evidence-live-update-v13.cjs
node scripts/verify-design-review-v12-multishop.cjs
node scripts/verify-fast-review-workspace.cjs
npm run verify:security
```

3. If all pass, deploy via your connected Git/Vercel project. `git status`, `git add -A`, `git commit -m "Fix evidence preview and safe live updates"`, `git push`. Verify the Vercel production deployment succeeded; the application cannot deploy itself.
4. NO `supabase db push` is required for these v13-only changes. If migrations 0119 or 0120 are still pending from the previous release, inspect `npx supabase migration list --linked` and `npx supabase db push --linked --dry-run`, then apply only on the correct linked Supabase database with `npx supabase db push --linked`.
5. On staging: verify a shop with one board, one shop with multiple boards, one board with front/back artwork, multiple selected shops, a shared artwork revised for only one board, old approved installation photos, PDF images, a deliberately inaccessible photo, Survey + Designer + Installation review/redo, and one user editing on mobile while a new Vercel build is deployed. Test Chrome, Edge, Safari and the installed PWA on real devices where accessible.

## No behavior changes

Roles, permissions, designer's upload responsibilities, approval RPC, survey and installation decision RPC, Supabase schema, assignments and fulfillment handoffs are not altered in this release. Only related evidence UI, secure-media fallback, and safe deployment watcher were changed.
