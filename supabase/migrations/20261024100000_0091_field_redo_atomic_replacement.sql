-- Field correction safety: replace the current evidence IN PLACE, never remove old
-- storage objects during a correction, and only resubmit corrections with a saved replacement.
-- No table drops, record deletes, or changes to approved evidence.
ALTER TABLE public.field_corrections ADD COLUMN IF NOT EXISTS replacement_saved_at timestamptz;

CREATE OR REPLACE FUNCTION public.field_redo_save(p_correction_id uuid, p_payload jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE c public.field_corrections%ROWTYPE; m record; old_count integer; supplied_count integer;
        p_item uuid; p_photo uuid; v_proof uuid; v_path text; v_url text; v_qty integer;
        v_width numeric; v_height numeric; v_unit text; v_w numeric; v_h numeric; v_before text;
BEGIN
  SELECT * INTO c FROM public.field_corrections WHERE id=p_correction_id FOR UPDATE;
  IF c.id IS NULL OR c.status <> 'open' OR c.assigned_to <> auth.uid()
    OR c.organization_id <> public.current_org_id() THEN
    RAISE EXCEPTION 'This correction is not available to the signed-in field worker';
  END IF;
  IF jsonb_typeof(p_payload) <> 'object' THEN RAISE EXCEPTION 'Invalid correction payload'; END IF;

  IF c.stage='survey' AND c.issue_type='measurement' THEN
    IF c.work_item_id IS NULL THEN RAISE EXCEPTION 'Missing target work item'; END IF;
    v_width := (p_payload->>'width')::numeric; v_height := (p_payload->>'height')::numeric;
    v_qty := (p_payload->>'quantity')::integer; v_unit := p_payload->>'unit';
    IF v_width IS NULL OR v_height IS NULL OR v_qty IS NULL OR v_unit IS NULL OR v_width <= 0 OR v_height <= 0 OR v_qty < 1 OR v_qty > 100000 OR v_unit NOT IN ('ft','in','m','cm') THEN
      RAISE EXCEPTION 'Provide valid measurements and quantity';
    END IF;
    v_w := v_width * CASE v_unit WHEN 'ft' THEN 1 WHEN 'in' THEN 1.0/12 WHEN 'm' THEN 3.280839895013123 ELSE 0.03280839895013123 END;
    v_h := v_height * CASE v_unit WHEN 'ft' THEN 1 WHEN 'in' THEN 1.0/12 WHEN 'm' THEN 3.280839895013123 ELSE 0.03280839895013123 END;
    SELECT concat_ws(' / ',survey_width,survey_height,survey_quantity,survey_notes) INTO v_before FROM public.work_items WHERE id=c.work_item_id;
    UPDATE public.work_items SET survey_width=v_w, survey_height=v_h, survey_unit='ft',
      entered_width=v_width, entered_height=v_height, entered_width_unit=v_unit, entered_height_unit=v_unit,
      survey_quantity=v_qty, survey_area=round(v_w*v_h*v_qty,2), survey_notes=NULLIF(p_payload->>'notes','')
      WHERE id=c.work_item_id AND shop_id=c.shop_id AND organization_id=c.organization_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Work item not found'; END IF;
    INSERT INTO public.audit_logs(organization_id,user_id,table_name,record_id,action,field_name,old_value,new_value,description)
      VALUES(c.organization_id,auth.uid(),'work_items',c.work_item_id,'update','survey_redo',v_before,
      concat_ws(' / ',v_w,v_h,v_qty,p_payload->>'notes'),'Survey measurements corrected in place');

  ELSIF c.stage='survey' AND c.issue_type='survey_photo' THEN
    v_path := NULLIF(p_payload->>'storage_path',''); v_url := NULLIF(p_payload->>'photo_url','');
    IF c.survey_photo_id IS NULL OR v_path IS NULL OR v_url IS NULL OR
      v_path NOT LIKE c.organization_id::text || '/' || c.shop_id::text || '/redo-' || c.id::text || '-%' THEN RAISE EXCEPTION 'Invalid replacement photo'; END IF;
    IF jsonb_typeof(p_payload->'markings') <> 'array' THEN RAISE EXCEPTION 'Markings required'; END IF;
    SELECT count(*) INTO old_count FROM public.board_markings WHERE survey_photo_id=c.survey_photo_id AND organization_id=c.organization_id;
    SELECT count(*) INTO supplied_count FROM jsonb_array_elements(p_payload->'markings');
    IF old_count <> supplied_count OR supplied_count <> (SELECT count(DISTINCT x->>'id') FROM jsonb_array_elements(p_payload->'markings') x) THEN
      RAISE EXCEPTION 'All existing boards on this photo must be re-marked exactly once'; END IF;
    FOR m IN SELECT x FROM jsonb_array_elements(p_payload->'markings') x LOOP
      IF jsonb_typeof(m.x->'points') <> 'array' OR jsonb_array_length(m.x->'points') NOT BETWEEN 3 AND 4
         OR EXISTS (SELECT 1 FROM jsonb_array_elements(m.x->'points') pt
           WHERE (pt->>'x')::numeric NOT BETWEEN 0 AND 100 OR (pt->>'y')::numeric NOT BETWEEN 0 AND 100)
      THEN RAISE EXCEPTION 'Each board needs three or four valid corners'; END IF;
      UPDATE public.board_markings SET points=m.x->'points',version=version+1
        WHERE id=(m.x->>'id')::uuid AND survey_photo_id=c.survey_photo_id AND organization_id=c.organization_id;
      IF NOT FOUND THEN RAISE EXCEPTION 'Unexpected marking target'; END IF;
    END LOOP;
    SELECT storage_path INTO v_before FROM public.survey_photos WHERE id=c.survey_photo_id;
    UPDATE public.survey_photos SET storage_path=v_path, photo_url=v_url
      WHERE id=c.survey_photo_id AND shop_id=c.shop_id AND organization_id=c.organization_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Survey photo not found'; END IF;
    INSERT INTO public.audit_logs(organization_id,user_id,table_name,record_id,action,field_name,old_value,new_value,description)
      VALUES(c.organization_id,auth.uid(),'survey_photos',c.survey_photo_id,'update','redo_evidence',v_before,v_path,
      'Marked survey photo and all existing polygons updated in place; previous file retained');

  ELSIF c.stage='installation' AND c.issue_type IN ('installation_photo','work_item') THEN
    v_path := NULLIF(p_payload->>'storage_path',''); v_url := NULLIF(p_payload->>'photo_url','');
    IF v_path IS NULL OR v_url IS NULL OR
      v_path NOT LIKE c.organization_id::text || '/' || c.shop_id::text || '/redo-' || c.id::text || '-%' THEN RAISE EXCEPTION 'Invalid proof photo'; END IF;
    v_proof := c.installation_proof_id;
    IF v_proof IS NULL THEN
      SELECT id INTO v_proof FROM public.installation_proofs WHERE installation_job_id=c.installation_job_id
        AND work_item_id=c.work_item_id ORDER BY captured_at DESC LIMIT 1;
    END IF;
    IF v_proof IS NOT NULL THEN
      SELECT storage_path INTO v_before FROM public.installation_proofs WHERE id=v_proof;
      UPDATE public.installation_proofs SET storage_path=v_path,photo_url=v_url,
        angle=COALESCE(NULLIF(p_payload->>'angle',''),angle),caption=NULLIF(p_payload->>'caption','')
        WHERE id=v_proof AND installation_job_id=c.installation_job_id AND shop_id=c.shop_id AND organization_id=c.organization_id;
      IF NOT FOUND THEN RAISE EXCEPTION 'Installation photo not found'; END IF;
      INSERT INTO public.audit_logs(organization_id,user_id,table_name,record_id,action,field_name,old_value,new_value,description)
        VALUES(c.organization_id,auth.uid(),'installation_proofs',v_proof,'update','redo_evidence',v_before,v_path,
        'Installation proof updated in place; previous file retained');
    ELSE
      IF c.work_item_id IS NULL THEN RAISE EXCEPTION 'Missing corrected work item'; END IF;
      INSERT INTO public.installation_proofs(organization_id,installation_job_id,shop_id,work_item_id,storage_path,photo_url,photo_type,angle)
      VALUES(c.organization_id,c.installation_job_id,c.shop_id,c.work_item_id,v_path,v_url,'installed',COALESCE(NULLIF(p_payload->>'angle',''),'other'));
    END IF;
  ELSE
    RAISE EXCEPTION 'Unsupported correction type';
  END IF;

  UPDATE public.field_corrections SET replacement_saved_at=now() WHERE id=c.id;
END $$;
REVOKE ALL ON FUNCTION public.field_redo_save(uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.field_redo_save(uuid,jsonb) TO authenticated;

-- Atomic resubmit: only corrected entities return to review; current evidence rows
-- retain their IDs so the Owner's work-item links & marked-photo links never duplicate.
CREATE OR REPLACE FUNCTION public.review_submit_corrections(p_stage text, p_shop_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_org uuid; v_name text; c record; v_n int := 0; v_job uuid; v_sv uuid;
BEGIN
  SELECT organization_id,name INTO v_org,v_name FROM public.shops WHERE id=p_shop_id FOR UPDATE;
  IF v_org IS NULL OR v_org <> public.current_org_id() THEN RAISE EXCEPTION 'Shop not accessible'; END IF;
  IF p_stage NOT IN ('survey','installation') THEN RAISE EXCEPTION 'Invalid stage'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.field_corrections WHERE shop_id=p_shop_id AND stage=p_stage AND status='open' AND assigned_to=auth.uid()) THEN
    RAISE EXCEPTION 'No corrections assigned to this user'; END IF;
  IF EXISTS(SELECT 1 FROM public.field_corrections WHERE shop_id=p_shop_id AND stage=p_stage AND status='open'
     AND (assigned_to<>auth.uid() OR replacement_saved_at IS NULL)) THEN
    RAISE EXCEPTION 'Save every returned item and its replacement evidence before submitting'; END IF;
  PERFORM set_config('app.review_rpc','on',true);
  FOR c IN SELECT * FROM public.field_corrections WHERE shop_id=p_shop_id AND stage=p_stage AND status='open' FOR UPDATE LOOP
    v_n := v_n+1; v_job := COALESCE(v_job,c.installation_job_id); v_sv:=COALESCE(v_sv,c.survey_id);
    DELETE FROM public.field_review_decisions WHERE stage=p_stage AND entity_id IN (
      COALESCE(c.work_item_id,'00000000-0000-0000-0000-000000000000'),
      COALESCE(c.survey_photo_id,'00000000-0000-0000-0000-000000000000'),
      COALESCE(c.installation_proof_id,'00000000-0000-0000-0000-000000000000'));
    UPDATE public.field_corrections SET status='resubmitted',resubmitted_at=now() WHERE id=c.id;
  END LOOP;
  IF (p_stage='survey' AND v_sv IS NULL) OR (p_stage='installation' AND v_job IS NULL) THEN
    RAISE EXCEPTION 'Correction record is missing the original review reference'; END IF;
  IF p_stage='survey' THEN
    UPDATE public.surveys SET status='submitted',submitted_at=now(),reviewed_at=NULL,reviewed_by=NULL WHERE id=v_sv;
    UPDATE public.shops SET status='surveyed' WHERE id=p_shop_id;
    UPDATE public.shop_assignments SET status='completed',completed_at=now() WHERE shop_id=p_shop_id AND role='surveyor' AND user_id=auth.uid();
    PERFORM public._notify_reviewers(v_org,'Survey corrections submitted','Corrected items of '||v_name||' are ready for review','/survey-review');
  ELSE
    UPDATE public.installation_jobs SET status='completed',review_status='pending',reviewed_at=NULL,reviewed_by=NULL,completed_at=now() WHERE id=v_job;
    UPDATE public.shops SET status='installation_review' WHERE id=p_shop_id;
    UPDATE public.shop_assignments SET status='completed',completed_at=now() WHERE shop_id=p_shop_id AND role='installer' AND user_id=auth.uid();
    PERFORM public._notify_reviewers(v_org,'Installation corrections submitted','Corrected items of '||v_name||' are ready for review','/installation-review');
  END IF;
  RETURN jsonb_build_object('resubmitted',v_n,'storage_paths','[]'::jsonb);
END $$;
REVOKE ALL ON FUNCTION public.review_submit_corrections(text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.review_submit_corrections(text,uuid) TO authenticated;
