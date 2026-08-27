/*
# Phase 21 — Remove the unused Public Shop Share Link feature

## Why
Migration 0049 added a "no-login, read-only shop link" feature
(`shop_share_links` table + `get_shared_shop_view()` RPC +
`PublicShopSharePage.tsx`). It was flagged optional in the architecture
doc, and it was never actually wired into the app — no route, no button
anywhere ever called it, no user could reach it. Per explicit decision,
this feature is not needed, so this migration removes it cleanly instead
of leaving an unused table + a public-facing RPC (granted to `anon`)
sitting around unused in the schema.

## What this does
- Drops the `get_shared_shop_view(text)` RPC (was the only door `anon`
  had into this schema — removing it also removes that surface area).
- Drops the `shop_share_links` table (and its policies/indexes along
  with it).
- Nothing else in the schema references either object (confirmed: no
  foreign keys point at `shop_share_links` from any other table), so
  this is a safe, isolated removal — no other feature is affected.

Idempotent — safe to run whether or not migration 0049 ever ran on a
given database.
*/

DROP FUNCTION IF EXISTS public.get_shared_shop_view(text);

DROP POLICY IF EXISTS "shop_share_links_select" ON public.shop_share_links;
DROP POLICY IF EXISTS "shop_share_links_insert" ON public.shop_share_links;
DROP POLICY IF EXISTS "shop_share_links_update" ON public.shop_share_links;

DROP TABLE IF EXISTS public.shop_share_links;
