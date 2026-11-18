# QA — Design Review v11

Release source: previous Full AdRoute Fulfillment/Sizing/Officer project. Date: 2026-11-18.

## Changes

| Area | Change | Regression expectation |
| --- | --- | --- |
| Design Queue | Removed duplicate summary tiles and expanded-row decision buttons | Existing status tabs, folder navigation, action queue and pagination remain |
| Owner Review modal | One comparison list, one final decision bar, no embedded second item review | Single/multiple boards and mixed artwork types are previewed |
| Corrected items | Select affected boards; note required; approve unaffected boards atomically | Designer receives correct board-level correction tasks |
| Resubmission | New mapped version required for each open design correction | Old uploaded artwork does not falsely satisfy redo |
| Company approval | Required handoff stays; historical-only notice hidden in Design modal | External approval cannot be bypassed |
| Bulk approve | Same `design_review_decide` backend as single approval | Partial failures reported, batch remains bounded |
| Permissions | Only owner/admin approve; designer remains upload-only | No privilege expansion |
| Survey/install | No edits to their review pages | Existing review tests remain green |

## Executed checks

- 39 Design Review v11 source, mapping, correction, RPC mock and migration-contract checks: PASS.
- 35 Designer artwork/mapping v8 checks: PASS.
- 28 Designer size-first v10 checks: PASS.
- 30 Survey/Installation review workspace v3 checks: PASS.
- 14 Review action contract checks: PASS.
- 35 Fast review workspace checks: PASS.
- 16 Phase 1 fulfillment checks: PASS.
- 21 Phase 3 handoff checks and 3 TSX parses: PASS.
- 27 Security static checks and 16 Phase 7 security/source checks: PASS.
- 130 TS/TSX files syntax parsed: PASS.
- Archived source comparison: SurveyReviewPage, InstallationReviewPage, ProductionPage, designer upload internals, other workflows unchanged.

## Not validated

1. `npm ci` could not finish because npm dependencies were unavailable during this run. No production `npm run build`/`npm run typecheck` result is claimed.
2. No live Supabase staging/production account was used; SQL function and trigger need real PostgreSQL/RLS integration tests.
3. No interactive browser-based mobile/desktop testing; perform preview/scroll/sticky-buttons checks on real devices.
4. Baseline release suite still fails 4 historic Campaign/deployment assertions (same 21/25 result before and after this patch). Old v7/oneclick source-pattern tests are known stale relative to the previous upload architecture.

## Production gate

Deploy only after npm build/typecheck pass, Supabase migration 0119 succeeds in staging, and Owner/Admin and assigned Designer smoke tests pass. Do not reset database or bypass required company sign-off.
