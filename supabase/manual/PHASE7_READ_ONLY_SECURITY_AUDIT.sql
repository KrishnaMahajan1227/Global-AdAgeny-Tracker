-- PHASE 7: SAFE READ-ONLY INSPECTION, run in staging SQL editor (privileged auditor).
-- No tables/roles/policies are modified. Review results before deploying.
-- RLS enabled is necessary but does NOT prove the policy logic is correct.

-- 1. Inspect critical table RLS and FORCE RLS flags.
SELECT n.nspname AS schema_name, c.relname AS table_name,
       c.relrowsecurity AS rls_enabled, c.relforcerowsecurity AS force_rls,
       CASE WHEN c.oid IS NULL THEN 'MISSING' WHEN NOT c.relrowsecurity THEN 'REVIEW' ELSE 'PRESENT' END AS finding
FROM (VALUES ('profiles'),('purchase_orders'),('shops'),('work_items'),('surveys'),
             ('design_tasks'),('production_orders'),('installation_jobs'),
             ('invoices'),('invoice_items'),('company_approval_handoffs'),
             ('supply_delivery_receipts')) AS required(name)
LEFT JOIN pg_catalog.pg_class c ON c.relname=required.name AND c.relkind IN ('r','p')
LEFT JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace AND n.nspname='public'
ORDER BY required.name;

-- 2. Inspect all policies on business-critical tables, including role scope.
SELECT schemaname,tablename,policyname,roles,cmd,qual,with_check
FROM pg_catalog.pg_policies
WHERE schemaname='public' AND tablename IN
  ('profiles','purchase_orders','shops','work_items','invoices','invoice_items',
   'company_approval_handoffs','supply_delivery_receipts')
ORDER BY tablename,cmd,policyname;

-- 3. Privileged RPC execution grants; check unexpected PUBLIC / anon grants.
SELECT n.nspname AS schema_name, p.proname AS rpc_name,
       p.prosecdef AS security_definer,
       pg_get_function_identity_arguments(p.oid) AS identity_arguments,
       has_function_privilege('PUBLIC',p.oid,'EXECUTE') AS public_can_execute,
       has_function_privilege('anon',p.oid,'EXECUTE') AS anon_can_execute,
       has_function_privilege('authenticated',p.oid,'EXECUTE') AS authenticated_can_execute
FROM pg_catalog.pg_proc p
JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND (
  p.proname LIKE 'phase2_%' OR p.proname LIKE 'phase3_%' OR
  p.proname LIKE 'phase4_%' OR p.proname='billing_archive_delete_invoice')
ORDER BY p.proname, identity_arguments;

-- 4. Verify phase policies/columns present; do not assume migrations are applied.
SELECT tbl.table_name, col.column_name,
       EXISTS(SELECT 1 FROM information_schema.columns ic
              WHERE ic.table_schema='public' AND ic.table_name=tbl.table_name
                AND ic.column_name=col.column_name) AS installed
FROM (VALUES ('purchase_orders','company_approval_required'),
             ('purchase_orders','delivery_receipt_required'),
             ('shops','phase4_field_request_id'),
             ('routes','phase4_request_id')) AS col(table_name,column_name)
JOIN (VALUES ('purchase_orders'),('shops'),('routes')) AS tbl(table_name)
  ON tbl.table_name=col.table_name;

-- 5. Inspect trigger guards that are necessary to protect direct-table writes.
SELECT c.relname AS table_name, t.tgname AS trigger_name,
       NOT t.tgisinternal AS user_trigger, pg_get_triggerdef(t.oid) AS trigger_definition
FROM pg_catalog.pg_trigger t
JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND (t.tgname LIKE 'trg_phase2_%' OR
     t.tgname LIKE 'trg_phase3_%' OR t.tgname LIKE 'trg_phase4_%')
ORDER BY c.relname,t.tgname;

-- 6. Privileged roles' table mutation grants (investigate direct writes to approval and receipts).
SELECT role_name, table_name,
       CASE WHEN to_regclass('public.'||table_name) IS NULL THEN NULL
            ELSE has_table_privilege(role_name,to_regclass('public.'||table_name),'INSERT') END AS can_insert,
       CASE WHEN to_regclass('public.'||table_name) IS NULL THEN NULL
            ELSE has_table_privilege(role_name,to_regclass('public.'||table_name),'UPDATE') END AS can_update
FROM (VALUES ('anon'),('authenticated')) AS roles(role_name)
CROSS JOIN (VALUES ('company_approval_handoffs'),('supply_delivery_receipts')) AS tbl(table_name)
ORDER BY table_name,role_name;

-- Manual follow-up: run RLS cross-organization negative tests with REAL roles,
-- check company-approval evidence-stale behavior, and two-person invoice concurrency.
