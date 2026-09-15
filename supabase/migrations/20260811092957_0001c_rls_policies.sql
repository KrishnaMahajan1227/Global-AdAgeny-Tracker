/*
# RLS Policies — All Tables
   Every table has 4 policies (SELECT/INSERT/UPDATE/DELETE) scoped by organization_id.
   Organization scoping uses public.current_org_id() which reads the user's profile.
   Role-based restrictions are layered on top for tables that need them.
*/

-- PROFILES: users can read everyone in their org; only owner can insert/update/delete
DROP POLICY IF EXISTS "profiles_select" ON public.profiles;
CREATE POLICY "profiles_select" ON public.profiles FOR SELECT
  TO authenticated USING (organization_id = public.current_org_id() OR id = auth.uid());

DROP POLICY IF EXISTS "profiles_insert" ON public.profiles;
CREATE POLICY "profiles_insert" ON public.profiles FOR INSERT
  TO authenticated WITH CHECK (public.current_role() = 'agency_owner');

DROP POLICY IF EXISTS "profiles_update" ON public.profiles;
CREATE POLICY "profiles_update" ON public.profiles FOR UPDATE
  TO authenticated USING (id = auth.uid() OR public.current_role() = 'agency_owner')
  WITH CHECK (id = auth.uid() OR public.current_role() = 'agency_owner');

DROP POLICY IF EXISTS "profiles_delete" ON public.profiles;
CREATE POLICY "profiles_delete" ON public.profiles FOR DELETE
  TO authenticated USING (public.current_role() = 'agency_owner');

-- ORGANIZATIONS: read for members; update only by owner
DROP POLICY IF EXISTS "orgs_select" ON public.organizations;
CREATE POLICY "orgs_select" ON public.organizations FOR SELECT
  TO authenticated USING (id = public.current_org_id());

DROP POLICY IF EXISTS "orgs_update" ON public.organizations;
CREATE POLICY "orgs_update" ON public.organizations FOR UPDATE
  TO authenticated USING (id = public.current_org_id() AND public.current_role() = 'agency_owner')
  WITH CHECK (id = public.current_org_id() AND public.current_role() = 'agency_owner');

DROP POLICY IF EXISTS "orgs_insert" ON public.organizations;
CREATE POLICY "orgs_insert" ON public.organizations FOR INSERT
  TO authenticated WITH CHECK (public.current_role() = 'agency_owner');

DROP POLICY IF EXISTS "orgs_delete" ON public.organizations;
CREATE POLICY "orgs_delete" ON public.organizations FOR DELETE
  TO authenticated USING (public.current_role() = 'agency_owner');

-- Generic org-scoped policy generator pattern applied to all business tables:
-- SELECT/INSERT/UPDATE/DELETE all require organization_id = current_org_id()
-- Inserts/Updates also set WITH CHECK to same condition.
-- Owner/Admin/Demo get full CRUD; field roles get scoped access per their assignments.

-- CLIENTS
DROP POLICY IF EXISTS "clients_select" ON public.clients;
CREATE POLICY "clients_select" ON public.clients FOR SELECT
  TO authenticated USING (organization_id = public.current_org_id());

DROP POLICY IF EXISTS "clients_insert" ON public.clients;
CREATE POLICY "clients_insert" ON public.clients FOR INSERT
  TO authenticated WITH CHECK (organization_id = public.current_org_id());

DROP POLICY IF EXISTS "clients_update" ON public.clients;
CREATE POLICY "clients_update" ON public.clients FOR UPDATE
  TO authenticated USING (organization_id = public.current_org_id())
  WITH CHECK (organization_id = public.current_org_id());

DROP POLICY IF EXISTS "clients_delete" ON public.clients;
CREATE POLICY "clients_delete" ON public.clients FOR DELETE
  TO authenticated USING (organization_id = public.current_org_id() AND public.current_role() IN ('agency_owner','admin'));

-- PROJECTS
DROP POLICY IF EXISTS "projects_select" ON public.projects;
CREATE POLICY "projects_select" ON public.projects FOR SELECT
  TO authenticated USING (organization_id = public.current_org_id());

