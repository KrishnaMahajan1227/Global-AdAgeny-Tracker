-- Department-read scopes. A direct REST GET with a guessed UUID must not
-- disclose another team's assigned site. This is deliberately read-only;
-- the existing designer/printing write policies from 0101/0102 remain.
CREATE OR REPLACE FUNCTION public.can_access_department_shop(p_shop uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_catalog AS $$
 SELECT
   (public.current_role()='designer' AND EXISTS (
     SELECT 1 FROM public.design_tasks d WHERE d.shop_id=p_shop
       AND d.organization_id=public.current_org_id() AND d.designer_id=auth.uid()))
   OR
   (public.current_role()='printing' AND EXISTS (
     SELECT 1 FROM public.production_orders p WHERE p.shop_id=p_shop
       AND p.organization_id=public.current_org_id() AND p.assigned_to=auth.uid()));
$$;
REVOKE ALL ON FUNCTION public.can_access_department_shop(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.can_access_department_shop(uuid) TO authenticated;

DROP POLICY IF EXISTS security_department_shops ON public.shops;
CREATE POLICY security_department_shops ON public.shops AS RESTRICTIVE FOR SELECT TO authenticated
 USING (public.current_role() NOT IN ('designer','printing') OR public.can_access_department_shop(id));
DROP POLICY IF EXISTS security_department_clients ON public.clients;
CREATE POLICY security_department_clients ON public.clients AS RESTRICTIVE FOR SELECT TO authenticated
 USING (public.current_role() NOT IN ('designer','printing') OR EXISTS (
    SELECT 1 FROM public.shops s WHERE s.client_id=clients.id AND public.can_access_department_shop(s.id)));
DROP POLICY IF EXISTS security_department_surveys ON public.surveys;
CREATE POLICY security_department_surveys ON public.surveys AS RESTRICTIVE FOR SELECT TO authenticated
 USING (public.current_role() NOT IN ('designer','printing') OR public.can_access_department_shop(shop_id));
DROP POLICY IF EXISTS security_department_survey_photos ON public.survey_photos;
CREATE POLICY security_department_survey_photos ON public.survey_photos AS RESTRICTIVE FOR SELECT TO authenticated
 USING (public.current_role() NOT IN ('designer','printing') OR public.can_access_department_shop(shop_id));
DROP POLICY IF EXISTS security_department_work_items ON public.work_items;
CREATE POLICY security_department_work_items ON public.work_items AS RESTRICTIVE FOR SELECT TO authenticated
 USING (public.current_role() NOT IN ('designer','printing') OR public.can_access_department_shop(shop_id));
DROP POLICY IF EXISTS security_department_design_tasks ON public.design_tasks;
CREATE POLICY security_department_design_tasks ON public.design_tasks AS RESTRICTIVE FOR SELECT TO authenticated
 USING (public.current_role() NOT IN ('designer','printing') OR public.can_access_department_shop(shop_id));
DROP POLICY IF EXISTS security_department_design_versions ON public.design_versions;
CREATE POLICY security_department_design_versions ON public.design_versions AS RESTRICTIVE FOR SELECT TO authenticated
 USING (public.current_role() NOT IN ('designer','printing') OR EXISTS (
   SELECT 1 FROM public.design_tasks d WHERE d.id=design_versions.design_task_id
    AND public.can_access_department_shop(d.shop_id)));
DROP POLICY IF EXISTS security_department_production_orders ON public.production_orders;
CREATE POLICY security_department_production_orders ON public.production_orders AS RESTRICTIVE FOR SELECT TO authenticated
 USING (public.current_role() NOT IN ('designer','printing') OR public.can_access_department_shop(shop_id));
DROP POLICY IF EXISTS security_department_production_items ON public.production_items;
CREATE POLICY security_department_production_items ON public.production_items AS RESTRICTIVE FOR SELECT TO authenticated
 USING (public.current_role() NOT IN ('designer','printing') OR EXISTS (
    SELECT 1 FROM public.production_orders po WHERE po.id=production_items.production_order_id
     AND public.can_access_department_shop(po.shop_id)));
DROP POLICY IF EXISTS security_department_install_proofs ON public.installation_proofs;
CREATE POLICY security_department_install_proofs ON public.installation_proofs AS RESTRICTIVE FOR SELECT TO authenticated
 USING (public.current_role() NOT IN ('designer','printing') OR public.can_access_department_shop(shop_id));

-- A demonstration login inside a real agency must not see real client/shop
-- records via a hand-crafted REST URL (even if UI normally filters is_demo).
DROP POLICY IF EXISTS security_demo_clients ON public.clients;
CREATE POLICY security_demo_clients ON public.clients AS RESTRICTIVE FOR SELECT TO authenticated
 USING (public.current_role()<>'demo' OR is_demo IS TRUE);
DROP POLICY IF EXISTS security_demo_shops ON public.shops;
CREATE POLICY security_demo_shops ON public.shops AS RESTRICTIVE FOR SELECT TO authenticated
 USING (public.current_role()<>'demo' OR is_demo IS TRUE);
DROP POLICY IF EXISTS security_demo_projects ON public.projects;
CREATE POLICY security_demo_projects ON public.projects AS RESTRICTIVE FOR SELECT TO authenticated
 USING (public.current_role()<>'demo' OR is_demo IS TRUE);
DROP POLICY IF EXISTS security_demo_purchase_orders ON public.purchase_orders;
CREATE POLICY security_demo_purchase_orders ON public.purchase_orders AS RESTRICTIVE FOR SELECT TO authenticated
 USING (public.current_role()<>'demo' OR is_demo IS TRUE);
DROP POLICY IF EXISTS security_demo_work_items ON public.work_items;
CREATE POLICY security_demo_work_items ON public.work_items AS RESTRICTIVE FOR SELECT TO authenticated
 USING (public.current_role()<>'demo' OR EXISTS (
    SELECT 1 FROM public.shops s WHERE s.id=work_items.shop_id AND s.is_demo IS TRUE));
