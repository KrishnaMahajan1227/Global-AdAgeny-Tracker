-- MANUAL, DESTRUCTIVE OPERATION: moves the selected organization's invoice
-- records out of active billing tables to a private immutable audit archive.
-- Do NOT run this against production before verifying legal retention obligations,
-- exporting offline backups, testing staging, and reading the preview.
-- Never use db reset or truncate. This script does not modify shops/POs/work items.
BEGIN;

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

DO $clear_old_billing$
DECLARE
  -- Set this to the exact agency organization UUID from the read-only preview.
  target_org uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  -- Type this exact text after you have a separate verified backup and
  -- checked your accountant's document retention requirements.
  confirmation text := 'NOT CONFIRMED';
  expected_invoices integer;
  expected_items integer;
  archived_invoices integer;
  archived_items integer;
BEGIN
  IF target_org = '00000000-0000-0000-0000-000000000000'::uuid
     OR confirmation <> 'ARCHIVE AND CLEAR THIS AGENCY BILLING' THEN
    RAISE EXCEPTION 'Billing reset NOT executed. Set target_org and explicit confirmation first.';
  END IF;

  -- Serialize a reset with another reset for this organization.
  PERFORM pg_advisory_xact_lock(hashtextextended(target_org::text, 5419));

  SELECT count(*) INTO expected_invoices FROM public.invoices WHERE organization_id = target_org;
  SELECT count(*) INTO expected_items
    FROM public.invoice_items ii
    JOIN public.invoices inv ON inv.id = ii.invoice_id
    WHERE inv.organization_id = target_org;

  INSERT INTO adroute_billing_archive.reset_records (organization_id, source_table, source_id, record)
  SELECT target_org, 'invoices', inv.id, to_jsonb(inv)
  FROM public.invoices inv WHERE inv.organization_id = target_org
  ON CONFLICT DO NOTHING;

  INSERT INTO adroute_billing_archive.reset_records (organization_id, source_table, source_id, record)
  SELECT target_org, 'invoice_items', ii.id, to_jsonb(ii)
  FROM public.invoice_items ii
  JOIN public.invoices inv ON inv.id = ii.invoice_id
  WHERE inv.organization_id = target_org
  ON CONFLICT DO NOTHING;

  SELECT count(*) INTO archived_invoices FROM adroute_billing_archive.reset_records
  WHERE organization_id = target_org AND source_table = 'invoices';
  SELECT count(*) INTO archived_items FROM adroute_billing_archive.reset_records
  WHERE organization_id = target_org AND source_table = 'invoice_items';
  IF archived_invoices < expected_invoices OR archived_items < expected_items THEN
    RAISE EXCEPTION 'Archive validation failed. No active invoices have been deleted.';
  END IF;

  DELETE FROM public.invoice_items ii
  USING public.invoices inv
  WHERE ii.invoice_id = inv.id AND inv.organization_id = target_org;

  DELETE FROM public.invoices WHERE organization_id = target_org;
  IF EXISTS(SELECT 1 FROM public.invoices WHERE organization_id = target_org) THEN
    RAISE EXCEPTION 'Incomplete deletion; transaction rolled back.';
  END IF;
  RAISE NOTICE 'Archived % invoices and % invoice items before removing them from active billing.', expected_invoices, expected_items;
END
$clear_old_billing$;
COMMIT;

-- Verification after committing, with your agency UUID:
-- SELECT COUNT(*) FROM public.invoices WHERE organization_id = '<AGENCY_UUID>';
-- SELECT source_table, COUNT(*) FROM adroute_billing_archive.reset_records
-- WHERE organization_id = '<AGENCY_UUID>' GROUP BY source_table;
