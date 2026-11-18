# AdRoute v13 — QA evidence

**Static/source & mocked checks in this environment**

| Test | Outcome |
| --- | --- |
| scripts/verify-evidence-live-update-v13.cjs | 31/31 pass |
| scripts/verify-design-review-v12-multishop.cjs | 33/33 pass |
| scripts/verify-design-review-v11.cjs | 39/39 pass |
| scripts/verify-production-v12-workflow.cjs | 36/36 pass |
| scripts/verify-fast-review-workspace.cjs | 35/35 pass |
| scripts/verify-review-action-contract.cjs | 14/14 pass |
| npm run verify:security | passed: security static 27 and Phase 7 16 checks, 131 source files parse |
| npm run build | not verified: vite absent (npm ci offline missing zip-stream; online npm CLI failed) |
| scripts/verify-installer-runtime.mjs | not run: missing dependency in runtime |
| npm run verify:release | 4 legacy Campaign/deployment source-pattern failures (pre-existing; no v13 migration) |
| Real Vercel/Supabase browser E2E | not available; must be run on staging |

New runtime-backed helper checks include current approved batch per board; complementary designs for one board; shared file revised for one board only; missing/unapproved files; repeated links de-duplicated; PDF and images; storage-path signing; expired signed URL fallback, duplicate photo status removal; and safe-version watcher static policy for editors, field capture, no-cache header and update loops.

**Critical staging checklist**

- [ ] Installation Review -> approved detail: previously broken photo loads or clearly indicates missing/inaccessible asset (never unexplained broken-image icon).
- [ ] Photo shows no repeated green APPROVED overlay. Review decision still visible on work-item header.
- [ ] Board A front/back image/PDF both show; Board B only its explicitly linked current artwork; unrelated shop artwork never appears.
- [ ] Old shared artwork revised for Board A still appears for Board B, not as stale duplicate on A.
- [ ] Designer Review correction check next to the same board/artwork; only selected boards returned; Review RPC permissions maintained.
- [ ] At least one gallery preview and PDF link tested after 1 minute (signed URL refresh).
- [ ] Stage-review chain, Installer proof capture/redo, Production mappings and reports still function.
- [ ] Before a Git push, open Vercel site on two browsers and a phone. After successful deploy, confirm fresh v2026.11.18.2 loads automatically on safe idle tabs (may take ~30 s + idle). Old open modal or capture wizard remains unchanged until closed; background Safari updates on wake.
- [ ] Offline capture queue persists intact across reloads; no field evidence lost.

Do not assume this checklist has been executed by real users; these are pending acceptance tests.
