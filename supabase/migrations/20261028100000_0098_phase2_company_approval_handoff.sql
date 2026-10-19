-- Phase 2: audited, owner/admin controlled external company approval handoff.
-- Existing POs keep company_approval_required=false. New POs default true.
-- Do not rewrite old approvals, billing or review RPCs.

ALTER TABLE public.purchase_orders ADD COLUMN IF NOT EXISTS company_approval_required boolean NOT NULL DEFAULT false;
ALTER TABLE public.purchase_orders ALTER COLUMN company_approval_required SET DEFAULT true;
-- Enforce new orders even when a client attempts to explicitly submit false.
-- Historical orders are untouched and remain opt-out.
CREATE OR REPLACE FUNCTION public.phase2_protect_po_approval_policy()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
  IF TG_OP='INSERT' THEN NEW.company_approval_required:=true;
  ELSIF OLD.company_approval_required AND NOT NEW.company_approval_required THEN
    RAISE EXCEPTION 'Company approval policy cannot be disabled after Work Order creation';
  END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS trg_phase2_protect_po_policy ON public.purchase_orders;
CREATE TRIGGER trg_phase2_protect_po_policy BEFORE INSERT OR UPDATE OF company_approval_required
ON public.purchase_orders FOR EACH ROW EXECUTE FUNCTION public.phase2_protect_po_approval_policy();

CREATE TABLE IF NOT EXISTS public.company_approval_handoffs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  purchase_order_id uuid NOT NULL REFERENCES public.purchase_orders(id) ON DELETE CASCADE,
  shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
  stage text NOT NULL CHECK (stage IN ('survey','design','installation')),
  ref_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'internal_checked' CHECK (status IN ('internal_checked','company_approved')),
  evidence_key text NOT NULL,
  internal_checked_by uuid NOT NULL REFERENCES public.profiles(id),
  internal_checked_at timestamptz NOT NULL DEFAULT now(),
  company_confirmed_by uuid REFERENCES public.profiles(id),
  company_confirmed_at timestamptz,
  company_reference text,
  revision integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(stage,ref_id)
);
CREATE INDEX IF NOT EXISTS idx_company_approval_handoffs_org_po ON public.company_approval_handoffs(organization_id,purchase_order_id);
ALTER TABLE public.company_approval_handoffs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS phase2_handoff_owner_read ON public.company_approval_handoffs;
CREATE POLICY phase2_handoff_owner_read ON public.company_approval_handoffs FOR SELECT TO authenticated
  USING (organization_id=public.current_org_id() AND public.current_role() IN ('agency_owner','admin'));
-- Deliberately no direct INSERT/UPDATE/DELETE policies: only validated RPCs write.
REVOKE INSERT, UPDATE, DELETE ON public.company_approval_handoffs FROM authenticated, anon;

CREATE OR REPLACE FUNCTION public.phase2_handoff_context(p_stage text, p_ref uuid)
RETURNS TABLE(org_id uuid, shop_id uuid, po_id uuid) LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF p_stage='survey' THEN
    RETURN QUERY SELECT s.organization_id,s.id,s.purchase_order_id FROM public.surveys r JOIN public.shops s ON s.id=r.shop_id WHERE r.id=p_ref;
  ELSIF p_stage='design' THEN
    RETURN QUERY SELECT s.organization_id,s.id,s.purchase_order_id FROM public.design_tasks r JOIN public.shops s ON s.id=r.shop_id WHERE r.id=p_ref;
  ELSIF p_stage='installation' THEN
    RETURN QUERY SELECT s.organization_id,s.id,s.purchase_order_id FROM public.installation_jobs r JOIN public.shops s ON s.id=r.shop_id WHERE r.id=p_ref;
  ELSE
    RAISE EXCEPTION 'Invalid approval stage';
  END IF;
END; $$;
REVOKE ALL ON FUNCTION public.phase2_handoff_context(text,uuid) FROM PUBLIC, anon, authenticated;

