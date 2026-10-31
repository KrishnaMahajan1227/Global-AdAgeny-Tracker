/** Offline regression for the 2026-10-31 security patch. DOES NOT connect to Supabase. */
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root,name),'utf8');
let passed=0,failed=0;
function check(title,ok){if(ok){passed++;console.log('PASS '+title)}else{failed++;console.error('FAIL '+title)}}
const sql = [
'supabase/migrations/20261031120000_0105_security_identity_and_permissions.sql',
'supabase/migrations/20261031121000_0106_private_media_storage.sql',
'supabase/migrations/20261031122000_0107_cross_tenant_integrity_and_admin_privacy.sql',
'supabase/migrations/20261031123000_0108_invalidate_known_seed_passwords.sql',
'supabase/migrations/20261031124000_0109_admin_rpc_and_audit_guards.sql',
'supabase/migrations/20261031125000_0110_rpcs_and_platform_hardening.sql',
'supabase/migrations/20261031130000_0111_financial_and_field_write_guards.sql',
'supabase/migrations/20261031131000_0112_integrity_and_rpc_hardening.sql'];
sql.forEach(f => check('Migration packaged '+path.basename(f),fs.existsSync(path.join(root,f))));
const a=read(sql[0]),b=read(sql[1]),c=read(sql[2]),d=read(sql[3]),e=read(sql[4]),f=read(sql[6]),g=read(sql[7]);
check('Server blocks role/tenant profile edits',a.includes('guard_profile_privileges')&&a.includes('NEW.organization_id IS DISTINCT FROM OLD.organization_id'));
check('Server denies inactive direct API sessions',a.includes('security_active_session')&&a.includes('AS RESTRICTIVE FOR ALL'));
check('Field workers limited to assigned shops',a.includes('security_field_shop_read')&&a.includes('can_access_field_shop'));
check('Anonymous phone-to-email lookup revoked',a.includes('get_login_email_by_phone(text) FROM PUBLIC, anon, authenticated'));
check('Anonymous public RPC execution revoked',a.includes('REVOKE ALL ON FUNCTION public.%I(%s) FROM PUBLIC, anon'));
check('All four private buckets disabled',b.includes("WHERE id IN ('survey-photos','design-files','installation-proof','purchase-orders')")&&b.includes('SET public=false'));
check('Storage file paths check org and role',b.includes('private_media_allowed')&&b.includes('v_owner<>v_org'));
check('Legacy public storage policies removed',b.includes('DROP POLICY IF EXISTS survey_photos_select')&&b.includes('DROP POLICY IF EXISTS purchase_order_files_select'));
check('Client links cannot self activate',c.includes('Agency approval required to activate a link'));
check('Platform dashboard no longer REST-fetches customer rows',read('src/pages/SuperAdminPage.tsx').includes('super_admin_org_metrics'));
check('Known seed passwords invalidated if unchanged',d.includes('encrypted_password=extensions.crypt')&&d.includes('gen_random_bytes'));
check('New privileged users require 12 character password',e.includes('length(p_password)<12'));
check('Financial writes scoped to office roles',f.includes('security_finance_insert')&&f.includes('security_po_insert'));
check('Worker location cannot impersonate another user',f.includes('user_id=auth.uid()'));
check('Tenant/customer foreign keys guarded',g.includes('guard_shop_business_identity')&&g.includes('guard_po_business_identity'));
check('Route stops require belonging worker',f.includes('guard_worker_route_stop_identity'));
check('Secure photo UI uses signed urls',read('src/lib/secureMedia.tsx').includes('createSignedUrl')&&read('src/lib/markingUtils.ts').includes('resolveSecureUrl'));
check('No real environment file packaged',!fs.existsSync(path.join(root,'.env')));
check('Direct sensitive React routes role protected',read('src/App.tsx').includes("path=\"/field-map\" element={<ProtectedRoute")&&read('src/App.tsx').includes("path=\"/survey-review\" element={<ProtectedRoute"));
console.log(`Security static checks: ${passed} PASS / ${failed} FAIL`);
if(failed) process.exitCode=1;
