-- Safe, one-invoice archival removal. DOES NOT remove anything on migration run.
-- Only an explicitly confirmed call from a logged-in active owner/admin may
-- remove an unpaid invoice from active billing. Archive remains private.
CREATE SCHEMA IF NOT EXISTS adroute_billing_archive;
REVOKE ALL ON SCHEMA adroute_billing_archive FROM PUBLIC, anon, authenticated;
CREATE TABLE IF NOT EXISTS adroute_billing_archive.reset_records (
  organization_id uuid NOT NULL,
  source_table text NOT NULL CHECK (source_table IN ('invoices','invoice_items')),
  source_id uuid NOT NULL,
  saved_at timestamptz NOT NULL DEFAULT now(),
  record jsonb NOT NULL,
  PRIMARY KEY (organization_id, source_table, source_id)
);
REVOKE ALL ON adroute_billing_archive.reset_records FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.billing_archive_delete_invoice(
  p_invoice_id uuid,
  p_confirm_number text
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_actor record;
  v_invoice public.invoices%ROWTYPE;
BEGIN
  SELECT organization_id, role, is_active INTO v_actor
  FROM public.profiles WHERE id = auth.uid();
  IF v_actor.organization_id IS NULL OR v_actor.is_active IS DISTINCT FROM true
    OR v_actor.role NOT IN ('agency_owner','admin') THEN
    RAISE EXCEPTION 'Only active agency owners/admins can remove invoices';
  END IF;

  SELECT * INTO v_invoice FROM public.invoices
  WHERE id = p_invoice_id AND organization_id = v_actor.organization_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found in your agency'; END IF;
  IF p_confirm_number IS DISTINCT FROM v_invoice.invoice_number THEN
    RAISE EXCEPTION 'Invoice number confirmation does not match';
  END IF;
  -- Paid, part-paid and overdue tax records must go through accounting review.
  IF v_invoice.payment_status IS DISTINCT FROM 'unpaid' THEN
    RAISE EXCEPTION 'Only unpaid invoices can be archived from this action';
  END IF;

  -- Entire RPC executes inside a single PostgreSQL transaction.
  INSERT INTO adroute_billing_archive.reset_records(organization_id, source_table, source_id, record)
  VALUES(v_actor.organization_id, 'invoices', v_invoice.id, to_jsonb(v_invoice));
  INSERT INTO adroute_billing_archive.reset_records(organization_id, source_table, source_id, record)
    SELECT v_actor.organization_id, 'invoice_items', ii.id, to_jsonb(ii)
    FROM public.invoice_items ii WHERE ii.invoice_id = v_invoice.id;

  DELETE FROM public.invoice_items WHERE invoice_id = v_invoice.id;
  DELETE FROM public.invoices WHERE id = v_invoice.id AND organization_id = v_actor.organization_id;
  INSERT INTO public.audit_logs(organization_id, user_id, table_name, record_id, action, description)
  VALUES(v_actor.organization_id, auth.uid(), 'invoices', v_invoice.id, 'delete',
    'Archived invoice ' || v_invoice.invoice_number || ' (recoverable in private archive)');
  RETURN true;
END;
$fn$;
REVOKE ALL ON FUNCTION public.billing_archive_delete_invoice(uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.billing_archive_delete_invoice(uuid,text) TO authenticated;
