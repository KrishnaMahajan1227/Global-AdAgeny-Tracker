# Adroute — Design & Production V7 (Changed Files Only)

## Scope
This ZIP contains **only two updated React screens**, one targeted verification script and these instructions. Based on the previously delivered 29 October 2026 One-Click update (and uploaded `supabase.zip` source). It is **not** a replacement for the full project or a database migration.

## What changed

**Designer (`src/pages/DesignerPage.tsx`)**
- Browse or drag/drop multiple artwork files through the same upload pipeline; skip duplicate selected files and reject unsupported types.
- Default action is **Upload & Send for Review** only when every eligible board is covered. Incomplete designs stay as drafts; **Save draft instead** remains available.
- Artwork source (agency vs company-supplied) and optional notes are under one disclosure, retaining the existing default without extra required fields.
- After a **successful full design handoff**, open the next assigned pending design on the current page, if one exists. Partial drafts do not auto-advance.
- Owner/Admin review, correction, company-approval checks, PDF/PPT, folders, client work scope and server permissions remain in place.

**Production (`src/pages/ProductionPage.tsx`)**
- **Record Qty** opens a focused *single-shop/multi-board workbench*, instead of expanding the shop and editing each board separately.
- Enter actual quantities for any number of boards, or explicitly use planned quantity as an input helper **only if it was really produced**. Nothing is auto-recorded as produced on opening the screen.
- One **Save changed quantities** processes only edited boards, with individual failure messages. Successful board inputs are retained as saved and not resent on retry.
- The existing single-board editor uses the same validation/write helper; existing requested and approved quantities stay intact on updates.
- For selected production orders, **Complete** proceeds directly only when every order is nonempty, quantity-complete, material-ready and the installer choice is unambiguous. Otherwise, the existing modal/assignment form opens.
- Final completion still calls the existing `phase3_complete_production` RPC: server role, quantity, materials, idempotency, approval and handoff gates are not bypassed.

## Apply (Windows PowerShell)

Stop Vite/dev server first. Back up the two existing source files or commit the current working tree. Extract the ZIP **into the existing project directory** preserving paths:

```powershell
cd D:\DarshanAdField
Copy-Item src\pages\DesignerPage.tsx src\pages\DesignerPage.tsx.before-v7
Copy-Item src\pages\ProductionPage.tsx src\pages\ProductionPage.tsx.before-v7
Expand-Archive -Path "D:\Downloads\Adroute_Design_Production_V7_Changed_Files.zip" -DestinationPath "D:\DarshanAdField" -Force
npm ci --include=dev
npm run typecheck
npm run build
node scripts/verify-design-production-workbench-v7.cjs
npm run dev
```

Change the Downloads path to where you saved the archive. If packages are already properly installed, do **not** run `npm ci` unnecessarily. If Windows locks `esbuild.exe`, stop running Vite/Node processes before reinstalling. Preserve `.env`, `package-lock.json` and all other project files.

## Staging acceptance checklist

- Designer: one board / many boards; one artwork / multiple files; drag/drop; duplicate file selection; company-provided artwork; partial draft; approved artwork immutable; send for company review; automatic next assigned shop only after success.
- Owner/Admin: design review, company approval check, revision and production assignment unaffected.
- Printing: one board/many boards in one shop; quantity 0/partial/full/above-plan; materials pending, locked items, failed writes then selective retry; production completion with supply-only/no installer/single installer/multiple installers.
- Bulk: selected fully-ready orders finish using existing atomic RPC; mixed incomplete orders open the existing review dialog, leaving unrelated orders unchanged.
- Realtime: run Designer, Owner and Printing in separate authenticated sessions; confirm updates and task counts without refresh; test interrupted connection and retry.
- Security: employee from another organization cannot fetch or mutate records; only Owner/Admin can mark Production completed. Check invoices/measurements stay consistent.

## Deployment and limits

- **No new Supabase migration**. Existing Phase 1–4 migrations, especially Phase 3 atomic handoff RPC, must already be applied.
- Source checks passed, including deterministic Supabase payload simulations. **Full Vite build and live authenticated end-to-end execution were not available in this environment**, so a staging build and role-based browser tests are required before production rollout.
- Individual quantity logging still performs separate `production_items` and `work_items` writes, as in the existing app. The new workbench reports partial failures and retries selectively; it does **not** make multiple-board writes an all-or-nothing database transaction. A future single RPC can provide atomic multi-board writes after schema/staging verification.