DROP POLICY IF EXISTS "projects_insert" ON public.projects;
CREATE POLICY "projects_insert" ON public.projects FOR INSERT
  TO authenticated WITH CHECK (organization_id = public.current_org_id());

DROP POLICY IF EXISTS "projects_update" ON public.projects;
CREATE POLICY "projects_update" ON public.projects FOR UPDATE
  TO authenticated USING (organization_id = public.current_org_id())
  WITH CHECK (organization_id = public.current_org_id());

DROP POLICY IF EXISTS "projects_delete" ON public.projects;
CREATE POLICY "projects_delete" ON public.projects FOR DELETE
  TO authenticated USING (organization_id = public.current_org_id() AND public.current_role() IN ('agency_owner','admin'));

-- WORK TYPES
DROP POLICY IF EXISTS "work_types_select" ON public.work_types;
CREATE POLICY "work_types_select" ON public.work_types FOR SELECT
  TO authenticated USING (organization_id = public.current_org_id());

DROP POLICY IF EXISTS "work_types_insert" ON public.work_types;
CREATE POLICY "work_types_insert" ON public.work_types FOR INSERT
  TO authenticated WITH CHECK (organization_id = public.current_org_id() AND public.current_role() IN ('agency_owner','admin'));

DROP POLICY IF EXISTS "work_types_update" ON public.work_types;
CREATE POLICY "work_types_update" ON public.work_types FOR UPDATE
  TO authenticated USING (organization_id = public.current_org_id())
  WITH CHECK (organization_id = public.current_org_id());

DROP POLICY IF EXISTS "work_types_delete" ON public.work_types;
CREATE POLICY "work_types_delete" ON public.work_types FOR DELETE
  TO authenticated USING (organization_id = public.current_org_id() AND public.current_role() IN ('agency_owner','admin'));

-- SHOPS
DROP POLICY IF EXISTS "shops_select" ON public.shops;
CREATE POLICY "shops_select" ON public.shops FOR SELECT
  TO authenticated USING (organization_id = public.current_org_id());

DROP POLICY IF EXISTS "shops_insert" ON public.shops;
CREATE POLICY "shops_insert" ON public.shops FOR INSERT
  TO authenticated WITH CHECK (organization_id = public.current_org_id());

DROP POLICY IF EXISTS "shops_update" ON public.shops;
CREATE POLICY "shops_update" ON public.shops FOR UPDATE
  TO authenticated USING (organization_id = public.current_org_id())
  WITH CHECK (organization_id = public.current_org_id());

DROP POLICY IF EXISTS "shops_delete" ON public.shops;
CREATE POLICY "shops_delete" ON public.shops FOR DELETE
  TO authenticated USING (organization_id = public.current_org_id() AND public.current_role() IN ('agency_owner','admin'));

-- SHOP ASSIGNMENTS
DROP POLICY IF EXISTS "shop_assign_select" ON public.shop_assignments;
CREATE POLICY "shop_assign_select" ON public.shop_assignments FOR SELECT
  TO authenticated USING (organization_id = public.current_org_id());

DROP POLICY IF EXISTS "shop_assign_insert" ON public.shop_assignments;
CREATE POLICY "shop_assign_insert" ON public.shop_assignments FOR INSERT
  TO authenticated WITH CHECK (organization_id = public.current_org_id());

DROP POLICY IF EXISTS "shop_assign_update" ON public.shop_assignments;
CREATE POLICY "shop_assign_update" ON public.shop_assignments FOR UPDATE
  TO authenticated USING (organization_id = public.current_org_id() OR user_id = auth.uid())
  WITH CHECK (organization_id = public.current_org_id());

DROP POLICY IF EXISTS "shop_assign_delete" ON public.shop_assignments;
CREATE POLICY "shop_assign_delete" ON public.shop_assignments FOR DELETE
  TO authenticated USING (organization_id = public.current_org_id() AND public.current_role() IN ('agency_owner','admin'));

