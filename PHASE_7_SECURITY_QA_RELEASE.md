# Adroute Phase 7 — Security, QA & Release Readiness

## What is implemented in this ZIP

- **Auth-session isolation** (`src/lib/auth.tsx`): clear React Query caches on user identity change/sign-out, ignore stale profile-load responses from old users, and prevent older session bootstrap from overwriting newer auth events. Unauthorized routes stay blocked until the active profile is loaded.
- **Error Boundary privacy** (`src/components/ErrorBoundary.tsx`): raw exception messages only in development, and no misleading claim that all unsaved work was preserved.
- **Field confirmations bound to active account** (`src/lib/fieldDialogs.tsx`, `src/App.tsx`): pending field confirmation dialogs auto-cancel on logout/user switch; no stale approval action can follow the next account.
- **Private evidence in PWA** (`vite.config.ts`, `src/App.tsx`): Supabase Storage network-only, clean up earlier `supabase-storage-cache` on application startup/service worker controller change. Field workers' IndexedDB upload queue and offline app shell are preserved.
- **Security and build preflight** (`scripts/verify-phase7-security.cjs`, `scripts/phase7-preflight.cjs`) dependency-free, runnable even without npm packages.
- **Read-only RLS/RPC audit SQL** (`supabase/manual/PHASE7_READ_ONLY_SECURITY_AUDIT.sql`) for *staging SQL editor* review, no writes.
- **No new migration**. Keep Phase 1–4 migrations and Phase 5/6 business behavior unchanged.

## Verified inside source workspace

- Phase 1: 16/16 checks; Phase 2: 21/21; Phase 3: 21/21; Phase 4: 19/19; Phase 5: 18/18; Phase 6: 17/17.
- Owner billing: 23/23; Owner navigation: 15/15; unified progress: 14/14.
- New Phase 7 static security/source assertions: 16/16, 116 TS/TSX source files parsed.
- **Cannot claim full compilation:** npm ci in this runtime exits with `npm error Exit handler never called!`; no working local Vite dependency installation. Run npm ci, npm run typecheck, npm run build in CI/workstation. Source parsing and static checks do not replace compilation.
- **Cannot claim live DB/browser verification:** Supabase instance credentials, operator sessions, Postgres test database and cross-role device testing are not accessible.

## Production blockers requiring special attention

1. **Invoice operations are not yet atomic.** `src/pages/BillingPage.tsx` inserts invoice header, then line items; its compensating delete can also fail. Invoice edits update header, delete lines, then insert replacement lines. Two accounts racing to invoice the same Work Items can pass their independent browser rechecks. Resolve this with a server-side *single transaction* allocation/invoice RPC, unique idempotency keys and locking before unrestricted production rollout. Existing billing flow is preserved here rather than shipping untested financial SQL.
2. **Current migration state unknown.** Phase 1–4 SQL files have `20261027`–`20261030` timestamps; the packaging date is 2026-10-19. Check staging/production migration history rather than assuming these future-named files have been applied.
3. **RLS privileges not actually inspected against live deployment.** Execute the included read-only audit and negative authorization tests for two separate agency accounts and client accounts.
4. **Realtime and offline flows require real-device/network tests.** Include network interruption/retry and service worker update tests.

## Acceptance scenarios before GO

| ID | Role and scenario | Required outcome |
|---|---|---|
| AUTH-01 | Agency A owner logs out, Agency B owner logs in same browser | No Agency A dashboard/finance/shop/evidence flash or cached data |
| AUTH-02 | Rapid account change during profile fetch | Earlier profile cannot override new account; route rights correspond to current user |
| AUTH-03 | Company client opens agency billing URL | Denied by route AND Supabase RLS |
| EVID-01 | Signed survey/install proof viewed, user switches accounts | Not served from service worker cache; signed URL access enforces auth/storage policy |
| FLOW-01 | Survey & Installation, 2 sites with survey corrections | Review → company confirmation → design → production → installation; rejected item stays blocked |
| FLOW-02 | Production & Installation with company artwork | Survey/Designer tasks not created unnecessarily; production/installation correctly handed off |
| FLOW-03 | Production & Delivery, 1 received + 1 dispatched | 50% sites delivered; only received/eligible work billed; legacy policy unchanged |
| FLOW-04 | On-site Execution with upload interrupted | No duplicate site/job; proof cannot finalize before valid upload and owner review |
| BILL-01 | Two accounts invoice same Work Item at the same time | At most one eligible allocation; **known release blocker pending atomic invoice RPC** |
| BILL-02 | Invoice item insert or edit fails midway | No header-only or missing-items invoice; **known release blocker** |
| DATA-01 | Any site changes status after approval | Owner, Work Order, Client and Billing reflect canonical state after refresh/realtime |
| UI-01 | Mobile 320px, tablet, desktop; keyboard-only | No trapped focus, clipped actions, blocked modal scroll or unintended visible finances |

**Release recommendation:** Do not mark production GO until build passes, billing atomicity is addressed, Supabase staging RLS/RPC tests are green, and acceptance scenarios are signed off.

## Reproducible commands (after extracting ZIP)

```bash
cd Darshan_Ad_Agency
node scripts/phase7-preflight.cjs
node scripts/verify-phase7-security.cjs
for test in scripts/verify-phase[1-6]-*.cjs; do node "$test"; done
npm ci
npm run typecheck
npm run build
```

Also run `node scripts/verify-owner-billing-readiness.cjs`, `node scripts/verify-unified-progress.cjs` and `node scripts/verify-owner-ux-stage-routing.cjs`.

Staging deployment only, after complete backup and SQL review:

```bash
supabase login
supabase link --project-ref YOUR_STAGING_PROJECT_REF
supabase migration list
supabase db push --dry-run
# If expected pending migrations ONLY and staging backup exists:
supabase db push
```

Use SQL Editor to run `supabase/manual/PHASE7_READ_ONLY_SECURITY_AUDIT.sql` and inspect output before testing migrations/RLS.

```bash
git switch -c qa/phase7-release-hardening
git status --short
git add .
git diff --cached --check
git commit -m "chore: Phase 7 QA and security hardening"
git push -u origin qa/phase7-release-hardening
```
