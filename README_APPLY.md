# Adroute — Design & Production One-click UX Patch (29 October 2026)

**Patch-only release.** This ZIP intentionally includes just the two modified frontend pages and one new verification script. It is built from the user's uploaded `supabase.zip`, which also contains current `src/pages` files and database migrations through `0100`. All existing `supabase/` SQL files, authentication/role definitions, billing, company approval code and other pages remain untouched. **No new Supabase migration.**

## Replace exactly these files

1. `src/pages/DesignerPage.tsx`
2. `src/pages/ProductionPage.tsx`
3. Add `scripts/verify-design-production-oneclick.cjs`

Don't replace the entire `src/` or `supabase/` folders. Back up your two existing page files before copying. Preserve `.env` and `package-lock.json`. If your live working copy has newer edits than the uploaded files, compare/merge these two pages rather than overwriting them blindly.

## Changes

### Design Studio
- Task-first and folder-based browsing from the uploaded version are retained.
- **Upload & Send for Review** is the default upload action *only when every currently pending/eligible board is included and no board still awaits survey approval*. Otherwise files save as design draft; the existing Send for Review button remains.
- Active-state check immediately before file upload; finalized task is rejected before writing more evidence.
- A single guarded design-task update places a fully covered upload into the existing `in_review` queue; original reviewer notification is reused.
- Owner/Admin review button advances to the next pending design **after** a successful approved decision; the existing approval/company gates remain in force. "Approve & Next" does not automatically approve the next task.
- Responsive row actions wrap on small devices.

### Production Studio
- **Log Qty** action opens the first unfinished board in the existing item editor, with materials and actual-quantity inputs visible; no guessed quantity is posted automatically.
- **Complete now** uses the pre-existing `phase3_complete_production` Supabase RPC, only when actual board quantities/materials are ready and the order has at least one board.
- When installation is required, instant completion is allowed only when exactly **one** active installer exists. With multiple installers (or when installer roster has not loaded), the existing assignment confirmation form opens.
- Supply-only / installation-not-required orders can be completed without choosing an installer, subject to the same RPC validation.
- Pending/completed/hold/empty/quantity-incomplete/materials-incomplete orders cannot use the direct completion shortcut.
- Completion and error views refresh through existing React Query invalidation and realtime subscriptions.

## Windows PowerShell

```powershell
cd D:\DarshanAdField
# Stop the running Vite server (Ctrl+C) and back up these two files first.
New-Item -ItemType Directory -Force D:\AdrouteBackups | Out-Null
Copy-Item .\src\pages\DesignerPage.tsx D:\AdrouteBackups\DesignerPage.before-oneclick.tsx
Copy-Item .\src\pages\ProductionPage.tsx D:\AdrouteBackups\ProductionPage.before-oneclick.tsx
# Extract this ZIP over the project root, preserving its src/pages and scripts subpaths.

# If deps are already installed successfully, you do not have to rerun npm ci.
npm run typecheck
npm run build
node scripts/verify-design-production-oneclick.cjs
node scripts/verify-taskfirst-design-production-dispatch.cjs
node scripts/verify-phase3-handoffs.cjs
npm run dev
```

No `supabase db push` is needed for this patch. The existing Phase 3 `0099` migration needs to be applied for atomic Production completion, as in earlier releases.

## Manual staging acceptance

- **Designer:** 1 shop, 3 ready boards, all 3 selected → upload once → task enters `In Review`, same Owner/Admin queue updates.
- **Designer:** 1 of 3 boards not selected → upload stays draft; no premature approval request. One board unapproved by Survey → no auto handoff.
- **Designer:** task already production-approved from another session → upload is blocked; do not create a new version.
- **Owner/Admin:** approve one design with another pending → next design opens. Redo/company-approval failure must **not** advance.
- **Production person:** tap Log Qty; actual quantity and material checklist open on the correct Work Item; no automatic quantity creation.
- **Owner/Admin:** all quantities and materials ready, Supply Only → Complete now, then enters dispatch queue.
- **Owner/Admin:** installation-required with exactly one active installer → Complete now and notify that installer; with two installers → explicit selection, no arbitrary assignment.
- **Owner/Admin:** pending materials/zero work items/incomplete quantity → cannot use Complete now; server still rejects any invalid status change.
- **Security:** Designer cannot approve design; Printing user cannot use privileged Owner/Admin UI; company approval required by PO remains mandatory.
- **Realtime:** two sessions open; perform approval/completion in one and observe refreshed queues, status, Work Orders, notifications.

## Test status

- 37 new focused source/logic checks pass.
- 23 existing `verify-*.cjs` regression suites pass (Phase 1–7, Design/Production V5/V6, Review, Billing and JSX symbol checks).
- Updated Design + Production TSX parse successfully using TypeScript.
- **Full Vite build and browser-connected Supabase E2E are not verified here:** `npm ci --offline` is blocked by missing `zip-stream@4.1.1` in the environment npm cache. Run the commands above on a fully installed local/staging setup before production.

## Remaining known limitations

The existing Design version upload uses multiple browser writes (Storage, design_versions, links, status). This patch reduces clicks but does **not** convert that workflow to a single backend transaction. Network interruption can still require manual reconciliation; do not repeatedly upload blindly after a failed request. Concurrent invoice creation is outside this patch.
