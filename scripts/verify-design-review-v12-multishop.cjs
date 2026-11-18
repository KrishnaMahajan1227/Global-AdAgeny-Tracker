/** AdRoute Design Review v12: single shop, multi-board, multi-artwork batch and guided multi-shop. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('/opt/nvm/versions/node/v22.16.0/lib/node_modules/typescript');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(root,p),'utf8');
const helper = read('src/lib/designReview.ts');
const page = read('src/pages/DesignerPage.tsx');
const production = read('src/pages/ProductionPage.tsx');
const shops = read('src/pages/ShopsPages.tsx');
const sql = read('supabase/migrations/20261118140000_0120_design_review_board_artwork_approval.sql');
let passed = 0;
const check = (name, fn) => { fn(); ++passed; process.stdout.write(`PASS ${name}\n`); };
for (const file of ['src/lib/designReview.ts','src/pages/DesignerPage.tsx','src/pages/ShopsPages.tsx','src/pages/ProductionPage.tsx']) {
 const source=read(file);
 check(`${file} TS/TSX parse`,()=>assert.equal(ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,file.endsWith('.tsx')?ts.ScriptKind.TSX:ts.ScriptKind.TS).parseDiagnostics.length,0));
}
const js=ts.transpileModule(helper,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
const m={exports:{}};new Function('module','exports',js)(m,m.exports);
const {latestReviewArtworkGroupByItem,latestReviewArtworkByItem,reviewArtworkCoverage,reviewQueueFromSelection,reviewQueueRemaining,validateDesignCorrection}=m.exports;
const files=[
 {id:'a1',version_number:1,upload_batch_id:'batch-one',status:'uploaded',file_url:'https://x/a-front.png',file_name:'A-front.png'},
 {id:'a2',version_number:2,upload_batch_id:'batch-one',status:'uploaded',file_url:'https://x/a-back.png',file_name:'A-back.png'},
 {id:'a-old',version_number:3,upload_batch_id:'old-batch',status:'uploaded',file_url:'https://x/old.png',file_name:'old.png'},
 {id:'a3',version_number:4,upload_batch_id:'batch-two',status:'uploaded',file_url:'https://x/a-new.png',file_name:'A-new.png'},
 {id:'a4',version_number:5,upload_batch_id:'batch-two',status:'uploaded',file_url:'https://x/a-details.pdf',file_name:'A-details.pdf'},
 {id:'b1',version_number:6,upload_batch_id:'batch-one',status:'uploaded',file_url:'https://x/b.png',file_name:'B.png'},
 {id:'b2',version_number:7,status:'approved',file_url:'https://x/b-revision.png',file_name:'B-revision.png'},
 {id:'bad',version_number:8,upload_batch_id:'bad',status:'rejected',file_url:'https://x/b-rejected.png'},
 {id:'empty',version_number:9,upload_batch_id:'empty',status:'uploaded',file_url:'  '},
];
const links=[
 ...['a1','a2','a-old','a3','a4','bad'].map(id=>({design_version_id:id,work_item_id:'board-A'})),
 ...['b1','b2','bad'].map(id=>({design_version_id:id,work_item_id:'board-B'})),
 {design_version_id:'a4',work_item_id:'board-C'},
 {design_version_id:'empty',work_item_id:'board-D'},
];
const groups=latestReviewArtworkGroupByItem(files,links);
check('Two complementary latest artwork files shown for board A',()=>assert.deepEqual(groups.get('board-A').map(v=>v.id),['a4','a3']));
check('Old prior upload batch hidden from current board A review',()=>assert(!groups.get('board-A').some(f=>['a1','a2','a-old'].includes(f.id))));
check('Board B has one latest legacy revision (no batch ID)',()=>assert.deepEqual(groups.get('board-B').map(f=>f.id),['b2']));
check('Explicit shared artwork on board C remains visible',()=>assert.deepEqual(groups.get('board-C').map(f=>f.id),['a4']));
check('Missing URL never counts as board D artwork',()=>assert.equal(groups.has('board-D'),false));
check('All mapped current design boards have coverage',()=>assert.equal(reviewArtworkCoverage([{id:'board-A'},{id:'board-B'},{id:'board-C'}],latestReviewArtworkByItem(files,links)).ready,true));
check('A missing artwork board blocks approval',()=>assert.deepEqual(reviewArtworkCoverage([{id:'board-A'},{id:'board-D'}],latestReviewArtworkByItem(files,links)).missing,['board-D']));
check('Cross-shop correction work item blocked',()=>assert.match(validateDesignCorrection([{id:'board-A'}],['shop-2-board'],'bad'),/Invalid work item/));
const chosen=[{design_task_id:'task-A',status:'in_review',shop_name:'Shop A'}, {design_task_id:'task-B',status:'in_review',shop_name:'Shop B'}, {design_task_id:'task-A',status:'in_review',shop_name:'Shop A duplicate'}, {design_task_id:'task-C',status:'approved',shop_name:'Shop C'}, {design_task_id:'task-D',status:'in_review',shop_name:'Shop D'}];
const queue=reviewQueueFromSelection(chosen);
check('Multi-shop review deduplicates and excludes approved tasks',()=>assert.deepEqual(queue.map(q=>q.design_task_id),['task-A','task-B','task-D']));
check('Approve first shop advances to second only',()=>assert.deepEqual(reviewQueueRemaining(queue,'task-A').map(q=>q.design_task_id),['task-B','task-D']));
check('Skip current shop does not approve it',()=>assert.deepEqual(reviewQueueRemaining(queue,'task-B').map(q=>q.design_task_id),['task-A','task-D']));
check('Single-shop review still supported',()=>assert.deepEqual(reviewQueueFromSelection([chosen[0]]).map(x=>x.design_task_id),['task-A']));
check('Queue UI has one primary review selected entry',()=>assert.match(page,/Review \{selInReview\.length\} shop/));
check('No blind batch approval action exposed in toolbar',()=>assert.doesNotMatch(page,/bulkApproveMutation\.mutate/));
check('One at a time shop preview and progress labels',()=>{assert.match(page,/Shop \{reviewQueueTotal - reviewQueue\.length \+ 1\} of \{reviewQueueTotal\}/);assert.match(page,/setReviewTask\(\{ \.\.\.row, \.\.\.loadedDetail \}\)/);});
check('Review modal shows all current artwork in latest upload batch',()=>assert.match(page,/artworks\.map\(file => \(/));
check('Approvals still require mapped coverage + company sign-off',()=>assert.match(page,/!reviewCoverage\.ready \|\| !companyGateReady/));
check('All decisions route to atomic task-scoped RPC',()=>assert.match(page,/supabase\.rpc\('design_review_decide'/));
check('Latest version and batch IDs stored from Designer upload',()=>{assert.match(page,/const uploadBatchId = crypto\.randomUUID\(\)/);assert.match(page,/upload_batch_id: uploadBatchId/);});
check('Shop details upload shares batch ID',()=>{assert.match(shops,/const uploadBatchId = crypto\.randomUUID\(\)/);assert.match(shops,/upload_batch_id: uploadBatchId/);});
check('Production still fetches approved artwork with explicit links',()=>{assert.match(production,/\.eq\('status', 'approved'\)/);assert.match(production,/\.from\('design_version_items'\)/);assert.match(production,/matches\.filter\(file =>/);});
check('Additive migration safely creates nullable batch column',()=>{assert.match(sql,/ADD COLUMN IF NOT EXISTS upload_batch_id uuid/);assert.doesNotMatch(sql,/DROP TABLE|TRUNCATE TABLE|DELETE FROM public\.design_versions/);});
check('RPC scoped and locked per shop/task',()=>{assert.match(sql,/WHERE id=p_task_id FOR UPDATE/);assert.match(sql,/v_org IS DISTINCT FROM public\.current_org_id\(\)/);});
check('Latest upload batch selected PER work item, not per shop',()=>{assert.match(sql,/DISTINCT ON \(vi\.work_item_id\)/);assert.match(sql,/COALESCE\(dv\.upload_batch_id,dv\.id\)/);});
check('All files in current batch for each board approved',()=>{assert.match(sql,/JOIN public\.design_version_items vi ON vi\.work_item_id=lb\.work_item_id/);assert.match(sql,/SET status=CASE WHEN dv\.id IN \(SELECT id FROM effective_files\)/);});
check('Superseded versions become unapproved without deletion',()=>assert.match(sql,/THEN 'approved' ELSE 'uploaded'/));
check('SQL protects rejected most recent file from legacy approval procedure',()=>assert.match(sql,/v_last_file_status NOT IN \('uploaded','approved'\)/));
check('SQL preserves note, role, company approval gate and atomic correction path',()=>{assert.match(sql,/public\.review_apply/);assert.match(sql,/v_bad_ids>0/);assert.match(sql,/p_note/);assert.match(sql,/public\.current_role/);});
check('RLS/grant remains authenticated only',()=>{assert.match(sql,/REVOKE ALL ON FUNCTION public\.design_review_decide/);assert.match(sql,/GRANT EXECUTE ON FUNCTION public\.design_review_decide.*TO authenticated/);});
console.log(`DESIGN REVIEW V12 MULTI-SHOP: ALL ${passed} CHECKS PASSED`);