-- ROUTES
DROP POLICY IF EXISTS "routes_select" ON public.routes;
CREATE POLICY "routes_select" ON public.routes FOR SELECT
  TO authenticated USING (organization_id = public.current_org_id());

DROP POLICY IF EXISTS "routes_insert" ON public.routes;
CREATE POLICY "routes_insert" ON public.routes FOR INSERT
  TO authenticated WITH CHECK (organization_id = public.current_org_id());

DROP POLICY IF EXISTS "routes_update" ON public.routes;
CREATE POLICY "routes_update" ON public.routes FOR UPDATE
  TO authenticated USING (organization_id = public.current_org_id())
  WITH CHECK (organization_id = public.current_org_id());

DROP POLICY IF EXISTS "routes_delete" ON public.routes;
CREATE POLICY "routes_delete" ON public.routes FOR DELETE
  TO authenticated USING (organization_id = public.current_org_id());

-- ROUTE STOPS
DROP POLICY IF EXISTS "route_stops_select" ON public.route_stops;
CREATE POLICY "route_stops_select" ON public.route_stops FOR SELECT
  TO authenticated USING (organization_id = public.current_org_id());

DROP POLICY IF EXISTS "route_stops_insert" ON public.route_stops;
CREATE POLICY "route_stops_insert" ON public.route_stops FOR INSERT
  TO authenticated WITH CHECK (organization_id = public.current_org_id());

DROP POLICY IF EXISTS "route_stops_update" ON public.route_stops;
CREATE POLICY "route_stops_update" ON public.route_stops FOR UPDATE
  TO authenticated USING (organization_id = public.current_org_id())
  WITH CHECK (organization_id = public.current_org_id());

DROP POLICY IF EXISTS "route_stops_delete" ON public.route_stops;
CREATE POLICY "route_stops_delete" ON public.route_stops FOR DELETE
  TO authenticated USING (organization_id = public.current_org_id());

-- SURVEYS
DROP POLICY IF EXISTS "surveys_select" ON public.surveys;
CREATE POLICY "surveys_select" ON public.surveys FOR SELECT
  TO authenticated USING (organization_id = public.current_org_id());

DROP POLICY IF EXISTS "surveys_insert" ON public.surveys;
CREATE POLICY "surveys_insert" ON public.surveys FOR INSERT
  TO authenticated WITH CHECK (organization_id = public.current_org_id());

DROP POLICY IF EXISTS "surveys_update" ON public.surveys;
CREATE POLICY "surveys_update" ON public.surveys FOR UPDATE
  TO authenticated USING (organization_id = public.current_org_id())
  WITH CHECK (organization_id = public.current_org_id());

DROP POLICY IF EXISTS "surveys_delete" ON public.surveys;
CREATE POLICY "surveys_delete" ON public.surveys FOR DELETE
  TO authenticated USING (organization_id = public.current_org_id() AND public.current_role() IN ('agency_owner','admin'));

-- SURVEY PHOTOS
DROP POLICY IF EXISTS "survey_photos_select" ON public.survey_photos;
CREATE POLICY "survey_photos_select" ON public.survey_photos FOR SELECT
  TO authenticated USING (organization_id = public.current_org_id());

DROP POLICY IF EXISTS "survey_photos_insert" ON public.survey_photos;
CREATE POLICY "survey_photos_insert" ON public.survey_photos FOR INSERT
  TO authenticated WITH CHECK (organization_id = public.current_org_id());

DROP POLICY IF EXISTS "survey_photos_update" ON public.survey_photos;
CREATE POLICY "survey_photos_update" ON public.survey_photos FOR UPDATE
  TO authenticated USING (organization_id = public.current_org_id())
  WITH CHECK (organization_id = public.current_org_id());

DROP POLICY IF EXISTS "survey_photos_delete" ON public.survey_photos;
CREATE POLICY "survey_photos_delete" ON public.survey_photos FOR DELETE
  TO authenticated USING (organization_id = public.current_org_id());

