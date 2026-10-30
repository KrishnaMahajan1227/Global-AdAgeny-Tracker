/** Adroute Designer V9 source-level fast-flow and mapping regression tests.
 * This does NOT replace authenticated browser + Supabase Storage/RLS testing.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const pagePath = path.join(root, 'src/pages/DesignerPage.tsx');
const helperPath = path.join(root, 'src/lib/designArtworkMapping.ts');
const page = fs.readFileSync(pagePath, 'utf8');
const helper = fs.readFileSync(helperPath, 'utf8');
let n = 0;
function check(name, fn) {
  try { fn(); ++n; console.log('PASS', name); }
  catch (error) { console.error('FAIL', name, error); process.exitCode = 1; throw error; }
}
const mod = new Module(helperPath, module);
mod.filename = helperPath;
mod.paths = module.paths;
mod._compile(ts.transpileModule(helper, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, helperPath);
const { designCoverage, validateArtworkMappings, editableDesignBoards } = mod.exports;
const b = (id, status='approved') => ({ id, status });
const v = (id, status='uploaded') => ({ id, status });
const l = (id, work_item_id) => ({ design_version_id: id, work_item_id });
const f = (id, workItemIds=[]) => ({ id, workItemIds });
for (const fname of ['src/pages/DesignerPage.tsx','src/components/DesignMarkingPreview.tsx','src/lib/designArtworkMapping.ts']) {
  const fp = path.join(root, fname);
  const ast = ts.createSourceFile(fp, fs.readFileSync(fp,'utf8'), ts.ScriptTarget.Latest, true, fp.endsWith('tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  check(fname + ' syntax', () => assert.deepEqual(ast.parseDiagnostics.map(e => e.messageText), []));
}
check('owner/admin and assigned Designer share upload entry', () => assert.match(page, /const canEditArtwork = isDesigner \|\| canApprove/));
check('one-click owner/admin queue action', () => assert.match(page, /\{canEditArtwork && \(!isDesigner \|\| row\.designer_id === profile\?\.id\) && !row\.requires_design_all_false && \['assigned', 'designing', 'design_ready'\]/));
check('owner/admin may upload from expanded task', () => assert.match(page, /\{canEditArtwork && \(!isDesigner \|\| row\.designer_id === profile\?\.id\) && !row\.requires_design_all_false && \['assigned', 'designing', 'design_ready', 'in_review'\]/));
check('designers are limited to assigned tasks', () => assert.match(page, /currentTask\.designer_id !== profile\.id/));
check('ownership checked against live task organization and shop', () => assert.match(page, /currentTask\.organization_id !== orgId \|\| currentTask\.shop_id !== uploadTask\.shop_id/));
check('no anonymous upload', () => assert.match(page, /if \(!uploadTask \|\| !profile\) throw/));
check('org scope checked before upload', () => assert.match(page, /profile\.organization_id !== uploadTask\.organization_id/));
check('review submission belongs to assigned designer or reviewer', () => assert.match(page, /canApprove \|\| \(isDesigner && row\.designer_id === profile\?\.id\)/));
check('approval and production gate stays owner/admin', () => assert.match(page, /status === 'approved' \|\| status === 'ready_for_production'/));
check('company approval workflow retained', () => assert.match(page, /CompanyApprovalHandoff/));
check('single upload and review in same primary action', () => assert.match(page, /Upload & Send for Review/));
check('draft available as optional explicit action', () => assert.match(page, /uploadMutation\.mutate\(\{ submitAfterUpload: false \}\)/));
check('submit intent specific to action, not stale state', () => assert.match(page, /mutationFn: async \(\{ submitAfterUpload \}: \{ submitAfterUpload: boolean \}\)/));
check('upload confirmation checkbox removed', () => assert.doesNotMatch(page, /Send this shop for review after upload \(no second button\)/));
check('reuse existing complete designs without reupload', () => assert.match(page, /Send existing mapped artwork for review/));
check('saved artwork review goes through full live evidence coverage', () => assert.match(page, /const liveDetail = await fetchShopDetail\(row\.shop_id, row\.design_task_id\)/));
check('saved artwork link is per work item', () => assert.match(page, /\.filter\(link => link\.work_item_id === item\.id\)/));
check('safe explicit shared art assignment', () => assert.match(page, /Apply to \{uncoveredEditableItemIds\.length\} unmapped item/));
check('only editable uncovered items mapped by shortcut', () => assert.match(page, /uploadEditableItems\.filter\(item => !uploadCoverage\.covered\.has\(item\.id\)\)/));
check('multi-artwork never blindly maps to all boards', () => assert.doesNotMatch(page, /selectedItemIds/));
check('all new versions linked file-by-file', () => assert.match(page, /entry\.workItemIds\.map\(workItemId =>/));
check('partial changes do not cause premature review', () => assert.match(page, /submitAfterUpload && canSubmitUploadForReview \? 'in_review' : 'design_ready'/));
check('company/agency design source stays tracked', () => assert.match(page, /source: batchSource/));
check('bulk send review reuses full marking coverage validation', () => assert.match(page, /Same evidence-coverage rule as single task submit[\s\S]*?designCoverage\(liveDetail\.items, liveDetail\.versions, liveDetail\.versionItems, \[\]\)\.ready/));
check('bulk send review checks stale design status', () => assert.match(page, /eq\('status', 'design_ready'\)\.select\('id'\)/));
check('single reviewer actions use stale-status compare-and-swap', () => assert.match(page, /eq\('status', row\.status\)\.select\('id'\)/));
check('uploaded files verified against live shop items', () => assert.match(page, /eq\('shop_id', uploadTask\.shop_id\)\.in\('id', mappedItemIds\)/));
check('wrong shop mapping rejected', () => assert.match(validateArtworkMappings([b('a')], [f('x', ['foreign'])]), /another shop/));
check('missing work items block', () => assert.match(validateArtworkMappings([], [f('x', ['x'])]), /No Work Items/));
check('unmapped selected file blocked', () => assert.match(validateArtworkMappings([b('a')], [f('x')]), /Map artwork/));
check('single item mapped automatically', () => assert.equal(validateArtworkMappings([b('a')], [f('x', ['a'])]), null));
check('many items map independently', () => {
  const items = Array.from({length: 250}, (_, i)=>b('item'+i));
  const files = items.map((it,i)=>f('file'+i, [it.id]));
  assert.equal(validateArtworkMappings(items,files), null);
  assert.equal(designCoverage(items,[],[],files).ready, true);
});
check('one explicit artwork can cover many items', () => assert.equal(designCoverage([b('a'),b('b'),b('c')],[],[],[f('shared',['a','b','c'])]).ready,true));
check('partially mapped design stays draft', () => assert.equal(designCoverage([b('a'),b('b')],[],[],[f('file',['a'])]).ready,false));
check('earlier valid version fulfills completed board without re-upload', () => assert.equal(designCoverage([b('a','designed'),b('b')],[v('old')],[l('old','a')],[f('new',['b'])]).ready,true));
check('review can use all valid existing artwork', () => assert.equal(designCoverage([b('a','designed'),b('b','designed')],[v('one'),v('two')],[l('one','a'),l('two','b')],[]).ready,true));
check('rejected old design cannot satisfy review', () => assert.equal(designCoverage([b('a')],[v('old','rejected')],[l('old','a')],[]).ready,false));
check('unapproved survey work item never bypasses approval', () => assert.equal(designCoverage([b('a','surveyed')],[],[],[f('x',['a'])]).ready,false));
check('production locked item cannot be remapped', () => assert.match(validateArtworkMappings([b('a','in_production')], [f('x',['a'])]), /editable/));
check('locked item not included in uncovered editable shortcut', () => assert.deepEqual(editableDesignBoards([b('a','design_approved'),b('b','approved')]).map(x=>x.id), ['b']));
check('explicit duplicate marking blocked', () => assert.match(validateArtworkMappings([b('a')], [f('x',['a','a'])]), /twice/));
console.log(`\n${n} Designer V9 source/logic checks passed (live staging still required).`);