-- Fingerprint actual evidence / measurements rather than mutable workflow status.
-- Changed files, positions or measurements require a fresh review and client confirmation.
CREATE OR REPLACE FUNCTION public.phase2_evidence_key(p_stage text, p_ref uuid, p_shop uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_data text; v_count integer;
BEGIN
  IF p_stage='survey' THEN
    SELECT count(*) INTO v_count FROM public.survey_photos WHERE survey_id=p_ref;
    IF v_count=0 THEN RETURN 'missing-evidence'; END IF;
    SELECT concat(
      COALESCE((SELECT jsonb_agg(jsonb_build_array(id,storage_path,caption,photo_type) ORDER BY id)::text FROM public.survey_photos WHERE survey_id=p_ref),'[]'),
      COALESCE((SELECT jsonb_agg(jsonb_build_array(id,survey_width,survey_height,survey_unit,survey_quantity,survey_area,survey_notes) ORDER BY id)::text FROM public.work_items WHERE survey_id=p_ref),'[]'),
      COALESCE((SELECT jsonb_agg(jsonb_build_array(id,points,version) ORDER BY id)::text FROM public.board_markings WHERE work_item_id IN (SELECT id FROM public.work_items WHERE survey_id=p_ref)),'[]')
    ) INTO v_data;
  ELSIF p_stage='design' THEN
    SELECT count(*) INTO v_count FROM public.design_versions WHERE design_task_id=p_ref;
    IF v_count=0 THEN RETURN 'missing-evidence'; END IF;
    SELECT concat(
      COALESCE((SELECT jsonb_agg(jsonb_build_array(id,version_number,storage_path,file_name,source) ORDER BY id)::text FROM public.design_versions WHERE design_task_id=p_ref),'[]'),
      COALESCE((SELECT jsonb_agg(jsonb_build_array(id,design_version_id,work_item_id) ORDER BY id)::text FROM public.design_version_items WHERE design_version_id IN (SELECT id FROM public.design_versions WHERE design_task_id=p_ref)),'[]')
    ) INTO v_data;
  ELSIF p_stage='installation' THEN
    SELECT count(*) INTO v_count FROM public.installation_proofs WHERE installation_job_id=p_ref;
    IF v_count=0 THEN RETURN 'missing-evidence'; END IF;
    SELECT concat(
      COALESCE((SELECT jsonb_agg(jsonb_build_array(id,storage_path,photo_type,caption,captured_at) ORDER BY id)::text FROM public.installation_proofs WHERE installation_job_id=p_ref),'[]'),
      COALESCE((SELECT jsonb_agg(jsonb_build_array(id,installed_width,installed_height,installed_unit,installed_quantity,installed_area,installed_notes,excluded_from_calculations) ORDER BY id)::text FROM public.work_items WHERE shop_id=p_shop),'[]')
    ) INTO v_data;
  ELSE RAISE EXCEPTION 'Invalid approval stage'; END IF;
  RETURN md5(coalesce(v_data,''));
END; $$;
REVOKE ALL ON FUNCTION public.phase2_evidence_key(text,uuid,uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.phase2_handoff_is_valid(p_stage text, p_ref uuid, p_shop uuid)
RETURNS boolean LANGUAGE sql SECURITY DEFINER STABLE SET search_path=public AS $$
 SELECT EXISTS (
   SELECT 1 FROM public.company_approval_handoffs h
   WHERE h.stage=p_stage AND h.ref_id=p_ref AND h.shop_id=p_shop AND h.status='company_approved'
     AND h.purchase_order_id=(SELECT purchase_order_id FROM public.shops WHERE id=p_shop)
     AND h.evidence_key=public.phase2_evidence_key(p_stage,p_ref,p_shop)
 );
$$;
REVOKE ALL ON FUNCTION public.phase2_handoff_is_valid(text,uuid,uuid) FROM PUBLIC, anon, authenticated;

-- Single read model used by all three review panels. Ref IDs are validated against org.
CREATE OR REPLACE FUNCTION public.phase2_handoff_status(p_stage text, p_ref uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_org uuid; v_shop uuid; v_po uuid; v_required boolean; v_row public.company_approval_handoffs%ROWTYPE; v_key text;
BEGIN
  IF auth.uid() IS NULL OR public.current_role() NOT IN ('agency_owner','admin') THEN RAISE EXCEPTION 'Not authorized'; END IF;
  SELECT c.org_id,c.shop_id,c.po_id INTO v_org,v_shop,v_po FROM public.phase2_handoff_context(p_stage,p_ref) c;
  IF v_org IS NULL OR v_org<>public.current_org_id() THEN RAISE EXCEPTION 'Record not accessible'; END IF;
  SELECT COALESCE(company_approval_required,false) INTO v_required FROM public.purchase_orders WHERE id=v_po;
  IF NOT v_required THEN RETURN jsonb_build_object('required',false,'status','legacy_optional','valid',true); END IF;
  SELECT * INTO v_row FROM public.company_approval_handoffs WHERE stage=p_stage AND ref_id=p_ref;
  IF NOT FOUND THEN RETURN jsonb_build_object('required',true,'status','not_reviewed','valid',false); END IF;
  v_key := public.phase2_evidence_key(p_stage,p_ref,v_shop);
  RETURN jsonb_build_object('required',true,'status',CASE WHEN v_row.evidence_key=v_key THEN v_row.status ELSE 'evidence_changed' END,
    'valid',v_row.evidence_key=v_key AND v_row.status='company_approved',
    'revision',v_row.revision,'checked_at',v_row.internal_checked_at,
    'company_approved_at',v_row.company_confirmed_at,'reference',v_row.company_reference);
END; $$;
REVOKE ALL ON FUNCTION public.phase2_handoff_status(text,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phase2_handoff_status(text,uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.phase2_handoff_action(p_stage text, p_ref uuid, p_action text, p_reference text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_org uuid; v_shop uuid; v_po uuid; v_required boolean; v_key text;
  v_prev public.company_approval_handoffs%ROWTYPE; v_status text; v_state text;
BEGIN
  IF auth.uid() IS NULL OR public.current_role() NOT IN ('agency_owner','admin') THEN RAISE EXCEPTION 'Only Owner/Admin can confirm external approvals'; END IF;
  IF p_action NOT IN ('internal_checked','company_approved') THEN RAISE EXCEPTION 'Invalid approval action'; END IF;
  SELECT c.org_id,c.shop_id,c.po_id INTO v_org,v_shop,v_po FROM public.phase2_handoff_context(p_stage,p_ref) c;
  IF v_org IS NULL OR v_org<>public.current_org_id() OR v_po IS NULL THEN RAISE EXCEPTION 'Work Order not accessible'; END IF;
  SELECT COALESCE(company_approval_required,false) INTO v_required FROM public.purchase_orders WHERE id=v_po;
  IF NOT v_required THEN RAISE EXCEPTION 'Company approval handoff not required on this historical Work Order'; END IF;
  IF p_stage='survey' THEN SELECT status INTO v_state FROM public.surveys WHERE id=p_ref;
    IF v_state NOT IN ('submitted','approved') THEN RAISE EXCEPTION 'Survey must be submitted before review'; END IF;
  ELSIF p_stage='design' THEN SELECT status INTO v_state FROM public.design_tasks WHERE id=p_ref;
    IF v_state NOT IN ('in_review','approved') THEN RAISE EXCEPTION 'Design must be in review'; END IF;
  ELSE SELECT review_status INTO v_state FROM public.installation_jobs WHERE id=p_ref;
    IF v_state NOT IN ('pending','approved') THEN RAISE EXCEPTION 'Installation must be submitted for review'; END IF;
  END IF;
  v_key := public.phase2_evidence_key(p_stage,p_ref,v_shop);
  IF v_key='missing-evidence' THEN RAISE EXCEPTION 'Add required photo / artwork evidence before recording approval'; END IF;
  SELECT * INTO v_prev FROM public.company_approval_handoffs WHERE stage=p_stage AND ref_id=p_ref FOR UPDATE;
  IF p_action='internal_checked' THEN
    IF v_prev.id IS NOT NULL AND v_prev.evidence_key=v_key AND v_prev.status='company_approved' THEN
      RETURN public.phase2_handoff_status(p_stage,p_ref); -- Never overwrite a valid approval accidentally.
    END IF;
    INSERT INTO public.company_approval_handoffs(organization_id,purchase_order_id,shop_id,stage,ref_id,status,evidence_key,internal_checked_by,internal_checked_at,revision)
    VALUES(v_org,v_po,v_shop,p_stage,p_ref,'internal_checked',v_key,auth.uid(),now(),COALESCE(v_prev.revision,0)+1)
    ON CONFLICT(stage,ref_id) DO UPDATE SET organization_id=EXCLUDED.organization_id,
      shop_id=EXCLUDED.shop_id,purchase_order_id=EXCLUDED.purchase_order_id,status='internal_checked',evidence_key=EXCLUDED.evidence_key,
      internal_checked_by=auth.uid(),internal_checked_at=now(),company_confirmed_by=NULL,company_confirmed_at=NULL,
      company_reference=NULL,revision=EXCLUDED.revision,updated_at=now();
  ELSE
    IF v_prev.id IS NULL OR v_prev.status<>'internal_checked' OR v_prev.evidence_key<>v_key THEN
      RAISE EXCEPTION 'Review current evidence first; changed evidence requires a new internal check';
    END IF;
    UPDATE public.company_approval_handoffs SET status='company_approved',company_confirmed_by=auth.uid(),
      company_confirmed_at=now(),company_reference=NULLIF(left(trim(coalesce(p_reference,'')),240),''),updated_at=now()
    WHERE stage=p_stage AND ref_id=p_ref;
  END IF;
  INSERT INTO public.audit_logs(organization_id,user_id,table_name,record_id,action,field_name,description)
  VALUES(v_org,auth.uid(),'company_approval_handoffs',p_ref,'update',p_action,
    p_stage||' evidence revision '||(SELECT revision FROM public.company_approval_handoffs WHERE stage=p_stage AND ref_id=p_ref)::text||': '||p_action);
  RETURN public.phase2_handoff_status(p_stage,p_ref);
END; $$;
REVOKE ALL ON FUNCTION public.phase2_handoff_action(text,uuid,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phase2_handoff_action(text,uuid,text,text) TO authenticated;

-- Database gate, not just a disabled button. Historic POs remain unaffected.
CREATE OR REPLACE FUNCTION public.phase2_guard_survey_final() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_po uuid; v_required boolean;
BEGIN
  IF NEW.status='approved' AND OLD.status IS DISTINCT FROM 'approved' THEN
    SELECT s.purchase_order_id INTO v_po FROM public.shops s WHERE s.id=NEW.shop_id;
    SELECT company_approval_required INTO v_required FROM public.purchase_orders WHERE id=v_po;
    IF COALESCE(v_required,false) AND NOT public.phase2_handoff_is_valid('survey',NEW.id,NEW.shop_id) THEN
      RAISE EXCEPTION 'Company approval missing/stale for survey. Check evidence, record external approval, then finalize.';
    END IF;
  END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS trg_phase2_survey_approval ON public.surveys;
CREATE TRIGGER trg_phase2_survey_approval BEFORE UPDATE OF status ON public.surveys FOR EACH ROW EXECUTE FUNCTION public.phase2_guard_survey_final();

CREATE OR REPLACE FUNCTION public.phase2_guard_design_final() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_po uuid; v_required boolean;
BEGIN
  IF NEW.status IN ('approved','ready_for_production') AND OLD.status NOT IN ('approved','ready_for_production') THEN
    SELECT s.purchase_order_id INTO v_po FROM public.shops s WHERE s.id=NEW.shop_id;
    SELECT company_approval_required INTO v_required FROM public.purchase_orders WHERE id=v_po;
    IF COALESCE(v_required,false)
      AND EXISTS(SELECT 1 FROM public.po_line_items WHERE purchase_order_id=v_po AND requires_design=true)
      AND NOT public.phase2_handoff_is_valid('design',NEW.id,NEW.shop_id) THEN
      RAISE EXCEPTION 'Company approval missing/stale for design. Check evidence, record external approval, then finalize.';
    END IF;
  END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS trg_phase2_design_approval ON public.design_tasks;
CREATE TRIGGER trg_phase2_design_approval BEFORE UPDATE OF status ON public.design_tasks FOR EACH ROW EXECUTE FUNCTION public.phase2_guard_design_final();

CREATE OR REPLACE FUNCTION public.phase2_guard_installation_final() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_po uuid; v_required boolean;
BEGIN
  IF NEW.review_status='approved' AND OLD.review_status IS DISTINCT FROM 'approved' THEN
    SELECT s.purchase_order_id INTO v_po FROM public.shops s WHERE s.id=NEW.shop_id;
    SELECT company_approval_required INTO v_required FROM public.purchase_orders WHERE id=v_po;
    IF COALESCE(v_required,false) AND NOT public.phase2_handoff_is_valid('installation',NEW.id,NEW.shop_id) THEN
      RAISE EXCEPTION 'Company approval missing/stale for installation. Check evidence, record external approval, then finalize.';
    END IF;
  END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS trg_phase2_installation_approval ON public.installation_jobs;
CREATE TRIGGER trg_phase2_installation_approval BEFORE UPDATE OF review_status ON public.installation_jobs FOR EACH ROW EXECUTE FUNCTION public.phase2_guard_installation_final();

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.company_approval_handoffs;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Prevent a direct shops.status update from bypassing the audited handoff.
-- The normal review RPC already records the approval before advancing the shop.
CREATE OR REPLACE FUNCTION public.phase2_guard_shop_stage_advance()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_type text; v_gate boolean;
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status OR NEW.purchase_order_id IS NULL THEN RETURN NEW; END IF;
  SELECT fulfillment_type,company_approval_required INTO v_type,v_gate
    FROM public.purchase_orders WHERE id=NEW.purchase_order_id;
  IF NOT COALESCE(v_gate,false) THEN RETURN NEW; END IF;
  IF v_type='survey_install' AND NEW.status IN (
    'design_pending','designing','design_ready','in_review','design_approved',
    'production_pending','in_production','production_ready','production_hold','production_done',
    'dispatched','installation_pending','installing','installation_review','installed','billed'
  ) AND NOT EXISTS (
    SELECT 1 FROM public.surveys r WHERE r.shop_id=NEW.id
      AND public.phase2_handoff_is_valid('survey',r.id,NEW.id)
  ) THEN RAISE EXCEPTION 'Survey company approval required before advancing this site';
  END IF;
  IF NEW.status IN (
    'production_pending','in_production','production_ready','production_hold','production_done',
    'dispatched','installation_pending','installing','installation_review','installed','billed'
  ) AND EXISTS (
    SELECT 1 FROM public.po_line_items li
    WHERE li.purchase_order_id=NEW.purchase_order_id AND li.requires_design=true
  ) AND v_type IN ('survey_install','production_install','supply_only') AND NOT EXISTS (
    SELECT 1 FROM public.design_tasks d WHERE d.shop_id=NEW.id
      AND public.phase2_handoff_is_valid('design',d.id,NEW.id)
  ) THEN RAISE EXCEPTION 'Design company approval required before advancing this site';
  END IF;
  IF NEW.status IN ('installed','billed') AND OLD.status NOT IN ('installed','billed')
    AND v_type IN ('survey_install','production_install','direct_install') AND NOT EXISTS (
      SELECT 1 FROM public.installation_jobs j WHERE j.shop_id=NEW.id
        AND public.phase2_handoff_is_valid('installation',j.id,NEW.id)
    ) THEN RAISE EXCEPTION 'Installation company approval required before final site delivery';
  END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS trg_phase2_guard_shop_advance ON public.shops;
CREATE TRIGGER trg_phase2_guard_shop_advance BEFORE UPDATE OF status ON public.shops
FOR EACH ROW EXECUTE FUNCTION public.phase2_guard_shop_stage_advance();