-- BOARD MARKINGS
DROP POLICY IF EXISTS "board_markings_select" ON public.board_markings;
CREATE POLICY "board_markings_select" ON public.board_markings FOR SELECT
  TO authenticated USING (organization_id = public.current_org_id());

DROP POLICY IF EXISTS "board_markings_insert" ON public.board_markings;
CREATE POLICY "board_markings_insert" ON public.board_markings FOR INSERT
  TO authenticated WITH CHECK (organization_id = public.current_org_id());

DROP POLICY IF EXISTS "board_markings_update" ON public.board_markings;
CREATE POLICY "board_markings_update" ON public.board_markings FOR UPDATE
  TO authenticated USING (organization_id = public.current_org_id())
  WITH CHECK (organization_id = public.current_org_id());

DROP POLICY IF EXISTS "board_markings_delete" ON public.board_markings;
CREATE POLICY "board_markings_delete" ON public.board_markings FOR DELETE
  TO authenticated USING (organization_id = public.current_org_id());

-- WORK ITEMS
DROP POLICY IF EXISTS "work_items_select" ON public.work_items;
CREATE POLICY "work_items_select" ON public.work_items FOR SELECT
  TO authenticated USING (organization_id = public.current_org_id());

DROP POLICY IF EXISTS "work_items_insert" ON public.work_items;
CREATE POLICY "work_items_insert" ON public.work_items FOR INSERT
  TO authenticated WITH CHECK (organization_id = public.current_org_id());

DROP POLICY IF EXISTS "work_items_update" ON public.work_items;
CREATE POLICY "work_items_update" ON public.work_items FOR UPDATE
  TO authenticated USING (organization_id = public.current_org_id())
  WITH CHECK (organization_id = public.current_org_id());

DROP POLICY IF EXISTS "work_items_delete" ON public.work_items;
CREATE POLICY "work_items_delete" ON public.work_items FOR DELETE
  TO authenticated USING (organization_id = public.current_org_id() AND public.current_role() IN ('agency_owner','admin'));

-- APPROVALS
DROP POLICY IF EXISTS "approvals_select" ON public.approvals;
CREATE POLICY "approvals_select" ON public.approvals FOR SELECT
  TO authenticated USING (organization_id = public.current_org_id());

DROP POLICY IF EXISTS "approvals_insert" ON public.approvals;
CREATE POLICY "approvals_insert" ON public.approvals FOR INSERT
  TO authenticated WITH CHECK (organization_id = public.current_org_id());

DROP POLICY IF EXISTS "approvals_update" ON public.approvals;
CREATE POLICY "approvals_update" ON public.approvals FOR UPDATE
  TO authenticated USING (organization_id = public.current_org_id())
  WITH CHECK (organization_id = public.current_org_id());

DROP POLICY IF EXISTS "approvals_delete" ON public.approvals;
CREATE POLICY "approvals_delete" ON public.approvals FOR DELETE
  TO authenticated USING (organization_id = public.current_org_id());

-- DESIGN TASKS
DROP POLICY IF EXISTS "design_tasks_select" ON public.design_tasks;
CREATE POLICY "design_tasks_select" ON public.design_tasks FOR SELECT
  TO authenticated USING (organization_id = public.current_org_id());

DROP POLICY IF EXISTS "design_tasks_insert" ON public.design_tasks;
CREATE POLICY "design_tasks_insert" ON public.design_tasks FOR INSERT
  TO authenticated WITH CHECK (organization_id = public.current_org_id());

DROP POLICY IF EXISTS "design_tasks_update" ON public.design_tasks;
CREATE POLICY "design_tasks_update" ON public.design_tasks FOR UPDATE
  TO authenticated USING (organization_id = public.current_org_id())
  WITH CHECK (organization_id = public.current_org_id());

DROP POLICY IF EXISTS "design_tasks_delete" ON public.design_tasks;
CREATE POLICY "design_tasks_delete" ON public.design_tasks FOR DELETE
  TO authenticated USING (organization_id = public.current_org_id());

-- DESIGN VERSIONS
DROP POLICY IF EXISTS "design_versions_select" ON public.design_versions;
CREATE POLICY "design_versions_select" ON public.design_versions FOR SELECT
  TO authenticated USING (organization_id = public.current_org_id());

