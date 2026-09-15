/*
# Phase 12 — "Direct Installation" fulfillment type (wall-painting / on-ground campaigns)

## The real-world case this closes
Some Work Orders never come with a shop list at all — the client just says
"paint dealer walls between City A and City B, wherever possible" or hands
over a dealer list with no addresses. There is no survey to do (nobody can
survey a wall that hasn't been chosen yet), no design to approve (it's a
standard painted campaign creative, not a per-shop board), and no
production stage (nothing is fabricated) — the ground team/agency crew
just goes to a wall, paints it, photographs it with its size, and that IS
the record. Today's two fulfillment types can't express this:
`survey_install` forces a survey+design+production pipeline that doesn't
exist for this work, and `supply_only` has no installation/on-site step at
all.

## Design — reuses the stage-flag mechanism from migration 0046, doesn't
## duplicate it
Migration 0046 already added `po_line_items.requires_survey /
requires_design / requires_production / requires_installation` plus a
`'custom'` fulfillment_type precisely so a PO's line items could skip
stages. Rather than overload `'custom'` (which is meant for a mix of
per-line-item choices, configured by hand in the PO Line Items UI) with a
second meaning, this migration adds one more named, fixed preset —
`'direct_install'` — exactly the way `'supply_only'` already auto-applies
its own fixed preset (`requires_survey=false, requires_installation=false`)
on line-item insert. `'direct_install'` is the mirror image: only
`requires_installation` stays true; survey, design and production are all
skipped, because the ground crew's on-site photo+measurement submission
*is* the installation record, submitted directly (see InstallerPage.tsx's
"Direct Install" tab and CHANGES.md for the flow).

Purely additive: a third named value on an already-3-way CHECK constraint
(`survey_install`, `supply_only`, `custom` -> now also `direct_install`),
and one more branch in the existing auto-preset trigger. Nothing about
`survey_install`/`supply_only`/`custom` POs changes, and every view that
already reads `fulfillment_type` (`v_po_work_context`,
`v_po_line_item_work_context`, `v_po_line_item_utilization`,
`v_po_line_item_burndown_events`) needs no changes — none of them
special-case the value, they just pass it through or key off
`po_line_item_id`, which `direct_install` line items have exactly like
every other type.
*/

-- ============ purchase_orders: fourth named fulfillment_type ============
ALTER TABLE public.purchase_orders
  DROP CONSTRAINT IF EXISTS purchase_orders_fulfillment_type_check;
ALTER TABLE public.purchase_orders
  ADD CONSTRAINT purchase_orders_fulfillment_type_check
  CHECK (fulfillment_type IN ('survey_install', 'supply_only', 'custom', 'direct_install'));

-- ============ auto-apply the direct_install preset on line-item insert ============
-- Same trigger function migration 0046 introduced for supply_only — adding
-- the direct_install branch here instead of a second trigger keeps there
-- being exactly one place that decides "what do this PO's line items
-- default to".
CREATE OR REPLACE FUNCTION public.apply_po_line_item_stage_preset()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_fulfillment_type text;
BEGIN
  SELECT fulfillment_type INTO v_fulfillment_type
  FROM public.purchase_orders WHERE id = NEW.purchase_order_id;

  -- Only auto-derive when nothing was explicitly customized (every flag
  -- still at its column default of true) — an explicit false anywhere
  -- means the caller (the 'custom' line-item form) already set this
  -- correctly and this trigger should leave it alone.
  IF v_fulfillment_type = 'supply_only'
     AND NEW.requires_survey IS TRUE AND NEW.requires_installation IS TRUE THEN
    NEW.requires_survey := false;
    NEW.requires_installation := false;
  ELSIF v_fulfillment_type = 'direct_install'
     AND NEW.requires_survey IS TRUE AND NEW.requires_design IS TRUE
     AND NEW.requires_production IS TRUE AND NEW.requires_installation IS TRUE THEN
    NEW.requires_survey := false;
    NEW.requires_design := false;
    NEW.requires_production := false;
    -- requires_installation stays true: the on-site paint+photo+size
    -- submission the ground crew makes IS the installation record.
  END IF;

  RETURN NEW;
END;
$$;

-- Backfill: any direct_install line item created before this migration
-- (shouldn't exist yet since the type didn't either, but safe/idempotent).
UPDATE public.po_line_items li
SET requires_survey = false, requires_design = false, requires_production = false
FROM public.purchase_orders po
WHERE li.purchase_order_id = po.id
  AND po.fulfillment_type = 'direct_install'
  AND (li.requires_survey IS TRUE OR li.requires_design IS TRUE OR li.requires_production IS TRUE);
