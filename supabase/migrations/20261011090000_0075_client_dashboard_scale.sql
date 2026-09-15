/*
# Scalable client dashboard stats

ClientOverviewPage was computing its site-status donut and per-agency
completion breakdown by fetching every single shop row
(`select('id, status, purchase_order_id')`, no limit) and bucketing them
in JavaScript. Fine at the 10-20 shops a client tests with; genuinely
bad once a real client has 10,000+ shops across many campaigns — that's
10,000+ rows of network transfer and client-side iteration just to
render two summary numbers.

`client_shop_status_counts()` does the grouping in SQL instead: one row
per (purchase_order_id, status) combination that actually has shops in
it — realistically a few hundred rows even at 10k+ shops, not 10k+ rows.
The client-side bucketing logic (siteBucket()) is unchanged; it now runs
over these grouped counts instead of individual shops.
*/

CREATE OR REPLACE FUNCTION public.client_shop_status_counts()
RETURNS TABLE (purchase_order_id uuid, status text, shop_count bigint)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT s.purchase_order_id, s.status, COUNT(*) AS shop_count
  FROM public.shops s
  JOIN public.purchase_orders po ON po.id = s.purchase_order_id
  WHERE public.current_org_type() = 'client'
    AND po.client_org_id = public.current_org_id()
  GROUP BY s.purchase_order_id, s.status;
$$;

REVOKE ALL ON FUNCTION public.client_shop_status_counts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.client_shop_status_counts() TO authenticated;