DROP POLICY IF EXISTS "design_versions_insert" ON public.design_versions;
CREATE POLICY "design_versions_insert" ON public.design_versions FOR INSERT
  TO authenticated WITH CHECK (organization_id = public.current_org_id());

DROP POLICY IF EXISTS "design_versions_update" ON public.design_versions;
CREATE POLICY "design_versions_update" ON public.design_versions FOR UPDATE
  TO authenticated USING (organization_id = public.current_org_id())
  WITH CHECK (organization_id = public.current_org_id());

DROP POLICY IF EXISTS "design_versions_delete" ON public.design_versions;
CREATE POLICY "design_versions_delete" ON public.design_versions FOR DELETE
  TO authenticated USING (organization_id = public.current_org_id());

-- PRODUCTION ORDERS
DROP POLICY IF EXISTS "production_orders_select" ON public.production_orders;
CREATE POLICY "production_orders_select" ON public.production_orders FOR SELECT
  TO authenticated USING (organization_id = public.current_org_id());

DROP POLICY IF EXISTS "production_orders_insert" ON public.production_orders;
CREATE POLICY "production_orders_insert" ON public.production_orders FOR INSERT
  TO authenticated WITH CHECK (organization_id = public.current_org_id());

DROP POLICY IF EXISTS "production_orders_update" ON public.production_orders;
CREATE POLICY "production_orders_update" ON public.production_orders FOR UPDATE
  TO authenticated USING (organization_id = public.current_org_id())
  WITH CHECK (organization_id = public.current_org_id());

DROP POLICY IF EXISTS "production_orders_delete" ON public.production_orders;
CREATE POLICY "production_orders_delete" ON public.production_orders FOR DELETE
  TO authenticated USING (organization_id = public.current_org_id());

-- PRODUCTION ITEMS
DROP POLICY IF EXISTS "production_items_select" ON public.production_items;
CREATE POLICY "production_items_select" ON public.production_items FOR SELECT
  TO authenticated USING (organization_id = public.current_org_id());

DROP POLICY IF EXISTS "production_items_insert" ON public.production_items;
CREATE POLICY "production_items_insert" ON public.production_items FOR INSERT
  TO authenticated WITH CHECK (organization_id = public.current_org_id());

DROP POLICY IF EXISTS "production_items_update" ON public.production_items;
CREATE POLICY "production_items_update" ON public.production_items FOR UPDATE
  TO authenticated USING (organization_id = public.current_org_id())
  WITH CHECK (organization_id = public.current_org_id());

DROP POLICY IF EXISTS "production_items_delete" ON public.production_items;
CREATE POLICY "production_items_delete" ON public.production_items FOR DELETE
  TO authenticated USING (organization_id = public.current_org_id());

-- INSTALLATION JOBS
DROP POLICY IF EXISTS "installation_jobs_select" ON public.installation_jobs;
CREATE POLICY "installation_jobs_select" ON public.installation_jobs FOR SELECT
  TO authenticated USING (organization_id = public.current_org_id());

DROP POLICY IF EXISTS "installation_jobs_insert" ON public.installation_jobs;
CREATE POLICY "installation_jobs_insert" ON public.installation_jobs FOR INSERT
  TO authenticated WITH CHECK (organization_id = public.current_org_id());

DROP POLICY IF EXISTS "installation_jobs_update" ON public.installation_jobs;
CREATE POLICY "installation_jobs_update" ON public.installation_jobs FOR UPDATE
  TO authenticated USING (organization_id = public.current_org_id())
  WITH CHECK (organization_id = public.current_org_id());

DROP POLICY IF EXISTS "installation_jobs_delete" ON public.installation_jobs;
CREATE POLICY "installation_jobs_delete" ON public.installation_jobs FOR DELETE
  TO authenticated USING (organization_id = public.current_org_id());

