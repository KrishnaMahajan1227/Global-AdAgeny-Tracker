/*
# Phase 1 — Global Client + Agency platform (foundation layer)

  Implements the data-model half of GLOBAL_ARCHITECTURE.md. Nothing in this
  migration touches the existing agency-internal `clients` table, the
  survey → design → production → installation → billing pipeline, or the
  two PO fulfillment types (`survey_install` / `supply_only`) — those keep
  working exactly as they do today for every existing agency. This
  migration only ADDS the ability for a second kind of tenant — a Client
  Organization — to log in, link itself to one or more Agency
  Organizations, and create a PO that an agency then accepts into its
  normal pipeline.

  IMPORTANT distinction (do not confuse the two "client" concepts):
  - `clients` table = an agency's own internal customer record (unchanged,
    e.g. "Acme Retail" as entered by the agency). This is what
    `purchase_orders.client_id` still points to.
  - `organizations` with `org_type = 'client'` (new) = an actual platform
    tenant with its own login, its own users, that can see across
    multiple agencies. This is what `purchase_orders.client_org_id`
    (new, nullable) points to. A client-org PO is *also* still required
    to carry a normal `client_id` — see backfill note below.

  Scope of this migration:
   1. organizations.org_type ('agency' | 'client')
   2. profiles.role gains 'client_admin' and 'client_viewer'
   3. client_agency_links — many-to-many link/invite table between a
      Client Organization and one or more Agency Organizations
   4. purchase_orders gains origin / client_org_id / assigned_agency_id /
      assignment_status, with a same-migration backfill so every existing
      PO is marked origin='agency_created', assigned_agency_id = its own
      organization_id, assignment_status='accepted' — i.e. behaves exactly
      as before for every agency already using the product.
   5. current_org_type() helper
   6. RLS: purchase_orders / po_line_items / shops / invoices /
      invoice_items gain an additional (OR'd, additive) branch so a
      logged-in client-org user can read — never write except where noted
      — the rows belonging to POs they are the client_org_id of. Every
      existing agency-side policy branch is untouched.

  Explicitly OUT of scope for this migration (next steps, done
  incrementally as agreed — "step by step"):
   - Client-side UI screens (Overview / Campaigns list / Map Feed /
     Billing / Agencies) — Phase 2+.
   - Agency-side "Client Requests" inbox screen — Phase 2.
   - Invite-flow RPC (client invites agency / agency invites client) —
     Phase 2. For now client_agency_links rows can be inserted directly
     by an agency_owner/admin (agency-initiated) or by a client_admin
     (client-initiated invite), both landing in 'invited' status.
*/

-- ============ 1. organizations.org_type ============
ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS org_type text NOT NULL DEFAULT 'agency'
    CHECK (org_type IN ('agency','client'));

-- ============ 2. profiles.role — add client_admin / client_viewer ============
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_role_check;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_role_check
  CHECK (role IN (
    'agency_owner','admin','client_manager','surveyor','designer','printing',
    'installer','accounts','demo',
    'client_admin','client_viewer'
  ));

-- ============ 3. client_agency_links ============
CREATE TABLE IF NOT EXISTS public.client_agency_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  agency_org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited','active','paused','revoked')),
  invited_by uuid REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.client_agency_links ENABLE ROW LEVEL SECURITY;

CREATE UNIQUE INDEX IF NOT EXISTS uq_client_agency_links_pair
  ON public.client_agency_links(client_org_id, agency_org_id);
CREATE INDEX IF NOT EXISTS idx_client_agency_links_client ON public.client_agency_links(client_org_id);
CREATE INDEX IF NOT EXISTS idx_client_agency_links_agency ON public.client_agency_links(agency_org_id);

-- ============ helper: current_org_type() ============
CREATE OR REPLACE FUNCTION public.current_org_type()
RETURNS text
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT o.org_type FROM public.organizations o
  JOIN public.profiles p ON p.organization_id = o.id
  WHERE p.id = auth.uid();
$$;

-- ============ helper: is_active_link(client_org, agency_org) ============
CREATE OR REPLACE FUNCTION public.is_active_client_agency_link(p_client_org_id uuid, p_agency_org_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.client_agency_links
    WHERE client_org_id = p_client_org_id
      AND agency_org_id = p_agency_org_id
      AND status = 'active'
  );
$$;

-- ============ RLS: client_agency_links ============
-- Both sides of a link can see it; only the org that owns each side can
-- write its own rows (an agency creates/accepts links landing on its own
-- agency_org_id, a client does the same for its own client_org_id).
DROP POLICY IF EXISTS "client_agency_links_select" ON public.client_agency_links;
CREATE POLICY "client_agency_links_select" ON public.client_agency_links FOR SELECT
  TO authenticated USING (
    client_org_id = public.current_org_id() OR agency_org_id = public.current_org_id()
  );

