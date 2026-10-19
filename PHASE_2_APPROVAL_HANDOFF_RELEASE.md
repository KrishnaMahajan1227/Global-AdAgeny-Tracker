# Adroute Phase 2 — Internal Evidence Review & Manual Company Approval Handoff

## Overview
This is a **source release** extending the Phase 1 ZIP. It does not contain a live Supabase deployment or a production browser certification.

### Delivered
- A shared Owner/Admin-only **Company Approval** panel in Survey Review, Designer Review and Installation Review, alongside existing photo/board evidence and granular correction controls.
- Separate `internal_checked` and `company_approved` states; actual company approval is recorded manually after the agency receives it outside Adroute.
- PDF and PPTX approval packs prefilled with organization, client, Work Order, site, measurements and actual evidence image attachments. Exports are prominently marked **FOR COMPANY APPROVAL**, not as proof of company sign-off.
- Server-side auditable approval records and security-definer RPCs; **no direct write policy** and org/role validation. Owner/Admin can approve; designer/surveyor/installer/client users cannot forge a confirmation.
- Evidence fingerprint: a change to surveyed dimensions, design version, relevant photograph or installed quantities invalidates the recorded external approval at the next gate check.
- Database guards on stage finalization (surveys, design_tasks, installation_jobs) and on direct shop stage advancement. A UI button alone cannot override a missing/stale approval for new Work Orders.
- Legacy orders are **not** backfilled or newly blocked. All new Work Orders have the policy by default after migration.
- Realtime invalidation for company approval handoffs (with polling fallback), and retained existing review/correction/billing logic.

### Standard workflow for new Work Orders
1. Field staff submits normal survey/design/installation evidence.
2. Owner/Admin opens existing review and checks photos, dimensions and item-level evidence.
3. Click **Evidence reviewed · Send for approval**. This records the fingerprint but does **not** mark the operational stage complete.
4. Click **PDF** or **PPT** for an evidence pack; send it manually via WhatsApp/email.
5. Receive company approval externally; enter an optional reference. Click **Record company approval** and explicitly confirm.
6. Use the **existing** per-item/final approval in that module. The database verifies the company confirmation and unchanged evidence before allowing stage completion. Corrections continue through existing redo controls.

### Role rules
| Role | Evidence viewing | Internal check / manual external approval | Final approval |
|---|---|---|---|
| Agency Owner | Existing review permissions | Yes | Existing privileges |
| Admin | Existing review permissions | Yes | Existing privileges |
| Designer, Surveyor, Installer | Their assigned context | No | No owner approval |
| Accounts | Existing finance access only | No | No stage approval |
| Client organization | Existing portal visibility | No | No in-app company approval |

### Legacy compatibility
- Historical POs retain `company_approval_required = false` and use their existing approval flow.
- New POs receive `company_approval_required = true` automatically by DB default and insert trigger.
- Deactivating this policy after PO creation is forbidden.
- No existing status, invoice, shop, approval or work-item row is automatically rewritten.
- Phase 1 migration **0097** must be applied before Phase 2 **0098**.

### Limitations / future phases
- A quick pack needs **accessible raster/image evidence**. Adobe/PDF artwork that cannot be rasterized in the browser needs a preview image or the pre-existing design comparison/report export. Quick packs do not silently omit unreachable evidence and refuse >24 evidence images; use existing batch Reports for large site packs. Photos are manually exported and sent, not emailed or WhatsApp-sent in-app.
- Multi-shop bulk approvals still work through existing review queues, but **each new-PO site's external approval must be recorded first**. Mass external-approval confirmation/report bundling is future bulk UX work and must preserve individual evidence checks.
- Company stage confirmation is not a digital signature from the client; it is a named, timestamped and audited agency attestation.
- Downstream assignment/notification automation remains in the existing code; Phase 3 is the planned handoff automation overhaul.
- Production & Delivery delivery-recipient acknowledgement is a separate Phase 4 gate; this migration covers Survey, Design and Installation review.
- Production DB and browser workflows were not verified here. Full npm installation failed due registry DNS (`EAI_AGAIN` / npm Exit handler error). TSX parsing and source-level regression scripts passed.

## Local project commands
Run in the extracted `Darshan_Ad_Agency` directory, with Node.js and npm installed:

```bash
npm ci
npm run typecheck
npm run build
NODE_PATH=$(npm root -g) node scripts/verify-phase2-approvals.cjs
```

The `NODE_PATH` suffix is only useful if TypeScript is installed globally instead of locally. After `npm ci`, `node scripts/verify-phase2-approvals.cjs` normally works.

## Git commands (inside your actual Git repo)
Do not copy a `.git` folder or overwrite the production `.env` file with this ZIP. Backup/commit your existing work first. Then apply the ZIP's changed files to your own project repository.

```bash
git status
git switch -c feature/phase2-company-approvals
git add src/components/CompanyApprovalHandoff.tsx src/lib/companyApproval.ts \
  src/pages/SurveyReviewPage.tsx src/pages/DesignerPage.tsx src/pages/InstallationReviewPage.tsx \
  supabase/migrations/20261028100000_0098_phase2_company_approval_handoff.sql \
  scripts/verify-phase2-approvals.cjs PHASE_2_APPROVAL_HANDOFF_RELEASE.md
git commit -m "feat: audited manual company approval handoff"
git push -u origin feature/phase2-company-approvals
```

## Supabase deployment — run on STAGING first
Install the official Supabase CLI, authenticate and link the **correct** project. Never paste service-role keys or passwords into chat. Check that Phase 1 and all preceding migrations are successfully applied. Because the repository contains many dated migrations, **do not blindly push all pending migrations to production**.

```bash
supabase login
supabase link --project-ref YOUR_STAGING_PROJECT_REF
supabase migration list
supabase db push --dry-run
# Review the entire pending migration list carefully; confirm 0097 is applied before 0098.
# Only after reviewing the pending SQL and staging backup:
supabase db push
```

For a production project, replace the staging ref only after successful staging tests, create a database backup, review the pending migrations again, then run `supabase db push` via your deployment process. **Do not run `supabase db reset` against a production project.**

If a project is not using CLI migration history, a DBA may run the verified migration SQL via Supabase SQL Editor **only after confirming all prerequisite schema objects exist and a backup is available**; never run it twice blindly to force an inconsistent history.

## Staging acceptance checks
1. Create a **new** Survey & Installation order and submit survey evidence. Try approval before company confirmation — DB must reject. Internally check, export images, confirm company, finalise — must work.
2. Edit a measured value/add new photo after confirmation; finalization must be rejected as stale until rechecked and reconfirmed.
3. Company design source vs agency artwork: design review must require uploaded version and company approval when design is applicable.
4. Production & Installation: no survey gate; design approval required before production, installation approval required before delivered.
5. On-site Execution: no survey/design gate; installation proof and company approval required before final installed status.
6. Old work order created before migration: existing survey/design/install approval behavior unchanged.
7. Supply/Delivery historical orders: existing billing/dispatch states unchanged. Test any **new** supply order's artwork/production path in staging.
8. Attempt to call the handoff mutation as a client, installer or designer, and across orgs — must fail.
9. Confirm PDF/PPT report images and dimensions are correct; test 404/CORS evidence, PDF-only artwork, large evidence sets, mobile browser, realtime updates, and correction redo.
10. Regression-test invoice readiness and original 96/144-style scope calculation; company approval must not synthesize measurements or billable quantities.
