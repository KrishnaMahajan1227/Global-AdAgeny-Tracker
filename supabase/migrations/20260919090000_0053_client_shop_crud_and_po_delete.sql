/*
# Phase 24 — client shop CRUD available anytime (guarded per-shop, not per-PO), + client Work Order delete

## The problem
Migration 0051 scoped a client's shops INSERT/UPDATE/DELETE to
`purchase_orders.assignment_status = 'pending_acceptance'` — the same
rule already used for po_line_items. In practice this meant the moment
an agency accepted a Work Order (which can happen quickly), the client
permanently lost the ability to add or manage sites on it — reported
back as "add option disappears after adding one shop" (the agency had
likely already accepted by then, or accepted right after).

## The fix
Split the rule by ACTION instead of by PO-wide status:

- **INSERT (add a new site)** — always allowed for a client_admin on
  their own client_created Work Order, regardless of assignment_status.
  Adding a brand-new site never touches or risks any of the agency's
  existing operational data, so there's no safety reason to gate it.

- **UPDATE / DELETE (edit or remove an existing site)** — gated on the
  SHOP's own status instead of the PO's: only while that specific site is
  still `pending` (the shop's default status — meaning no survey has
  started on it yet). This protects real field work the agency has
  already recorded (photos, measurements, installation proof) from being
  edited or deleted out from under them by the client, while still
  letting the client freely manage sites nobody has touched yet — the
  common case of "I added a site with a typo" or "this site was added by
  mistake, no work started".

## Client-side Work Order delete
`purchase_orders` never had a client-org DELETE branch — only the
existing "cancel via status update" path (migration 0037's
`purchase_orders_client_update`, itself gated to `pending_acceptance`
only). This adds an actual DELETE, same scope: a client_admin may
permanently delete their own client_created Work Order only while it's
still `pending_acceptance` — before an agency has accepted it and before
any real operational data could exist against it. `po_line_items` cascade
-deletes automatically (`ON DELETE CASCADE`, migration 0020); any shops
the client already added on it are explicitly cleaned up too (rather than
left behind as orphaned `purchase_order_id = NULL` rows via `shops`'
`ON DELETE SET NULL`), since the client added them and the PO never got
accepted.
*/

-- ============ shops — split INSERT (always) vs UPDATE/DELETE (shop must be still 'pending') ============
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
      AND status = 'pending'
      AND purchase_order_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM public.purchase_orders po
        WHERE po.id = shops.purchase_order_id
          AND po.client_org_id = public.current_org_id()
          AND po.origin = 'client_created'
      )
    )
  )
  WITH CHECK (
    organization_id = public.current_org_id()
    OR
    (
      public.current_org_type() = 'client'
      AND public.current_role() = 'client_admin'
      AND status = 'pending'
      AND purchase_order_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM public.purchase_orders po
        WHERE po.id = shops.purchase_order_id
          AND po.client_org_id = public.current_org_id()
          AND po.origin = 'client_created'
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
      AND status = 'pending'
      AND purchase_order_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM public.purchase_orders po
        WHERE po.id = shops.purchase_order_id
          AND po.client_org_id = public.current_org_id()
          AND po.origin = 'client_created'
      )
    )
  );

-- ============ purchase_orders — client-org DELETE (own pending Work Order only) ============
DROP POLICY IF EXISTS "purchase_orders_client_delete" ON public.purchase_orders;
CREATE POLICY "purchase_orders_client_delete" ON public.purchase_orders FOR DELETE
  TO authenticated USING (
    public.current_org_type() = 'client'
    AND public.current_role() = 'client_admin'
    AND client_org_id = public.current_org_id()
    AND origin = 'client_created'
    AND assignment_status = 'pending_acceptance'
  );
