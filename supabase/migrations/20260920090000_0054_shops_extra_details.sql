/*
# Phase 25 — shops.extra_details (client-specific custom fields)

## Why
Every client builds their own shop list slightly differently — some
track a landmark, some a GST number, some an internal site code that
means nothing to anyone else. The standard field set (name, owner,
contact phone, address, village, city, district, zone, state) covers
what's common across every client, but a bulk-upload Excel a specific
client brings may legitimately carry a few columns beyond that set.

Rather than silently dropping those extra columns (data loss) or
rejecting the whole file (unnecessarily strict), the client portal's bulk
upload now detects any column that doesn't map to a known field, shows
the client exactly which ones, and lets them choose to carry those over.
If they do, the values land here — a single flexible column rather than
a ballooning number of narrow, mostly-empty ones — and are then shown
consistently everywhere a shop's details are shown (the details drawer,
on both the per-Work-Order Shops tab and the top-level Shops page).

## Design
`extra_details jsonb NOT NULL DEFAULT '{}'::jsonb` — a flat string-keyed
object, e.g. `{"Landmark": "Near City Mall", "GST Number": "27AAAAA..."}`.
No schema migration needed every time a new client uses a new custom
column; the key names come straight from that client's own file.
*/

ALTER TABLE public.shops ADD COLUMN IF NOT EXISTS extra_details jsonb NOT NULL DEFAULT '{}'::jsonb;
