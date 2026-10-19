# Adroute — Phase 3: Safe Department Handoffs (source release)

## Scope implemented

This release **extends Phase 1 and Phase 2**. It preserves the established Survey -> Design and Installation Review server RPCs. It does not add another approval system or prematurely create invoices.

**1. Design -> Production, server-side atomic transition** (`phase3_send_to_production`)
- Owner/Admin only, matching organization; must choose an active printing staff member.
- Checks linked active Work Order, PO lines and required company approval against the current evidence before advancing.
- Reuses one existing production order safely; rejects data corruption if multiple production orders exist for the same site.
- Prevents moving already dispatched/installed work backwards.
- Creates/assigns production order, advances design/shop/work-item statuses, audits and notifies in a single transaction.
- Retrying completed handoffs does not create duplicate production orders or duplicate notifications.
- Artwork supplied by the client uses **the same design stage**. Uploaded artwork still needs its review/approval; truly design-free scope can skip an unnecessary designer.

**2. Production -> Installation or Dispatch** (`phase3_complete_production`)
- Owner/Admin or the individually assigned Printing staff member can complete production.
- Validates actual produced quantities, components/material readiness, active work item scope and team roles server-side.
- A documented Owner/Admin override exists only for incomplete work quantities; the override does NOT synthesize measurements or billing eligibility.
- Survey & Installation and Production & Installation require an active installer, so shop assignments and completion statuses commit together.
- Production & Delivery goes to `packed` and waits for existing manual dispatch. **Delivery-received confirmation is Phase 4; this release does not bypass it or change historical billing.**
- No-installation historical Custom scope still follows its previous terminal-status convention.
- One notification to the chosen installer on first completion, including pre-existing assignees; retries do not duplicate notifications.

**3. Zero-click deterministic assignment when safe**
- If there is exactly one active Printing employee, Phase 3 automatically creates the production handoff when a *new* company-gated Work Order reaches design-approved state and its approval is valid.
- When several production staff are available, Owner/Admin must choose a responsible person in the existing handoff modal. The modal preselects the only available person when unambiguous.
- Survey bulk approval similarly preselects one available designer; Production completion preselects one installer when unambiguous.
- Historic orders retain existing manual handoffs. No existing orders, invoices, line items or approval records are backfilled.

**4. Database bypass protections**
- For new company-gated orders, direct `design_tasks.status=ready_for_production` and `production_orders.status=completed` updates cannot bypass Phase 3 verified RPCs.
- Older Work Orders preserve legacy status update semantics.
- Role checks occur server-side, not only by hiding UI buttons.

## Files changed
- `supabase/migrations/20261029100000_0099_phase3_atomic_department_handoffs.sql` **(apply after 0097 and 0098)**
- `src/pages/SurveyReviewPage.tsx`
- `src/pages/DesignerPage.tsx`
- `src/pages/ProductionPage.tsx`
- `scripts/verify-phase3-handoffs.cjs`

## Commands on your local machine

From extracted `Darshan_Ad_Agency` directory:

```bash
npm ci
npm run typecheck
npm run build
node scripts/verify-phase1-fulfillment.cjs
node scripts/verify-phase2-approvals.cjs
node scripts/verify-phase3-handoffs.cjs
node scripts/verify-owner-billing-readiness.cjs
```

If modules are missing, install dependencies using normal internet-connected npm first. The project needs its original `.env` from your own deployment; **do not overwrite secrets from any ZIP**. Environment keys are intentionally excluded.

## Supabase migration — STAGING FIRST

**Do not run destructive `supabase db reset` on production.** Confirm backup, linked project and migration history. The ZIP already includes 0097 and 0098; apply them in order before 0099. If other unapplied migrations exist, review each of them first.

```bash
supabase login
supabase link --project-ref YOUR_STAGING_PROJECT_REF
supabase migration list
supabase db push --dry-run
# Review ALL pending SQL and apply only after a staging backup.
supabase db push
```

After staging validates all four fulfillment workflows, apply through your normal deployment pipeline to production. Re-check `supabase migration list` on production before deploying and take a backup. Do not manually mark migrations applied without executing and validating them.

## Git commands (your own repo, not the extracted ZIP)

```bash
git status
git switch -c feature/phase3-atomic-handoffs
# Copy updated files from this ZIP to your repository, then:
git add src/pages/SurveyReviewPage.tsx src/pages/DesignerPage.tsx src/pages/ProductionPage.tsx \
  supabase/migrations/20261029100000_0099_phase3_atomic_department_handoffs.sql \
  scripts/verify-phase3-handoffs.cjs PHASE_3_ATOMIC_HANDOFF_RELEASE.md
git commit -m "feat: Phase 3 atomic department handoffs"
git push -u origin feature/phase3-atomic-handoffs
```

## Staging acceptance matrix (MANDATORY)

1. New Survey & Installation: Owner-approved survey with valid company approval -> Design task; one active Printer -> automatic Production assignment after design approval; 2+ printers -> Owner selection.
2. New Production & Installation: Skip Survey entirely; Design approval -> Production; completing Production -> installer assignment without moving site straight to `installed`.
3. Production & Delivery: Complete Production -> destination `packed`; dispatch remains manual; it is NOT marked delivered by production completion.
4. On-site Execution: existing field capture -> installation review and manual company confirmation unchanged; no artificial production order.
5. Upload company artwork and ensure its approval is required before the handoff, even when agency Designer is not required. For genuinely design-free supply, no fake design approval is created.
6. Without company approval, with changed evidence, or with unapproved design, new-PO Production handoff is rejected by the database.
7. 0 work items, insufficient produced quantities, or incomplete material components: printing user cannot complete; Owner must explicitly acknowledge override, still no invented billable quantity.
8. Unauthorized client/surveyor/designer/accounts user cannot call these RPCs, nor can an agency user assign a different organization's staff member.
9. Retry a successful request: no extra Production Order, installation assignment or duplicate notification. Existing in-progress/finished work cannot move backward.
10. Bulk send and bulk complete: successfully processed orders remain processed if one later row fails; failed rows show actionable errors and can be retried.
11. Realtime in Designer, Production, Shops, Owner Dashboard and Installer queue (including offline or Realtime-disconnected polling fallback) shows correct stage progression.
12. Existing historic orders and legacy Custom type still execute; existing invoices and invoice eligibility unchanged. Verify partial billing separately.
13. Run mobile/tablet/desktop browser E2E after migration. Confirm SQL trigger recursion/deadlock absence and actual PostgreSQL compilation.

## Verification state / known limitations

- Static/logic-source Phase 3 checks, TSX transpilation and existing Phase 1/2 and billing regressions pass.
- Full `npm ci` / Vite build and a live Supabase/Postgres migration execution were **not available in this environment**. Source checks do not prove a compiled/running application. Staging must pass before deploying or calling this production ready.
- A company approval still requires an Owner/Admin's explicit final review action. Installer/billing progression remains evidence-driven. Phase 4 will address delivery-received checkpoint, field/offline retries and further execution optimizations.
