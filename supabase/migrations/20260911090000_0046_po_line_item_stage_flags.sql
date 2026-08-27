/*
# Phase 11 — Configurable per-line-item pipeline stages (Architecture v2.0 §3.4, §8 item 6)

## What this replaces
Per §3.4's corrected architecture, "Dealer Boards / Others / Supply Only /
Shopboarding" are genuinely different work-scopes a client can hand an
agency per PO, not one fixed pipeline with two doors. The binary
`fulfillment_type` (`survey_install` / `supply_only`) can't express
"just install pre-made boards" or "just verify/onboard a shop" — those
need SOME stages skipped, not all-or-nothing.

## Design (exactly the doc's own "Recommended data model change")
- Four new boolean flags on `po_line_items`:
  `requires_survey` / `requires_design` / `requires_production` /
  `requires_installation`. All default `true` — i.e. every EXISTING line
  item, and every new `survey_install` line item, behaves exactly as
  before (the "Dealer Boards" / full-branding preset) with zero migration
  risk to the working pipeline.
- `fulfillment_type` gains a third value, `'custom'`, purely additive —
  `survey_install` and `supply_only` are untouched, nothing renames.
  `'custom'` is where "Others" (e.g. install-only, design-only,
  re-servicing) and "Shopboarding" (survey/verify only, nothing else)
  actually get expressed: an Admin/Owner ticks whichever of the four
  stages apply, per line item, in the PO Line Items UI.
- A trigger auto-applies the existing `supply_only` preset
  (`requires_survey = false`, `requires_installation = false`) for line
  items under a `supply_only` PO, UNLESS the row was inserted with an
  explicit override (i.e. anything other than "both still true" — the
  signal that nothing custom was specified). This means no application
  code had to change at every insert call-site for the two presets that
  already exist; only the new `'custom'` path (PurchaseOrdersPage's line
  item form) explicitly sets these columns itself.
- Existing `supply_only` line items are backfilled the same way, so
  historical data reads correctly too.

## Scope note (read this before assuming stage-skipping is "done")
This migration ships the DATA MODEL and (in the same pass) the PO Line
Item UI to configure it — an Admin/Owner can now create a line item
scoped to e.g. "survey-only" (Shopboarding) or "install-only" (Others)
and it's correctly recorded and visible. Actually WIRING these flags
into the Survey Review / Designer / Production / Installation Review
queues (skip a work item's queue card when its line item says that stage
doesn't apply, and auto-advance its `work_items.status` past that stage)
is intentionally a separate, later pass — that touches the same
state-transition triggers (0011, 0013, 0014) that gate the
already-working, heavily-tested core pipeline, and doing it carelessly
in the same pass as the schema change risks regressing survey/design/
production/installation approvals for every existing agency. See
CHANGES.md for the explicit list of what's left.
*/

-- ============ po_line_items: per-stage requirement flags ============
ALTER TABLE public.po_line_items
  ADD COLUMN IF NOT EXISTS requires_survey boolean NOT NULL DEFAULT true;
ALTER TABLE public.po_line_items
  ADD COLUMN IF NOT EXISTS requires_design boolean NOT NULL DEFAULT true;
ALTER TABLE public.po_line_items
  ADD COLUMN IF NOT EXISTS requires_production boolean NOT NULL DEFAULT true;
ALTER TABLE public.po_line_items
  ADD COLUMN IF NOT EXISTS requires_installation boolean NOT NULL DEFAULT true;

-- ============ purchase_orders: additive third fulfillment_type ============
ALTER TABLE public.purchase_orders
  DROP CONSTRAINT IF EXISTS purchase_orders_fulfillment_type_check;
ALTER TABLE public.purchase_orders
  ADD CONSTRAINT purchase_orders_fulfillment_type_check
  CHECK (fulfillment_type IN ('survey_install', 'supply_only', 'custom'));

-- ============ auto-apply the supply_only preset on insert ============
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

  -- Only auto-derive when nothing was explicitly customized (both still
  -- at their column default of true) — an explicit false anywhere means
  -- the caller (the 'custom' line-item form) already set this correctly.
  IF v_fulfillment_type = 'supply_only' AND NEW.requires_survey IS TRUE AND NEW.requires_installation IS TRUE THEN
    NEW.requires_survey := false;
    NEW.requires_installation := false;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_apply_po_line_item_stage_preset ON public.po_line_items;
CREATE TRIGGER trg_apply_po_line_item_stage_preset
  BEFORE INSERT ON public.po_line_items
  FOR EACH ROW EXECUTE FUNCTION public.apply_po_line_item_stage_preset();

-- ============ backfill existing supply_only line items ============
UPDATE public.po_line_items li
SET requires_survey = false, requires_installation = false
FROM public.purchase_orders po
WHERE li.purchase_order_id = po.id
  AND po.fulfillment_type = 'supply_only'
  AND (li.requires_survey IS TRUE OR li.requires_installation IS TRUE);
