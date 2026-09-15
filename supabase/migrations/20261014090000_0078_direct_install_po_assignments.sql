/*
# Phase 13 — Assign the ground crew to a Direct Installation Work Order

## What was missing
Migration 0077 let Owner/Admin create a `direct_install` PO and let ANY
installer in the org see it and log a site against it (the Installer
Home's "Direct Install" tab queried every active `direct_install` PO in
the org, unfiltered). That's fine for a one-person agency, but for a real
team it means the work never actually reaches the RIGHT ground crew — the
office has no way to say "this City-A-to-City-B wall-painting drive is
Ramesh and Suresh's job", and an installer has no way to tell "is this
mine to do" apart from every other Direct Install PO anyone in the
company has ever created.

## Design
A shop can be assigned to a surveyor/installer via `shop_assignments`
(existing) because a shop already exists to assign. A `direct_install`
PO's whole point is that no shop exists yet — there's nothing to assign
AT that level. So this adds the PO-level equivalent: `po_assignments`,
one row per (Work Order, ground-crew member) — same shape as
`shop_assignments` minus the columns that only make sense once a shop
exists (`status`, `completed_at`).

Scoped narrowly to `role = 'installer'` for now (this is specifically
for Direct Install ground crew — if a future PO type needs a surveyor
equivalent, that's a `role` value to add later, not a reason to
generalize now). RLS mirrors `shop_assignments`: any org member can read
assignments (needed for both the office's own management UI and the
Installer app's own filter), only Owner/Admin can create or remove one.

This does NOT touch `purchase_orders` RLS (still financial-role-only) —
`po_assignments` itself carries no money, just "who's on this job", so it
can safely stay readable by the installer role that's actually assigned
to it.
*/

CREATE TABLE IF NOT EXISTS public.po_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  purchase_order_id uuid NOT NULL REFERENCES public.purchase_orders(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'installer' CHECK (role IN ('installer')),
  assigned_by uuid REFERENCES public.profiles(id),
  assigned_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (purchase_order_id, user_id, role)
);
ALTER TABLE public.po_assignments ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_po_assignments_org ON public.po_assignments(organization_id);
CREATE INDEX IF NOT EXISTS idx_po_assignments_po ON public.po_assignments(purchase_order_id);
CREATE INDEX IF NOT EXISTS idx_po_assignments_user ON public.po_assignments(user_id);

DROP POLICY IF EXISTS "po_assignments_select" ON public.po_assignments;
CREATE POLICY "po_assignments_select" ON public.po_assignments FOR SELECT
  TO authenticated USING (organization_id = public.current_org_id());

DROP POLICY IF EXISTS "po_assignments_insert" ON public.po_assignments;
CREATE POLICY "po_assignments_insert" ON public.po_assignments FOR INSERT
  TO authenticated WITH CHECK (
    organization_id = public.current_org_id()
    AND public.current_role() IN ('agency_owner', 'admin')
  );

DROP POLICY IF EXISTS "po_assignments_delete" ON public.po_assignments;
CREATE POLICY "po_assignments_delete" ON public.po_assignments FOR DELETE
  TO authenticated USING (
    organization_id = public.current_org_id()
    AND public.current_role() IN ('agency_owner', 'admin')
  );

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'po_assignments'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.po_assignments;
  END IF;
END $$;
