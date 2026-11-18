/** Design Review v11 focused regression: pure coverage + atomic RPC + UI source. */
const fs = require('fs');
const assert = require('node:assert/strict');
const ts = require('/opt/nvm/versions/node/v22.16.0/lib/node_modules/typescript');
const page = fs.readFileSync('src/pages/DesignerPage.tsx', 'utf8');
const component = fs.readFileSync('src/components/CompanyApprovalHandoff.tsx', 'utf8');
const lib = fs.readFileSync('src/lib/designReview.ts', 'utf8');
const sql = fs.readFileSync('supabase/migrations/20261118110000_0119_design_review_one_step_atomic.sql', 'utf8');
let total = 0;
function test(label, fn) { fn(); total++; console.log(`PASS ${label}`); }
for (const [file,kind] of [
  ['src/pages/DesignerPage.tsx',ts.ScriptKind.TSX],
  ['src/components/CompanyApprovalHandoff.tsx',ts.ScriptKind.TSX],
  ['src/lib/designReview.ts',ts.ScriptKind.TS],
]) {
  test(`Parses ${file}`, () => {
    const src = fs.readFileSync(file,'utf8');
    const result = ts.createSourceFile(file,src,ts.ScriptTarget.Latest,true,kind);
    assert.equal(result.parseDiagnostics.length,0,result.parseDiagnostics.map(e=>e.messageText).join('; '));
  });
}
const js = ts.transpileModule(lib,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
const moduleObject = {exports:{}};
new Function('module','exports',js)(moduleObject,moduleObject.exports);
const {latestReviewArtworkByItem,reviewArtworkCoverage,validateDesignCorrection} = moduleObject.exports;
const files = [
  {id:'v1',version_number:1,status:'approved',file_url:'https://foo/old.pdf',file_name:'old.pdf'},
  {id:'v2',version_number:2,status:'uploaded',file_url:'https://foo/new.pdf',file_name:'new.pdf'},
  {id:'bad',version_number:9,status:'rejected',file_url:'https://foo/bad.pdf'},
  {id:'gone',version_number:10,status:'deleted',file_url:'https://foo/gone.pdf'},
  {id:'empty',version_number:11,status:'uploaded',file_url:'  '},
];
const links=[
  {design_version_id:'v1',work_item_id:'a'},
  {design_version_id:'v2',work_item_id:'a'},
  {design_version_id:'v2',work_item_id:'b'},
  {design_version_id:'bad',work_item_id:'a'},
  {design_version_id:'gone',work_item_id:'b'},
  {design_version_id:'empty',work_item_id:'c'},
];
const artwork = latestReviewArtworkByItem(files,links);
test('Newer usable artwork wins over older version',()=>assert.equal(artwork.get('a').id,'v2'));
test('One explicitly shared file covers two mapped boards',()=>assert.equal(artwork.get('b').id,'v2'));
test('Rejected/deleted artwork ignored',()=>assert.notEqual(artwork.get('a').id,'bad'));
test('Empty artwork URL does not satisfy review',()=>assert.equal(artwork.has('c'),false));
test('Unmapped board is never covered by another board file',()=>assert.equal(artwork.has('outside'),false));
test('Complete multi-board art passes',()=>assert.equal(reviewArtworkCoverage([{id:'a'},{id:'b'}],artwork).ready,true));
test('Missing/empty board coverage blocks approval',()=>{assert.equal(reviewArtworkCoverage([{id:'a'},{id:'c'}],artwork).ready,false);assert.equal(reviewArtworkCoverage([],artwork).ready,false);});
test('Missing correction selection blocked',()=>assert.match(validateDesignCorrection([{id:'a'}],[],'note'),/Select/));
test('Missing reason blocked',()=>assert.match(validateDesignCorrection([{id:'a'}],['a'],'  '),/note/));
test('Wrong shop board selection blocked',()=>assert.match(validateDesignCorrection([{id:'a'}],['b'],'Fix'),/Invalid/));
test('Duplicate board correction selection blocked',()=>assert.match(validateDesignCorrection([{id:'a'}],['a','a'],'Fix'),/Invalid/));
test('Valid multiple corrections allowed',()=>assert.equal(validateDesignCorrection([{id:'a'},{id:'b'}],['a','b'],'Please correct'),null));

test('Modal contains one board comparison list',()=>assert.equal((page.match(/data-testid="design-review-board-list"/g)||[]).length,1));
test('No second item-review decision panel in Design modal',()=>assert.doesNotMatch(page,/ItemLevelReviewPanel/));
test('No duplicate expanded-row Approve Design / Redo controls',()=>{assert.doesNotMatch(page,/Redo \/ Changes/);assert.doesNotMatch(page,/onClick=\{\(\) => updateStatusMutation\.mutate\(\{ row, status: 'approved'/);});
test('Review action includes explicit selected work items and note',()=>assert.match(page,/redoIds: \[\.\.\.reviewCorrectionIds\], note: changesNote/));
test('Review approval is gated by coverage and company approval',()=>assert.match(page,/!reviewCoverage\.ready \|\| !companyGateReady/));
test('Correction path stays available when artwork is missing',()=>assert.match(page,/Request Changes[\s\S]*?Approve Design/));
test('Client upload/review and production handoff kept',()=>{assert.match(page,/Upload & Send for Review/);assert.match(page,/phase3_send_to_production/);assert.match(page,/openUploadModal/);});
test('No direct design task approve writes remain',()=>assert.doesNotMatch(page,/\.update\(\{ status: 'approved', completed_at/));
test('Guided and single decisions use one atomic RPC per shop',()=>{assert.match(page,/async function decideDesignReview/);assert.match(page,/reviewSelectedShops\(selInReview\)/);assert.match(page,/decideDesignReview\(row, redoIds, note\)/);});
test('Company handoff still runs and hides historical-only notice in Design',()=>{assert.match(page,/CompanyApprovalHandoff stage="design"/);assert.match(component,/hideWhenNotRequired/);});
test('Large queue still uses server pagination',()=>assert.match(page,/\.range\(from, to\)/));
test('Design routes do not grant designer approval privileges',()=>assert.match(page,/const canApprove = profile\?\.role === 'agency_owner' \|\| profile\?\.role === 'admin'/));

test('SQL checks role, org, status and locks live task',()=>{assert.match(sql,/public\.current_role\(\) NOT IN \('agency_owner','admin'\)/);assert.match(sql,/FOR UPDATE/);assert.match(sql,/v_status <> 'in_review'/);assert.match(sql,/current_org_id/);});
test('SQL prevents cross-shop and duplicate correction selections',()=>{assert.match(sql,/v_bad_ids>0/);assert.match(sql,/v_unique_redo/);});
test('SQL validates file-task-work-item links and missing evidence',()=>{assert.match(sql,/public\.design_version_items/);assert.match(sql,/dv\.design_task_id=p_task_id/);assert.match(sql,/v_missing_artwork>0/);});
test('SQL handles selected corrections and approval in one transaction',()=>{assert.match(sql,/v_redo_json,'redo'/);assert.match(sql,/v_approve_json,'approved'/);assert.match(sql,/p_task_id,NULL,'approved'/);});
test('SQL preserves company gate via existing review_apply',()=>assert.match(sql,/public\.review_apply/));
test('SQL grants only authenticated actors and audits',()=>{assert.match(sql,/REVOKE ALL .* FROM PUBLIC, anon/);assert.match(sql,/GRANT EXECUTE .* TO authenticated/);assert.match(sql,/INSERT INTO public\.audit_logs/);});
test('Redo requires newer artwork on the affected board before resubmission',()=>{assert.match(sql,/CREATE TRIGGER trg_design_review_fresh_corrections/);assert.match(sql,/c\.status='open'/);assert.match(sql,/vi\.work_item_id=c\.work_item_id/);assert.match(sql,/dv\.created_at>c\.created_at/);});

// Exercise the actual frontend RPC wrapper with a minimal Supabase mock.
const beginning=page.indexOf('async function decideDesignReview(');
const end=page.indexOf('async function sendDesignTaskToProduction(',beginning);
assert(beginning>0 && end>beginning);
const wrapped=ts.transpileModule(page.slice(beginning,end),{compilerOptions:{module:ts.ModuleKind.None,target:ts.ScriptTarget.ES2020}}).outputText;
async function rpcFixture(error){
 const calls=[];
 const supabase={rpc:async(name,args)=>{calls.push({name,args});return {data:{finalized:true},error:error||null};}};
 const decide=new Function('supabase',wrapped+'\nreturn decideDesignReview;')(supabase);
 return {decide,calls};
}
(async()=>{
 test('RPC fixture initialized',()=>assert.equal(typeof rpcFixture,'function'));
 let m=await rpcFixture();await m.decide({design_task_id:'task-1'});
 test('Approval sends one atomic RPC with no redos',()=>assert.deepEqual(m.calls,[{name:'design_review_decide',args:{p_task_id:'task-1',p_redo_item_ids:[],p_note:null}}]));
 m=await rpcFixture();await m.decide({design_task_id:'task-2'},['board-3'],'  correct logo ');
 test('Correction sends exact IDs and trimmed note',()=>assert.deepEqual(m.calls[0].args,{p_task_id:'task-2',p_redo_item_ids:['board-3'],p_note:'correct logo'}));
 m=await rpcFixture({message:'This design is no longer awaiting review'});
 await assert.rejects(m.decide({design_task_id:'task-1'}),/no longer awaiting review/);
 test('Database stale-state errors visible',()=>assert.equal(m.calls.length,1));
 m=await rpcFixture({message:'Could not find the function design_review_decide'});
 await assert.rejects(m.decide({design_task_id:'task-1'}),/migration 0119/);
 test('Missing migration gives actionable message',()=>assert.equal(m.calls.length,1));
 console.log(`\nALL ${total} DESIGN REVIEW V11 CHECKS PASSED`);
})().catch(error=>{console.error(error);process.exitCode=1});
