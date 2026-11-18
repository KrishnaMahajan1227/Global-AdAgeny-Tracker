-- Additive indexes only: efficient scoped paging and pre-production design mapping.
-- No existing PO, assignment, approval, shop or evidence row is modified.
-- Run in staging first; index creation may briefly acquire locks on large tables.
CREATE INDEX IF NOT EXISTS idx_adroute_shops_org_po_created
  ON public.shops (organization_id, purchase_order_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_adroute_shops_org_status_created
  ON public.shops (organization_id, status, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_adroute_work_items_shop_line_status
  ON public.work_items (shop_id, po_line_item_id, status);
CREATE INDEX IF NOT EXISTS idx_adroute_design_links_item_version
  ON public.design_version_items (work_item_id, design_version_id);

-- Large Work Orders: one set-based initialization when a NEW PO line is added.
-- Replaces a row-by-row loop through every shop. Preserves original 0097
-- semantics, including statuses, task creation and never fabricating sizes.
CREATE OR REPLACE FUNCTION public.trg_initialize_production_install_line()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_po record;
BEGIN
  SELECT id, organization_id, client_id, fulfillment_type INTO v_po
    FROM public.purchase_orders WHERE id=NEW.purchase_order_id;
  IF NOT FOUND OR v_po.fulfillment_type IS DISTINCT FROM 'production_install' THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.work_items
    (organization_id, shop_id, po_line_item_id, work_type_id, work_type_name, status,
     survey_quantity, approved_quantity, approved_area)
  SELECT s.organization_id, s.id, NEW.id, NEW.work_type_id, NEW.description, 'pending',
         NULL, NULL, NULL
    FROM public.shops AS s
   WHERE s.purchase_order_id=NEW.purchase_order_id
     AND s.organization_id=v_po.organization_id AND s.client_id=v_po.client_id
     AND s.status IN ('pending','assigned','design_pending')
     AND NOT EXISTS (SELECT 1 FROM public.work_items wi
       WHERE wi.shop_id=s.id AND wi.po_line_item_id=NEW.id);

  INSERT INTO public.design_tasks (organization_id,shop_id,status,designer_id)
  SELECT s.organization_id,s.id,'assigned',NULL
    FROM public.shops s
   WHERE s.purchase_order_id=NEW.purchase_order_id
     AND s.organization_id=v_po.organization_id AND s.client_id=v_po.client_id
     AND s.status IN ('pending','assigned','design_pending')
     AND NOT EXISTS (SELECT 1 FROM public.design_tasks d WHERE d.shop_id=s.id);

  UPDATE public.shops s SET status='design_pending'
   WHERE s.purchase_order_id=NEW.purchase_order_id
     AND s.organization_id=v_po.organization_id AND s.client_id=v_po.client_id
     AND s.status IN ('pending','assigned');
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.trg_initialize_production_install_line() FROM PUBLIC;
