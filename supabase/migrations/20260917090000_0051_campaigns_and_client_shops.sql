/*
# Phase 22 — Campaigns (a level above PO) + client-owned shop list

## Why
Per explicit correction: the client's flow should read as Campaign FIRST
(decide what campaign to run) -> PO SECOND (added under that campaign,
each PO deciding which agency it goes to) -> shops THIRD (the client
builds/uploads the shop list themselves, one by one or via Excel, and
that data travels with the PO to whichever agency it's assigned to).
Today `purchase_orders` IS the client's "campaign" — there's no level
above it. This migration adds that level without touching a single
existing agency-side table, screen, or RLS branch.

## 1. `campaigns` — client-owned, one level above PO
A campaign belongs to exactly one client org (never an agency — an
agency's own operational grouping is still just "a PO", unchanged). A PO
optionally belongs to one campaign via the new `purchase_orders.campaign_id`.
`ON DELETE SET NULL` on that FK so deleting a campaign never destroys or
orphans a PO's actual operational data — it just un-groups it.

## 2. shops — client-org write branch, mirroring po_line_items exactly
Migration 0037 already gave a client org READ access to shops on their
own POs (for the old Map Feed). This adds INSERT/UPDATE/DELETE, scoped
identically to how migration 0039 scoped `po_line_items` writes: a
client_admin may only add/edit/remove shops on a PO that (a) is their own
client_org's PO, (b) has `origin = 'client_created'`, and (c) is still
`assignment_status = 'pending_acceptance'`. The moment an agency accepts
the PO, shop management becomes agency-owned operational data like
everything else on that pipeline (same rule already applied to line
items) — the agency's own Shops screen keeps working exactly as it
always has, on top of whatever shops the client already added.

`shops.client_id` (NOT NULL, references the AGENCY's own internal
`clients` row for this client) is resolved the same way PO creation
already resolves it: `client_agency_links.agency_client_id`.

## 3. shops.village — the address-hierarchy field the client-facing form
needs (name/address/contact/zone/district/city/village) that didn't
already exist (city, district, zone, state, address all did).

## Fix note
Original version of this migration created the campaigns_select RLS
policy (which reads purchase_orders.campaign_id) BEFORE adding that
column, and failed with "column po.campaign_id does not exist" on first
apply. Section order below is corrected: table -> column -> policies.
Safe to re-run — every statement here is idempotent (IF NOT EXISTS /
DROP...IF EXISTS / CREATE OR REPLACE), so anything that already applied
from a partial run is simply skipped.
*/

-- ============ 1. campaigns ============
CREATE TABLE IF NOT EXISTS public.campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  start_date date,
  end_date date,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'cancelled')),
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.campaigns ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_campaigns_client_org ON public.campaigns(client_org_id);

