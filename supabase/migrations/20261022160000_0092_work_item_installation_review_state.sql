-- Work-item authoritative installation submission/review state.
-- Every work item can independently be pending, approved, sent for redo, or rejected.
-- Site-unavailable items still require photo evidence + reason, but remain excluded from calculations.

ALTER TABLE public.work_items
  ADD COLUMN IF NOT EXISTS installation_review_status text NOT NULL DEFAULT 'not_submitted',
  ADD COLUMN IF NOT EXISTS installation_review_note text,
  ADD COLUMN IF NOT EXISTS installation_submitted_at timestamptz,
  ADD COLUMN IF NOT EXISTS installation_reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS installation_reviewed_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL;

DO $$ BEGIN
  ALTER TABLE public.work_items ADD CONSTRAINT work_items_installation_review_status_check
    CHECK (installation_review_status IN ('not_submitted','pending','approved','redo','rejected'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE public.installation_proofs
  ADD COLUMN IF NOT EXISTS evidence_kind text NOT NULL DEFAULT 'installed';

DO $$ BEGIN
  ALTER TABLE public.installation_proofs ADD CONSTRAINT installation_proofs_evidence_kind_check
    CHECK (evidence_kind IN ('installed','not_installed'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_work_items_install_review ON public.work_items(shop_id, installation_review_status);
CREATE INDEX IF NOT EXISTS idx_installation_proofs_work_item_kind ON public.installation_proofs(work_item_id, evidence_kind);

-- Historical submitted jobs should not suddenly look unsubmitted.
UPDATE public.work_items wi
SET installation_review_status = CASE
      WHEN ij.review_status='approved' THEN 'approved'
      WHEN ij.review_status='rejected' THEN 'redo'
      WHEN ij.review_status='pending' THEN 'pending'
      ELSE wi.installation_review_status
    END,
    installation_submitted_at = COALESCE(wi.installation_submitted_at, ij.completed_at)
FROM public.installation_jobs ij
WHERE ij.shop_id=wi.shop_id
  AND wi.installation_review_status='not_submitted'
  AND ij.status IN ('completed','exception');

-- Installer submits exact work items for review. This is atomic and validates that
-- every submitted work item has at least one mapped proof. Site-unavailable work
-- additionally requires a reason and is explicitly excluded from calculations.
CREATE OR REPLACE FUNCTION public.submit_installation_work_items(
  p_installation_job_id uuid,
  p_work_item_ids uuid[]
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  v_org uuid;
  v_shop uuid;
  v_installer uuid;
  v_item uuid;
BEGIN
  SELECT organization_id,shop_id,installer_id INTO v_org,v_shop,v_installer
  FROM public.installation_jobs WHERE id=p_installation_job_id;
  IF v_org IS NULL OR v_org<>public.current_org_id() THEN RAISE EXCEPTION 'Installation job not accessible'; END IF;
  IF public.current_role()<>'installer' AND public.current_role() NOT IN ('agency_owner','admin','demo') THEN
    RAISE EXCEPTION 'Only the assigned Installer or Owner/Admin can submit installation work';
  END IF;
  IF public.current_role()='installer' AND v_installer IS DISTINCT FROM auth.uid() AND NOT EXISTS(
    SELECT 1 FROM public.shop_assignments sa WHERE sa.shop_id=v_shop AND sa.user_id=auth.uid() AND sa.role='installer'
  ) THEN RAISE EXCEPTION 'This installation is not assigned to you'; END IF;
  IF COALESCE(array_length(p_work_item_ids,1),0)=0 THEN RAISE EXCEPTION 'No work items selected for submission'; END IF;

  FOREACH v_item IN ARRAY p_work_item_ids LOOP
    IF NOT EXISTS(SELECT 1 FROM public.work_items wi WHERE wi.id=v_item AND wi.shop_id=v_shop AND wi.organization_id=v_org) THEN
      RAISE EXCEPTION 'Work item % does not belong to this installation', v_item;
    END IF;
    IF NOT EXISTS(SELECT 1 FROM public.installation_proofs ip WHERE ip.installation_job_id=p_installation_job_id AND ip.work_item_id=v_item) THEN
      RAISE EXCEPTION 'Every work item needs at least one photo before submission';
    END IF;
    IF EXISTS(SELECT 1 FROM public.field_corrections fc WHERE fc.installation_job_id=p_installation_job_id AND fc.work_item_id=v_item AND fc.stage='installation' AND fc.status='open')
       AND NOT EXISTS(
         SELECT 1 FROM public.installation_proofs ip
         WHERE ip.installation_job_id=p_installation_job_id AND ip.work_item_id=v_item
           AND ip.captured_at > COALESCE((SELECT max(fc.created_at) FROM public.field_corrections fc WHERE fc.installation_job_id=p_installation_job_id AND fc.work_item_id=v_item AND fc.stage='installation' AND fc.status='open'),'epoch'::timestamptz)
       ) THEN
      RAISE EXCEPTION 'Redo work requires a new replacement photo before resubmission';
    END IF;
    IF EXISTS(
      SELECT 1 FROM public.work_items wi WHERE wi.id=v_item
      AND (wi.excluded_from_calculations OR COALESCE(wi.execution_state,'active')<>'active')
      AND NULLIF(trim(COALESCE(wi.execution_reason,'')),'') IS NULL
    ) THEN RAISE EXCEPTION 'Not-installed work requires a reason before submission'; END IF;
  END LOOP;

  UPDATE public.work_items wi SET
    installation_review_status='pending',
    installation_review_note=NULL,
    installation_submitted_at=now(),
    installation_reviewed_at=NULL,
    installation_reviewed_by=NULL,
    status=wi.status
  WHERE wi.id=ANY(p_work_item_ids) AND wi.shop_id=v_shop;

  -- Submitted unavailable evidence is visibly distinguishable in review/details.
  UPDATE public.installation_proofs ip SET evidence_kind = CASE
    WHEN EXISTS(SELECT 1 FROM public.work_items wi WHERE wi.id=ip.work_item_id AND (wi.excluded_from_calculations OR COALESCE(wi.execution_state,'active')<>'active'))
    THEN 'not_installed' ELSE 'installed' END
  WHERE ip.installation_job_id=p_installation_job_id AND ip.work_item_id=ANY(p_work_item_ids);

  UPDATE public.installation_jobs SET
    status='completed', review_status='pending', completed_at=now(),
    reviewed_at=NULL, reviewed_by=NULL, review_note=NULL
  WHERE id=p_installation_job_id;
  UPDATE public.shops SET status='installation_review' WHERE id=v_shop;
  UPDATE public.shop_assignments SET status='completed',completed_at=now()
    WHERE shop_id=v_shop AND user_id=COALESCE(v_installer,auth.uid()) AND role='installer';

  -- Resubmitting a redo closes only those correction tasks and preserves history.
  UPDATE public.field_corrections SET status='resubmitted',resubmitted_at=now()
  WHERE installation_job_id=p_installation_job_id AND stage='installation' AND status='open'
    AND work_item_id=ANY(p_work_item_ids);
END $$;
GRANT EXECUTE ON FUNCTION public.submit_installation_work_items(uuid,uuid[]) TO authenticated;

-- Single atomic Owner/Admin action for any selection of work items in one job.
CREATE OR REPLACE FUNCTION public.review_installation_work_items(
  p_installation_job_id uuid,
  p_work_item_ids uuid[],
  p_decision text,
  p_note text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  v_org uuid;
  v_shop uuid;
  v_installer uuid;
  v_item uuid;
  v_pending int;
  v_redo int;
  v_now timestamptz := now();
BEGIN
  IF p_decision NOT IN ('approved','redo','rejected') THEN RAISE EXCEPTION 'Decision must be approved, redo, or rejected'; END IF;
  IF public.current_role() NOT IN ('agency_owner','admin','demo') THEN RAISE EXCEPTION 'Only Owner/Admin can review installation work'; END IF;
  SELECT organization_id,shop_id,installer_id INTO v_org,v_shop,v_installer FROM public.installation_jobs WHERE id=p_installation_job_id;
  IF v_org IS NULL OR v_org<>public.current_org_id() THEN RAISE EXCEPTION 'Installation job not accessible'; END IF;
  IF COALESCE(array_length(p_work_item_ids,1),0)=0 THEN RAISE EXCEPTION 'Select at least one work item'; END IF;

  FOREACH v_item IN ARRAY p_work_item_ids LOOP
    IF NOT EXISTS(SELECT 1 FROM public.work_items wi WHERE wi.id=v_item AND wi.shop_id=v_shop AND wi.installation_review_status='pending') THEN
      RAISE EXCEPTION 'One or more selected work items are no longer pending review';
    END IF;

    IF p_decision='approved' THEN
      UPDATE public.work_items wi SET
        installation_review_status='approved', installation_review_note=NULLIF(trim(COALESCE(p_note,'')),''),
        installation_reviewed_at=v_now, installation_reviewed_by=auth.uid(),
        installed_width=CASE WHEN wi.excluded_from_calculations OR COALESCE(wi.execution_state,'active')<>'active' THEN NULL ELSE wi.approved_width END,
        installed_height=CASE WHEN wi.excluded_from_calculations OR COALESCE(wi.execution_state,'active')<>'active' THEN NULL ELSE wi.approved_height END,
        installed_unit=CASE WHEN wi.excluded_from_calculations OR COALESCE(wi.execution_state,'active')<>'active' THEN NULL ELSE wi.approved_unit END,
        installed_quantity=CASE WHEN wi.excluded_from_calculations OR COALESCE(wi.execution_state,'active')<>'active' THEN NULL ELSE COALESCE(wi.approved_quantity,1) END,
        installed_area=CASE WHEN wi.excluded_from_calculations OR COALESCE(wi.execution_state,'active')<>'active' THEN NULL ELSE wi.approved_area END,
        installed_at=CASE WHEN wi.excluded_from_calculations OR COALESCE(wi.execution_state,'active')<>'active' THEN NULL ELSE v_now END,
        status=CASE WHEN wi.excluded_from_calculations OR COALESCE(wi.execution_state,'active')<>'active' THEN wi.status ELSE 'installed' END
      WHERE wi.id=v_item;
      UPDATE public.field_corrections SET status='resolved',resolved_at=v_now
        WHERE installation_job_id=p_installation_job_id AND work_item_id=v_item AND stage='installation' AND status IN ('open','resubmitted');
    ELSIF p_decision='redo' THEN
      UPDATE public.work_items SET installation_review_status='redo',installation_review_note=NULLIF(trim(COALESCE(p_note,'')),''),installation_reviewed_at=v_now,installation_reviewed_by=auth.uid()
      WHERE id=v_item;
      IF v_installer IS NULL THEN
        SELECT user_id INTO v_installer FROM public.shop_assignments WHERE shop_id=v_shop AND role='installer' ORDER BY assigned_at DESC NULLS LAST LIMIT 1;
      END IF;
      IF v_installer IS NULL THEN RAISE EXCEPTION 'No installer assigned to this shop'; END IF;
      UPDATE public.field_corrections SET status='cancelled' WHERE installation_job_id=p_installation_job_id AND work_item_id=v_item AND stage='installation' AND status='open';
      INSERT INTO public.field_corrections(organization_id,shop_id,stage,installation_job_id,work_item_id,assigned_to,requested_by,issue_type,note,status)
      VALUES(v_org,v_shop,'installation',p_installation_job_id,v_item,v_installer,auth.uid(),'work_item',NULLIF(trim(COALESCE(p_note,'')),''),'open');
    ELSE
      UPDATE public.work_items SET
        installation_review_status='rejected', installation_review_note=NULLIF(trim(COALESCE(p_note,'')),''),
        installation_reviewed_at=v_now, installation_reviewed_by=auth.uid(),
        execution_state='removed_from_scope', excluded_from_calculations=true,
        execution_reason=COALESCE(NULLIF(trim(COALESCE(p_note,'')),''),'Rejected during installation review'),
        execution_marked_at=v_now, execution_marked_by=auth.uid(),
        installed_width=NULL,installed_height=NULL,installed_unit=NULL,installed_quantity=NULL,installed_area=NULL,installed_at=NULL
      WHERE id=v_item;
      UPDATE public.field_corrections SET status='cancelled' WHERE installation_job_id=p_installation_job_id AND work_item_id=v_item AND stage='installation' AND status IN ('open','resubmitted');
    END IF;

    INSERT INTO public.field_review_decisions(organization_id,shop_id,stage,installation_job_id,entity_type,entity_id,decision,note,reviewed_by,reviewed_at)
    VALUES(v_org,v_shop,'installation',p_installation_job_id,'work_item',v_item,CASE WHEN p_decision='rejected' THEN 'rejected' ELSE p_decision END,NULLIF(trim(COALESCE(p_note,'')),''),auth.uid(),v_now)
    ON CONFLICT(stage,entity_type,entity_id) DO UPDATE SET decision=EXCLUDED.decision,note=EXCLUDED.note,reviewed_by=auth.uid(),reviewed_at=v_now,installation_job_id=EXCLUDED.installation_job_id;
  END LOOP;

  SELECT count(*) FILTER (WHERE installation_review_status='pending'), count(*) FILTER (WHERE installation_review_status='redo')
    INTO v_pending,v_redo FROM public.work_items WHERE shop_id=v_shop AND approved_width IS NOT NULL AND approved_height IS NOT NULL;

  IF v_pending>0 THEN
    UPDATE public.installation_jobs SET review_status='pending',reviewed_at=NULL,reviewed_by=NULL WHERE id=p_installation_job_id;
    UPDATE public.shops SET status='installation_review' WHERE id=v_shop;
  ELSIF v_redo>0 THEN
    UPDATE public.installation_jobs SET review_status='rejected',reviewed_at=v_now,reviewed_by=auth.uid(),review_note='One or more work items require redo' WHERE id=p_installation_job_id;
    UPDATE public.shops SET status='installation_pending' WHERE id=v_shop;
    IF v_installer IS NOT NULL THEN
      UPDATE public.shop_assignments SET status='assigned',completed_at=NULL WHERE shop_id=v_shop AND user_id=v_installer AND role='installer';
    END IF;
  ELSE
    UPDATE public.installation_jobs SET review_status='approved',reviewed_at=v_now,reviewed_by=auth.uid(),review_note=NULL WHERE id=p_installation_job_id;
    UPDATE public.shops SET status='installed' WHERE id=v_shop;
  END IF;
END $$;
GRANT EXECUTE ON FUNCTION public.review_installation_work_items(uuid,uuid[],text,text) TO authenticated;

-- Allow a true final Reject decision to be represented in the shared audit table.
ALTER TABLE public.field_review_decisions DROP CONSTRAINT IF EXISTS field_review_decisions_decision_check;
ALTER TABLE public.field_review_decisions ADD CONSTRAINT field_review_decisions_decision_check CHECK (decision IN ('approved','redo','rejected'));
