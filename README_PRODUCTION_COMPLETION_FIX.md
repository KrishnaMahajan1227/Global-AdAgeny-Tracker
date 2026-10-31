# Production Studio — Completed status / 100% consistency fix

## What was wrong

The Production Studio counted boards only in pre-installation work-item statuses. Once an item became `installed`, it disappeared from the board totals, even when the production order itself was marked `completed`. The summary percentage was calculated from recorded board readiness **without checking the completed order stage**, so completed orders could appear at `58%` or `0%`. A historical completed order with no linked boards displayed a confusing `0/0` next to `Completed`.

## What's changed

- **Database migration 0103:** The existing `v_production_order_list` keeps its original columns, order, and types. It considers production `completed` if the order was completed **or** the shop has unambiguously passed production (`production_done`, dispatched/delivered, installation phases, installed or billed). This derived status is used consistently in server-side tabs and the existing `production_order_stats()` RPC. In such cases the **production-stage** progress is `100%`, and the order is not counted as production-pending or materials-pending. Board counts include installed items, exclude items explicitly marked unavailable, and do not create/alter any work-item records.
- **Frontend:** Completed orders show a green `Done` marker, `100% · stage done`, no editable status action, and a read-only board history. Missing linked boards are explicitly identified rather than showing a misleading `0/0` figure. Board-level actual quantities are still shown *as recorded*, never invented.
- **Database migration 0104:** Prevents direct completion updates that bypass the audited `phase3_complete_production` handoff and prevents status changes on an already completed order or shop that has passed production. Ordinary pending/hold/in-production/ready status changes remain supported until handoff.

**Important distinction:** Production-stage completion is not the same thing as installation or full Work Order completion. A Production order can legitimately be `100% · stage done` while its shop is awaiting installation. Likewise, `100%` does **not** assert a physically measured quantity or automatically create billing quantities or invoices.

## Applying to your Supabase project

1. Back up the database and verify the current migrations are applied through `0102`. Test on staging first.
2. Apply `supabase/migrations/20261030180000_0103_production_completion_stage_reconciliation.sql` and then `supabase/migrations/20261030181000_0104_production_completion_guard.sql`, using your usual Supabase migration/deployment workflow. **Do not rerun old seed/reset scripts.**
3. Deploy the updated frontend code from `src/pages/ProductionPage.tsx`. This ZIP deliberately excludes the local `.env` and Supabase `.temp` connection metadata; retain your own existing environment and Supabase linking configuration when deploying.
4. Verify on the target environment with the checks below. **No migration has been applied to your live database by this ZIP creation.**

## Manual regression checklist

| Scenario | Expected |
|---|---|
| Production completed, 11 of 19 item records ready | `Completed` with 100% production stage, not `58%`; actual quantities still unchanged |
| Production completed, 0 eligible board records | `Completed` and 100% stage; visible message explains missing linked records; no fabricated boards |
| Shop already installed, production order historically left `ready` | Production Studio derives `Completed`; 100%; no pending count or edit action |
| Shop dispatched / delivered (supply-only) | Production complete; delivery/receipt stage is still separately tracked |
| Shop in production with 3 of 5 boards ready | 60% board readiness; record/status actions available according to role |
| Item status `installed` | Included in linked historical board counts and detail, not editable |
| Item excluded from calculations | Excluded from active production board counts |
| Complete the same order twice | Atomic RPC handles retry idempotently; no duplicate installer notification |
| User tries a direct `UPDATE ... SET status='completed'` | Rejected by database completion guard |
| User tries to reopen a completed production order | Rejected by database finality guard |
| Different tenant / non-production role | Existing organization/role RLS and page-level access still apply |

## Validation limits

Static TypeScript transpilation and SQL view column-contract checks can be run without a Supabase connection. The **full Vite build and live Supabase/role/realtime integration tests still need to run in an environment with project dependencies and a staging database**. This package is a code patch, not a deployed or live-tested database change.
