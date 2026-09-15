/*
# Phase 20 — Client-shareable public read-only shop link (Architecture v2.0 §6/§8 item 8)

The last remaining gap explicitly flagged as "(Optional, Phase 2)" in
the architecture doc's data-model table: a no-login, read-only link an
agency can hand a client (or the client's own end-customer/dealer) to
check a single shop's progress, without creating them a platform
account.

## Design
- `shop_share_links` — one row per generated link: a random `token`
  (the only thing the public URL carries), which org/shop it belongs to,
  who created it, and an optional `revoked_at` so a link can be killed
  without deleting history. Normal RLS applies to this table — only the
  owning org's Owner/Admin/Demo can create, list, or revoke their own
  links. Nothing about this table is ever reachable by `anon`.
- `public.get_shared_shop_view(p_token text)` — a SECURITY DEFINER RPC,
  the ONLY thing the unauthenticated public page is allowed to call.
  Looks up the token, confirms it's not revoked, and returns a
  deliberately narrow, curated set of columns — explicitly no rate/₹,
  no PO number, no owner/contact phone (personal info), no GPS
  coordinates, no client name. Just enough for someone to recognize
  "yes, this is my shop" and see its stage/progress and one
  representative photo. Granted to `anon` — nothing else in this schema
  is.
*/

CREATE TABLE IF NOT EXISTS public.shop_share_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
  token text NOT NULL UNIQUE,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
ALTER TABLE public.shop_share_links ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_shop_share_links_shop ON public.shop_share_links(shop_id);
CREATE INDEX IF NOT EXISTS idx_shop_share_links_token ON public.shop_share_links(token);

DROP POLICY IF EXISTS "shop_share_links_select" ON public.shop_share_links;
CREATE POLICY "shop_share_links_select" ON public.shop_share_links FOR SELECT
  USING (organization_id = public.current_org_id() AND public.current_role() IN ('agency_owner','admin','demo'));

DROP POLICY IF EXISTS "shop_share_links_insert" ON public.shop_share_links;
CREATE POLICY "shop_share_links_insert" ON public.shop_share_links FOR INSERT
  WITH CHECK (organization_id = public.current_org_id() AND public.current_role() IN ('agency_owner','admin','demo'));

DROP POLICY IF EXISTS "shop_share_links_update" ON public.shop_share_links;
CREATE POLICY "shop_share_links_update" ON public.shop_share_links FOR UPDATE
  USING (organization_id = public.current_org_id() AND public.current_role() IN ('agency_owner','admin','demo'));

-- ============================================================
-- Public RPC — the only door into this data for an unauthenticated
-- visitor. Deliberately returns a narrow, curated shape (see header).
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_shared_shop_view(p_token text)
RETURNS TABLE (
  shop_name text,
  city text,
  state text,
  zone_name text,
  status text,
  total_boards bigint,
  installed_boards bigint,
  photo_url text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_shop_id uuid;
BEGIN
  SELECT shop_id INTO v_shop_id
  FROM public.shop_share_links
  WHERE token = p_token AND revoked_at IS NULL;

  IF v_shop_id IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    s.name,
    s.city,
    s.state,
    z.name,
    s.status,
    (SELECT count(*) FROM public.work_items wi WHERE wi.shop_id = s.id),
    (SELECT count(*) FROM public.work_items wi WHERE wi.shop_id = s.id AND wi.status = 'installed'),
    (
      SELECT ip.photo_url FROM public.installation_proofs ip
      WHERE ip.shop_id = s.id AND ip.photo_type = 'installed'
      ORDER BY ip.captured_at DESC LIMIT 1
    )
  FROM public.shops s
  LEFT JOIN public.zones z ON z.id = s.zone_id
  WHERE s.id = v_shop_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_shared_shop_view(text) TO anon;
GRANT EXECUTE ON FUNCTION public.get_shared_shop_view(text) TO authenticated;
