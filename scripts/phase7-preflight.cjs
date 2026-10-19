'use strict';
/** Run `node scripts/phase7-preflight.cjs` locally. No credentials printed. */
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const root = path.resolve(__dirname, '..');
const result = { pass: [], warn: [], fail: [] };
function log(type,msg) { result[type].push(msg); }
function exists(p) { return fs.existsSync(path.join(root,p)); }
if (exists('package-lock.json')) log('pass','Lockfile available for reproducible npm ci.');
else log('fail','Missing package-lock.json');
if (exists('.env')) {
  const env = fs.readFileSync(path.join(root,'.env'),'utf8');
  for (const field of ['VITE_SUPABASE_URL']) {
    if (!new RegExp('^'+field+'=\\S+','m').test(env)) log('fail',`${field} not configured`);
  }
  if (!/^VITE_SUPABASE_(?:PUBLISHABLE_KEY|ANON_KEY)=\S+/m.test(env)) log('fail','Supabase publishable/anon key not configured');
  if (/^VITE_[A-Z0-9_]*(?:SERVICE_ROLE|SECRET_KEY|PRIVATE_KEY)[A-Z0-9_]*=/m.test(env)) log('fail','A secret-looking VITE_ variable is exposed to the browser. Remove it immediately.');
  if (!result.fail.length) log('pass','Required client environment names are configured; secret patterns not detected.');
} else log('warn','No local .env (expected in distributed ZIP): copy your existing safe .env before building.');
const migrations = ['20261027100000_0097_phase1_production_install.sql','20261028100000_0098_phase2_company_approval_handoff.sql','20261029100000_0099_phase3_atomic_department_handoffs.sql','20261030100000_0100_phase4_supply_delivery_integrity.sql'];
for(const m of migrations) if (!exists('supabase/migrations/'+m)) log('fail',`Required migration missing: ${m}`);
if (!result.fail.some(x=>x.includes('migration'))) log('pass','Phase 1–4 migration sources included; applied state MUST be confirmed with Supabase migration list.');
if (!exists('node_modules/.bin/vite')) log('warn','Vite dependencies not installed. Run npm ci, typecheck and build on your workstation/CI.');
else log('pass','Local Vite binary available (run npm run build).');
const check = cp.spawnSync(process.execPath,[path.join(root,'scripts/verify-phase7-security.cjs')],{encoding:'utf8',timeout:60000});
if(check.status === 0) log('pass','Phase 7 source security tests pass.');
else log('fail',`Phase 7 source tests failed: ${(check.stderr||check.stdout||'').slice(-450)}`);
for(const level of ['pass','warn','fail']) for(const msg of result[level]) console.log(`${level.toUpperCase()}: ${msg}`);
if(result.fail.length) { console.error('Preflight FAILED. Do not deploy.'); process.exitCode=1; }
else { console.log('Source preflight finished. Live DB/RLS, build, E2E and billing concurrency checks remain mandatory.'); }
