/*
# Phase 1 — Purchase Order layer (budget control)
   New tables only. Nothing existing is altered or dropped, so the current
   survey → design → production → installation → billing pipeline keeps
   working exactly as before.

   - purchase_orders: one row per PO document a client issues (uploaded PDF
     + a few header fields the admin types in).
   - po_line_items: the actual sqft/qty budget rows inside that PO (one PO
     can cover many work types, e.g. foam sheet, ACP board, poles...).

   Linking these into shops/work_items (zone_id, purchase_order_id,
   po_line_item_id) is Phase 3 per the architecture doc — intentionally
   left out here so this phase ships small and isolated.
*/

-- PURCHASE ORDERS
CREATE TABLE IF NOT EXISTS public.purchase_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  project_id uuid REFERENCES public.projects(id) ON DELETE SET NULL,
  po_number text NOT NULL,
  po_date date NOT NULL,
  fulfillment_type text NOT NULL DEFAULT 'survey_install'
    CHECK (fulfillment_type IN ('survey_install','supply_only')),
  storage_path text,
  file_url text,
  total_amount numeric,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed','cancelled')),
  notes text,
  created_by uuid REFERENCES public.profiles(id),
  is_demo boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.purchase_orders ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_purchase_orders_org ON public.purchase_orders(organization_id);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_client ON public.purchase_orders(client_id);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_project ON public.purchase_orders(project_id);
-- Same PO number should not be entered twice for the same client within an org.
CREATE UNIQUE INDEX IF NOT EXISTS uq_purchase_orders_org_client_ponum
  ON public.purchase_orders(organization_id, client_id, po_number);

-- PO LINE ITEMS
CREATE TABLE IF NOT EXISTS public.po_line_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  purchase_order_id uuid NOT NULL REFERENCES public.purchase_orders(id) ON DELETE CASCADE,
  work_type_id uuid REFERENCES public.work_types(id) ON DELETE SET NULL,
  description text NOT NULL,
  uom text NOT NULL DEFAULT 'sqft' CHECK (uom IN ('sqft','piece','lot')),
  budgeted_qty numeric,
  budgeted_area numeric,
  rate numeric,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.po_line_items ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_po_line_items_org ON public.po_line_items(organization_id);
CREATE INDEX IF NOT EXISTS idx_po_line_items_po ON public.po_line_items(purchase_order_id);
CREATE INDEX IF NOT EXISTS idx_po_line_items_work_type ON public.po_line_items(work_type_id);

-- ============ RLS: purchase_orders ============
-- Same org-scoped pattern as clients/projects: any office role in the org
-- can read/write; delete restricted to owner/admin (mirrors clients_delete).
DROP POLICY IF EXISTS "purchase_orders_select" ON public.purchase_orders;
CREATE POLICY "purchase_orders_select" ON public.purchase_orders FOR SELECT
  TO authenticated USING (organization_id = public.current_org_id());

DROP POLICY IF EXISTS "purchase_orders_insert" ON public.purchase_orders;
CREATE POLICY "purchase_orders_insert" ON public.purchase_orders FOR INSERT
  TO authenticated WITH CHECK (organization_id = public.current_org_id());

DROP POLICY IF EXISTS "purchase_orders_update" ON public.purchase_orders;
CREATE POLICY "purchase_orders_update" ON public.purchase_orders FOR UPDATE
  TO authenticated USING (organization_id = public.current_org_id())
  WITH CHECK (organization_id = public.current_org_id());

DROP POLICY IF EXISTS "purchase_orders_delete" ON public.purchase_orders;
CREATE POLICY "purchase_orders_delete" ON public.purchase_orders FOR DELETE
  TO authenticated USING (organization_id = public.current_org_id() AND public.current_role() IN ('agency_owner','admin'));

-- ============ RLS: po_line_items ============
DROP POLICY IF EXISTS "po_line_items_select" ON public.po_line_items;
CREATE POLICY "po_line_items_select" ON public.po_line_items FOR SELECT
  TO authenticated USING (organization_id = public.current_org_id());

DROP POLICY IF EXISTS "po_line_items_insert" ON public.po_line_items;
CREATE POLICY "po_line_items_insert" ON public.po_line_items FOR INSERT
  TO authenticated WITH CHECK (organization_id = public.current_org_id());

DROP POLICY IF EXISTS "po_line_items_update" ON public.po_line_items;
CREATE POLICY "po_line_items_update" ON public.po_line_items FOR UPDATE
  TO authenticated USING (organization_id = public.current_org_id())
  WITH CHECK (organization_id = public.current_org_id());

DROP POLICY IF EXISTS "po_line_items_delete" ON public.po_line_items;
CREATE POLICY "po_line_items_delete" ON public.po_line_items FOR DELETE
  TO authenticated USING (organization_id = public.current_org_id() AND public.current_role() IN ('agency_owner','admin'));

-- ============ Storage bucket for uploaded PO PDFs ============
-- Same public-read / authenticated-write pattern as design-files.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('purchase-orders', 'purchase-orders', true, 20971520, ARRAY['application/pdf','image/jpeg','image/png'])
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "purchase_order_files_select" ON storage.objects;
CREATE POLICY "purchase_order_files_select" ON storage.objects FOR SELECT
  TO public USING (bucket_id = 'purchase-orders');

DROP POLICY IF EXISTS "purchase_order_files_insert" ON storage.objects;
CREATE POLICY "purchase_order_files_insert" ON storage.objects FOR INSERT
  TO authenticated WITH CHECK (bucket_id = 'purchase-orders');

DROP POLICY IF EXISTS "purchase_order_files_update" ON storage.objects;
CREATE POLICY "purchase_order_files_update" ON storage.objects FOR UPDATE
  TO authenticated USING (bucket_id = 'purchase-orders');

DROP POLICY IF EXISTS "purchase_order_files_delete" ON storage.objects;
CREATE POLICY "purchase_order_files_delete" ON storage.objects FOR DELETE
  TO authenticated USING (bucket_id = 'purchase-orders');

-- ============ Realtime ============
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'purchase_orders'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.purchase_orders;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'po_line_items'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.po_line_items;
  END IF;
END $$;