DROP POLICY IF EXISTS "client_agency_links_insert" ON public.client_agency_links;
CREATE POLICY "client_agency_links_insert" ON public.client_agency_links FOR INSERT
  TO authenticated WITH CHECK (
    (client_org_id = public.current_org_id() AND public.current_org_type() = 'client'
      AND public.current_role() IN ('client_admin'))
    OR
    (agency_org_id = public.current_org_id() AND public.current_org_type() = 'agency'
      AND public.current_role() IN ('agency_owner','admin'))
  );

DROP POLICY IF EXISTS "client_agency_links_update" ON public.client_agency_links;
CREATE POLICY "client_agency_links_update" ON public.client_agency_links FOR UPDATE
  TO authenticated USING (
    (client_org_id = public.current_org_id() AND public.current_role() IN ('client_admin'))
    OR
    (agency_org_id = public.current_org_id() AND public.current_role() IN ('agency_owner','admin'))
  )
  WITH CHECK (
    (client_org_id = public.current_org_id() AND public.current_role() IN ('client_admin'))
    OR
    (agency_org_id = public.current_org_id() AND public.current_role() IN ('agency_owner','admin'))
  );

-- ============ 4. purchase_orders — cross-org fields ============
ALTER TABLE public.purchase_orders
  ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'agency_created'
    CHECK (origin IN ('client_created','agency_created')),
  ADD COLUMN IF NOT EXISTS client_org_id uuid REFERENCES public.organizations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS assigned_agency_id uuid REFERENCES public.organizations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS assignment_status text NOT NULL DEFAULT 'accepted'
    CHECK (assignment_status IN ('pending_acceptance','accepted','rejected','in_progress','completed'));

-- Backfill: every PO that already exists was agency-created and is its
-- own "assigned agency" — this is what keeps every current agency's
-- pipeline behaving identically after this migration.
UPDATE public.purchase_orders
SET assigned_agency_id = organization_id
WHERE assigned_agency_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_purchase_orders_client_org ON public.purchase_orders(client_org_id);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_assigned_agency ON public.purchase_orders(assigned_agency_id);

-- ============ RLS: purchase_orders — add client-org branches ============
-- Agency-side branch (existing behaviour, incl. 0033's client_manager
-- scoping) is left completely untouched — it is simply OR'd with a new
-- client-org branch below.
DROP POLICY IF EXISTS "purchase_orders_select" ON public.purchase_orders;
CREATE POLICY "purchase_orders_select" ON public.purchase_orders FOR SELECT
  TO authenticated USING (
    (
      organization_id = public.current_org_id()
      AND public.current_role() IN ('agency_owner','admin','accounts','client_manager')
      AND (
        public.current_role() <> 'client_manager'
        OR public.current_client_id() IS NULL
        OR client_id = public.current_client_id()
      )
    )
    OR
    (
      public.current_org_type() = 'client'
      AND client_org_id = public.current_org_id()
    )
  );

-- Agency-created POs: unchanged, still inserted with organization_id =
-- the agency's own org and origin defaults to 'agency_created'.
DROP POLICY IF EXISTS "purchase_orders_insert" ON public.purchase_orders;
CREATE POLICY "purchase_orders_insert" ON public.purchase_orders FOR INSERT
  TO authenticated WITH CHECK (
    (
      organization_id = public.current_org_id()
      AND public.current_org_type() = 'agency'
    )
    OR
    (
      -- Client-created PO: row must land inside the target agency's org
      -- (so the normal pipeline RLS on shops/work_items/etc picks it up
      -- exactly like any agency-created PO), but only a client_admin
      -- from a currently-active linked client org can create it, and it
      -- must start life waiting for that agency to accept it.
      public.current_org_type() = 'client'
      AND public.current_role() = 'client_admin'
      AND client_org_id = public.current_org_id()
      AND origin = 'client_created'
      AND assignment_status = 'pending_acceptance'
      AND organization_id = assigned_agency_id
      AND public.is_active_client_agency_link(client_org_id, assigned_agency_id)
    )
  );

-- Agency-side update: unchanged (covers accept/reject of a client PO too,
-- since the row's organization_id already equals the agency's own org).
DROP POLICY IF EXISTS "purchase_orders_update" ON public.purchase_orders;
CREATE POLICY "purchase_orders_update" ON public.purchase_orders FOR UPDATE
  TO authenticated USING (organization_id = public.current_org_id() AND public.current_org_type() = 'agency')
  WITH CHECK (organization_id = public.current_org_id() AND public.current_org_type() = 'agency');

