// Regression guard: removed public-sharing feature must not be referenced
// by the 0112 migration, which is deployed after migration 0066.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, 'supabase', 'migrations', name), 'utf8');
const removed = read('20261002090000_0066_remove_public_shop_share_links.sql');
const migration = read('20261031131000_0112_integrity_and_rpc_hardening.sql');
const assertions = [
 ['0066 removes defunct share link table', () => assert.match(removed, /DROP TABLE IF EXISTS public\.shop_share_links\s*;/)],
 ['0066 removes public share RPC', () => assert.match(removed, /DROP FUNCTION IF EXISTS public\.get_shared_shop_view\(text\)/)],
 ['0112 does not reference dropped share link table', () => assert.doesNotMatch(migration, /\b(?:ON\s+)?public\.shop_share_links\b/i)],
 ['0112 retains purchase-order integrity guard', () => assert.match(migration, /CREATE TRIGGER trg_guard_po_business_identity/)],
 ['0112 retains shop integrity guard', () => assert.match(migration, /CREATE TRIGGER trg_guard_shop_business_identity/)],
 ['0112 retains tenant-scoped notification guard', () => assert.match(migration, /CREATE POLICY security_notify_insert/)],
];
let failures=0;
for (const [name, fn] of assertions) {try {fn(); console.log('PASS',name)} catch(e) {failures++;console.log('FAIL',name,e.message)}}
console.log(`${assertions.length-failures}/${assertions.length} passed`);
if (failures) process.exitCode = 1;
