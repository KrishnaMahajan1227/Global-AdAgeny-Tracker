-- Board-wise Design Review artwork approval for multiple boards/shops.
-- Additive change after 0119; no existing data deletion or rewrite.
-- Preserve original 0119 RPC permissions, guards, company gate, audit and
-- correction trigger. The RPC is replaced with an enhanced finalization.
-- Design Review: one atomic decision per shop, including selected-item rework.
-- Reuses review_apply (0090) for decisions, corrections, notifications and
-- company approval trigger (0098). No change to Survey/Installation review.
ALTER TABLE public.design_versions
  ADD COLUMN IF NOT EXISTS upload_batch_id uuid;
CREATE INDEX IF NOT EXISTS idx_design_versions_task_batch
  ON public.design_versions(design_task_id, upload_batch_id, version_number DESC);

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
  v_last_file_id uuid;
  v_last_file_status text;
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

  -- Legacy review_apply marks the highest version as approved, even if it
  -- was rejected. Restore a rejected/deleted last file before deriving the
  -- current per-board batch; never revive invalid artwork.
  SELECT id,status INTO v_last_file_id,v_last_file_status
    FROM public.design_versions WHERE design_task_id=p_task_id
    ORDER BY version_number DESC,created_at DESC,id DESC LIMIT 1;

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


  -- One uploaded file may cover several boards, and different boards may
  -- use different uploaded versions. Production reads only APPROVED files;
  -- the previous finalizer approved only the last file for the entire shop.
  -- Mark exactly the newest usable mapped file for EACH board approved.
  -- Superseded approved files are returned to "uploaded" so old revisions
  -- cannot accidentally appear alongside the approved latest board artwork.
  -- Existing rejected files stay rejected. This happens in the same atomic
  -- transaction as the shop review; no partial production mappings.
  IF COALESCE((v_result->>'finalized')::boolean,false) THEN
    IF v_last_file_id IS NOT NULL AND v_last_file_status NOT IN ('uploaded','approved') THEN
      UPDATE public.design_versions SET status=v_last_file_status
        WHERE id=v_last_file_id;
    END IF;
    WITH latest_batch AS (
      SELECT DISTINCT ON (vi.work_item_id)
        vi.work_item_id, COALESCE(dv.upload_batch_id,dv.id) AS batch_id
      FROM public.design_version_items vi
      JOIN public.design_versions dv ON dv.id=vi.design_version_id
      JOIN public.work_items wi ON wi.id=vi.work_item_id
      WHERE dv.design_task_id=p_task_id AND wi.shop_id=v_shop
        AND dv.status IN ('uploaded','approved')
        AND NULLIF(btrim(dv.file_url),'') IS NOT NULL
      ORDER BY vi.work_item_id,dv.version_number DESC,dv.created_at DESC,dv.id DESC
    ), effective_files AS (
      SELECT DISTINCT dv.id
      FROM latest_batch lb
      JOIN public.design_version_items vi ON vi.work_item_id=lb.work_item_id
      JOIN public.design_versions dv ON dv.id=vi.design_version_id
      WHERE dv.design_task_id=p_task_id
        AND COALESCE(dv.upload_batch_id,dv.id)=lb.batch_id
        AND dv.status IN ('uploaded','approved')
        AND NULLIF(btrim(dv.file_url),'') IS NOT NULL
    )
    UPDATE public.design_versions dv
      SET status=CASE WHEN dv.id IN (SELECT id FROM effective_files)
                      THEN 'approved' ELSE 'uploaded' END
    WHERE dv.design_task_id=p_task_id AND dv.status IN ('uploaded','approved')
      AND dv.status IS DISTINCT FROM CASE WHEN dv.id IN (SELECT id FROM effective_files)
                                         THEN 'approved' ELSE 'uploaded' END;
  END IF;

  INSERT INTO public.audit_logs(organization_id,user_id,table_name,record_id,action,field_name,description)
  VALUES(v_org,auth.uid(),'design_tasks',p_task_id,'update','design_review',
    CASE WHEN v_unique_redo>0 THEN 'Changes requested on '||v_unique_redo||' work item(s)'
         ELSE 'All design work items approved' END);
  RETURN v_result;
END $$;
REVOKE ALL ON FUNCTION public.design_review_decide(uuid,uuid[],text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.design_review_decide(uuid,uuid[],text) TO authenticated;

