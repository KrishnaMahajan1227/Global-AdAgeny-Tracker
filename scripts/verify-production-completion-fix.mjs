/** Dependency-free static regression check for Production Stage Completion fix.
 * Run: node scripts/verify-production-completion-fix.mjs
 * These checks do NOT replace executing migrations on a staging Postgres DB.
 */
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const old = read('supabase/migrations/20261019090000_0083_client_level_folder_browse.sql');
const sql = read('supabase/migrations/20261030180000_0103_production_completion_stage_reconciliation.sql');
const guard = read('supabase/migrations/20261030181000_0104_production_completion_guard.sql');
const page = read('src/pages/ProductionPage.tsx');
function check(label, fn) { fn(); process.stdout.write(`PASS ${label}\n`); }
function selectClause(source) {
  return source.split('CREATE OR REPLACE VIEW public.v_production_order_list AS')[1]
    .split('\nSELECT\n')[1].split('\nFROM public.production_orders')[0].trim();
}
function cols(select) {
  let depth = 0, quote = false, pos = 0;
  const out = [];
  for (let i = 0; i < select.length; i++) {
    const c = select[i];
    if (c === "'" && select[i - 1] !== "'") quote = !quote;
    if (quote) continue;
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (depth === 0 && c === ',') { out.push(select.slice(pos, i).trim()); pos = i + 1; }
  }
  out.push(select.slice(pos).trim());
  return out.map(expr => {
    const alias = expr.match(/\bAS\s+([a-z_][\w]*)\s*$/i);
    const raw = expr.match(/\b(?:\w+\.)?([a-z_][\w]*)\s*$/i);
    assert.ok(alias || raw, 'Could not identify view column from: ' + expr);
    return alias?.[1] ?? raw[1];
  });
}
check('Postgres view existing column order and names preserved', () => {
  assert.deepEqual(cols(selectClause(sql)), cols(selectClause(old)));
  assert.equal(cols(selectClause(sql)).length, 34);
});
check('Completed production stage reaches 100 independent of quantity completeness', () => {
  assert.match(sql, /END AS status/);
  assert.match(sql, /THEN 100::numeric/);
  assert.match(sql, /END AS progress_pct/);
  assert.match(sql, /s\.status IN \(\s*'production_done', 'dispatched', 'delivered', 'installation_pending'/);
  assert.match(page, /const stageProgress = row\.status === 'completed' \? 100 : row\.progress_pct;/);
  assert.match(page, /style=\{\{ width: `\$\{stageProgress\}%` \}\}/);
});
check('Completed orders have no false pending or BOM queue counts', () => {
  assert.match(sql, /0::bigint ELSE COALESCE\(bc\.pending_boards, 0\) END AS pending_boards/);
  assert.match(sql, /0::bigint ELSE COALESCE\(bc\.materials_pending_boards, 0\) END AS materials_pending_boards/);
  assert.match(sql, /THEN 3\s+WHEN COALESCE\(bc\.materials_pending_boards/);
});
check('Historical installed items remain readable and unavailable boards excluded', () => {
  assert.match(sql, /'production_done', 'installed'\)\s+AND NOT COALESCE\(wi\.excluded_from_calculations, false\)/);
  assert.match(page, /const PRODUCTION_ELIGIBLE_STATUSES = \[.*'installed'\]/);
});
check('Closed production rows are readonly, avoid misleading 0\/0', () => {
  assert.match(page, /row\.status !== 'completed' && <button/);
  assert.match(page, /if \(row\.status === 'completed'\) return/);
  assert.match(page, /const locked = entry\.locked \|\| row\.status === 'completed'/);
  assert.match(page, /row\.status === 'completed' \? 'Production is completed, but no board-level records/);
  assert.match(page, /no quantities have been assumed/);
});
check('Completion stays atomic, role-checked and prevents reopen', () => {
  assert.match(page, /supabase\.rpc\('phase3_complete_production'/);
  assert.match(guard, /IF OLD\.status = 'completed' THEN/);
  assert.match(guard, /IF NEW\.status = 'completed' AND current_setting\('app\.phase3_handoff', true\) IS DISTINCT FROM 'on'/);
  assert.match(guard, /BEFORE UPDATE OF status ON public\.production_orders/);
});
check('Read view migration makes no work/quantity writes', () => {
  assert.doesNotMatch(sql, /\b(?:UPDATE|INSERT INTO|DELETE FROM|TRUNCATE)\s+public\.(?:production_orders|work_items|production_items)\b/i);
});
console.log('ALL PRODUCTION COMPLETION STATIC REGRESSIONS PASSED. Live staging tests still required.');
