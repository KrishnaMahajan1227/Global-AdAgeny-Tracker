/*
# Phase D — Consumables confirmation, wired into the existing BOM gate

  ARCHITECTURE doc Section 6.2 asks for: consumables (tape, nails, packing)
  to be tracked per work item, auto-suggested from the work type's catalog
  when defined, addable ad hoc otherwise, and confirmed-available before an
  item can be marked ready for dispatch/installation — using the same gate
  as components.

  What we found already built (SupplyOrdersPage.tsx, migration 0023/0024):
  - work_item_components already IS a generic BOM/readiness checklist:
    component_name + status (pending/in_progress/ready), one row per
    required item on a board.
  - SupplyOrdersPage already seeds this table straight from
    work_type_consumables at work-item-creation time, scaled by qty, for
    the supply_only path — and Production's existing gate ("produced only
    once every row is ready") already applies to those seeded rows with NO
    extra code, because they live in the same table as hand-added
    components.

  So instead of the doc's proposed brand-new `work_item_consumables` table
  (which would fork the gating logic into two parallel systems), we extend
  the ONE table that already works:

  1. Add `source` ('component' | 'consumable') so the Production checklist
     can visually group and label rows without changing how the gate
     works — a consumable row still just needs status = 'ready' like any
     component, satisfying "must be confirmed available" from Section 6.2.
  2. Nothing about the gate itself changes — the existing app-layer rule
     ("produced only when every row's status = 'ready'") already covers
     consumables the moment they're rows in this table. This is the
     lightest possible way to satisfy 6.2 without duplicating the BOM
     gating logic that migration 0023 already built.
  3. The one real gap: survey_install work items (created via
     src/lib/syncManager.ts on survey submit) never got this auto-seed —
     only supply_only did. That's closed in this same phase at the app
     layer (syncManager.ts), using this new `source` column so seeded
     consumable rows are distinguishable from hand-added components.
*/

ALTER TABLE public.work_item_components
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'component'
    CHECK (source IN ('component', 'consumable'));

CREATE INDEX IF NOT EXISTS idx_work_item_components_source ON public.work_item_components(source);

-- Backfill: rows already seeded from work_type_consumables by
-- SupplyOrdersPage (identifiable as: component_name matches a catalog
-- entry for that work item's work type) get relabeled 'consumable' so
-- existing supply_only jobs show the same grouped checklist retroactively
-- instead of only new jobs going forward.
UPDATE public.work_item_components wic
SET source = 'consumable'
FROM public.work_items wi
WHERE wic.work_item_id = wi.id
  AND wi.work_type_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM public.work_type_consumables wtc
    WHERE wtc.work_type_id = wi.work_type_id
      AND wtc.consumable_name = wic.component_name
  );
