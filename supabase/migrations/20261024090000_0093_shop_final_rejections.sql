-- Explicit terminal shop rejection, never conflated with redo or cancellation.
ALTER TABLE public.shops ADD COLUMN IF NOT EXISTS rejected_reason text;
ALTER TABLE public.shops ADD COLUMN IF NOT EXISTS rejected_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL;
ALTER TABLE public.shops ADD COLUMN IF NOT EXISTS rejected_at timestamptz;
ALTER TABLE public.shops DROP CONSTRAINT IF EXISTS shops_status_check;
ALTER TABLE public.shops ADD CONSTRAINT shops_status_check CHECK (status IN (
 'pending','assigned','survey_started','surveyed','approval_pending','approved','design_pending','designing','design_ready','in_review','design_approved',
 'production_pending','in_production','production_ready','production_hold','production_done','dispatched','installation_pending','installing',
 'installation_review','installed','billed','cancelled','rejected'));
CREATE INDEX IF NOT EXISTS idx_shops_org_rejected ON public.shops(organization_id, rejected_at DESC) WHERE status='rejected';
-- Permission guard: only office owner/admin can mark a shop rejected.
CREATE OR REPLACE FUNCTION public.guard_final_shop_rejection() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
 IF NEW.status='rejected' AND OLD.status IS DISTINCT FROM 'rejected' THEN
   IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id=auth.uid() AND organization_id=NEW.organization_id AND role IN ('agency_owner','admin')) THEN
     RAISE EXCEPTION 'Only owner/admin may reject shops';
   END IF;
   IF NULLIF(trim(NEW.rejected_reason),'') IS NULL THEN RAISE EXCEPTION 'Rejection reason is required'; END IF;
   NEW.rejected_by:=auth.uid(); NEW.rejected_at:=now();
 ELSIF OLD.status='rejected' AND NEW.status IS DISTINCT FROM 'rejected' THEN
   RAISE EXCEPTION 'Final rejection cannot be undone by changing shop stage';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS guard_final_shop_rejection ON public.shops;
CREATE TRIGGER guard_final_shop_rejection BEFORE UPDATE OF status ON public.shops FOR EACH ROW EXECUTE FUNCTION public.guard_final_shop_rejection();

-- Final survey rejection: atomic shop+survey decision (distinct from redo).
CREATE OR REPLACE FUNCTION public.reject_survey_shop_final(p_survey_id uuid, p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE v_shop uuid; v_org uuid;
BEGIN
 IF NULLIF(trim(p_reason),'') IS NULL THEN RAISE EXCEPTION 'Rejection reason is required'; END IF;
 SELECT s.shop_id,s.organization_id INTO v_shop,v_org FROM public.surveys s WHERE s.id=p_survey_id AND s.status='submitted' FOR UPDATE;
 IF v_shop IS NULL THEN RAISE EXCEPTION 'Survey not found or not pending review'; END IF;
 IF NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id=auth.uid() AND p.organization_id=v_org AND p.role IN ('agency_owner','admin')) THEN RAISE EXCEPTION 'Owner/admin access required'; END IF;
 UPDATE public.shops SET status='rejected', rejected_reason=trim(p_reason), rejected_by=auth.uid(), rejected_at=now() WHERE id=v_shop AND organization_id=v_org AND status <> 'rejected';
 IF NOT FOUND THEN RAISE EXCEPTION 'Shop already rejected or unavailable'; END IF;
 UPDATE public.surveys SET status='rejected', reviewed_at=now(), reviewed_by=auth.uid(), review_note=trim(p_reason) WHERE id=p_survey_id;
END $$;
REVOKE ALL ON FUNCTION public.reject_survey_shop_final(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reject_survey_shop_final(uuid,text) TO authenticated;

-- Per-photo GPS survives offline capture and remains independently auditable in review.
ALTER TABLE public.survey_photos ADD COLUMN IF NOT EXISTS capture_lat double precision;
ALTER TABLE public.survey_photos ADD COLUMN IF NOT EXISTS capture_lng double precision;
ALTER TABLE public.survey_photos ADD COLUMN IF NOT EXISTS capture_accuracy double precision;
ALTER TABLE public.survey_photos ADD COLUMN IF NOT EXISTS captured_at timestamptz;