-- ============ 2. purchase_orders.campaign_id ============
-- Added BEFORE the campaigns RLS policies below, since campaigns_select
-- references this column — creating the policy first would fail (and did,
-- on a first run of this migration, with "column po.campaign_id does not
-- exist"). Column first, then every policy that reads it.
ALTER TABLE public.purchase_orders
  ADD COLUMN IF NOT EXISTS campaign_id uuid REFERENCES public.campaigns(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_purchase_orders_campaign ON public.purchase_orders(campaign_id);

-- ============ 3. campaigns RLS ============
DROP POLICY IF EXISTS "campaigns_select" ON public.campaigns;
CREATE POLICY "campaigns_select" ON public.campaigns FOR SELECT
  TO authenticated USING (
    (public.current_org_type() = 'client' AND client_org_id = public.current_org_id())
    OR
    EXISTS (
      SELECT 1 FROM public.purchase_orders po
      WHERE po.campaign_id = campaigns.id AND po.organization_id = public.current_org_id()
    )
  );

DROP POLICY IF EXISTS "campaigns_insert" ON public.campaigns;
CREATE POLICY "campaigns_insert" ON public.campaigns FOR INSERT
  TO authenticated WITH CHECK (
    public.current_org_type() = 'client'
    AND public.current_role() = 'client_admin'
    AND client_org_id = public.current_org_id()
  );

DROP POLICY IF EXISTS "campaigns_update" ON public.campaigns;
CREATE POLICY "campaigns_update" ON public.campaigns FOR UPDATE
  TO authenticated USING (
    public.current_org_type() = 'client'
    AND public.current_role() = 'client_admin'
    AND client_org_id = public.current_org_id()
  )
  WITH CHECK (
    public.current_org_type() = 'client'
    AND public.current_role() = 'client_admin'
    AND client_org_id = public.current_org_id()
  );

DROP POLICY IF EXISTS "campaigns_delete" ON public.campaigns;
CREATE POLICY "campaigns_delete" ON public.campaigns FOR DELETE
  TO authenticated USING (
    public.current_org_type() = 'client'
    AND public.current_role() = 'client_admin'
    AND client_org_id = public.current_org_id()
  );

CREATE OR REPLACE FUNCTION public.set_campaigns_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_campaigns_updated_at ON public.campaigns;
CREATE TRIGGER trg_campaigns_updated_at BEFORE UPDATE ON public.campaigns
  FOR EACH ROW EXECUTE FUNCTION public.set_campaigns_updated_at();

-- ============ 4. shops.village ============
ALTER TABLE public.shops ADD COLUMN IF NOT EXISTS village text;

-- ============ 5. shops — client-org write branch (own pending PO only) ============
DROP POLICY IF EXISTS "shops_insert" ON public.shops;
CREATE POLICY "shops_insert" ON public.shops FOR INSERT
  TO authenticated WITH CHECK (
    organization_id = public.current_org_id()
    OR
    (
      public.current_org_type() = 'client'
      AND public.current_role() = 'client_admin'
      AND purchase_order_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM public.purchase_orders po
        WHERE po.id = shops.purchase_order_id
          AND po.organization_id = shops.organization_id
          AND po.client_org_id = public.current_org_id()
          AND po.origin = 'client_created'
          AND po.assignment_status = 'pending_acceptance'
      )
    )
  );

DROP POLICY IF EXISTS "shops_update" ON public.shops;
CREATE POLICY "shops_update" ON public.shops FOR UPDATE
  TO authenticated USING (
    organization_id = public.current_org_id()
    OR
    (
      public.current_org_type() = 'client'
      AND public.current_role() = 'client_admin'
      AND purchase_order_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM public.purchase_orders po
        WHERE po.id = shops.purchase_order_id
          AND po.client_org_id = public.current_org_id()
          AND po.origin = 'client_created'
          AND po.assignment_status = 'pending_acceptance'
      )
    )
  )
  WITH CHECK (
    organization_id = public.current_org_id()
    OR
    (
      public.current_org_type() = 'client'
      AND public.current_role() = 'client_admin'
      AND purchase_order_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM public.purchase_orders po
        WHERE po.id = shops.purchase_order_id
          AND po.client_org_id = public.current_org_id()
          AND po.origin = 'client_created'
          AND po.assignment_status = 'pending_acceptance'
      )
    )
  );

DROP POLICY IF EXISTS "shops_delete" ON public.shops;
CREATE POLICY "shops_delete" ON public.shops FOR DELETE
  TO authenticated USING (
    (organization_id = public.current_org_id() AND public.current_role() IN ('agency_owner','admin'))
    OR
    (
      public.current_org_type() = 'client'
      AND public.current_role() = 'client_admin'
      AND purchase_order_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM public.purchase_orders po
        WHERE po.id = shops.purchase_order_id
          AND po.client_org_id = public.current_org_id()
          AND po.origin = 'client_created'
          AND po.assignment_status = 'pending_acceptance'
      )
    )
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.campaigns TO authenticated;
