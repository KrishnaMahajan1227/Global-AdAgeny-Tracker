-- Security release 0106: private evidence and documents. Apply after 0105.
-- Existing file paths and DB rows stay unchanged; client resolves legacy public URLs into
-- short-lived authorized signed URLs. Previously cached public CDN URLs may outlive rollout.

CREATE OR REPLACE FUNCTION public.private_media_allowed(p_bucket text, p_path text, p_write boolean DEFAULT false)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_catalog AS $$
DECLARE v_org uuid; v_role text; v_target uuid; v_owner uuid; v_shop uuid; v_client uuid;
BEGIN
 v_org:=public.current_org_id(); v_role:=public.current_role();
 IF v_org IS NULL OR v_role IS NULL OR p_bucket NOT IN ('survey-photos','installation-proof','design-files','purchase-orders') THEN RETURN false; END IF;
 IF p_path IS NULL OR length(p_path)>1024 OR p_path LIKE '%..%' OR position(E'\\' IN p_path)>0 THEN RETURN false; END IF;
 IF split_part(p_path,'/',1) !~* '^[a-f0-9-]{36}$' OR split_part(p_path,'/',2)='' THEN RETURN false; END IF;
 v_owner:=split_part(p_path,'/',1)::uuid;
 IF p_write THEN
   IF v_owner<>v_org THEN RETURN false; END IF;
   IF v_role IN ('agency_owner','admin') THEN RETURN true; END IF;
   IF p_bucket='purchase-orders' THEN RETURN v_role IN ('accounts','client_manager'); END IF;
   IF split_part(p_path,'/',2) !~* '^[a-f0-9-]{36}$' THEN RETURN false; END IF;
   v_target:=split_part(p_path,'/',2)::uuid;
   IF p_bucket='survey-photos' AND v_role='surveyor' THEN
     RETURN EXISTS(SELECT 1 FROM public.surveys s WHERE s.id=v_target AND s.organization_id=v_org
       AND public.can_access_field_shop(s.shop_id))
       OR public.can_access_field_shop(v_target);
   ELSIF p_bucket='installation-proof' AND v_role='installer' THEN
     RETURN EXISTS(SELECT 1 FROM public.installation_jobs j WHERE j.id=v_target AND j.organization_id=v_org
       AND public.can_access_field_shop(j.shop_id))
       OR public.can_access_field_shop(v_target); -- legacy redo evidence uses a shop-id key
   ELSIF p_bucket='design-files' AND v_role='designer' THEN
     RETURN EXISTS(SELECT 1 FROM public.design_tasks d WHERE d.id=v_target
       AND d.organization_id=v_org AND d.designer_id=auth.uid());
   END IF;
   RETURN false;
 END IF;
 -- A private object is not readable merely because its UUID/prefix is known.
 -- Agency office roles are permitted within their own organization.
 IF v_owner=v_org AND v_role IN ('agency_owner','admin','accounts','client_manager') THEN RETURN true; END IF;
 -- Scoped worker reads, plus assigned designer/printer's evidence/artwork.
 IF p_bucket='survey-photos' THEN
   SELECT s.shop_id INTO v_shop FROM public.survey_photos s WHERE s.storage_path=p_path LIMIT 1;
 ELSIF p_bucket='installation-proof' THEN
   SELECT j.shop_id INTO v_shop FROM public.installation_proofs j WHERE j.storage_path=p_path LIMIT 1;
 ELSIF p_bucket='design-files' THEN
   SELECT d.shop_id INTO v_shop FROM public.design_versions v
     JOIN public.design_tasks d ON d.id=v.design_task_id WHERE v.storage_path=p_path LIMIT 1;
 ELSIF p_bucket='purchase-orders' THEN
   SELECT po.client_org_id INTO v_client FROM public.purchase_orders po WHERE po.storage_path=p_path LIMIT 1;
 END IF;
 IF v_shop IS NOT NULL AND v_owner=v_org THEN
   IF public.can_access_field_shop(v_shop) THEN RETURN true; END IF;
   IF v_role='designer' AND EXISTS (SELECT 1 FROM public.design_tasks d WHERE d.shop_id=v_shop AND d.designer_id=auth.uid()) THEN RETURN true; END IF;
   IF v_role='printing' AND EXISTS (SELECT 1 FROM public.production_orders p WHERE p.shop_id=v_shop AND p.assigned_to=auth.uid()) THEN RETURN true; END IF;
 END IF;
 -- Client users may only read records for their own linked Work Orders.
 IF v_role IN ('client_admin','client_viewer') THEN
   IF p_bucket='purchase-orders' AND v_client=v_org THEN
     RETURN EXISTS(SELECT 1 FROM public.purchase_orders po WHERE po.storage_path=p_path
       AND po.client_org_id=v_org AND public.is_active_client_agency_link(v_org,po.organization_id));
   END IF;
   IF v_shop IS NOT NULL THEN
     RETURN EXISTS(SELECT 1 FROM public.shops sh JOIN public.purchase_orders po ON po.id=sh.purchase_order_id
       WHERE sh.id=v_shop AND po.client_org_id=v_org
       AND public.is_active_client_agency_link(v_org,po.organization_id));
   END IF;
 END IF;
 RETURN false;
END;
$$;
REVOKE ALL ON FUNCTION public.private_media_allowed(text,text,boolean) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.private_media_allowed(text,text,boolean) TO authenticated;

UPDATE storage.buckets SET public=false
 WHERE id IN ('survey-photos','design-files','installation-proof','purchase-orders');

-- Remove the original public read and unscoped authenticated write policies.
DROP POLICY IF EXISTS survey_photos_select ON storage.objects;
DROP POLICY IF EXISTS survey_photos_insert ON storage.objects;
DROP POLICY IF EXISTS survey_photos_update ON storage.objects;
DROP POLICY IF EXISTS survey_photos_delete ON storage.objects;
DROP POLICY IF EXISTS design_files_select ON storage.objects;
DROP POLICY IF EXISTS design_files_insert ON storage.objects;
DROP POLICY IF EXISTS design_files_update ON storage.objects;
DROP POLICY IF EXISTS design_files_delete ON storage.objects;
DROP POLICY IF EXISTS installation_proof_select ON storage.objects;
DROP POLICY IF EXISTS installation_proof_insert ON storage.objects;
DROP POLICY IF EXISTS installation_proof_update ON storage.objects;
DROP POLICY IF EXISTS installation_proof_delete ON storage.objects;
DROP POLICY IF EXISTS purchase_order_files_select ON storage.objects;
DROP POLICY IF EXISTS purchase_order_files_insert ON storage.objects;
DROP POLICY IF EXISTS purchase_order_files_update ON storage.objects;
DROP POLICY IF EXISTS purchase_order_files_delete ON storage.objects;

CREATE POLICY adroute_media_read ON storage.objects FOR SELECT TO authenticated
 USING (public.private_media_allowed(bucket_id,name,false));
CREATE POLICY adroute_media_insert ON storage.objects FOR INSERT TO authenticated
 WITH CHECK (public.private_media_allowed(bucket_id,name,true));
CREATE POLICY adroute_media_update ON storage.objects FOR UPDATE TO authenticated
 USING (public.private_media_allowed(bucket_id,name,true))
 WITH CHECK (public.private_media_allowed(bucket_id,name,true));
CREATE POLICY adroute_media_delete ON storage.objects FOR DELETE TO authenticated
 USING (public.private_media_allowed(bucket_id,name,true));
