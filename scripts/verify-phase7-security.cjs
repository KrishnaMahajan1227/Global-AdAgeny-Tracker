'use strict';
/** Dependency-free Phase 7 source safety checks. Not a replacement for live RLS or browser testing. */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
let ts;
try { ts = require('typescript'); } catch { ts = require('/opt/nvm/versions/node/v22.16.0/lib/node_modules/typescript'); }
const root = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
let passed = 0;
function check(label, callback) {
  callback();
  console.log('PASS', label);
  passed++;
}
const auth = read('src/lib/auth.tsx');
const app = read('src/App.tsx');
const boundary = read('src/components/ErrorBoundary.tsx');
const vite = read('vite.config.ts');
const dashboard = read('src/pages/DashboardPage.tsx');
const migration2 = read('supabase/migrations/20261028100000_0098_phase2_company_approval_handoff.sql');
const migration3 = read('supabase/migrations/20261029100000_0099_phase3_atomic_department_handoffs.sql');
const migration4 = read('supabase/migrations/20261030100000_0100_phase4_supply_delivery_integrity.sql');
check('Auth clears React Query data when user identity changes', () => {
  assert.match(auth, /identityRef\.current !== nextUserId/);
  assert.match(auth, /queryClient\.cancelQueries\(\)/);
  assert.match(auth, /queryClient\.clear\(\)/);
});
check('Stale profile responses cannot overwrite a newer signed-in account', () => {
  assert.match(auth, /revision === authRevisionRef\.current && identityRef\.current === userId/);
  assert.match(auth, /authRevisionRef\.current \+= 1/);
});
check('A stale session bootstrap cannot override a newer auth event', () => {
  assert.match(auth, /observedAuthEvent = true/);
  assert.match(auth, /if \(!observedAuthEvent\) applySession\(initial\)/);
});
check('Sign out clears in-memory profile and sensitive query caches', () => {
  assert.match(auth, /const \{ error \} = await supabase\.auth\.signOut\(\)/);
  assert.match(auth, /if \(error\) throw error/);
  assert.match(auth, /queryClient\.clear\(\)/);
});
check('Production error UI hides internal error messages and does not promise saved edits', () => {
  assert.match(boundary, /import\.meta\.env\.DEV &&/);
  assert.doesNotMatch(boundary, /your data is safe, nothing was lost/i);
});
check('PWA never caches Supabase Storage evidence', () => {
  assert.match(vite, /url\.origin\.endsWith\('\.supabase\.co'\)/);
  assert.match(vite, /handler: 'NetworkOnly'/);
  assert.doesNotMatch(vite, /cacheName: 'supabase-storage-cache'/);
});
check('Previous private image cache is removed on app startup/service worker controller change', () => {
  assert.match(app, /window\.caches\.delete\(name\)/);
  assert.match(app, /controllerchange/);
});
check('Field confirmation dialogs are cancelled on account switch', () => {
  const dialogs = read('src/lib/fieldDialogs.tsx');
  assert.match(dialogs, /const activeUserId = session\?\.user\.id \?\? null/);
  assert.match(dialogs, /pendingRef\.current\.forEach\(request => request\.resolve\(false\)\)/);
  assert.match(app, /<AuthProvider>\s*<FieldDialogHost \/>/);
});
check('Dashboard only enables finance fetch for explicit agency owner opt-in', () => {
  assert.match(dashboard, /Boolean\(isOwner && privateFinance\)/);
  assert.match(dashboard, /useAgencyFinancials\(orgId, financialView\)/);
});
check('Protected routes are role-gated for Owner Console and money views', () => {
  assert.match(app, /allowedRoles=\{\['agency_owner'\]\}/);
  assert.match(app, /allowedRoles=\{FINANCIAL_ROLES\}/);
});
check('Company approval records require owner/admin and are audited at database level', () => {
  assert.match(migration2, /Only Owner\/Admin can confirm external approvals/);
  assert.match(migration2, /company_approval_handoffs/);
  assert.match(migration2, /INSERT INTO public\.audit_logs/);
});
check('Department handoffs have privileged RPC restrictions', () => {
  assert.match(migration3, /SECURITY DEFINER/);
  assert.match(migration3, /REVOKE ALL ON FUNCTION/);
  assert.match(migration3, /GRANT EXECUTE ON FUNCTION/);
});
check('Supply receipt, dispatch and direct-install RPCs exist', () => {
  for (const name of ['phase4_create_supply_dispatch','phase4_confirm_supply_receipt','phase4_create_direct_install_site']) assert.ok(migration4.includes(name), name);
});
check('Supply receipt RLS and server invoice gate exist', () => {
  assert.match(migration4, /supply_delivery_receipts ENABLE ROW LEVEL SECURITY/);
  assert.match(migration4, /phase4_guard_invoice_delivery/);
});
check('No deploy credentials or actual local .env are part of source ZIP', () => {
  assert.ok(!fs.existsSync(path.join(root, '.env')));
  assert.ok(!fs.existsSync(path.join(root, '.env.local')));
  assert.doesNotMatch(read('.env.example'), /(?:eyJ[A-Za-z0-9_-]{50}|sb_secret_[A-Za-z0-9_-]{10})/);
});
check('All application TS/TSX sources parse with the TypeScript compiler', () => {
  const walk = d => fs.readdirSync(d,{withFileTypes:true}).flatMap(x => x.isDirectory() ? walk(path.join(d,x.name)) : /\.tsx?$/.test(x.name) ? [path.join(d,x.name)] : []);
  const files = walk(path.join(root, 'src'));
  assert.ok(files.length > 40);
  for (const file of files) {
    const source = ts.createSourceFile(file, fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true,file.endsWith('tsx')?ts.ScriptKind.TSX:ts.ScriptKind.TS);
    assert.equal(source.parseDiagnostics.length,0, file + ': ' + source.parseDiagnostics.map(d=>ts.flattenDiagnosticMessageText(d.messageText,' ')).join(';'));
  }
  console.log(`  Verified ${files.length} TypeScript/TSX source files`);
});
console.log(`ALL ${passed} PHASE 7 SECURITY/SOURCE CHECKS PASSED`);
