import fs from 'node:fs';
import ts from 'typescript';
import vm from 'node:vm';
let passed=0;
function test(name, action){try{action();passed++;console.log('PASS',name);}catch(e){console.error('FAIL',name,e);process.exitCode=1;}}
const helper=fs.readFileSync('src/lib/surveyReviewSelection.ts','utf8');
const js=ts.transpileModule(helper,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
const mod={exports:{}};
vm.runInNewContext(js,{module:mod,exports:mod.exports,Set,Map,Error});
const model=mod.exports.surveyReviewSelectionModel;
const args={items:[{id:'w1'}],photos:[{id:'p1'}],markings:[{survey_photo_id:'p1',work_item_id:'w1'}],links:[],decisions:[]};
test('one linked image and item = one checkbox',()=>{if(model(args).choices.length!==1)throw Error('duplicate count');});
test('approve expands to both server records',()=>{const r=model(args).expand(new Set(['measurement:w1']),'approved');if(r.length!==2)throw Error(JSON.stringify(r));});
test('measurement-only redo targets measurement, not photo',()=>{const r=model(args).expand(new Set(['measurement:w1']),'redo','measurement');if(r.length!==1||r[0].type!=='measurement')throw Error(JSON.stringify(r));});
test('photo-only redo targets photo, not measurement',()=>{const r=model(args).expand(new Set(['measurement:w1']),'redo','photo');if(r.length!==1||r[0].type!=='survey_photo')throw Error(JSON.stringify(r));});
const shared={items:[{id:'w1'},{id:'w2'}],photos:[{id:'p1'}],markings:[{survey_photo_id:'p1',work_item_id:'w1'},{survey_photo_id:'p1',work_item_id:'w2'}],links:[],decisions:[]};
test('shared photo only one item selected for redo does not affect photo',()=>{const r=model(shared).expand(new Set(['measurement:w1']),'redo','both');if(r.length!==1||r[0].type!=='measurement')throw Error(JSON.stringify(r));});
test('shared photo photo-only redo requires all linked boards',()=>{let blocked=false;try{model(shared).expand(new Set(['measurement:w1']),'redo','photo');}catch{blocked=true;}if(!blocked)throw Error('shared image accidentally rejected');});
test('shared photo photo-only redo succeeds with all linked boards',()=>{const r=model(shared).expand(new Set(['measurement:w1','measurement:w2']),'redo','photo');if(r.length!==1||r[0].type!=='survey_photo')throw Error(JSON.stringify(r));});
test('single item with two photos can reject exactly one image',()=>{const data={items:[{id:'w1'}],photos:[{id:'p1'},{id:'p2'}],markings:[{survey_photo_id:'p1',work_item_id:'w1'},{survey_photo_id:'p2',work_item_id:'w1'}],links:[],decisions:[]};const r=model(data).expand(new Set(['measurement:w1']),'redo','photo','p2');if(r.length!==1||r[0].id!=='p2')throw Error(JSON.stringify(r));});
test('independent unlinked photo can be rejected',()=>{const m=model({...args,photos:[{id:'p1'},{id:'p2'}]});const r=m.expand(new Set(['survey_photo:p2']),'redo','photo');if(r.length!==1||r[0].id!=='p2')throw Error(JSON.stringify(r));});
test('already-approved work item cannot be selected again',()=>{const m=model({...args,decisions:[{entity_type:'measurement',entity_id:'w1',decision:'approved'}]});if(m.choices.some(x=>x.id==='w1'&&x.type==='measurement'))throw Error('duplicate review');});
for(const f of ['src/components/SurveyReviewGallery.tsx','src/pages/SupplyOrdersPage.tsx','src/lib/surveyReviewSelection.ts']){
 test('TS/TSX syntax '+f,()=>{const source=fs.readFileSync(f,'utf8');const sf=ts.createSourceFile(f,source,ts.ScriptTarget.Latest,true,f.endsWith('.tsx')?ts.ScriptKind.TSX:ts.ScriptKind.TS);if(sf.parseDiagnostics.length)throw Error(sf.parseDiagnostics.map(d=>d.messageText).join('\n'));});
}
console.log(`${passed} checks passed`);