-- INSTALLATION PROOFS
DROP POLICY IF EXISTS "installation_proofs_select" ON public.installation_proofs;
CREATE POLICY "installation_proofs_select" ON public.installation_proofs FOR SELECT
  TO authenticated USING (organization_id = public.current_org_id());

DROP POLICY IF EXISTS "installation_proofs_insert" ON public.installation_proofs;
CREATE POLICY "installation_proofs_insert" ON public.installation_proofs FOR INSERT
  TO authenticated WITH CHECK (organization_id = public.current_org_id());

DROP POLICY IF EXISTS "installation_proofs_update" ON public.installation_proofs;
CREATE POLICY "installation_proofs_update" ON public.installation_proofs FOR UPDATE
  TO authenticated USING (organization_id = public.current_org_id())
  WITH CHECK (organization_id = public.current_org_id());

DROP POLICY IF EXISTS "installation_proofs_delete" ON public.installation_proofs;
CREATE POLICY "installation_proofs_delete" ON public.installation_proofs FOR DELETE
  TO authenticated USING (organization_id = public.current_org_id());

-- RATE CARDS
DROP POLICY IF EXISTS "rate_cards_select" ON public.rate_cards;
CREATE POLICY "rate_cards_select" ON public.rate_cards FOR SELECT
  TO authenticated USING (organization_id = public.current_org_id());

DROP POLICY IF EXISTS "rate_cards_insert" ON public.rate_cards;
CREATE POLICY "rate_cards_insert" ON public.rate_cards FOR INSERT
  TO authenticated WITH CHECK (organization_id = public.current_org_id() AND public.current_role() IN ('agency_owner','admin','accounts'));

DROP POLICY IF EXISTS "rate_cards_update" ON public.rate_cards;
CREATE POLICY "rate_cards_update" ON public.rate_cards FOR UPDATE
  TO authenticated USING (organization_id = public.current_org_id())
  WITH CHECK (organization_id = public.current_org_id());

DROP POLICY IF EXISTS "rate_cards_delete" ON public.rate_cards;
CREATE POLICY "rate_cards_delete" ON public.rate_cards FOR DELETE
  TO authenticated USING (organization_id = public.current_org_id() AND public.current_role() IN ('agency_owner','admin','accounts'));

-- INVOICES
DROP POLICY IF EXISTS "invoices_select" ON public.invoices;
CREATE POLICY "invoices_select" ON public.invoices FOR SELECT
  TO authenticated USING (organization_id = public.current_org_id());

DROP POLICY IF EXISTS "invoices_insert" ON public.invoices;
CREATE POLICY "invoices_insert" ON public.invoices FOR INSERT
  TO authenticated WITH CHECK (organization_id = public.current_org_id() AND public.current_role() IN ('agency_owner','admin','accounts'));

DROP POLICY IF EXISTS "invoices_update" ON public.invoices;
CREATE POLICY "invoices_update" ON public.invoices FOR UPDATE
  TO authenticated USING (organization_id = public.current_org_id() AND public.current_role() IN ('agency_owner','admin','accounts'))
  WITH CHECK (organization_id = public.current_org_id());

DROP POLICY IF EXISTS "invoices_delete" ON public.invoices;
CREATE POLICY "invoices_delete" ON public.invoices FOR DELETE
  TO authenticated USING (organization_id = public.current_org_id() AND public.current_role() IN ('agency_owner','admin','accounts'));

-- INVOICE ITEMS
DROP POLICY IF EXISTS "invoice_items_select" ON public.invoice_items;
CREATE POLICY "invoice_items_select" ON public.invoice_items FOR SELECT
  TO authenticated USING (organization_id = public.current_org_id());

DROP POLICY IF EXISTS "invoice_items_insert" ON public.invoice_items;
CREATE POLICY "invoice_items_insert" ON public.invoice_items FOR INSERT
  TO authenticated WITH CHECK (organization_id = public.current_org_id() AND public.current_role() IN ('agency_owner','admin','accounts'));

DROP POLICY IF EXISTS "invoice_items_update" ON public.invoice_items;
CREATE POLICY "invoice_items_update" ON public.invoice_items FOR UPDATE
  TO authenticated USING (organization_id = public.current_org_id() AND public.current_role() IN ('agency_owner','admin','accounts'))
  WITH CHECK (organization_id = public.current_org_id());

