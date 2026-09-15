/*
# Phase 3 — Client app: Overview / Campaigns (PO) list / PO detail

  Builds the third slice of GLOBAL_ARCHITECTURE.md's rollout plan, on top of
  Phase 1 (migration 0037: org_type, client_agency_links, PO
  origin/client_org_id/assigned_agency_id/assignment_status + RLS) and
  Phase 2 (migration 0038: agency_invite_client_org, notify_linked_org_users,
  organizations cross-link visibility). Nothing here touches the existing
  agency-internal pipeline or any agency-side screen; it only ADDS what a
  client_admin/client_viewer needs to actually run Flow A end-to-end
  (doc section 3): create a PO themselves and assign it to a linked agency,
  then track its progress.

  Scope of this migration:

   1. po_line_items INSERT/UPDATE/DELETE — Phase 1 only extended
      po_line_items' SELECT policy for a client org; a client_admin could
      already see a PO's line items but had no way to add any, which meant
      a client-created PO could never actually carry a budget. This adds a
      client-org branch (client_admin only, and only while their own PO is
      still 'pending_acceptance' — once an agency accepts it, it becomes
      agency-owned operational data like any other PO, same rule already
      used for purchase_orders_client_update in migration 0037).

   2. v_po_line_item_utilization (migration 0025/0029) carries `rate` and
      `invoiced_amount` and is deliberately locked to the four agency
      money-roles (migration 0029) — a client_admin/client_viewer must
      never receive rate/cost data (doc section 2.5 / 7). So this adds a
      SEPARATE, narrower view, v_client_po_line_item_progress: the same
      budgeted-vs-actual qty/area rollup per line item, minus rate and
      invoiced_amount entirely (not just hidden in the UI — the columns
      don't exist in this view's output), scoped so it only ever returns
      rows to the client org that PO actually belongs to. Billing figures
      for a client come from the `invoices` table directly instead (their
      own bill — already readable per migration 0037), never from this
      view.

  Explicitly still out of scope (Phase 4+): Map Feed, the full Billing
  screen/PDF downloads, client-initiated "Invite Agency" (needs a lookup-
  by-code RPC not built yet — client_agency_links can still be inserted
  directly by a client_admin per 0037's insert policy once that RPC
  exists), and Reports/export.
*/

-- ============ 1. po_line_items — client-org write branch (own pending PO only) ============
DROP POLICY IF EXISTS "po_line_items_insert" ON public.po_line_items;
CREATE POLICY "po_line_items_insert" ON public.po_line_items FOR INSERT
  TO authenticated WITH CHECK (
    organization_id = public.current_org_id()
    OR
    (
      public.current_org_type() = 'client'
      AND public.current_role() = 'client_admin'
      AND EXISTS (
        SELECT 1 FROM public.purchase_orders po
        WHERE po.id = po_line_items.purchase_order_id
          AND po.organization_id = po_line_items.organization_id
          AND po.client_org_id = public.current_org_id()
          AND po.origin = 'client_created'
          AND po.assignment_status = 'pending_acceptance'
      )
    )
  );

DROP POLICY IF EXISTS "po_line_items_update" ON public.po_line_items;
CREATE POLICY "po_line_items_update" ON public.po_line_items FOR UPDATE
  TO authenticated USING (
    organization_id = public.current_org_id()
    OR
    (
      public.current_org_type() = 'client'
      AND public.current_role() = 'client_admin'
      AND EXISTS (
        SELECT 1 FROM public.purchase_orders po
        WHERE po.id = po_line_items.purchase_order_id
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
      AND EXISTS (
        SELECT 1 FROM public.purchase_orders po
        WHERE po.id = po_line_items.purchase_order_id
          AND po.client_org_id = public.current_org_id()
          AND po.origin = 'client_created'
          AND po.assignment_status = 'pending_acceptance'
      )
    )
  );

DROP POLICY IF EXISTS "po_line_items_delete" ON public.po_line_items;
CREATE POLICY "po_line_items_delete" ON public.po_line_items FOR DELETE
  TO authenticated USING (
    (organization_id = public.current_org_id() AND public.current_role() IN ('agency_owner','admin'))
    OR
    (
      public.current_org_type() = 'client'
      AND public.current_role() = 'client_admin'
      AND EXISTS (
        SELECT 1 FROM public.purchase_orders po
        WHERE po.id = po_line_items.purchase_order_id
          AND po.client_org_id = public.current_org_id()
          AND po.origin = 'client_created'
          AND po.assignment_status = 'pending_acceptance'
      )
    )
  );

-- ============ 2. v_client_po_line_item_progress — rate-free progress view ============
DROP VIEW IF EXISTS public.v_client_po_line_item_progress;
CREATE VIEW public.v_client_po_line_item_progress AS
SELECT
  pli.id AS po_line_item_id,
  pli.purchase_order_id,
  po.organization_id AS agency_org_id,
  po.client_org_id,
  po.po_number,
  po.po_date,
  po.fulfillment_type,
  po.status AS po_status,
  po.assignment_status,
  pli.description,
  pli.work_type_id,
  wt.name AS work_type_name,
  pli.uom,
  pli.budgeted_qty,
  pli.budgeted_area,
  COALESCE((SELECT sum(wi.survey_area) FROM public.work_items wi WHERE wi.po_line_item_id = pli.id), 0) AS surveyed_area,
  COALESCE((SELECT sum(wi.survey_quantity) FROM public.work_items wi WHERE wi.po_line_item_id = pli.id), 0) AS surveyed_qty,
  COALESCE((SELECT sum(wi.approved_area) FROM public.work_items wi WHERE wi.po_line_item_id = pli.id), 0) AS approved_area,
  COALESCE((SELECT sum(wi.approved_quantity) FROM public.work_items wi WHERE wi.po_line_item_id = pli.id), 0) AS approved_qty,
  COALESCE((SELECT sum(wi.produced_quantity) FROM public.work_items wi WHERE wi.po_line_item_id = pli.id), 0) AS produced_qty,
  COALESCE((SELECT sum(wi.installed_area) FROM public.work_items wi WHERE wi.po_line_item_id = pli.id), 0) AS installed_area,
  COALESCE((SELECT sum(wi.installed_quantity) FROM public.work_items wi WHERE wi.po_line_item_id = pli.id), 0) AS installed_qty,
  COALESCE((SELECT count(*) FROM public.work_items wi WHERE wi.po_line_item_id = pli.id), 0) AS linked_work_item_count
FROM public.po_line_items pli
JOIN public.purchase_orders po ON po.id = pli.purchase_order_id
LEFT JOIN public.work_types wt ON wt.id = pli.work_type_id
WHERE po.client_org_id IS NOT NULL
  AND public.current_org_type() = 'client'
  AND po.client_org_id = public.current_org_id();

GRANT SELECT ON public.v_client_po_line_item_progress TO authenticated;
