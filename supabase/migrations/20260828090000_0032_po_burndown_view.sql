/*
# Phase I (remainder) — Burndown view (Section 10)

  ARCHITECTURE doc Section 10 asks for a burndown view on the PO detail
  page and/or Admin Dashboard: cumulative surveyed/produced/installed sqft
  over time against the PO's budgeted line, "same idea as gOGig's burndown
  chart, adapted to your PO-budget model".

  v_po_line_item_utilization (migration 0025) already gives the CURRENT
  totals per line item, but has no time dimension — you can't draw a line
  chart from a single snapshot row. This migration adds a companion view,
  v_po_line_item_burndown_events, that is one row PER WORK ITEM PER STAGE
  IT HAS REACHED, each carrying the date that stage happened and the
  qty/area delta it contributed. The frontend buckets these by day and
  cumulatively sums them to draw the burndown lines — same pattern as
  gOGig's burndown, but driven off real pipeline timestamps you already
  capture (surveys.submitted_at/reviewed_at, work_items.produced_at,
  work_items.installed_at) instead of a new tracking table.

  Four stages, one row each (when that stage has actually happened):
  - 'surveyed' — dated by surveys.submitted_at (falls back to the work
    item's created_at if the linked survey row is missing, e.g. legacy
    backfilled data), valued by survey_area/survey_quantity.
  - 'approved' — dated by surveys.reviewed_at (only emitted once the
    survey has actually been approved, i.e. work_items.approved_area or
    approved_quantity is set), valued by approved_area/approved_quantity.
  - 'produced' — dated by work_items.produced_at, valued by
    produced_quantity (produced is always qty-based, mirroring
    poUtilization.ts's getActualForStage).
  - 'installed' — dated by work_items.installed_at, valued by
    installed_area/installed_quantity.

  Scoped with organization_id = current_org_id(), same pattern as
  v_po_line_item_utilization.
*/

DROP VIEW IF EXISTS public.v_po_line_item_burndown_events;
CREATE VIEW public.v_po_line_item_burndown_events AS
WITH events AS (
-- surveyed
SELECT
  wi.id AS work_item_id,
  wi.po_line_item_id,
  wi.organization_id,
  'surveyed'::text AS stage,
  COALESCE(s.submitted_at, wi.created_at)::date AS event_date,
  COALESCE(wi.survey_area, 0) AS area_delta,
  COALESCE(wi.survey_quantity, 0) AS qty_delta
FROM public.work_items wi
LEFT JOIN public.surveys s ON s.id = wi.survey_id
WHERE wi.po_line_item_id IS NOT NULL
  AND (wi.survey_area IS NOT NULL OR wi.survey_quantity IS NOT NULL)

UNION ALL
-- approved
SELECT
  wi.id AS work_item_id,
  wi.po_line_item_id,
  wi.organization_id,
  'approved'::text AS stage,
  COALESCE(s.reviewed_at, wi.updated_at)::date AS event_date,
  COALESCE(wi.approved_area, 0) AS area_delta,
  COALESCE(wi.approved_quantity, 0) AS qty_delta
FROM public.work_items wi
LEFT JOIN public.surveys s ON s.id = wi.survey_id
WHERE wi.po_line_item_id IS NOT NULL
  AND (wi.approved_area IS NOT NULL OR wi.approved_quantity IS NOT NULL)

UNION ALL
-- produced
SELECT
  wi.id AS work_item_id,
  wi.po_line_item_id,
  wi.organization_id,
  'produced'::text AS stage,
  COALESCE(wi.produced_at, wi.updated_at)::date AS event_date,
  0 AS area_delta,
  COALESCE(wi.produced_quantity, 0) AS qty_delta
FROM public.work_items wi
WHERE wi.po_line_item_id IS NOT NULL
  AND wi.produced_quantity IS NOT NULL

UNION ALL
-- installed
SELECT
  wi.id AS work_item_id,
  wi.po_line_item_id,
  wi.organization_id,
  'installed'::text AS stage,
  COALESCE(wi.installed_at, wi.updated_at)::date AS event_date,
  COALESCE(wi.installed_area, 0) AS area_delta,
  COALESCE(wi.installed_quantity, 0) AS qty_delta
FROM public.work_items wi
WHERE wi.po_line_item_id IS NOT NULL
  AND (wi.installed_area IS NOT NULL OR wi.installed_quantity IS NOT NULL)
)
-- Scoped with organization_id = current_org_id(), same pattern as
-- v_po_line_item_utilization (migration 0025) — no separate RLS needed on
-- a view built this way.
SELECT * FROM events WHERE organization_id = public.current_org_id();

GRANT SELECT ON public.v_po_line_item_burndown_events TO authenticated;
