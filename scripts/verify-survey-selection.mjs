import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('typescript');

// Compile only the pure helper; no Supabase or browser services required.
const source = readFileSync('src/lib/surveyReviewSelection.ts', 'utf8');
const transpiled = ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020,
}, reportDiagnostics: true });
assert.equal(transpiled.diagnostics?.length || 0, 0, 'selection helper syntax');
const moduleShim = { exports: {} };
new Function('module', 'exports', transpiled.outputText)(moduleShim, moduleShim.exports);
const { surveyReviewSelectionModel } = moduleShim.exports;
const item = id => ({ id });
const photo = id => ({ id });
const m = (p,i) => ({ survey_photo_id:p, work_item_id:i });
const plan = (items,photos,markings=[],decisions=[]) => surveyReviewSelectionModel({items:items.map(item),photos:photos.map(photo),markings:markings.map(([p,i])=>m(p,i)),links:[],decisions});
const keys = xs => xs.map(x => `${x.type}:${x.id}`).sort();
const check = (name, fn) => { fn(); console.log(`PASS ${name}`); };

check('one item + one linked image = ONE selection and TWO server decisions',()=>{
  const x=plan(['A'],['P'],[['P','A']]);
  assert.deepEqual(keys(x.choices),['measurement:A']);
  assert.deepEqual(keys(x.expand(new Set(['measurement:A']),'approved')),['measurement:A','survey_photo:P']);
  assert.deepEqual(keys(x.expand(new Set(['measurement:A']),'redo')),['measurement:A','survey_photo:P']);
});
check('one work item with 2 linked photos = one checkbox; no duplicate target',()=>{
  const x=plan(['A'],['P','Q'],[['P','A'],['Q','A'],['P','A']]);
  assert.equal(x.choices.length,1);
  assert.deepEqual(keys(x.expand(new Set(['measurement:A']),'approved')),['measurement:A','survey_photo:P','survey_photo:Q']);
});
check('shared photo two boards: partial approval must NOT also review other board',()=>{
  const x=plan(['A','B'],['P'],[['P','A'],['P','B']]);
  assert.equal(x.choices.length,2);
  assert.deepEqual(keys(x.expand(new Set(['measurement:A']),'approved')),['measurement:A']);
  assert.deepEqual(keys(x.expand(new Set(['measurement:A','measurement:B']),'approved')),['measurement:A','measurement:B','survey_photo:P']);
});
check('shared photo auto-decided when other board was already approved',()=>{
  const x=plan(['A','B'],['P'],[['P','A'],['P','B']],[{entity_type:'measurement',entity_id:'A',decision:'approved'}]);
  assert.deepEqual(keys(x.choices),['measurement:B']);
  assert.deepEqual(keys(x.expand(new Set(['measurement:B']),'approved')),['measurement:B','survey_photo:P']);
  assert.deepEqual(keys(x.expand(new Set(['measurement:B']),'redo')),['measurement:B']);
});
check('orphan photo has exactly one independent selection',()=>{
  const x=plan(['A'],['P']);
  assert.deepEqual(keys(x.choices),['measurement:A','survey_photo:P']);
  assert.deepEqual(keys(x.expand(new Set(['survey_photo:P']),'redo')),['survey_photo:P']);
});
check('once all linked items have decisions, photo can be reviewed separately',()=>{
  const x=plan(['A'],['P'],[['P','A']],[{entity_type:'measurement',entity_id:'A',decision:'approved'}]);
  assert.deepEqual(keys(x.choices),['survey_photo:P']);
});
check('already-reviewed photo never sent again',()=>{
  const x=plan(['A'],['P'],[['P','A']],[{entity_type:'survey_photo',entity_id:'P',decision:'approved'}]);
  assert.deepEqual(keys(x.expand(new Set(['measurement:A']),'approved')),['measurement:A']);
});
check('stale UI selection cannot approve unseen items',()=>{
  const x=plan(['A'],['P'],[['P','A']]);
  assert.deepEqual(keys(x.expand(new Set(['measurement:X']),'approved')),[]);
});
check('unrelated image never auto-included',()=>{
  const x=plan(['A'],['P','Q'],[['P','A']]);
  assert.deepEqual(keys(x.expand(new Set(['measurement:A']),'approved')),['measurement:A','survey_photo:P']);
});
check('explicit photo-to-item links work even without polygon rows',()=>{
  const x=surveyReviewSelectionModel({items:[item('A')],photos:[photo('P')],markings:[],links:[{survey_photo_id:'P',work_item_id:'A'}],decisions:[]});
  assert.equal(x.choices.length,1);
  assert.deepEqual(keys(x.expand(new Set(['measurement:A']),'approved')),['measurement:A','survey_photo:P']);
});
check('fully approved evidence is no longer selectable',()=>{
  const x=plan(['A'],['P'],[['P','A']],[
    {entity_type:'measurement',entity_id:'A',decision:'approved'},
    {entity_type:'survey_photo',entity_id:'P',decision:'approved'}]);
  assert.equal(x.choices.length,0);
  assert.deepEqual(x.expand(new Set(['measurement:A']),'approved'),[]);
});
check('different decision on other board never automatically redoes shared photo',()=>{
  const x=plan(['A','B'],['P'],[['P','A'],['P','B']],[{entity_type:'measurement',entity_id:'A',decision:'approved'}]);
  assert.deepEqual(keys(x.expand(new Set(['measurement:B']),'redo')),['measurement:B']);
});
const gallery = readFileSync('src/components/SurveyReviewGallery.tsx','utf8');
assert.ok(gallery.includes('selectionPlan.expand'));
assert.ok(gallery.includes('selectionPlan.choices'));
assert.ok(!gallery.includes('2 selected') && !gallery.includes('window.confirm'));
console.log('PASS gallery wiring checks');
