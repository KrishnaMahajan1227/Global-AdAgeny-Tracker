-- Authoritative review/redo flow repair.
-- Item-level decisions create/resolve exact correction tasks but DO NOT prematurely
-- change the parent survey/job final review status. Final review buttons own that.
-- Also recovers legacy rows where surveyor_id/installer_id is null by using the
-- latest matching shop assignment.

CREATE OR REPLACE FUNCTION public.set_field_review_decision(
  p_stage text,
  p_shop_id uuid,
  p_survey_id uuid,
  p_installation_job_id uuid,
  p_entity_type text,
  p_entity_id uuid,
  p_decision text,
  p_note text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  v_org uuid;
  v_assigned uuid;
  v_work_item uuid;
BEGIN
  IF p_stage NOT IN ('survey','installation') OR p_decision NOT IN ('approved','redo') THEN
    RAISE EXCEPTION 'Invalid review action';
  END IF;
  SELECT organization_id INTO v_org FROM public.shops WHERE id=p_shop_id;
  IF v_org IS NULL OR v_org <> public.current_org_id() THEN RAISE EXCEPTION 'Shop not accessible'; END IF;
  IF public.current_role() NOT IN ('agency_owner','admin','demo') THEN RAISE EXCEPTION 'Only Owner/Admin can review field evidence'; END IF;

  IF p_stage='survey' THEN
    SELECT surveyor_id INTO v_assigned FROM public.surveys
      WHERE id=p_survey_id AND shop_id=p_shop_id AND organization_id=v_org;
    IF v_assigned IS NULL THEN
      SELECT user_id INTO v_assigned FROM public.shop_assignments
      WHERE shop_id=p_shop_id AND organization_id=v_org AND role='surveyor'
      ORDER BY assigned_at DESC NULLS LAST LIMIT 1;
    END IF;
  ELSE
    SELECT installer_id INTO v_assigned FROM public.installation_jobs
      WHERE id=p_installation_job_id AND shop_id=p_shop_id AND organization_id=v_org;
    IF v_assigned IS NULL THEN
      SELECT user_id INTO v_assigned FROM public.shop_assignments
      WHERE shop_id=p_shop_id AND organization_id=v_org AND role='installer'
      ORDER BY assigned_at DESC NULLS LAST LIMIT 1;
    END IF;
  END IF;

  INSERT INTO public.field_review_decisions(
    organization_id,shop_id,stage,survey_id,installation_job_id,
    entity_type,entity_id,decision,note,reviewed_by,reviewed_at
  ) VALUES(
    v_org,p_shop_id,p_stage,p_survey_id,p_installation_job_id,
    p_entity_type,p_entity_id,p_decision,NULLIF(trim(p_note),''),auth.uid(),now()
  )
  ON CONFLICT(stage,entity_type,entity_id) DO UPDATE SET
    organization_id=EXCLUDED.organization_id, shop_id=EXCLUDED.shop_id,
    survey_id=EXCLUDED.survey_id, installation_job_id=EXCLUDED.installation_job_id,
    decision=EXCLUDED.decision, note=EXCLUDED.note, reviewed_by=auth.uid(), reviewed_at=now();

  IF p_entity_type IN ('measurement','work_item') THEN
    v_work_item:=p_entity_id;
  ELSIF p_entity_type='installation_photo' THEN
    SELECT work_item_id INTO v_work_item FROM public.installation_proofs WHERE id=p_entity_id;
  ELSIF p_entity_type='survey_photo' THEN
    SELECT spi.work_item_id INTO v_work_item
    FROM public.survey_photo_items spi WHERE spi.survey_photo_id=p_entity_id LIMIT 1;
  END IF;

  IF p_decision='redo' THEN
    IF v_assigned IS NULL THEN
      RAISE EXCEPTION 'No assigned % found for this shop', CASE WHEN p_stage='survey' THEN 'surveyor' ELSE 'installer' END;
    END IF;

    UPDATE public.field_corrections SET status='cancelled'
    WHERE organization_id=v_org AND stage=p_stage AND status='open'
      AND ((p_entity_type IN ('measurement','work_item') AND work_item_id=p_entity_id)
        OR (p_entity_type='survey_photo' AND survey_photo_id=p_entity_id)
        OR (p_entity_type='installation_photo' AND installation_proof_id=p_entity_id));

    INSERT INTO public.field_corrections(
      organization_id,shop_id,stage,survey_id,installation_job_id,work_item_id,
      survey_photo_id,installation_proof_id,assigned_to,requested_by,issue_type,note,status
    ) VALUES(
      v_org,p_shop_id,p_stage,p_survey_id,p_installation_job_id,v_work_item,
      CASE WHEN p_entity_type='survey_photo' THEN p_entity_id END,
      CASE WHEN p_entity_type='installation_photo' THEN p_entity_id END,
      v_assigned,auth.uid(),p_entity_type,NULLIF(trim(p_note),''),'open'
    );

    -- Keep parent review in its current queue. Only reset the field assignment so
    -- the exact correction immediately appears on Surveyor/Installer My Work.
    UPDATE public.shop_assignments SET status='assigned',completed_at=NULL
    WHERE shop_id=p_shop_id AND user_id=v_assigned
      AND role=CASE WHEN p_stage='survey' THEN 'surveyor' ELSE 'installer' END;
  ELSE
    UPDATE public.field_corrections SET status='resolved',resolved_at=now()
    WHERE organization_id=v_org AND stage=p_stage AND status IN ('open','resubmitted')
      AND ((p_entity_type IN ('measurement','work_item') AND work_item_id=p_entity_id)
        OR (p_entity_type='survey_photo' AND survey_photo_id=p_entity_id)
        OR (p_entity_type='installation_photo' AND installation_proof_id=p_entity_id));
  END IF;
END $$;
GRANT EXECUTE ON FUNCTION public.set_field_review_decision(text,uuid,uuid,uuid,text,uuid,text,text) TO authenticated;

-- Ensure Not Available is usable by the assigned installer as well as Owner/Admin,
-- and never contributes installed/billing values.
CREATE OR REPLACE FUNCTION public.set_work_item_execution_availability(
  p_work_item_id uuid, p_unavailable boolean, p_reason text DEFAULT NULL, p_note text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_org uuid; v_shop uuid; v_role text; BEGIN
  SELECT organization_id,shop_id INTO v_org,v_shop FROM public.work_items WHERE id=p_work_item_id;
  IF v_org IS NULL OR v_org <> public.current_org_id() THEN RAISE EXCEPTION 'Work item not accessible'; END IF;
  v_role:=public.current_role();
  IF v_role NOT IN ('agency_owner','admin','demo','installer') THEN RAISE EXCEPTION 'Only Owner/Admin or assigned Installer can change site availability'; END IF;
  IF v_role='installer' AND NOT EXISTS(
    SELECT 1 FROM public.shop_assignments sa WHERE sa.shop_id=v_shop AND sa.user_id=auth.uid() AND sa.role='installer'
  ) THEN RAISE EXCEPTION 'This work item is not assigned to you'; END IF;
  IF p_unavailable AND NULLIF(trim(p_reason),'') IS NULL THEN RAISE EXCEPTION 'Reason is required when marking Not available'; END IF;

  UPDATE public.work_items SET
    execution_state=CASE WHEN p_unavailable THEN 'site_unavailable' ELSE 'active' END,
    execution_reason=CASE WHEN p_unavailable THEN trim(p_reason) ELSE NULL END,
    execution_note=CASE WHEN p_unavailable THEN NULLIF(trim(p_note),'') ELSE NULL END,
    excluded_from_calculations=p_unavailable,
    execution_marked_at=now(), execution_marked_by=auth.uid(),
    installed_width=CASE WHEN p_unavailable THEN NULL ELSE installed_width END,
    installed_height=CASE WHEN p_unavailable THEN NULL ELSE installed_height END,
    installed_unit=CASE WHEN p_unavailable THEN NULL ELSE installed_unit END,
    installed_quantity=CASE WHEN p_unavailable THEN NULL ELSE installed_quantity END,
    installed_area=CASE WHEN p_unavailable THEN NULL ELSE installed_area END,
    installed_at=CASE WHEN p_unavailable THEN NULL ELSE installed_at END
  WHERE id=p_work_item_id;
END $$;
GRANT EXECUTE ON FUNCTION public.set_work_item_execution_availability(uuid,boolean,text,text) TO authenticated;

-- Repair stale review parents left by older item-level redo behavior.
UPDATE public.surveys s SET status='submitted', reviewed_at=NULL, reviewed_by=NULL
WHERE s.status='correction_requested'
  AND EXISTS (SELECT 1 FROM public.field_corrections fc WHERE fc.survey_id=s.id AND fc.status='open')
  AND NOT EXISTS (SELECT 1 FROM public.field_review_decisions d WHERE d.survey_id=s.id AND d.stage='survey' AND d.decision='approved');

UPDATE public.installation_jobs j SET review_status='pending', reviewed_at=NULL, reviewed_by=NULL
WHERE EXISTS (SELECT 1 FROM public.field_corrections fc WHERE fc.installation_job_id=j.id AND fc.status='open')
  AND j.review_status <> 'pending';
