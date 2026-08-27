/*
# Phase G — PO-aware live survey comparison + adjustment note (Section 8)

  ARCHITECTURE doc Section 8: at the moment a surveyor logs Width/Height/Qty
  for a work item, the Survey screen and the Review screen must both show,
  inline, a *read-only* comparison against that PO line item's budget
  (already-surveyed-elsewhere + this measurement = running total vs
  budgeted). This is never a hard block — real sites vary from paper
  estimates — but if the running total would exceed budget, Admin/Owner
  must be able to attach a free-text adjustment note explaining the
  variance, exactly as specified.

  This migration only adds the three columns the doc specifies. No RLS
  changes needed: work_items already has an org-wide SELECT policy (no role
  restriction — see migration 0001c), so every role, including surveyor,
  can already read the sums this banner needs. The budget figures
  themselves come from the existing non-financial
  `v_po_line_item_work_context` view (migration 0029), which carries
  budgeted_qty/budgeted_area but never `rate` — so a surveyor role never
  sees money, only work-relevant budget context, matching Section 9's
  matrix ("Surveyor: sees PO budget %/variance read-only, own submissions").
*/

ALTER TABLE public.work_items
  ADD COLUMN IF NOT EXISTS po_variance_note text,
  ADD COLUMN IF NOT EXISTS po_variance_acknowledged_by uuid REFERENCES public.profiles(id),
  ADD COLUMN IF NOT EXISTS po_variance_acknowledged_at timestamptz;
