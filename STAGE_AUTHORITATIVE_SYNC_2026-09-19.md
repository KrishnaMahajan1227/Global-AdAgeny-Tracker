# Authoritative stage synchronization — 2026-09-19

`shops.status` is now the authoritative operational stage.

- Moving a shop back to Survey reopens the assigned surveyor as a normal fresh survey round and clears stale open redo state.
- Moving a shop back to Design reopens the latest design task and clears stale correction state.
- Moving a shop to Production Done / Dispatched / Installation Pending / Installing reopens the assigned installer as normal work and cancels stale installation redo requests.
- Installation job review/completion state is reset for the new installation round; existing evidence is retained for audit/history.
- Owner/Admin stage changes invalidate Installer, Surveyor, Design, Production, Review, Dashboard/Shop caches.
- Installer Home and My Work subscribe to shop/assignment/job/correction realtime changes.

Migration: `20261022090000_0086_shop_stage_authoritative_sync.sql`
Deploy with: `npx supabase db push --include-all`
