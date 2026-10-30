-- Production V11: restrict direct write access to Owner, Admin and the assigned
-- Production worker. This migration does not change historic records, views,
-- read visibility, installed-site status or the phase3 completion RPC.
-- It follows 0101 (Designer artwork access). Review on staging before push.

-- The existing policy names are replaced, not combined with old permissive
-- policies (Postgres permissive RLS policies are OR'ed).
DROP POLICY IF EXISTS "production_orders_insert" ON public.production_orders;
CREATE POLICY "production_orders_insert" ON public.production_orders FOR INSERT
  TO authenticated WITH CHECK (
    organization_id = public.current_org_id()
    AND public.current_role() IN ('agency_owner','admin')
  );

DROP POLICY IF EXISTS "production_orders_update" ON public.production_orders;
CREATE POLICY "production_orders_update" ON public.production_orders FOR UPDATE
  TO authenticated USING (
    organization_id = public.current_org_id() AND (
      public.current_role() IN ('agency_owner','admin')
      OR (public.current_role()='printing' AND assigned_to = auth.uid())
    )
  ) WITH CHECK (
    organization_id = public.current_org_id() AND (
      public.current_role() IN ('agency_owner','admin')
      OR (public.current_role()='printing' AND assigned_to = auth.uid())
    )
  );

DROP POLICY IF EXISTS "production_items_insert" ON public.production_items;
CREATE POLICY "production_items_insert" ON public.production_items FOR INSERT
  TO authenticated WITH CHECK (
    organization_id = public.current_org_id() AND
    EXISTS (SELECT 1 FROM public.production_orders scope_po
      WHERE scope_po.id=production_order_id AND scope_po.organization_id=public.current_org_id()) AND (
      public.current_role() IN ('agency_owner','admin')
      OR (public.current_role()='printing' AND EXISTS (
        SELECT 1 FROM public.production_orders po
        WHERE po.id=production_order_id AND po.organization_id=public.current_org_id()
          AND po.assigned_to=auth.uid() AND po.status NOT IN ('completed','hold')
      ))
    )
  );

DROP POLICY IF EXISTS "production_items_update" ON public.production_items;
CREATE POLICY "production_items_update" ON public.production_items FOR UPDATE
  TO authenticated USING (
    organization_id = public.current_org_id() AND
    EXISTS (SELECT 1 FROM public.production_orders scope_po
      WHERE scope_po.id=production_order_id AND scope_po.organization_id=public.current_org_id()) AND (
      public.current_role() IN ('agency_owner','admin')
      OR (public.current_role()='printing' AND EXISTS (
        SELECT 1 FROM public.production_orders po
        WHERE po.id=production_order_id AND po.organization_id=public.current_org_id()
          AND po.assigned_to=auth.uid() AND po.status NOT IN ('completed','hold')
      ))
    )
  ) WITH CHECK (
    organization_id = public.current_org_id() AND
    EXISTS (SELECT 1 FROM public.production_orders scope_po
      WHERE scope_po.id=production_order_id AND scope_po.organization_id=public.current_org_id()) AND (
      public.current_role() IN ('agency_owner','admin')
      OR (public.current_role()='printing' AND EXISTS (
        SELECT 1 FROM public.production_orders po
        WHERE po.id=production_order_id AND po.organization_id=public.current_org_id()
          AND po.assigned_to=auth.uid() AND po.status NOT IN ('completed','hold')
      ))
    )
  );

DROP POLICY IF EXISTS "production_items_delete" ON public.production_items;
CREATE POLICY "production_items_delete" ON public.production_items FOR DELETE
  TO authenticated USING (
    organization_id = public.current_org_id()
    AND public.current_role() IN ('agency_owner','admin')
  );

-- Read permissions are intentionally unchanged: downstream authorized
-- installation/load/report flows still need approved production details.
-- Work-item/component tables are shared with Survey/Design/Field modules:
-- do not restrict those tables here without a separate cross-role migration.
