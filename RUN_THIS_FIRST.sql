-- RUN_THIS_FIRST.sql — Supabase SQL Editor me poora paste karke RUN karein (dobara chalana safe hai). 0087 + 0088 + 0090
-- Per-work-item site availability / non-execution state.
-- Keeps the work item and its survey/design history, while explicitly excluding
-- temporarily/permanently unavailable installation scope from installed/billing totals.
ALTER TABLE public.work_items
  ADD COLUMN IF NOT EXISTS execution_state text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS execution_reason text,
  ADD COLUMN IF NOT EXISTS execution_note text,
  ADD COLUMN IF NOT EXISTS excluded_from_calculations boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS execution_marked_at timestamptz,
  ADD COLUMN IF NOT EXISTS execution_marked_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL;

DO $$ BEGIN
  ALTER TABLE public.work_items ADD CONSTRAINT work_items_execution_state_check
    CHECK (execution_state IN ('active','site_unavailable','removed_from_scope'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_work_items_execution_state ON public.work_items(shop_id, execution_state);

-- Execution exclusion + evidence reliability hardening.
-- Self-heals deployments where 0087 was not applied, prevents excluded work
-- from ever contributing installed totals, and backfills safe legacy proof links.

ALTER TABLE public.work_items
  ADD COLUMN IF NOT EXISTS execution_state text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS execution_reason text,
  ADD COLUMN IF NOT EXISTS execution_note text,
  ADD COLUMN IF NOT EXISTS excluded_from_calculations boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS execution_marked_at timestamptz,
  ADD COLUMN IF NOT EXISTS execution_marked_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL;

-- Any excluded item is, by definition, not installed. Keep this invariant in DB
-- even if an older client tries to write installed metrics later.
CREATE OR REPLACE FUNCTION public.enforce_work_item_execution_exclusion()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.excluded_from_calculations IS TRUE OR COALESCE(NEW.execution_state,'active') <> 'active' THEN
    NEW.excluded_from_calculations := TRUE;
    NEW.installed_width := NULL;
    NEW.installed_height := NULL;
    NEW.installed_unit := NULL;
    NEW.installed_quantity := NULL;
    NEW.installed_area := NULL;
    NEW.installed_at := NULL;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_work_item_execution_exclusion ON public.work_items;
CREATE TRIGGER trg_work_item_execution_exclusion
BEFORE INSERT OR UPDATE ON public.work_items
FOR EACH ROW EXECUTE FUNCTION public.enforce_work_item_execution_exclusion();

-- Normalize any rows that were marked unavailable before this trigger existed.
UPDATE public.work_items
SET installed_width=NULL, installed_height=NULL, installed_unit=NULL,
    installed_quantity=NULL, installed_area=NULL, installed_at=NULL
WHERE excluded_from_calculations IS TRUE OR COALESCE(execution_state,'active') <> 'active';

-- Safe legacy evidence backfill: when a shop has exactly one work item there is
-- no ambiguity, so old installation proofs can be linked automatically.
UPDATE public.installation_proofs ip
SET work_item_id = only_item.work_item_id
FROM (
  SELECT shop_id, id AS work_item_id
  FROM (
    SELECT shop_id, id, count(*) OVER (PARTITION BY shop_id) AS item_count
    FROM public.work_items
  ) ranked_items
  WHERE item_count = 1
) only_item
WHERE ip.shop_id = only_item.shop_id AND ip.work_item_id IS NULL;

-- Agency PO utilization: excluded/non-executed items never contribute installed
-- area/quantity or the linked executed-item count used for billing readiness.
CREATE OR REPLACE VIEW public.v_po_line_item_utilization AS
SELECT
  pli.id AS po_line_item_id, pli.organization_id, pli.purchase_order_id,
  po.po_number, po.po_date, po.fulfillment_type, po.status AS po_status,
  po.client_id, c.name AS client_name, po.project_id, pr.name AS project_name,
  pli.description, pli.hsn_code, pli.work_type_id, wt.name AS work_type_name,
  pli.uom, pli.budgeted_qty, pli.budgeted_area, pli.rate,
  COALESCE((SELECT sum(wi.survey_area) FROM public.work_items wi WHERE wi.po_line_item_id=pli.id),0) AS surveyed_area,
  COALESCE((SELECT sum(wi.survey_quantity) FROM public.work_items wi WHERE wi.po_line_item_id=pli.id),0) AS surveyed_qty,
  COALESCE((SELECT sum(wi.approved_area) FROM public.work_items wi WHERE wi.po_line_item_id=pli.id),0) AS approved_area,
  COALESCE((SELECT sum(wi.approved_quantity) FROM public.work_items wi WHERE wi.po_line_item_id=pli.id),0) AS approved_qty,
  COALESCE((SELECT sum(wi.produced_quantity) FROM public.work_items wi WHERE wi.po_line_item_id=pli.id),0) AS produced_qty,
  COALESCE((SELECT sum(wi.installed_area) FROM public.work_items wi WHERE wi.po_line_item_id=pli.id AND NOT COALESCE(wi.excluded_from_calculations,false)),0) AS installed_area,
  COALESCE((SELECT sum(wi.installed_quantity) FROM public.work_items wi WHERE wi.po_line_item_id=pli.id AND NOT COALESCE(wi.excluded_from_calculations,false)),0) AS installed_qty,
  COALESCE((SELECT count(*) FROM public.work_items wi WHERE wi.po_line_item_id=pli.id AND NOT COALESCE(wi.excluded_from_calculations,false)),0) AS linked_work_item_count,
  COALESCE((SELECT sum(ii.amount) FROM public.invoice_items ii WHERE ii.po_line_item_id=pli.id),0) AS invoiced_amount
FROM public.po_line_items pli
JOIN public.purchase_orders po ON po.id=pli.purchase_order_id
LEFT JOIN public.clients c ON c.id=po.client_id
LEFT JOIN public.projects pr ON pr.id=po.project_id
LEFT JOIN public.work_types wt ON wt.id=pli.work_type_id
WHERE pli.organization_id=public.current_org_id();
GRANT SELECT ON public.v_po_line_item_utilization TO authenticated;

CREATE OR REPLACE VIEW public.v_client_po_line_item_progress AS
SELECT
  pli.id AS po_line_item_id, pli.purchase_order_id, po.organization_id AS agency_org_id,
  po.client_org_id, po.po_number, po.po_date, po.fulfillment_type,
  po.status AS po_status, po.assignment_status, pli.description, pli.work_type_id,
  wt.name AS work_type_name, pli.uom, pli.budgeted_qty, pli.budgeted_area,
  COALESCE((SELECT sum(wi.survey_area) FROM public.work_items wi WHERE wi.po_line_item_id=pli.id),0) AS surveyed_area,
  COALESCE((SELECT sum(wi.survey_quantity) FROM public.work_items wi WHERE wi.po_line_item_id=pli.id),0) AS surveyed_qty,
  COALESCE((SELECT sum(wi.approved_area) FROM public.work_items wi WHERE wi.po_line_item_id=pli.id),0) AS approved_area,
  COALESCE((SELECT sum(wi.approved_quantity) FROM public.work_items wi WHERE wi.po_line_item_id=pli.id),0) AS approved_qty,
  COALESCE((SELECT sum(wi.produced_quantity) FROM public.work_items wi WHERE wi.po_line_item_id=pli.id),0) AS produced_qty,
  COALESCE((SELECT sum(wi.installed_area) FROM public.work_items wi WHERE wi.po_line_item_id=pli.id AND NOT COALESCE(wi.excluded_from_calculations,false)),0) AS installed_area,
  COALESCE((SELECT sum(wi.installed_quantity) FROM public.work_items wi WHERE wi.po_line_item_id=pli.id AND NOT COALESCE(wi.excluded_from_calculations,false)),0) AS installed_qty,
  COALESCE((SELECT count(*) FROM public.work_items wi WHERE wi.po_line_item_id=pli.id AND NOT COALESCE(wi.excluded_from_calculations,false)),0) AS linked_work_item_count
FROM public.po_line_items pli
JOIN public.purchase_orders po ON po.id=pli.purchase_order_id
LEFT JOIN public.work_types wt ON wt.id=pli.work_type_id
WHERE po.client_org_id IS NOT NULL
  AND public.current_org_type()='client'
  AND po.client_org_id=public.current_org_id();
GRANT SELECT ON public.v_client_po_line_item_progress TO authenticated;

-- 0090 — FINAL: atomic review / redo / approval / site-unavailable flow.
-- Fully idempotent. Safe to run any number of times (self-heals 0085–0089 too).

-- ---------- 1. prerequisites ----------
CREATE TABLE IF NOT EXISTS public.field_review_decisions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  shop_id uuid not null references public.shops(id) on delete cascade,
  stage text not null,
  survey_id uuid references public.surveys(id) on delete cascade,
  installation_job_id uuid references public.installation_jobs(id) on delete cascade,
  entity_type text not null,
  entity_id uuid not null,
  decision text not null,
  note text,
  reviewed_by uuid,
  reviewed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique(stage, entity_type, entity_id)
);
ALTER TABLE public.field_review_decisions DROP CONSTRAINT IF EXISTS field_review_decisions_stage_check;
ALTER TABLE public.field_review_decisions ADD CONSTRAINT field_review_decisions_stage_check CHECK (stage IN ('survey','installation','design'));
ALTER TABLE public.field_review_decisions DROP CONSTRAINT IF EXISTS field_review_decisions_entity_type_check;
ALTER TABLE public.field_review_decisions ADD CONSTRAINT field_review_decisions_entity_type_check CHECK (entity_type IN ('measurement','survey_photo','work_item','installation_photo'));
ALTER TABLE public.field_review_decisions DROP CONSTRAINT IF EXISTS field_review_decisions_decision_check;
ALTER TABLE public.field_review_decisions ADD CONSTRAINT field_review_decisions_decision_check CHECK (decision IN ('approved','redo'));
CREATE INDEX IF NOT EXISTS idx_field_review_decisions_shop ON public.field_review_decisions(shop_id, stage);
ALTER TABLE public.field_review_decisions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "org members manage field review decisions" ON public.field_review_decisions;
CREATE POLICY "org members manage field review decisions" ON public.field_review_decisions FOR ALL TO authenticated
  USING (organization_id IN (SELECT organization_id FROM public.profiles WHERE id = auth.uid()))
  WITH CHECK (organization_id IN (SELECT organization_id FROM public.profiles WHERE id = auth.uid()));
GRANT ALL ON public.field_review_decisions TO authenticated;

ALTER TABLE public.field_corrections DROP CONSTRAINT IF EXISTS field_corrections_stage_check;
ALTER TABLE public.field_corrections ADD CONSTRAINT field_corrections_stage_check CHECK (stage IN ('survey','installation','design'));

ALTER TABLE public.installation_proofs ADD COLUMN IF NOT EXISTS work_item_id uuid REFERENCES public.work_items(id) ON DELETE SET NULL;
ALTER TABLE public.work_items
  ADD COLUMN IF NOT EXISTS execution_state text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS execution_reason text,
  ADD COLUMN IF NOT EXISTS execution_note text,
  ADD COLUMN IF NOT EXISTS excluded_from_calculations boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS execution_marked_at timestamptz,
  ADD COLUMN IF NOT EXISTS execution_marked_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL;
DO $$ BEGIN
  ALTER TABLE public.work_items ADD CONSTRAINT work_items_execution_state_check CHECK (execution_state IN ('active','site_unavailable','removed_from_scope'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE OR REPLACE FUNCTION public.enforce_work_item_execution_exclusion()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.excluded_from_calculations IS TRUE OR COALESCE(NEW.execution_state,'active') <> 'active' THEN
    NEW.excluded_from_calculations := TRUE;
    NEW.installed_width := NULL; NEW.installed_height := NULL; NEW.installed_unit := NULL;
    NEW.installed_quantity := NULL; NEW.installed_area := NULL; NEW.installed_at := NULL;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_work_item_execution_exclusion ON public.work_items;
CREATE TRIGGER trg_work_item_execution_exclusion BEFORE INSERT OR UPDATE ON public.work_items
FOR EACH ROW EXECUTE FUNCTION public.enforce_work_item_execution_exclusion();
UPDATE public.work_items SET installed_width=NULL, installed_height=NULL, installed_unit=NULL,
  installed_quantity=NULL, installed_area=NULL, installed_at=NULL
WHERE excluded_from_calculations IS TRUE OR COALESCE(execution_state,'active') <> 'active';

-- realtime for everything the review flow touches
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['field_corrections','field_review_decisions','work_items','installation_proofs','installation_jobs','surveys','survey_photos','design_tasks','shops']
  LOOP
    IF EXISTS (SELECT 1 FROM pg_class WHERE relname=t AND relnamespace='public'::regnamespace)
       AND NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename=t) THEN
      BEGIN EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t); EXCEPTION WHEN OTHERS THEN NULL; END;
    END IF;
  END LOOP;
END $$;

-- ---------- 2. gates: honour the review-RPC bypass flag ----------
CREATE OR REPLACE FUNCTION public.review_rpc_active() RETURNS boolean LANGUAGE sql STABLE AS
$$ SELECT COALESCE(current_setting('app.review_rpc', true),'') = 'on' $$;

CREATE OR REPLACE FUNCTION public.enforce_survey_review_gate() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF public.review_rpc_active() THEN RETURN NEW; END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('approved','rejected','correction_requested') THEN
    IF public.current_role() NOT IN ('agency_owner','admin','demo') THEN RAISE EXCEPTION 'Only the Agency Owner or Admin can review a survey'; END IF;
    IF OLD.status <> 'submitted' THEN RAISE EXCEPTION 'Only a submitted survey can be reviewed (current status: %)', OLD.status; END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.enforce_installation_review_gate() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF public.review_rpc_active() THEN RETURN NEW; END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status = 'installed' THEN
    IF public.current_role() NOT IN ('agency_owner','admin','demo') THEN RAISE EXCEPTION 'Only the Agency Owner or Admin can approve an installation'; END IF;
    IF OLD.status <> 'installation_review' THEN RAISE EXCEPTION 'Installation must go through review before it can be marked Installed (current status: %)', OLD.status; END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.enforce_installation_job_review_gate() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF public.review_rpc_active() THEN RETURN NEW; END IF;
  IF NEW.review_status IS DISTINCT FROM OLD.review_status AND NEW.review_status IN ('approved','rejected') THEN
    IF public.current_role() NOT IN ('agency_owner','admin','demo') THEN RAISE EXCEPTION 'Only the Agency Owner or Admin can review an installation'; END IF;
    IF OLD.review_status <> 'pending' THEN RAISE EXCEPTION 'Only a pending installation review can be approved or rejected (current: %)', OLD.review_status; END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.enforce_design_task_gate() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF public.review_rpc_active() THEN RETURN NEW; END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status IN ('approved','ready_for_production') THEN
      IF public.current_role() NOT IN ('agency_owner','admin','demo') THEN RAISE EXCEPTION 'Only the Agency Owner or Admin can approve a design or send it to production'; END IF;
      IF NEW.status = 'approved' AND OLD.status NOT IN ('in_review','internal_review') THEN RAISE EXCEPTION 'A design can only be approved from In Review (current status: %)', OLD.status; END IF;
      IF NEW.status = 'ready_for_production' AND OLD.status <> 'approved' THEN RAISE EXCEPTION 'A design must be Approved before it can move to production (current status: %)', OLD.status; END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- The DB used to REFUSE completion unless the (now removed) material-check step ran.
-- Auto-confirm instead of blocking, so installers can always submit.
CREATE OR REPLACE FUNCTION public.enforce_material_check_before_completion() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status IN ('completed','exception') AND NEW.material_check_confirmed IS NOT TRUE THEN
    NEW.material_check_confirmed := TRUE;
    NEW.material_check_confirmed_by := COALESCE(NEW.material_check_confirmed_by, NEW.installer_id);
    NEW.material_check_confirmed_at := COALESCE(NEW.material_check_confirmed_at, now());
  END IF;
  RETURN NEW;
END $$;

-- Manual stage overrides only. System-driven review moves (flag on) must not wipe corrections.
CREATE OR REPLACE FUNCTION public.sync_shop_stage_change() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF public.review_rpc_active() THEN RETURN NEW; END IF;
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
  -- Normal pipeline hops made by the app itself (survey submit -> surveyed, installer submit etc.)
  -- are not "manual overrides": only reset children when going BACKWARDS from a later stage.
  IF NEW.status IN ('pending','assigned','survey_started') AND OLD.status NOT IN ('pending','assigned','survey_started') THEN
    UPDATE public.field_corrections SET status='cancelled', resolved_at=COALESCE(resolved_at, now()) WHERE shop_id=NEW.id AND status IN ('open','resubmitted');
    UPDATE public.shop_assignments SET status='assigned', completed_at=NULL WHERE shop_id=NEW.id AND role='surveyor' AND status<>'declined';
    UPDATE public.surveys SET status='draft', submitted_at=NULL, reviewed_at=NULL, reviewed_by=NULL, review_note=NULL, updated_at=now()
      WHERE id=(SELECT id FROM public.surveys WHERE shop_id=NEW.id ORDER BY created_at DESC LIMIT 1);
  END IF;
  IF NEW.status IN ('design_pending','designing') AND OLD.status NOT IN ('design_pending','designing','approved','surveyed','approval_pending') THEN
    UPDATE public.field_corrections SET status='cancelled', resolved_at=COALESCE(resolved_at, now()) WHERE shop_id=NEW.id AND status IN ('open','resubmitted');
    UPDATE public.design_tasks SET status=CASE WHEN NEW.status='designing' THEN 'designing' ELSE 'assigned' END, completed_at=NULL, updated_at=now()
      WHERE id=(SELECT id FROM public.design_tasks WHERE shop_id=NEW.id ORDER BY created_at DESC LIMIT 1);
  END IF;
  IF NEW.status IN ('production_done','dispatched','installation_pending','installing') AND OLD.status NOT IN ('production_done','dispatched','installation_pending','installing','production_ready','installation_review') THEN
    UPDATE public.field_corrections SET status='cancelled', resolved_at=COALESCE(resolved_at, now()) WHERE shop_id=NEW.id AND stage='installation' AND status IN ('open','resubmitted');
    UPDATE public.shop_assignments SET status='assigned', completed_at=NULL WHERE shop_id=NEW.id AND role='installer' AND status<>'declined';
    UPDATE public.installation_jobs SET status=CASE WHEN NEW.status='installing' THEN 'started' ELSE 'assigned' END,
      review_status='not_applicable', reviewed_at=NULL, reviewed_by=NULL, completed_at=NULL, exception_reason=NULL, exception_note=NULL, updated_at=now()
      WHERE id=(SELECT id FROM public.installation_jobs WHERE shop_id=NEW.id ORDER BY created_at DESC LIMIT 1);
  END IF;
  RETURN NEW;
END $$;

-- designer re-sends design for review => its open design corrections become "resubmitted"
CREATE OR REPLACE FUNCTION public.design_resubmit_corrections() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status='in_review' AND OLD.status IS DISTINCT FROM 'in_review' THEN
    DELETE FROM public.field_review_decisions d USING public.field_corrections c
      WHERE c.shop_id=NEW.shop_id AND c.stage='design' AND c.status='open' AND d.stage='design' AND d.entity_id=c.work_item_id;
    UPDATE public.field_corrections SET status='resubmitted', resubmitted_at=now() WHERE shop_id=NEW.shop_id AND stage='design' AND status='open';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_design_resubmit_corrections ON public.design_tasks;
CREATE TRIGGER trg_design_resubmit_corrections AFTER UPDATE OF status ON public.design_tasks FOR EACH ROW EXECUTE FUNCTION public.design_resubmit_corrections();

-- ---------- 3. helpers ----------
CREATE OR REPLACE FUNCTION public._notify(p_org uuid, p_user uuid, p_title text, p_msg text, p_type text, p_link text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF p_user IS NULL THEN RETURN; END IF;
  INSERT INTO public.notifications(organization_id,user_id,title,message,type,link) VALUES(p_org,p_user,p_title,p_msg,p_type,p_link);
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

CREATE OR REPLACE FUNCTION public._notify_reviewers(p_org uuid, p_title text, p_msg text, p_link text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE r record;
BEGIN
  FOR r IN SELECT id FROM public.profiles WHERE organization_id=p_org AND role IN ('agency_owner','admin') AND is_active LOOP
    PERFORM public._notify(p_org, r.id, p_title, p_msg, 'info', p_link);
  END LOOP;
END $$;

-- when a shop leaves review, any duplicate pending job/survey rows of the same shop must leave too
CREATE OR REPLACE FUNCTION public._supersede_pending(p_stage text, p_shop uuid, p_ref uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF p_stage='installation' THEN
    UPDATE public.installation_jobs j SET review_status=(SELECT review_status FROM public.installation_jobs WHERE id=p_ref),
      reviewed_at=now(), reviewed_by=auth.uid(), review_note=COALESCE(j.review_note,'Superseded by the reviewed installation')
    WHERE j.shop_id=p_shop AND j.id<>p_ref AND j.review_status='pending';
  ELSIF p_stage='survey' THEN
    UPDATE public.surveys v SET status=(SELECT status FROM public.surveys WHERE id=p_ref),
      reviewed_at=now(), reviewed_by=auth.uid(), review_note=COALESCE(v.review_note,'Superseded by the reviewed survey')
    WHERE v.shop_id=p_shop AND v.id<>p_ref AND v.status='submitted';
  END IF;
END $$;

-- ---------- 4. main review RPC ----------
DROP FUNCTION IF EXISTS public.review_apply(text,uuid,uuid,jsonb,text,text,uuid,jsonb);
CREATE OR REPLACE FUNCTION public.review_apply(
  p_stage text, p_shop_id uuid, p_ref_id uuid, p_entities jsonb, p_decision text,
  p_note text DEFAULT NULL, p_designer_id uuid DEFAULT NULL, p_variance jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  v_org uuid; v_shop text; v_assigned uuid; v_note text := NULLIF(trim(coalesce(p_note,'')),'');
  e record; ent jsonb; v_etype text; v_eid uuid; v_wi uuid;
  v_ents jsonb := '[]'::jsonb; v_all boolean;
  v_pending int; v_redo int; v_total int; v_open int;
  v_designer uuid; v_finalized boolean := false; v_needs_designer boolean := false;
  v_shopname text; it record; v_missing text; v_undecided int := 0;
BEGIN
  IF p_stage NOT IN ('survey','installation','design') OR p_decision NOT IN ('approved','redo') THEN RAISE EXCEPTION 'Invalid review action'; END IF;
  SELECT organization_id, name INTO v_org, v_shopname FROM public.shops WHERE id=p_shop_id;
  IF v_org IS NULL OR v_org <> public.current_org_id() THEN RAISE EXCEPTION 'Shop not accessible'; END IF;
  IF public.current_role() NOT IN ('agency_owner','admin','demo') THEN RAISE EXCEPTION 'Only Owner/Admin can review'; END IF;
  PERFORM set_config('app.review_rpc','on',true);

  IF p_stage='survey' THEN
    SELECT surveyor_id INTO v_assigned FROM public.surveys WHERE id=p_ref_id AND shop_id=p_shop_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Survey not found'; END IF;
  ELSIF p_stage='installation' THEN
    SELECT installer_id INTO v_assigned FROM public.installation_jobs WHERE id=p_ref_id AND shop_id=p_shop_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Installation job not found'; END IF;
  ELSE
    SELECT designer_id INTO v_assigned FROM public.design_tasks WHERE id=p_ref_id AND shop_id=p_shop_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Design task not found'; END IF;
  END IF;
  IF p_decision='redo' AND v_assigned IS NULL THEN RAISE EXCEPTION 'No assigned person found to send the redo to'; END IF;

  -- which entities?
  v_all := (p_entities IS NULL OR jsonb_typeof(p_entities)<>'array' OR jsonb_array_length(p_entities)=0);
  IF v_all THEN
    IF p_stage='survey' THEN
      SELECT COALESCE(jsonb_agg(jsonb_build_object('type','measurement','id',id)),'[]') INTO v_ents FROM public.work_items WHERE survey_id=p_ref_id;
      v_ents := v_ents || COALESCE((SELECT jsonb_agg(jsonb_build_object('type','survey_photo','id',id)) FROM public.survey_photos WHERE survey_id=p_ref_id),'[]');
    ELSIF p_stage='installation' THEN
      SELECT COALESCE(jsonb_agg(jsonb_build_object('type','work_item','id',id)),'[]') INTO v_ents FROM public.work_items WHERE shop_id=p_shop_id;
      v_ents := v_ents || COALESCE((SELECT jsonb_agg(jsonb_build_object('type','installation_photo','id',id)) FROM public.installation_proofs WHERE installation_job_id=p_ref_id),'[]');
    ELSE
      SELECT COALESCE(jsonb_agg(jsonb_build_object('type','work_item','id',id)),'[]') INTO v_ents FROM public.work_items WHERE shop_id=p_shop_id;
    END IF;
  ELSE v_ents := p_entities; END IF;
  -- "approve all remaining" never overrides an item that is currently sent back for redo
  IF v_all AND p_decision='approved' THEN
    SELECT COALESCE(jsonb_agg(x),'[]') INTO v_ents FROM jsonb_array_elements(v_ents) x
     WHERE NOT EXISTS (SELECT 1 FROM public.field_review_decisions d WHERE d.stage=p_stage AND d.entity_type=x->>'type' AND d.entity_id=(x->>'id')::uuid AND d.decision='redo');
  END IF;

  -- variance notes (survey approval)
  IF p_stage='survey' AND p_decision='approved' AND p_variance IS NOT NULL AND jsonb_typeof(p_variance)='object' THEN
    FOR e IN SELECT key, value FROM jsonb_each_text(p_variance) LOOP
      IF NULLIF(trim(e.value),'') IS NOT NULL THEN
        UPDATE public.work_items SET po_variance_note=trim(e.value), po_variance_acknowledged_by=auth.uid(), po_variance_acknowledged_at=now() WHERE id=e.key::uuid AND shop_id=p_shop_id;
      END IF;
    END LOOP;
  END IF;

  FOR ent IN SELECT * FROM jsonb_array_elements(v_ents) LOOP
    v_etype := ent->>'type'; v_eid := (ent->>'id')::uuid;
    IF v_etype NOT IN ('measurement','survey_photo','work_item','installation_photo') THEN RAISE EXCEPTION 'Invalid entity type %', v_etype; END IF;
    v_wi := NULL;
    IF v_etype IN ('measurement','work_item') THEN v_wi := v_eid;
    ELSIF v_etype='installation_photo' THEN SELECT work_item_id INTO v_wi FROM public.installation_proofs WHERE id=v_eid; END IF;

    IF p_decision='approved' AND p_stage='installation' AND v_etype='work_item' THEN
      -- unavailable work needs no photo; it is simply acknowledged
      IF EXISTS (SELECT 1 FROM public.work_items WHERE id=v_eid AND NOT excluded_from_calculations)
         AND NOT EXISTS (SELECT 1 FROM public.installation_proofs WHERE installation_job_id=p_ref_id AND (work_item_id=v_eid OR work_item_id IS NULL)) THEN
        SELECT COALESCE(work_type_name,'Work item') INTO v_missing FROM public.work_items WHERE id=v_eid;
        RAISE EXCEPTION '% has no installation photo. Send it for redo, or mark it Not available.', v_missing;
      END IF;
    END IF;

    INSERT INTO public.field_review_decisions(organization_id,shop_id,stage,survey_id,installation_job_id,entity_type,entity_id,decision,note,reviewed_by,reviewed_at)
    VALUES(v_org,p_shop_id,p_stage,CASE WHEN p_stage='survey' THEN p_ref_id END,CASE WHEN p_stage='installation' THEN p_ref_id END,v_etype,v_eid,p_decision,v_note,auth.uid(),now())
    ON CONFLICT(stage,entity_type,entity_id) DO UPDATE SET organization_id=EXCLUDED.organization_id, shop_id=EXCLUDED.shop_id,
      survey_id=EXCLUDED.survey_id, installation_job_id=EXCLUDED.installation_job_id, decision=EXCLUDED.decision, note=EXCLUDED.note,
      reviewed_by=auth.uid(), reviewed_at=now();

    UPDATE public.field_corrections SET status=CASE WHEN p_decision='redo' THEN 'cancelled' ELSE 'resolved' END, resolved_at=now()
     WHERE organization_id=v_org AND shop_id=p_shop_id AND stage=p_stage AND status IN ('open','resubmitted')
       AND ((v_etype IN ('measurement','work_item') AND work_item_id=v_eid)
         OR (v_etype='survey_photo' AND survey_photo_id=v_eid)
         OR (v_etype='installation_photo' AND installation_proof_id=v_eid));

    IF p_decision='redo' THEN
      INSERT INTO public.field_corrections(organization_id,shop_id,stage,survey_id,installation_job_id,work_item_id,survey_photo_id,installation_proof_id,assigned_to,requested_by,issue_type,note,status)
      VALUES(v_org,p_shop_id,p_stage,CASE WHEN p_stage='survey' THEN p_ref_id END,CASE WHEN p_stage='installation' THEN p_ref_id END,v_wi,
        CASE WHEN v_etype='survey_photo' THEN v_eid END, CASE WHEN v_etype='installation_photo' THEN v_eid END,
        v_assigned,auth.uid(),v_etype,v_note,'open');
    END IF;
  END LOOP;

  -- overall state
  IF p_stage='survey' THEN
    SELECT count(*) INTO v_total FROM (SELECT id FROM public.work_items WHERE survey_id=p_ref_id UNION ALL SELECT id FROM public.survey_photos WHERE survey_id=p_ref_id) x;
    SELECT count(*) INTO v_pending FROM (
      SELECT 'measurement'::text t, id FROM public.work_items WHERE survey_id=p_ref_id UNION ALL SELECT 'survey_photo', id FROM public.survey_photos WHERE survey_id=p_ref_id) r
      WHERE NOT EXISTS (SELECT 1 FROM public.field_review_decisions d WHERE d.stage='survey' AND d.entity_type=r.t AND d.entity_id=r.id AND d.decision='approved');
    SELECT count(*) INTO v_redo FROM public.field_review_decisions WHERE stage='survey' AND survey_id=p_ref_id AND decision='redo';
  ELSIF p_stage='installation' THEN
    SELECT count(*) INTO v_total FROM (SELECT id FROM public.work_items WHERE shop_id=p_shop_id UNION ALL SELECT id FROM public.installation_proofs WHERE installation_job_id=p_ref_id) x;
    -- photos are proof for the work item: only work items must carry an explicit approval (excluded ones auto-satisfied)
    SELECT count(*) INTO v_pending FROM public.work_items w WHERE w.shop_id=p_shop_id AND NOT w.excluded_from_calculations
      AND NOT EXISTS (SELECT 1 FROM public.field_review_decisions d WHERE d.stage='installation' AND d.entity_type='work_item' AND d.entity_id=w.id AND d.decision='approved');
    SELECT count(*) INTO v_redo FROM public.field_review_decisions WHERE stage='installation' AND installation_job_id=p_ref_id AND decision='redo'
      AND (entity_type<>'work_item' OR entity_id IN (SELECT id FROM public.work_items WHERE shop_id=p_shop_id AND NOT excluded_from_calculations));
  ELSE
    SELECT count(*) INTO v_total FROM public.work_items WHERE shop_id=p_shop_id;
    SELECT count(*) INTO v_pending FROM public.work_items w WHERE w.shop_id=p_shop_id
      AND NOT EXISTS (SELECT 1 FROM public.field_review_decisions d WHERE d.stage='design' AND d.entity_type='work_item' AND d.entity_id=w.id AND d.decision='approved');
    SELECT count(*) INTO v_redo FROM public.field_review_decisions WHERE stage='design' AND shop_id=p_shop_id AND decision='redo';
  END IF;
  SELECT count(*) INTO v_open FROM public.field_corrections WHERE shop_id=p_shop_id AND stage=p_stage AND status IN ('open','resubmitted');

  -- "undecided" = work still waiting for a decision. While any work is undecided the shop STAYS in review.
  IF p_stage='survey' THEN
    SELECT count(*) INTO v_undecided FROM (
      SELECT 'measurement'::text t, id FROM public.work_items WHERE survey_id=p_ref_id UNION ALL SELECT 'survey_photo', id FROM public.survey_photos WHERE survey_id=p_ref_id) r
      WHERE NOT EXISTS (SELECT 1 FROM public.field_review_decisions d WHERE d.stage='survey' AND d.entity_type=r.t AND d.entity_id=r.id);
  ELSIF p_stage='installation' THEN
    SELECT count(*) INTO v_undecided FROM public.work_items w WHERE w.shop_id=p_shop_id AND NOT w.excluded_from_calculations
      AND NOT EXISTS (SELECT 1 FROM public.field_review_decisions d WHERE d.stage='installation' AND d.entity_type='work_item' AND d.entity_id=w.id);
  ELSE
    SELECT count(*) INTO v_undecided FROM public.work_items w WHERE w.shop_id=p_shop_id
      AND NOT EXISTS (SELECT 1 FROM public.field_review_decisions d WHERE d.stage='design' AND d.entity_type='work_item' AND d.entity_id=w.id);
  END IF;

  IF v_redo>0 AND v_undecided=0 THEN
    -- everything is decided and some work must be redone -> shop leaves review and goes back to the field person
    IF p_stage='survey' THEN
      UPDATE public.surveys SET status=CASE WHEN v_total>0 AND v_redo>=v_total THEN 'rejected' ELSE 'correction_requested' END,
        review_note=COALESCE(v_note,'Selected survey evidence needs correction'), reviewed_at=now(), reviewed_by=auth.uid() WHERE id=p_ref_id;
      UPDATE public.shops SET status='assigned' WHERE id=p_shop_id;
    ELSIF p_stage='installation' THEN
      UPDATE public.installation_jobs SET review_status='rejected', reviewed_at=now(), reviewed_by=auth.uid(),
        review_note=COALESCE(v_note,'Selected installation evidence needs correction') WHERE id=p_ref_id;
      UPDATE public.shops SET status='installation_pending' WHERE id=p_shop_id;
    ELSE
      UPDATE public.design_tasks SET status='designing', notes=COALESCE(v_note,notes), completed_at=NULL WHERE id=p_ref_id;
      UPDATE public.shops SET status='designing' WHERE id=p_shop_id;
    END IF;
  END IF;

  IF p_decision='redo' THEN
    IF p_stage='survey' THEN
      UPDATE public.shop_assignments SET status='assigned', completed_at=NULL WHERE shop_id=p_shop_id AND user_id=v_assigned AND role='surveyor';
      PERFORM public._notify(v_org,v_assigned,'Survey redo requested','Some items of '||v_shopname||' need correction. '||COALESCE(v_note,''),'warning','/mobile');
    ELSIF p_stage='installation' THEN
      UPDATE public.shop_assignments SET status='assigned', completed_at=NULL WHERE shop_id=p_shop_id AND user_id=v_assigned AND role='installer';
      PERFORM public._notify(v_org,v_assigned,'Installation redo requested','Some items of '||v_shopname||' need redo. '||COALESCE(v_note,''),'warning','/mobile');
    ELSE
      PERFORM public._notify(v_org,v_assigned,'Design changes requested','Some designs of '||v_shopname||' need changes. '||COALESCE(v_note,''),'warning','/design');
    END IF;
    IF v_undecided=0 AND v_redo>0 THEN PERFORM public._supersede_pending(p_stage,p_shop_id,p_ref_id); END IF;
    RETURN jsonb_build_object('finalized',false,'pending',v_pending,'undecided',v_undecided,'redo',v_redo,'open_corrections',v_open,'left_review',(v_undecided=0 AND v_redo>0));
  END IF;

  -- approved: finalize when nothing left
  IF v_pending=0 AND v_redo=0 AND v_open=0 THEN
    IF p_stage='survey' THEN
      v_designer := COALESCE(p_designer_id, (SELECT designer_id FROM public.design_tasks WHERE shop_id=p_shop_id ORDER BY created_at DESC LIMIT 1));
      IF v_designer IS NULL THEN
        v_needs_designer := true;
      ELSE
        UPDATE public.surveys SET status='approved', reviewed_at=now(), reviewed_by=auth.uid(), review_note=v_note WHERE id=p_ref_id;
        UPDATE public.work_items SET approved_width=survey_width, approved_height=survey_height, approved_unit=survey_unit,
          approved_quantity=survey_quantity, approved_area=survey_area, approved_notes=survey_notes, status='approved' WHERE survey_id=p_ref_id;
        UPDATE public.shops SET status='design_pending' WHERE id=p_shop_id;
        IF EXISTS (SELECT 1 FROM public.design_tasks WHERE shop_id=p_shop_id) THEN
          UPDATE public.design_tasks SET designer_id=v_designer WHERE id=(SELECT id FROM public.design_tasks WHERE shop_id=p_shop_id ORDER BY created_at DESC LIMIT 1);
        ELSE
          INSERT INTO public.design_tasks(organization_id,shop_id,status,designer_id) VALUES(v_org,p_shop_id,'assigned',v_designer);
        END IF;
        PERFORM public._notify(v_org,v_designer,'New Design Task','You have been assigned to design '||v_shopname,'info','/design');
        PERFORM public._notify(v_org,v_assigned,'Survey approved','Your survey for '||v_shopname||' was approved.','success','/mobile');
        v_finalized := true;
      END IF;
    ELSIF p_stage='installation' THEN
      UPDATE public.shops SET status='installed' WHERE id=p_shop_id;
      UPDATE public.installation_jobs SET review_status='approved', reviewed_at=now(), reviewed_by=auth.uid(), review_note=v_note WHERE id=p_ref_id;
      UPDATE public.shop_assignments SET status='completed', completed_at=COALESCE(completed_at,now()) WHERE shop_id=p_shop_id AND role='installer' AND user_id=v_assigned;
      UPDATE public.work_items SET status='installed' WHERE shop_id=p_shop_id AND NOT excluded_from_calculations;
      PERFORM public._notify(v_org,v_assigned,'Installation approved','Installation for '||v_shopname||' was approved.','success','/mobile');
      v_finalized := true;
    ELSE
      UPDATE public.design_tasks SET status='approved', completed_at=now() WHERE id=p_ref_id;
      UPDATE public.shops SET status='design_approved' WHERE id=p_shop_id;
      UPDATE public.design_versions SET status='approved' WHERE id=(SELECT id FROM public.design_versions WHERE design_task_id=p_ref_id ORDER BY version_number DESC LIMIT 1);
      PERFORM public._notify(v_org,v_assigned,'Design approved','Your design for '||v_shopname||' was approved.','success','/design');
      v_finalized := true;
    END IF;
  END IF;
  IF v_finalized OR (v_undecided=0 AND v_redo>0) THEN PERFORM public._supersede_pending(p_stage,p_shop_id,p_ref_id); END IF;
  RETURN jsonb_build_object('finalized',v_finalized,'needs_designer',v_needs_designer,'pending',v_pending,'undecided',v_undecided,'redo',v_redo,'open_corrections',v_open,'left_review',(v_finalized OR (v_undecided=0 AND v_redo>0)));
END $$;
GRANT EXECUTE ON FUNCTION public.review_apply(text,uuid,uuid,jsonb,text,text,uuid,jsonb) TO authenticated;

-- backwards compatible wrapper for older clients
CREATE OR REPLACE FUNCTION public.set_field_review_decision(p_stage text,p_shop_id uuid,p_survey_id uuid,p_installation_job_id uuid,p_entity_type text,p_entity_id uuid,p_decision text,p_note text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  PERFORM public.review_apply(p_stage,p_shop_id,COALESCE(p_survey_id,p_installation_job_id),
    jsonb_build_array(jsonb_build_object('type',p_entity_type,'id',p_entity_id)),p_decision,p_note,NULL,'{}'::jsonb);
END $$;
GRANT EXECUTE ON FUNCTION public.set_field_review_decision(text,uuid,uuid,uuid,text,uuid,text,text) TO authenticated;

-- ---------- 5. field person re-submits corrected work ----------
DROP FUNCTION IF EXISTS public.review_submit_corrections(text,uuid);
CREATE OR REPLACE FUNCTION public.review_submit_corrections(p_stage text, p_shop_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_org uuid; v_name text; c record; v_id uuid; v_paths text[] := '{}'; v_n int := 0; v_job uuid; v_sv uuid;
BEGIN
  SELECT organization_id,name INTO v_org,v_name FROM public.shops WHERE id=p_shop_id;
  IF v_org IS NULL OR v_org <> public.current_org_id() THEN RAISE EXCEPTION 'Shop not accessible'; END IF;
  PERFORM set_config('app.review_rpc','on',true);
  IF p_stage NOT IN ('survey','installation') THEN RAISE EXCEPTION 'Invalid stage'; END IF;

  FOR c IN SELECT * FROM public.field_corrections WHERE shop_id=p_shop_id AND stage=p_stage AND status='open' LOOP
    v_n := v_n + 1;
    v_job := COALESCE(v_job, c.installation_job_id); v_sv := COALESCE(v_sv, c.survey_id);
    -- drop the stale decision so the fixed item shows up as "needs review" again
    DELETE FROM public.field_review_decisions WHERE stage=p_stage AND entity_id IN (COALESCE(c.work_item_id,'00000000-0000-0000-0000-000000000000'),
      COALESCE(c.survey_photo_id,'00000000-0000-0000-0000-000000000000'),COALESCE(c.installation_proof_id,'00000000-0000-0000-0000-000000000000'));
    IF p_stage='installation' THEN
      IF c.installation_proof_id IS NOT NULL THEN
        SELECT id INTO v_id FROM public.installation_proofs p WHERE p.id=c.installation_proof_id
          AND EXISTS (SELECT 1 FROM public.installation_proofs n WHERE n.installation_job_id=p.installation_job_id AND n.captured_at>c.created_at);
        IF v_id IS NOT NULL THEN
          SELECT array_append(v_paths, storage_path) INTO v_paths FROM public.installation_proofs WHERE id=v_id;
          DELETE FROM public.installation_proofs WHERE id=v_id;
        END IF;
      ELSIF c.work_item_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.installation_proofs n WHERE n.work_item_id=c.work_item_id AND n.installation_job_id=c.installation_job_id AND n.captured_at>c.created_at) THEN
        SELECT COALESCE(array_agg(storage_path),'{}') INTO v_paths FROM (SELECT storage_path FROM public.installation_proofs WHERE work_item_id=c.work_item_id AND installation_job_id=c.installation_job_id AND captured_at<c.created_at UNION ALL SELECT unnest(v_paths)) z;
        DELETE FROM public.installation_proofs WHERE work_item_id=c.work_item_id AND installation_job_id=c.installation_job_id AND captured_at<c.created_at;
      END IF;
    END IF;
    UPDATE public.field_corrections SET status='resubmitted', resubmitted_at=now() WHERE id=c.id;
  END LOOP;
  IF v_n=0 THEN RETURN jsonb_build_object('resubmitted',0,'storage_paths','[]'::jsonb); END IF;

  IF p_stage='survey' THEN
    UPDATE public.surveys SET status='submitted', submitted_at=now(), reviewed_at=NULL, reviewed_by=NULL WHERE id=v_sv;
    UPDATE public.shops SET status='surveyed' WHERE id=p_shop_id;
    UPDATE public.shop_assignments SET status='completed', completed_at=now() WHERE shop_id=p_shop_id AND role='surveyor' AND user_id=auth.uid();
    PERFORM public._notify_reviewers(v_org,'Survey corrections submitted','Corrected items of '||v_name||' are ready for review','/survey-review');
  ELSE
    UPDATE public.installation_jobs SET status='completed', review_status='pending', reviewed_at=NULL, reviewed_by=NULL, completed_at=now() WHERE id=v_job;
    UPDATE public.shops SET status='installation_review' WHERE id=p_shop_id;
    UPDATE public.shop_assignments SET status='completed', completed_at=now() WHERE shop_id=p_shop_id AND role='installer' AND user_id=auth.uid();
    PERFORM public._notify_reviewers(v_org,'Installation corrections submitted','Corrected items of '||v_name||' are ready for review','/installation-review');
  END IF;
  RETURN jsonb_build_object('resubmitted',v_n,'storage_paths',to_jsonb(v_paths));
END $$;
GRANT EXECUTE ON FUNCTION public.review_submit_corrections(text,uuid) TO authenticated;

-- ---------- 6. site not available for a work item ----------
CREATE OR REPLACE FUNCTION public.set_work_item_execution_availability(p_work_item_id uuid, p_unavailable boolean, p_reason text DEFAULT NULL, p_note text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_org uuid; v_shop uuid; v_name text; v_sname text;
BEGIN
  SELECT organization_id, shop_id, work_type_name INTO v_org, v_shop, v_name FROM public.work_items WHERE id=p_work_item_id;
  IF v_org IS NULL OR v_org <> public.current_org_id() THEN RAISE EXCEPTION 'Work item not accessible'; END IF;
  IF p_unavailable AND NULLIF(trim(coalesce(p_reason,'')),'') IS NULL THEN RAISE EXCEPTION 'Reason is required when marking Not available'; END IF;
  UPDATE public.work_items SET
    execution_state=CASE WHEN p_unavailable THEN 'site_unavailable' ELSE 'active' END,
    execution_reason=CASE WHEN p_unavailable THEN trim(p_reason) ELSE NULL END,
    execution_note=CASE WHEN p_unavailable THEN NULLIF(trim(coalesce(p_note,'')),'') ELSE NULL END,
    excluded_from_calculations=p_unavailable, execution_marked_at=now(), execution_marked_by=auth.uid()
  WHERE id=p_work_item_id;
  -- any earlier approval of this item's installation is void once it is not executed
  IF p_unavailable THEN
    DELETE FROM public.field_review_decisions WHERE stage='installation' AND entity_type='work_item' AND entity_id=p_work_item_id AND decision='redo';
    UPDATE public.field_corrections SET status='cancelled', resolved_at=now() WHERE work_item_id=p_work_item_id AND stage='installation' AND status='open';
    SELECT name INTO v_sname FROM public.shops WHERE id=v_shop;
    PERFORM public._notify_reviewers(v_org,'Work marked not available',COALESCE(v_name,'Work item')||' at '||COALESCE(v_sname,'shop')||': '||trim(p_reason),'/installation-review');
  END IF;
END $$;
GRANT EXECUTE ON FUNCTION public.set_work_item_execution_availability(uuid,boolean,text,text) TO authenticated;

-- ---------- 7. cleanup: stale "open" corrections on shops that are already finished ----------
UPDATE public.field_corrections c SET status='cancelled', resolved_at=COALESCE(resolved_at, now())
FROM public.shops s WHERE s.id=c.shop_id AND c.status='open' AND s.status IN ('installed','billed')
  AND c.stage='installation';
UPDATE public.field_corrections c SET status='cancelled', resolved_at=COALESCE(resolved_at, now())
FROM public.shops s WHERE s.id=c.shop_id AND c.status='open' AND c.stage='installation'
  AND NOT EXISTS (SELECT 1 FROM public.field_review_decisions d WHERE d.stage='installation' AND d.decision='redo' AND d.shop_id=c.shop_id);

-- ---------- 8. cleanup: shops that are already past review must not sit in "Pending" ----------
UPDATE public.installation_jobs j SET review_status='approved', reviewed_at=COALESCE(j.reviewed_at, now())
FROM public.shops s WHERE s.id=j.shop_id AND j.review_status='pending' AND s.status IN ('installed','billed');
UPDATE public.surveys v SET status='approved', reviewed_at=COALESCE(v.reviewed_at, now())
FROM public.shops s WHERE s.id=v.shop_id AND v.status='submitted' AND s.status IN
 ('design_pending','designing','design_ready','in_review','design_approved','production_pending','in_production','production_ready','production_hold','production_done','dispatched','installation_pending','installing','installation_review','installed','billed');
