# Migration 0112 — Remote `db push` fix (2026-10-31)

## Confirmed failure from operator's log

`ERROR: relation "public.shop_share_links" does not exist (SQLSTATE 42P01)` at `20261031131000_0112_integrity_and_rpc_hardening.sql`, statement 10.

## Confirmed root cause

- `20260914090000_0049_public_shop_share_links.sql` created `public.shop_share_links`.
- `20261002090000_0066_remove_public_shop_share_links.sql` deliberately dropped the unused public shop-sharing RPC and table.
- Previous version of `20261031131000_0112_integrity_and_rpc_hardening.sql` incorrectly tried to run `DROP POLICY` and `CREATE POLICY` against that deleted relation.
- `DROP POLICY IF EXISTS ... ON public.shop_share_links` still requires the relation to exist. `IF EXISTS` only refers to the policy, not the table.

## Minimal hotfix

Remove ONLY the obsolete `shop_share_links` policy block at the end of migration `0112`. Do NOT recreate that table, restore anonymous sharing, or drop any other tables. All earlier security measures in `0112`, including PO/shop identity triggers and notification policy, stay intact.

## Windows PowerShell instructions

1. Take a verified Supabase database backup or snapshot and preserve a copy of your current project migrations. Never expose service-role secrets in logs or support tickets.
2. Copy `supabase/migrations/20261031131000_0112_integrity_and_rpc_hardening.sql` from this updated ZIP into the same path in `D:\DarshanAdField`, overwriting **only** that local file. **Do not create a new timestamped migration** for an object that was already removed.
3. From the root of the local project, inspect migration status and push:

```powershell
cd D:\DarshanAdField
supabase migration list
supabase db push
```

4. Review the proposed migration list. Based on the provided log, expect `0112`, `0113`, and `0114` to be pending; `0105` through `0111` were applied. Do not approve unexpected replays or destructive changes.
5. After a successful push, run `supabase migration list` again. Verify all three migration versions are recorded on the remote DB, and validate roles/direct REST access plus atomic invoice RPCs on staging before production release.

### Why this is safe for existing data

The hotfix does not execute `DROP TABLE`, modify any real records, or re-enable a removed public sharing feature. It only removes obsolete DDL statements from a **failed/unapplied migration**. Migrations previously applied to the remote database must not be rewritten or rerun.

### Verification status

- VERIFIED OFFLINE: `0112` no longer references `public.shop_share_links`; historic `0066` intentionally drops it.
- VERIFIED OFFLINE: remaining SQL in `0112` is unchanged.
- NOT RUN: live/staging PostgreSQL migration, invoice RPC execution, frontend build and role E2E tests (no access to your Supabase database from this environment).
- NOTE: the security and billing release has additional outstanding integration verification; this fix resolves only the observed migration error, not all possible later errors.
