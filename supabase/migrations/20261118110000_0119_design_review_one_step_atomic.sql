-- Design Review: one atomic decision per shop, including selected-item rework.
-- Reuses review_apply (0090) for decisions, corrections, notifications and
-- company approval trigger (0098). No change to Survey/Installation review.
CREATE OR REPLACE FUNCTION public.design_review_decide(
  p_task_id uuid, p_redo_item_ids uuid[] DEFAULT '{}'::uuid[], p_note text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  v_shop uuid;
  v_org uuid;
  v_status text;
  v_total integer;
  v_unique_redo integer;
  v_bad_ids integer;
  v_missing_artwork integer;
  v_redo_json jsonb;
  v_approve_json jsonb;
  v_result jsonb;
BEGIN
  IF auth.uid() IS NULL OR public.current_role() NOT IN ('agency_owner','admin') THEN
    RAISE EXCEPTION 'Only Owner/Admin may review designs';
  END IF;
  SELECT shop_id, organization_id, status INTO v_shop, v_org, v_status
  FROM public.design_tasks WHERE id=p_task_id FOR UPDATE;
  IF v_shop IS NULL OR v_org IS DISTINCT FROM public.current_org_id() THEN
    RAISE EXCEPTION 'Design task not accessible';
  END IF;
  IF v_status <> 'in_review' THEN
    RAISE EXCEPTION 'This design is no longer awaiting review. Refresh the queue.';
  END IF;
  SELECT count(*) INTO v_total FROM public.work_items WHERE shop_id=v_shop;
  IF v_total=0 THEN RAISE EXCEPTION 'No work items were found for design review'; END IF;

  SELECT count(DISTINCT id) INTO v_unique_redo FROM unnest(COALESCE(p_redo_item_ids,'{}'::uuid[])) AS selected(id);
  IF cardinality(COALESCE(p_redo_item_ids,'{}'::uuid[]))<>v_unique_redo THEN
    RAISE EXCEPTION 'A work item was selected more than once';
  END IF;
  SELECT count(*) INTO v_bad_ids FROM unnest(COALESCE(p_redo_item_ids,'{}'::uuid[])) AS selected(id)
  WHERE NOT EXISTS(SELECT 1 FROM public.work_items w WHERE w.id=selected.id AND w.shop_id=v_shop);
  IF v_bad_ids>0 THEN RAISE EXCEPTION 'Correction includes work items from another shop'; END IF;

  -- Only boards being approved need usable mapped artwork. A reviewer must
  -- still be able to send a completely missing artwork board for correction.
  SELECT count(*) INTO v_missing_artwork FROM public.work_items w
  WHERE w.shop_id=v_shop AND (v_unique_redo=0 OR NOT (w.id=ANY(p_redo_item_ids))) AND NOT EXISTS (
    SELECT 1 FROM public.design_version_items vi
    JOIN public.design_versions dv ON dv.id=vi.design_version_id
    WHERE vi.work_item_id=w.id AND dv.design_task_id=p_task_id
      AND dv.status NOT IN ('rejected','deleted')
      AND NULLIF(btrim(dv.file_url),'') IS NOT NULL
  );
  IF v_missing_artwork>0 THEN
    RAISE EXCEPTION '% work item(s) cannot be approved without mapped artwork. Select them for changes first.',v_missing_artwork;
  END IF;
  IF v_unique_redo>0 AND NULLIF(btrim(COALESCE(p_note,'')),'') IS NULL THEN
    RAISE EXCEPTION 'Correction note is required';
  END IF;

  -- Both statements run inside this transaction. A failure at either step
  -- (including missing company approval) rolls back *all* item decisions.
  IF v_unique_redo>0 THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object('type','work_item','id',id)),'[]'::jsonb)
    INTO v_redo_json FROM unnest(p_redo_item_ids) AS selected(id);
    v_result := public.review_apply('design',v_shop,p_task_id,v_redo_json,'redo',p_note,NULL,'{}'::jsonb);

    SELECT COALESCE(jsonb_agg(jsonb_build_object('type','work_item','id',w.id)),'[]'::jsonb)
    INTO v_approve_json FROM public.work_items w
    WHERE w.shop_id=v_shop AND NOT (w.id=ANY(p_redo_item_ids));
    IF jsonb_array_length(v_approve_json)>0 THEN
      v_result := public.review_apply('design',v_shop,p_task_id,v_approve_json,'approved',NULL,NULL,'{}'::jsonb);
    END IF;
    IF NOT COALESCE((v_result->>'left_review')::boolean,false) THEN
      RAISE EXCEPTION 'Design review did not finish; please reload the review';
    END IF;
  ELSE
    v_result := public.review_apply('design',v_shop,p_task_id,NULL,'approved',NULL,NULL,'{}'::jsonb);
    IF NOT COALESCE((v_result->>'finalized')::boolean,false) THEN
      RAISE EXCEPTION 'Design approval is incomplete. Check open corrections before approving';
    END IF;
  END IF;

  INSERT INTO public.audit_logs(organization_id,user_id,table_name,record_id,action,field_name,description)
  VALUES(v_org,auth.uid(),'design_tasks',p_task_id,'update','design_review',
    CASE WHEN v_unique_redo>0 THEN 'Changes requested on '||v_unique_redo||' work item(s)'
         ELSE 'All design work items approved' END);
  RETURN v_result;
END $$;
REVOKE ALL ON FUNCTION public.design_review_decide(uuid,uuid[],text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.design_review_decide(uuid,uuid[],text) TO authenticated;

-- Prevent closing a correction without a newer artwork version mapped to
-- the *specific* affected board. The old uploaded file remains visible for
-- comparison, but is not enough to claim the correction was completed.
CREATE OR REPLACE FUNCTION public.design_review_require_fresh_correction_artwork()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_unfixed integer;
BEGIN
  IF NEW.status='in_review' AND OLD.status IS DISTINCT FROM 'in_review' THEN
    SELECT count(*) INTO v_unfixed FROM public.field_corrections c
    WHERE c.shop_id=NEW.shop_id AND c.stage='design' AND c.status='open'
      AND c.work_item_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.design_version_items vi
        JOIN public.design_versions dv ON dv.id=vi.design_version_id
        WHERE vi.work_item_id=c.work_item_id AND dv.design_task_id=NEW.id
          AND dv.status NOT IN ('rejected','deleted')
          AND NULLIF(btrim(dv.file_url),'') IS NOT NULL
          AND dv.created_at>c.created_at
      );
    IF v_unfixed>0 THEN
      RAISE EXCEPTION 'Upload fresh artwork mapped to the % corrected work item(s) before submitting for review',v_unfixed;
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_design_review_fresh_corrections ON public.design_tasks;
CREATE TRIGGER trg_design_review_fresh_corrections
  BEFORE UPDATE OF status ON public.design_tasks
  FOR EACH ROW EXECUTE FUNCTION public.design_review_require_fresh_correction_artwork();
