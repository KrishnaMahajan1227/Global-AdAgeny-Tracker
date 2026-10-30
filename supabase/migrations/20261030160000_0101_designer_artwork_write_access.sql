-- Design Studio V10: agency owner/admin and the assigned designer are the
-- only identities permitted to write design task/artwork records.
-- Keep SELECT policies unchanged: Production and reporting still need
-- approved artwork as *read-only* input to their established workflows.
-- Safe additive policy hardening. No historical data changed.

CREATE OR REPLACE FUNCTION public.can_write_design_task(p_task_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.design_tasks t
    WHERE t.id = p_task_id
      AND t.organization_id = public.current_org_id()
      AND (
        public.current_role() IN ('agency_owner', 'admin')
        OR (public.current_role() = 'designer' AND t.designer_id = auth.uid())
      )
  );
$$;
REVOKE ALL ON FUNCTION public.can_write_design_task(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.can_write_design_task(uuid) TO authenticated;

DROP POLICY IF EXISTS design_tasks_insert ON public.design_tasks;
CREATE POLICY design_tasks_insert ON public.design_tasks FOR INSERT TO authenticated
  WITH CHECK (organization_id = public.current_org_id()
    AND public.current_role() IN ('agency_owner','admin'));

DROP POLICY IF EXISTS design_tasks_update ON public.design_tasks;
CREATE POLICY design_tasks_update ON public.design_tasks FOR UPDATE TO authenticated
  USING (organization_id = public.current_org_id() AND public.can_write_design_task(id))
  WITH CHECK (organization_id = public.current_org_id() AND public.can_write_design_task(id));

DROP POLICY IF EXISTS design_tasks_delete ON public.design_tasks;
CREATE POLICY design_tasks_delete ON public.design_tasks FOR DELETE TO authenticated
  USING (organization_id = public.current_org_id() AND public.current_role() IN ('agency_owner','admin'));

DROP POLICY IF EXISTS design_versions_insert ON public.design_versions;
CREATE POLICY design_versions_insert ON public.design_versions FOR INSERT TO authenticated
  WITH CHECK (organization_id = public.current_org_id()
    AND uploaded_by = auth.uid()
    AND public.can_write_design_task(design_task_id));

DROP POLICY IF EXISTS design_versions_update ON public.design_versions;
CREATE POLICY design_versions_update ON public.design_versions FOR UPDATE TO authenticated
  USING (organization_id = public.current_org_id() AND public.can_write_design_task(design_task_id))
  WITH CHECK (organization_id = public.current_org_id() AND public.can_write_design_task(design_task_id));

DROP POLICY IF EXISTS design_versions_delete ON public.design_versions;
CREATE POLICY design_versions_delete ON public.design_versions FOR DELETE TO authenticated
  USING (organization_id = public.current_org_id() AND public.can_write_design_task(design_task_id));

-- Work-item association is enforced by task AND shop, not just matching org.
CREATE OR REPLACE FUNCTION public.can_write_design_version_item(p_version_id uuid, p_work_item_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.design_versions v
    JOIN public.design_tasks t ON t.id = v.design_task_id
    JOIN public.work_items w ON w.id = p_work_item_id
    WHERE v.id = p_version_id
      AND v.organization_id = public.current_org_id()
      AND t.organization_id = public.current_org_id()
      AND w.organization_id = public.current_org_id()
      AND t.shop_id = w.shop_id
      AND public.can_write_design_task(t.id)
  );
$$;
REVOKE ALL ON FUNCTION public.can_write_design_version_item(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.can_write_design_version_item(uuid,uuid) TO authenticated;

DROP POLICY IF EXISTS design_version_items_insert ON public.design_version_items;
CREATE POLICY design_version_items_insert ON public.design_version_items FOR INSERT TO authenticated
  WITH CHECK (organization_id = public.current_org_id()
    AND public.can_write_design_version_item(design_version_id,work_item_id));

DROP POLICY IF EXISTS design_version_items_update ON public.design_version_items;
CREATE POLICY design_version_items_update ON public.design_version_items FOR UPDATE TO authenticated
  USING (organization_id = public.current_org_id()
    AND public.can_write_design_version_item(design_version_id,work_item_id))
  WITH CHECK (organization_id = public.current_org_id()
    AND public.can_write_design_version_item(design_version_id,work_item_id));

DROP POLICY IF EXISTS design_version_items_delete ON public.design_version_items;
CREATE POLICY design_version_items_delete ON public.design_version_items FOR DELETE TO authenticated
  USING (organization_id = public.current_org_id()
    AND public.can_write_design_version_item(design_version_id,work_item_id));

-- Existing design-file object keys have shape: org-id/design-task-id/version-filename.
-- Restrict writes, leave SELECT untouched for existing production/reporting.
CREATE OR REPLACE FUNCTION public.can_write_design_object(p_name text)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_task uuid;
BEGIN
  IF split_part(p_name,'/',1) <> public.current_org_id()::text
     OR split_part(p_name,'/',2) !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN false;
  END IF;
  v_task := split_part(p_name,'/',2)::uuid;
  RETURN public.can_write_design_task(v_task);
END;
$$;
REVOKE ALL ON FUNCTION public.can_write_design_object(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.can_write_design_object(text) TO authenticated;

DROP POLICY IF EXISTS design_files_insert ON storage.objects;
CREATE POLICY design_files_insert ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'design-files' AND public.can_write_design_object(name));

DROP POLICY IF EXISTS design_files_update ON storage.objects;
CREATE POLICY design_files_update ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'design-files' AND public.can_write_design_object(name))
  WITH CHECK (bucket_id = 'design-files' AND public.can_write_design_object(name));

DROP POLICY IF EXISTS design_files_delete ON storage.objects;
CREATE POLICY design_files_delete ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'design-files' AND public.can_write_design_object(name));