DROP POLICY IF EXISTS "invoice_items_delete" ON public.invoice_items;
CREATE POLICY "invoice_items_delete" ON public.invoice_items FOR DELETE
  TO authenticated USING (organization_id = public.current_org_id() AND public.current_role() IN ('agency_owner','admin','accounts'));

-- WORKER LOCATIONS: writable only by the worker themselves; readable by admin/owner
DROP POLICY IF EXISTS "worker_locations_select" ON public.worker_locations;
CREATE POLICY "worker_locations_select" ON public.worker_locations FOR SELECT
  TO authenticated USING (organization_id = public.current_org_id() AND (user_id = auth.uid() OR public.current_role() IN ('agency_owner','admin','demo')));

DROP POLICY IF EXISTS "worker_locations_insert" ON public.worker_locations;
CREATE POLICY "worker_locations_insert" ON public.worker_locations FOR INSERT
  TO authenticated WITH CHECK (organization_id = public.current_org_id() AND user_id = auth.uid());

DROP POLICY IF EXISTS "worker_locations_update" ON public.worker_locations;
CREATE POLICY "worker_locations_update" ON public.worker_locations FOR UPDATE
  TO authenticated USING (organization_id = public.current_org_id() AND user_id = auth.uid())
  WITH CHECK (organization_id = public.current_org_id());

DROP POLICY IF EXISTS "worker_locations_delete" ON public.worker_locations;
CREATE POLICY "worker_locations_delete" ON public.worker_locations FOR DELETE
  TO authenticated USING (organization_id = public.current_org_id() AND user_id = auth.uid());

-- AUDIT LOGS: readable by owner/admin; insertable by any authenticated user (via app)
DROP POLICY IF EXISTS "audit_logs_select" ON public.audit_logs;
CREATE POLICY "audit_logs_select" ON public.audit_logs FOR SELECT
  TO authenticated USING (organization_id = public.current_org_id() AND public.current_role() IN ('agency_owner','admin','demo'));

DROP POLICY IF EXISTS "audit_logs_insert" ON public.audit_logs;
CREATE POLICY "audit_logs_insert" ON public.audit_logs FOR INSERT
  TO authenticated WITH CHECK (organization_id = public.current_org_id());

DROP POLICY IF EXISTS "audit_logs_update" ON public.audit_logs;
CREATE POLICY "audit_logs_update" ON public.audit_logs FOR UPDATE
  TO authenticated USING (organization_id = public.current_org_id() AND public.current_role() = 'agency_owner')
  WITH CHECK (organization_id = public.current_org_id());

DROP POLICY IF EXISTS "audit_logs_delete" ON public.audit_logs;
CREATE POLICY "audit_logs_delete" ON public.audit_logs FOR DELETE
  TO authenticated USING (organization_id = public.current_org_id() AND public.current_role() = 'agency_owner');

-- NOTIFICATIONS
DROP POLICY IF EXISTS "notifications_select" ON public.notifications;
CREATE POLICY "notifications_select" ON public.notifications FOR SELECT
  TO authenticated USING (organization_id = public.current_org_id() AND user_id = auth.uid());

DROP POLICY IF EXISTS "notifications_insert" ON public.notifications;
CREATE POLICY "notifications_insert" ON public.notifications FOR INSERT
  TO authenticated WITH CHECK (organization_id = public.current_org_id());

DROP POLICY IF EXISTS "notifications_update" ON public.notifications;
CREATE POLICY "notifications_update" ON public.notifications FOR UPDATE
  TO authenticated USING (organization_id = public.current_org_id() AND user_id = auth.uid())
  WITH CHECK (organization_id = public.current_org_id());

DROP POLICY IF EXISTS "notifications_delete" ON public.notifications;
CREATE POLICY "notifications_delete" ON public.notifications FOR DELETE
  TO authenticated USING (organization_id = public.current_org_id() AND user_id = auth.uid());