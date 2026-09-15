/*
# Production marking system: make production_items usable per-board

## Why this migration exists
`production_items` has existed since the very first schema (0001) with
exactly the right shape — one row per (production_order_id, work_item_id)
carrying requested/approved/produced quantity — but the Production page
never wrote to it. Every "Update Status" instead applied a single shared
`produced_qty` number to *every* work item on the shop, which is wrong the
moment a shop has more than one board (a Fascia Signboard and a Glow Sign
would incorrectly get the same produced quantity). This is the same class
of gap 0018 fixed for Designer (design_versions had no link to the boards
it covered) — production has the identical problem one stage later.

This migration only adds the constraint the app needs to safely upsert:
one production_items row per (order, board), so recording production
against a board is idempotent (re-editing a quantity updates the same row
instead of creating duplicates that would double-count in reports).
*/

-- Safe to run even if duplicate rows already exist from manual DB edits —
-- keep the earliest row per (production_order_id, work_item_id) and drop
-- the rest before adding the constraint, so this migration never fails.
DELETE FROM public.production_items a
USING public.production_items b
WHERE a.production_order_id = b.production_order_id
  AND a.work_item_id = b.work_item_id
  AND a.work_item_id IS NOT NULL
  AND a.id > b.id;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'production_items_order_work_item_unique'
  ) THEN
    ALTER TABLE public.production_items
      ADD CONSTRAINT production_items_order_work_item_unique
      UNIQUE (production_order_id, work_item_id);
  END IF;
END $$;

-- production_items was already added to supabase_realtime by 0013, but
-- re-assert it here too in case that migration was applied before this
-- table existed on some environments.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'production_items'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.production_items;
  END IF;
END $$;
