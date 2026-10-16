-- DO NOT EXECUTE WITHOUT A VERIFIED EXTERNAL BACKUP + ACCOUNTING REVIEW.
-- Targets only the agency supplied to psql via -v org_id and -v approval.
-- Archived records stay outside public schema for retention/recovery.
\set ON_ERROR_STOP on
BEGIN;
SELECT set_config('adroute.target_org', :'org_id', true);
SELECT set_config('adroute.confirmation', :'approval', true);
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
DO $clear$
DECLARE
  v_org uuid := current_setting('adroute.target_org')::uuid;
  v_confirmation text := current_setting('adroute.confirmation');
  v_org_exists bool;
  v_invoice_count int;
  v_line_count int;
  v_archived_invoices int;
  v_archived_lines int;
BEGIN
  IF v_org = '00000000-0000-0000-0000-000000000000'::uuid
     OR v_confirmation <> 'ARCHIVE AND CLEAR THIS AGENCY BILLING' THEN
    RAISE EXCEPTION 'Explicit confirmation and actual agency UUID required';
  END IF;
  SELECT EXISTS(SELECT 1 FROM public.organizations WHERE id=v_org) INTO v_org_exists;
  IF NOT v_org_exists THEN RAISE EXCEPTION 'Agency UUID not found'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(v_org::text, 5419));
  SELECT count(*) INTO v_invoice_count FROM public.invoices WHERE organization_id=v_org;
  SELECT count(*) INTO v_line_count FROM public.invoice_items ii
    JOIN public.invoices inv ON inv.id=ii.invoice_id WHERE inv.organization_id=v_org;

  -- Conflict on a previously archived invoice ID indicates a reused or
  -- modified record; fail safely rather than overwrite retained history.
  IF EXISTS (
    SELECT 1 FROM public.invoices inv
    JOIN adroute_billing_archive.reset_records a
      ON a.organization_id=v_org AND a.source_table='invoices' AND a.source_id=inv.id
    WHERE inv.organization_id=v_org AND a.record IS DISTINCT FROM to_jsonb(inv)
  ) THEN RAISE EXCEPTION 'Existing invoice archive differs from live record; reconcile manually'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.invoice_items ii
    JOIN public.invoices inv ON inv.id=ii.invoice_id
    JOIN adroute_billing_archive.reset_records a
      ON a.organization_id=v_org AND a.source_table='invoice_items' AND a.source_id=ii.id
    WHERE inv.organization_id=v_org AND a.record IS DISTINCT FROM to_jsonb(ii)
  ) THEN RAISE EXCEPTION 'Existing line archive differs from live record; reconcile manually'; END IF;

  INSERT INTO adroute_billing_archive.reset_records(organization_id,source_table,source_id,record)
    SELECT v_org,'invoices',inv.id,to_jsonb(inv)
    FROM public.invoices inv WHERE inv.organization_id=v_org
    ON CONFLICT DO NOTHING;
  INSERT INTO adroute_billing_archive.reset_records(organization_id,source_table,source_id,record)
    SELECT v_org,'invoice_items',ii.id,to_jsonb(ii)
    FROM public.invoice_items ii JOIN public.invoices inv ON inv.id=ii.invoice_id
    WHERE inv.organization_id=v_org
    ON CONFLICT DO NOTHING;

  SELECT count(*) INTO v_archived_invoices FROM public.invoices inv
    JOIN adroute_billing_archive.reset_records a ON a.source_id=inv.id AND a.organization_id=v_org AND a.source_table='invoices'
    WHERE inv.organization_id=v_org;
  SELECT count(*) INTO v_archived_lines FROM public.invoice_items ii
    JOIN public.invoices inv ON inv.id=ii.invoice_id
    JOIN adroute_billing_archive.reset_records a ON a.source_id=ii.id AND a.organization_id=v_org AND a.source_table='invoice_items'
    WHERE inv.organization_id=v_org;
  IF v_archived_invoices<>v_invoice_count OR v_archived_lines<>v_line_count THEN
    RAISE EXCEPTION 'Archive row-count verification failed. No deletion committed.';
  END IF;
  DELETE FROM public.invoice_items ii USING public.invoices inv
    WHERE ii.invoice_id=inv.id AND inv.organization_id=v_org;
  DELETE FROM public.invoices WHERE organization_id=v_org;
  IF EXISTS(SELECT 1 FROM public.invoices WHERE organization_id=v_org) THEN
    RAISE EXCEPTION 'Deletion incomplete, rolling back';
  END IF;
  RAISE NOTICE 'Archived and cleared % invoice headers and % invoice lines for agency %', v_invoice_count, v_line_count, v_org;
END $clear$;
COMMIT;
SELECT :'org_id' AS agency_id, count(*) AS remaining_active_invoices FROM public.invoices WHERE organization_id=:'org_id'::uuid;
SELECT source_table,count(*) AS archived FROM adroute_billing_archive.reset_records WHERE organization_id=:'org_id'::uuid GROUP BY source_table ORDER BY source_table;
