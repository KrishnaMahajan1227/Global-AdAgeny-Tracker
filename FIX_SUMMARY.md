# Adroute targeted repair — 12 October 2026

- Work Orders: paginated shop-to-work-order mapping queries, so counts and zone filters do not truncate at Supabase row limits.
- Realtime shop changes now invalidate Work Order shop-link counts.
- Shops: if the optional reviewer foreign-key relationship has not been created, retry the same paginated shop query without that relationship.
- Shops: display the actual database error with Retry rather than silently presenting an empty shop list.
- Standardized a set of field, progress, review, installation, reporting and voice messages to concise professional English.

## Deployment validation
- Ensure all database migrations are applied (including shop rejection migration).
- Run `npm ci`, `npm run typecheck`, and `npm run build`.
- Check access and shop counts for agency owner, admin, client, surveyor and installer users against real Supabase data.
- No live backend tests were possible in this environment. Dependencies present here are incomplete, so a full typecheck/build could not be completed.
- No database schema changes were introduced in this patch.
