# ADROUTE — Phase 1 Fulfillment Standardization

## Scope & what is implemented

This release introduces **four business-facing fulfillment presets** in Agency and Client Work Order creation:

| Selection | Stored ID | Workflow behavior |
|---|---|---|
| Survey & Installation | `survey_install` | Existing Survey → Design → Production → Installation (unchanged) |
| Production & Installation | `production_install` | **New**: No survey assignment, Design Review → Production → Dispatch → Installation; dispatch is not final |
| Production & Delivery | `supply_only` | Existing supply route, design/production/dispatch, no installation (unchanged status/billing rules) |
| On-site Execution | `direct_install` | Existing field execution and installation review (unchanged) |

- **No extra stage checkboxes** added to Work Order creation. The selected preset drives line requirement flags. Existing `custom` POs retain their exact stored fields and remain readable/editable as historical orders, but users cannot create another `custom` order from the regular form.
- Both Agency Owner/Admin and Client Organization PO creation use the same four names.
- A compact one-line workflow preview clarifies the choice in the Agency form.
- The existing Design Studio upload supports company-supplied files (`client_provided`) and agency-designed files (`agency_designed`), within **one design stage**.
- The **Production & Delivery** entry form now asks *Artwork source*: Company artwork received vs Agency will create. Company-artwork entries do not require a designer assignment, but still create a task for Owner/Admin evidence upload/approval (not auto-approved).
- **Production & Installation**: When sites are linked, the new server-side migration creates the Design Task and placeholder PO-linked work items automatically, without a survey or fabricated approved/installed quantities. Owner/Admin can upload company artwork in existing Design Studio, or assign a designer there. Existing Design approval → Production and Production → Installation flows are reused.
- Current fulfillment types and associated invoices/statuses remain unchanged.
- New no-survey orders cannot acquire Surveyor assignments or be advanced into survey statuses by mistake (server-side guard).
- New type's dispatched shops count as **in progress** in Agency and Client Overview/Map, until installation completion.

## Required deployment steps

**Important: Source ZIP alone cannot change the live database.**

1. Back up the Supabase project and verify which existing migrations have actually been applied. **Do not blindly apply other unapplied future-dated migrations** that happen to be present in this source tree.
2. Deploy the application sources.
3. Apply the *new* additive migration `supabase/migrations/20261027100000_0097_phase1_production_install.sql` **after its prerequisites** (especially migrations 0046, 0077 and shop/work-item tables). Review the full migration chain in a staging database first. Ensure that your migration deployment mechanism does not apply unexpected pending scripts.
4. Run `node scripts/verify-phase1-fulfillment.cjs` plus existing regression scripts.
5. Test on a staging database, authenticated as owner, admin, client admin, designer, printing and installer, then release to production.

## Key acceptance tests in a live DB

1. New **Production & Installation** PO → add line item (stage flags: survey false, others true) → add or bulk import shop linked to PO → shop enters `design_pending`; exactly one Design Task and one placeholder Work Item per PO line; NO survey assignment, fake survey/approval/qty records, duplicate tasks.
2. Agency owner uploads company-supplied artwork in Design Studio (without assigning a designer) → internal approval and production handoff → production logged → installer assigned → real installation reviewed → installed shop completed. Dispatched is not installed and not billable by itself.
3. Agency-created artwork: assign a designer in the existing Shop detail, approve design and hand off to production.
4. **Production & Delivery** entry with company artwork: no assigned designer required, same design review remains mandatory; agency-created artwork still requires designer selection. Existing dispatch flow unchanged.
5. Existing `survey_install`, `supply_only`, `direct_install`, and historical `custom` orders keep their original flags, records, progress and billing.
6. Client portal, agency dashboard and map: `production_install` dispatched is incomplete; `supply_only` dispatched still completed (legacy meaning).
7. Reject changing fulfillment on a PO with linked shops/execution records; no database row changes on rejection.
8. Multi-shop/multi-line batch, page refresh, realtime updates, network retries and client-org access/RLS validated.

## Non-goals in Phase 1 (planned later)

- Automatic PDF/PPT external company approval packet and manual Company Approval audit gate are **Phase 2**. Phase 1 does not falsely claim approval from the company.
- Automated cross-department notifications/handoffs beyond the existing Design → Production and Production → Field paths are **Phase 3**.
- Requiring **delivery receipt** before Supply Only billing is a policy change reserved for Phase 4/5. This release preserves the previous `supply_only` billing rule for historical compatibility; an unacknowledged dispatch currently remains a final site status for that legacy type. Do not treat Phase 1 as implementation of delivery-received billing gate.
- Mixed custom per-line workflow redesign, bulk transactional bootstrap at enormous scale, and production-wide live data reconciliation require additional DB-backed testing.

## Validation performed here

- Targeted TypeScript parser: 16 changed TS/TSX files, 0 syntax errors.
- JSX runtime symbol scan: 61 TSX files pass.
- Phase 1 regression tests: 16/16 pass.
- Owner billing readiness regression tests: 23/23 pass.
- Supply workflow static tests: 15/15 pass.
- Owner UX/navigation: 15/15 pass.
- Execution reconciliation: 10 checks pass, plus missing-survey and custom-stage checks.
- Existing site progression regression passed.
- **Not validated here**: full Vite build, full typecheck, SQL applied to a running Supabase instance, staging deployment, actual browser E2E. `npm ci` failed due to the environment's npm exit-handler/dependency registry problem. Do not call this production-tested or fully bug-free until staging tests pass.

## Security / compatibility

- No credentials or `.env` copied into the release ZIP. Preserve your existing protected configuration.
- The additive migration uses server-side scope checks and guards only the new workflow type; it does not backfill, approve, charge or modify old execution records.
- Historical `custom` remains in the database, not offered for new normal Work Orders.
