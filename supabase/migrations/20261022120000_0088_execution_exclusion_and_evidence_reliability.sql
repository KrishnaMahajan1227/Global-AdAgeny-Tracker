-- Execution exclusion + evidence reliability hardening.
-- Self-heals deployments where 0087 was not applied, prevents excluded work
-- from ever contributing installed totals, and backfills safe legacy proof links.

ALTER TABLE public.work_items
  ADD COLUMN IF NOT EXISTS execution_state text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS execution_reason text,
  ADD COLUMN IF NOT EXISTS execution_note text,
  ADD COLUMN IF NOT EXISTS excluded_from_calculations boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS execution_marked_at timestamptz,
  ADD COLUMN IF NOT EXISTS execution_marked_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL;

-- Any excluded item is, by definition, not installed. Keep this invariant in DB
-- even if an older client tries to write installed metrics later.
CREATE OR REPLACE FUNCTION public.enforce_work_item_execution_exclusion()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.excluded_from_calculations IS TRUE OR COALESCE(NEW.execution_state,'active') <> 'active' THEN
    NEW.excluded_from_calculations := TRUE;
    NEW.installed_width := NULL;
    NEW.installed_height := NULL;
    NEW.installed_unit := NULL;
    NEW.installed_quantity := NULL;
    NEW.installed_area := NULL;
    NEW.installed_at := NULL;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_work_item_execution_exclusion ON public.work_items;
CREATE TRIGGER trg_work_item_execution_exclusion
BEFORE INSERT OR UPDATE ON public.work_items
FOR EACH ROW EXECUTE FUNCTION public.enforce_work_item_execution_exclusion();

-- Normalize any rows that were marked unavailable before this trigger existed.
UPDATE public.work_items
SET installed_width=NULL, installed_height=NULL, installed_unit=NULL,
    installed_quantity=NULL, installed_area=NULL, installed_at=NULL
WHERE excluded_from_calculations IS TRUE OR COALESCE(execution_state,'active') <> 'active';

-- Safe legacy evidence backfill: when a shop has exactly one work item there is
-- no ambiguity, so old installation proofs can be linked automatically.
UPDATE public.installation_proofs ip
SET work_item_id = only_item.work_item_id
FROM (
  SELECT shop_id, min(id) AS work_item_id
  FROM public.work_items
  GROUP BY shop_id
  HAVING count(*) = 1
) only_item
WHERE ip.shop_id = only_item.shop_id AND ip.work_item_id IS NULL;

-- Agency PO utilization: excluded/non-executed items never contribute installed
-- area/quantity or the linked executed-item count used for billing readiness.
CREATE OR REPLACE VIEW public.v_po_line_item_utilization AS
SELECT
  pli.id AS po_line_item_id, pli.organization_id, pli.purchase_order_id,
  po.po_number, po.po_date, po.fulfillment_type, po.status AS po_status,
  po.client_id, c.name AS client_name, po.project_id, pr.name AS project_name,
  pli.description, pli.hsn_code, pli.work_type_id, wt.name AS work_type_name,
  pli.uom, pli.budgeted_qty, pli.budgeted_area, pli.rate,
  COALESCE((SELECT sum(wi.survey_area) FROM public.work_items wi WHERE wi.po_line_item_id=pli.id),0) AS surveyed_area,
  COALESCE((SELECT sum(wi.survey_quantity) FROM public.work_items wi WHERE wi.po_line_item_id=pli.id),0) AS surveyed_qty,
  COALESCE((SELECT sum(wi.approved_area) FROM public.work_items wi WHERE wi.po_line_item_id=pli.id),0) AS approved_area,
  COALESCE((SELECT sum(wi.approved_quantity) FROM public.work_items wi WHERE wi.po_line_item_id=pli.id),0) AS approved_qty,
  COALESCE((SELECT sum(wi.produced_quantity) FROM public.work_items wi WHERE wi.po_line_item_id=pli.id),0) AS produced_qty,
  COALESCE((SELECT sum(wi.installed_area) FROM public.work_items wi WHERE wi.po_line_item_id=pli.id AND NOT COALESCE(wi.excluded_from_calculations,false)),0) AS installed_area,
  COALESCE((SELECT sum(wi.installed_quantity) FROM public.work_items wi WHERE wi.po_line_item_id=pli.id AND NOT COALESCE(wi.excluded_from_calculations,false)),0) AS installed_qty,
  COALESCE((SELECT count(*) FROM public.work_items wi WHERE wi.po_line_item_id=pli.id AND NOT COALESCE(wi.excluded_from_calculations,false)),0) AS linked_work_item_count,
  COALESCE((SELECT sum(ii.amount) FROM public.invoice_items ii WHERE ii.po_line_item_id=pli.id),0) AS invoiced_amount
FROM public.po_line_items pli
JOIN public.purchase_orders po ON po.id=pli.purchase_order_id
LEFT JOIN public.clients c ON c.id=po.client_id
LEFT JOIN public.projects pr ON pr.id=po.project_id
LEFT JOIN public.work_types wt ON wt.id=pli.work_type_id
WHERE pli.organization_id=public.current_org_id();
GRANT SELECT ON public.v_po_line_item_utilization TO authenticated;

CREATE OR REPLACE VIEW public.v_client_po_line_item_progress AS
SELECT
  pli.id AS po_line_item_id, pli.purchase_order_id, po.organization_id AS agency_org_id,
  po.client_org_id, po.po_number, po.po_date, po.fulfillment_type,
  po.status AS po_status, po.assignment_status, pli.description, pli.work_type_id,
  wt.name AS work_type_name, pli.uom, pli.budgeted_qty, pli.budgeted_area,
  COALESCE((SELECT sum(wi.survey_area) FROM public.work_items wi WHERE wi.po_line_item_id=pli.id),0) AS surveyed_area,
  COALESCE((SELECT sum(wi.survey_quantity) FROM public.work_items wi WHERE wi.po_line_item_id=pli.id),0) AS surveyed_qty,
  COALESCE((SELECT sum(wi.approved_area) FROM public.work_items wi WHERE wi.po_line_item_id=pli.id),0) AS approved_area,
  COALESCE((SELECT sum(wi.approved_quantity) FROM public.work_items wi WHERE wi.po_line_item_id=pli.id),0) AS approved_qty,
  COALESCE((SELECT sum(wi.produced_quantity) FROM public.work_items wi WHERE wi.po_line_item_id=pli.id),0) AS produced_qty,
  COALESCE((SELECT sum(wi.installed_area) FROM public.work_items wi WHERE wi.po_line_item_id=pli.id AND NOT COALESCE(wi.excluded_from_calculations,false)),0) AS installed_area,
  COALESCE((SELECT sum(wi.installed_quantity) FROM public.work_items wi WHERE wi.po_line_item_id=pli.id AND NOT COALESCE(wi.excluded_from_calculations,false)),0) AS installed_qty,
  COALESCE((SELECT count(*) FROM public.work_items wi WHERE wi.po_line_item_id=pli.id AND NOT COALESCE(wi.excluded_from_calculations,false)),0) AS linked_work_item_count
FROM public.po_line_items pli
JOIN public.purchase_orders po ON po.id=pli.purchase_order_id
LEFT JOIN public.work_types wt ON wt.id=pli.work_type_id
WHERE po.client_org_id IS NOT NULL
  AND public.current_org_type()='client'
  AND po.client_org_id=public.current_org_id();
GRANT SELECT ON public.v_client_po_line_item_progress TO authenticated;
