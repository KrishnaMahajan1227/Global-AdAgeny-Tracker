/*
# Helper functions, triggers, and indexes
   - current_org_id(): returns org_id for the authenticated user
   - current_role(): returns role for the authenticated user
   - updated_at trigger function + triggers on tables with updated_at
   - indexes for frequently-queried columns
*/

-- HELPER FUNCTIONS (safe to re-run with CREATE OR REPLACE)
CREATE OR REPLACE FUNCTION public.current_org_id()
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT organization_id FROM public.profiles WHERE id = auth.uid();
$$;

CREATE OR REPLACE FUNCTION public.current_role()
RETURNS text
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT role FROM public.profiles WHERE id = auth.uid();
$$;

-- UPDATED_AT TRIGGER FUNCTION
CREATE OR REPLACE FUNCTION public.trigger_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DO $$ BEGIN
  CREATE TRIGGER set_updated_at_surveys
    BEFORE UPDATE ON public.surveys
    FOR EACH ROW EXECUTE FUNCTION public.trigger_set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TRIGGER set_updated_at_work_items
    BEFORE UPDATE ON public.work_items
    FOR EACH ROW EXECUTE FUNCTION public.trigger_set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TRIGGER set_updated_at_design_tasks
    BEFORE UPDATE ON public.design_tasks
    FOR EACH ROW EXECUTE FUNCTION public.trigger_set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TRIGGER set_updated_at_production_orders
    BEFORE UPDATE ON public.production_orders
    FOR EACH ROW EXECUTE FUNCTION public.trigger_set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TRIGGER set_updated_at_installation_jobs
    BEFORE UPDATE ON public.installation_jobs
    FOR EACH ROW EXECUTE FUNCTION public.trigger_set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- INDEXES
CREATE INDEX IF NOT EXISTS idx_profiles_org ON public.profiles(organization_id);
CREATE INDEX IF NOT EXISTS idx_clients_org ON public.clients(organization_id);
CREATE INDEX IF NOT EXISTS idx_projects_org ON public.projects(organization_id);
CREATE INDEX IF NOT EXISTS idx_projects_client ON public.projects(client_id);
CREATE INDEX IF NOT EXISTS idx_shops_org ON public.shops(organization_id);
CREATE INDEX IF NOT EXISTS idx_shops_client ON public.shops(client_id);
CREATE INDEX IF NOT EXISTS idx_shops_status ON public.shops(status);
CREATE INDEX IF NOT EXISTS idx_shop_assignments_shop ON public.shop_assignments(shop_id);
CREATE INDEX IF NOT EXISTS idx_shop_assignments_user ON public.shop_assignments(user_id);
CREATE INDEX IF NOT EXISTS idx_surveys_shop ON public.surveys(shop_id);
CREATE INDEX IF NOT EXISTS idx_surveys_surveyor ON public.surveys(surveyor_id);
CREATE INDEX IF NOT EXISTS idx_work_items_shop ON public.work_items(shop_id);
CREATE INDEX IF NOT EXISTS idx_work_items_status ON public.work_items(status);
CREATE INDEX IF NOT EXISTS idx_installation_jobs_installer ON public.installation_jobs(installer_id);
CREATE INDEX IF NOT EXISTS idx_worker_locations_user ON public.worker_locations(user_id);
CREATE INDEX IF NOT EXISTS idx_worker_locations_org ON public.worker_locations(organization_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_org ON public.audit_logs(organization_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON public.notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_invoices_org ON public.invoices(organization_id);
CREATE INDEX IF NOT EXISTS idx_invoices_client ON public.invoices(client_id);