# Adroute — Review V4: Mixed decisions and item/photo redo

## Scope and background

Based on the existing Review V3 source. This release improves **Survey Review** and **Installation Review** while retaining Phase 1–7 workflow, approval/handoff, billing and organization security rules. It adds no database schema changes.

## Why

Previously, one batch footer applied the **same** approve/redo action to every inspected shop. It was difficult to handle mixed situations (e.g., 20 approvals, 2 corrections and 1 final survey rejection) without repeat navigation. Installation evidence photographs could show status labels but could not reliably be selected independently for a correction in the inline gallery.

## Updated operator flow

1. Open Survey/Installation Review and filter by Work Order, client, installer/surveyor or city as available. Select a subset or click **Review page** to open the current paginated workset (up to 250 shops).
2. Inspect shop's photos, measurements and other work items in the existing shared evidence workspace.
3. **Approve & next** queues this shop's approval only after evidence finished loading. **Redo shop** queues a correction with a mandatory, explicit reason (can be selected even if evidence is missing). Survey also supports **Final reject** with mandatory reason. Installation uses redo, never a permanent reject.
4. Individual measurement/Work Item/photo actions are still in the evidence gallery. They call the existing item-review RPC immediately; they are separate from the *queued* shop batch. A specific installation proof photo can now be selected without inadvertently selecting every item.
5. The bounded navigator shows each queued shop's distinct decision; revisit any shop to see correction reason or undo before submission.
6. **Submit N decisions** sends *only queued* shops to existing atomic server-side RPCs using a maximum of three in-flight requests. Other shops remain pending. Any permanently rejected surveys require an additional explicit confirmation before execution.
7. Successful shops are removed from the workset, failed shops and their exact error/reason remain to retry. Existing audit logs, company-approval checks, stage handoffs and role/RLS checks still apply.

## Role and data policy

- Only Owner/Admin (as authorized in existing DB RPC policies) may make final decisions; no new role grants.
- Survey permanent rejection uses the existing `reject_survey_shop_final` RPC; redo uses `review_apply` with `decision='redo'`; installations never invoke the final rejection RPC.
- Final work approval still requires the Phase 2 company-approval handoff when applicable. The frontend never updates shop statuses directly.
- Corrections are linked to the exact measurement, work item or photo in the existing `field_review_decisions` / `field_corrections` tables. Saved notes display next to status badges; review tabs show shop-level notes.
- Approved evidence is *not* made billable by mere selection/queuing.
- Queue data lives in memory until submitted; closing a workspace with unsubmitted decisions asks for confirmation.
- Realtime invalidates review queues on survey, installation and item review events. Existing 15-second polling fallback remains.

## Limits / deployment gate

- List queries are **server-paginated**. Shops beyond the current 250-item page require another workset; thousands of photos are never loaded simultaneously in one browser tab.
- Failed requests are not automatically retried with blind writes. The operator can see failures and retry after checking the error.
- Production database migrations: **none new**. Previously shipped Phase 1–4 and review RPC migrations must already be applied (check with `supabase migration list`).
- Source-level tests are not equivalent to a live browser/Supabase end-to-end test. Full `npm ci`/Vite build was unavailable locally because an uncached transitive dependency (`zip-stream`) prevented offline npm installation.

## Windows PowerShell deployment commands

Keep your own `.env` outside ZIP and never commit credentials. Stop the running Vite server before npm installation (Windows locks esbuild/Rollup binaries).

```powershell
cd D:\\DarshanAdField
npm ci --include=dev
npm run typecheck
npm run build
node scripts/verify-review-v4-decisions.cjs
node scripts/verify-review-workspace-v3.cjs
node scripts/verify-review-workspace-v2.cjs
node scripts/verify-fast-review-workspace.cjs
node scripts/verify-runtime-jsx-symbols.cjs
npx supabase migration list
```

`supabase db push` is **not required just for V4**. If migrations are pending from earlier phases, back up/validate in staging before pushing to production.

## Required staging acceptance matrix

- 1 shop with 1 measurement: approval, redo reason and final survey rejection.
- 1 shop with 5 measurements / several annotated photos: redo precisely one measurement or survey photo; other evidence remains unaffected.
- 1 shop with 5 installation Work Items: correct proof photos, reject one *installation photo* with reason, do not redo the other four approved work items.
- 3+ shops mixed: A approve, B redo, C reject survey; submit once; verify correct table statuses, notes, audit, assignments and handoffs.
- Installation mixed: A approve, B redo; rejected tab shows redo and reason; installer receives only assigned corrections.
- 250-shop page, 1000+ organization: navigate/search, handle missing evidence, approve only queued items, no frozen UI; next page remains visible.
- Two reviewers concurrently: stale data/approval gates reject invalid operations; failed decisions retained for retry.
- New Work Orders without company approval: approval is blocked server-side; historical orders use their existing gate policy.
- Offline, intermittent network and partial failure: no silent approve, per-shop feedback, safe resume.
- Same browser Owner/Admin to another role: no cached evidence or privileged approval access.
- Real device viewport: 375px mobile, tablet and desktop with long shop names and oversized images.
- Full source build and authenticated Supabase tests required before production GO.
