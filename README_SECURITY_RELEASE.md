> **Latest application revision:** Billing, navigation and professional exports update. See [`docs/REPORTING_BILLING_RELEASE.md`](docs/REPORTING_BILLING_RELEASE.md) for the new atomic billing migration, verified checks, current blockers and staging acceptance tests. The original security hardening remains included.

# AdRoute security-hardened source ZIP — 31 October 2026

**Release status: SECURITY PATCH CANDIDATE — NOT YET PRODUCTION-VERIFIED.**

This ZIP contains source-code and additive Supabase SQL migrations. The original source was NOT modified in place. No remote database was accessed and **no migrations, bucket privacy changes, or password rotations have been applied** to any real Supabase project by preparing this ZIP.

## What changed

- Database-controlled `profiles` role/tenant/active state, hardened administrator creation/deletion, no editable privilege escalation from a profile PATCH; existing passwords remain hashed and cannot be displayed in plain text.
- An active-profile restrictive RLS barrier on every RLS-protected business table. It prevents inactive logins retaining access through an old JWT.
- Field users are restricted to their assigned shops/routes/survey/installation records. Designer/Printing restricted to assigned department shops; demo users restricted to marked demo client/shop/Work Order records.
- Owner/Admin/Accounts-only finance mutation policies. Client-admin can create/edit their **linked agency** draft purchase orders subject to scoped checks. Prevent cross-tenant client, project and PO identity changes.
- Audit and notification guardrails, confidential platform aggregate metrics without full-client data access, disable unauthenticated phone/email enumeration.
- Survey/design/installation/PO Storage buckets made **private**, with role/tenant/assignment-scoped access. Legacy `getPublicUrl()` DB strings are resolved by signed URL only while an authorized user views a file; shared CDN direct public URLs cease working once private migration is deployed. PDFs/canvas images use the secure resolver too.
- URL route guards aligned with role permissions. Auth cache cleared on account switch; inactive profiles denied on login and periodic refresh. Deployment security headers added.
- Known seeded default password values are replaced *only for accounts still using those exact seeded passwords* (password reset required for those accounts).
- Historical campaigns were not re-enabled. Existing data, schema history and workflows otherwise retained, though **staging regression is essential**.

### Database migrations, in order

`supabase/migrations/20261031120000_0105_security_identity_and_permissions.sql`
`supabase/migrations/20261031121000_0106_private_media_storage.sql`
`supabase/migrations/20261031122000_0107_cross_tenant_integrity_and_admin_privacy.sql`
`supabase/migrations/20261031123000_0108_invalidate_known_seed_passwords.sql`
`supabase/migrations/20261031124000_0109_admin_rpc_and_audit_guards.sql`
`supabase/migrations/20261031125000_0110_rpcs_and_platform_hardening.sql`
`supabase/migrations/20261031130000_0111_financial_and_field_write_guards.sql`
`supabase/migrations/20261031131000_0112_integrity_and_rpc_hardening.sql`
`supabase/migrations/20261031132000_0113_department_and_demo_read_scope.sql`

## CRITICAL PRE-DEPLOY WARNING

1. First take a **verified backup of Postgres, auth users, storage buckets, and storage object metadata** and verify restoration. Map your live schema to all nine additive migration prerequisites. DO NOT reset the production DB, rewrite already-applied migrations, or directly apply untested SQL to production.
2. **Arrange owner/super-admin access recovery before migration 0108**: accounts that have never changed their known seed passwords will immediately lose login until passwords are reset via a trusted admin method. Manually rotate any other real privileged credentials, Supabase service-role key (if exposed), API secrets and signing keys when warranted.
3. Apply migrations **only to an isolated staging Supabase clone first** and run every row-level-authorization and file-upload test described in `docs/SECURITY_STAGING_TESTS.md`. Check storage access, client agency invitations, multi-shop reporting, survey/installation offline sync, artwork uploads and billing on actual data.
4. Before deploying the frontend, provide its real `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` through the host's secure environment variables. `\.env` and `supabase/.temp/` intentionally excluded. Never put Supabase service-role or database password in `VITE_*` variables.
5. Private signed links are bearer capabilities for their lifetime (60s). Once shared, possession allows use until expiry; an old link may remain live until expiry. No application can guarantee that a valid authorized user cannot copy their screen or export data.
6. The original ZIP omitted `public/` assets and had incomplete dependencies in this audit runner. **Clean install, Vite build, lint, typecheck, browser E2E, full security tests and live RLS checks are not VERIFIED** and must pass before any live/client handover. `xlsx@0.18.5` remains in package dependencies (multiple legacy import/export modules); its known advisory is **NOT REMEDIATED by this patch**. Replace it with a maintained parser in a separately-tested migration before production.
7. Assess and revoke older already-issued public URLs, browser/CDN caches, and existing saved/offline copies. `get_shared_shop_view` unauthenticated public share RPC is intentionally revoked by 0105; any public sharing workflow needs an approved, scoped, expiring replacement.
8. These changes are **not proof of zero vulnerabilities or perfect authorization**. Other SECURITY DEFINER RPCs and legacy views require live penetration/regression review.

## Commands to verify source offline

```sh
npm ci
npm run typecheck
npm run lint
npm run build
npm run verify:security
npm run verify:production-completion
```

`npm ci`, Vite build, TypeScript typecheck and lint **could not complete in the supplied runner**, due to incomplete dependencies. Offline static checks listed below **did** run, and are not equivalent to production verification.

## Evidence from this packaging audit

- `node scripts/check-syntax.cjs` — **PASS: 127 TypeScript/TSX files, zero parse errors**.
- `node scripts/verify-security-release.cjs` — **PASS: 27 checks; source-only**.
- `node scripts/verify-phase7-security.cjs` — **PASS: all 16 pre-existing checks; source-only**.
- `node scripts/verify-production-completion-fix.mjs` — **PASS: all 7 source-only checks**.
- Live Postgres migration execution, cross-org negative API tests, storage signing and browser regression — **NOT RUN**.
- Legacy non-security regression suite had known failures from the earlier audit; not certified fixed here.

**Deployment decision: NO-GO pending successful staging DB migrations + all-role E2E and dependency remediation.**