-- Client-side update: a client_admin may only edit/cancel their own PO
-- while it is still waiting on the agency (before acceptance) — once the
-- agency has accepted it, it behaves like normal operational data and is
-- agency-owned from that point.
DROP POLICY IF EXISTS "purchase_orders_client_update" ON public.purchase_orders;
CREATE POLICY "purchase_orders_client_update" ON public.purchase_orders FOR UPDATE
  TO authenticated USING (
    public.current_org_type() = 'client'
    AND public.current_role() = 'client_admin'
    AND client_org_id = public.current_org_id()
    AND assignment_status = 'pending_acceptance'
  )
  WITH CHECK (
    client_org_id = public.current_org_id()
    AND assigned_agency_id = assigned_agency_id -- no-op guard, kept explicit for readability
  );

DROP POLICY IF EXISTS "purchase_orders_delete" ON public.purchase_orders;
CREATE POLICY "purchase_orders_delete" ON public.purchase_orders FOR DELETE
  TO authenticated USING (organization_id = public.current_org_id() AND public.current_role() IN ('agency_owner','admin'));

-- ============ RLS: po_line_items — read-only client-org branch ============
DROP POLICY IF EXISTS "po_line_items_select" ON public.po_line_items;
CREATE POLICY "po_line_items_select" ON public.po_line_items FOR SELECT
  TO authenticated USING (
    (
      organization_id = public.current_org_id()
      AND public.current_role() IN ('agency_owner','admin','accounts','client_manager')
      AND (
        public.current_role() <> 'client_manager'
        OR public.current_client_id() IS NULL
        OR EXISTS (
          SELECT 1 FROM public.purchase_orders po
          WHERE po.id = po_line_items.purchase_order_id
            AND po.client_id = public.current_client_id()
        )
      )
    )
    OR
    (
      public.current_org_type() = 'client'
      AND EXISTS (
        SELECT 1 FROM public.purchase_orders po
        WHERE po.id = po_line_items.purchase_order_id
          AND po.client_org_id = public.current_org_id()
      )
    )
  );

-- ============ RLS: shops — read-only client-org branch (needed for Map Feed) ============
DROP POLICY IF EXISTS "shops_select" ON public.shops;
CREATE POLICY "shops_select" ON public.shops FOR SELECT
  TO authenticated USING (
    (
      organization_id = public.current_org_id()
      AND (
        public.current_role() <> 'client_manager'
        OR public.current_client_id() IS NULL
        OR client_id = public.current_client_id()
      )
    )
    OR
    (
      public.current_org_type() = 'client'
      AND purchase_order_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM public.purchase_orders po
        WHERE po.id = shops.purchase_order_id
          AND po.client_org_id = public.current_org_id()
      )
    )
  );

-- ============ RLS: invoices / invoice_items — read-only client-org branch ============
DROP POLICY IF EXISTS "invoices_select" ON public.invoices;
CREATE POLICY "invoices_select" ON public.invoices FOR SELECT
  TO authenticated USING (
    (
      organization_id = public.current_org_id()
      AND public.current_role() IN ('agency_owner','admin','accounts','client_manager')
      AND (
        public.current_role() <> 'client_manager'
        OR public.current_client_id() IS NULL
        OR client_id = public.current_client_id()
      )
    )
    OR
    (
      public.current_org_type() = 'client'
      AND purchase_order_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM public.purchase_orders po
        WHERE po.id = invoices.purchase_order_id
          AND po.client_org_id = public.current_org_id()
      )
    )
  );

DROP POLICY IF EXISTS "invoice_items_select" ON public.invoice_items;
CREATE POLICY "invoice_items_select" ON public.invoice_items FOR SELECT
  TO authenticated USING (
    (
      organization_id = public.current_org_id()
      AND public.current_role() IN ('agency_owner','admin','accounts','client_manager')
      AND (
        public.current_role() <> 'client_manager'
        OR public.current_client_id() IS NULL
        OR EXISTS (
          SELECT 1 FROM public.invoices inv
          WHERE inv.id = invoice_items.invoice_id
            AND inv.client_id = public.current_client_id()
        )
      )
    )
    OR
    (
      public.current_org_type() = 'client'
      AND EXISTS (
        SELECT 1 FROM public.invoices inv
        JOIN public.purchase_orders po ON po.id = inv.purchase_order_id
        WHERE inv.id = invoice_items.invoice_id
          AND po.client_org_id = public.current_org_id()
      )
    )
  );

-- ============ Realtime ============
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'client_agency_links'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.client_agency_links;
  END IF;
END $$;
