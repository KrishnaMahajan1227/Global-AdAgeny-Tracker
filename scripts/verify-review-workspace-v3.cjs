const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const ts = require('typescript');
const root = path.join(__dirname, '..');
const source = file => fs.readFileSync(path.join(root, file),'utf8');
const js=ts.transpileModule(source('src/lib/reviewBatchSafety.ts'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
const runtime={exports:{}};
new Function('module','exports',js)(runtime,runtime.exports);
const {allInspected,reviewedTargets,nextUnreviewedIndex,processReviewedBatch}=runtime.exports;
let passed=0;
const check = (name,fn) => { fn(); console.log('PASS',name); passed++; };
(async ()=>{
  const many=Array.from({length:1000},(_,i)=>({id:`shop-${i}`,name:`Shop ${i}`}));
  const inspected=new Set(many.filter((_,i)=>i%5===0).map(x=>x.id));
  check('1000 selected and only 200 inspected gives 200 eligible',()=> assert.equal(reviewedTargets(many,inspected).length,200));
  check('Uninspected shops never enter batch action',()=> assert.ok(reviewedTargets(many,inspected).every(row=>inspected.has(row.id))));
  check('Invalid/empty review cannot approve',()=> assert.deepEqual(reviewedTargets([],inspected),[]));
  check('Legacy allInspected helper still guards all-selected semantics',()=> assert.equal(allInspected(many,inspected),false));
  check('Next missing review skips confirmed shops',()=> assert.equal(nextUnreviewedIndex(many,0,inspected),1));
  check('Wrap navigation safe at 1000 shops',()=> assert.equal(nextUnreviewedIndex(many,999,new Set(many.slice(1).map(x=>x.id))),0));
  const submitted=[];let active=0,peak=0;
  const result=await processReviewedBatch(reviewedTargets(many,inspected),async item=>{
    active++;peak=Math.max(peak,active);
    await new Promise(resolve=>setImmediate(resolve));
    active--;
    submitted.push(item.id);
    if(Number(item.id.split('-')[1])%20===0) throw new Error('Approval not confirmed');
  },()=>{},3);
  check('Each eligible item is processed exactly once',()=>assert.equal(new Set(submitted).size,200));
  check('Failures retained, successes distinct',()=>{assert.equal(result.failed.length,50);assert.equal(result.succeeded.length,150);});
  check('Bounded parallelism avoids DB saturation',()=> assert.ok(peak<=3 && peak>0));
  check('Results maintain original queue order',()=>assert.deepEqual(result.succeeded.map(i=>i.id),many.filter((_,i)=>i%5===0&&i%20!==0).map(i=>i.id)));
  { let updates=0; await processReviewedBatch([{id:'x'},{id:'y'}],async()=>{},()=>updates++); check('Exactly one progress update per attempted shop',()=>assert.equal(updates,2)); }
  {const empty=await processReviewedBatch([],async()=>{}); check('0 target pool finishes cleanly',()=>assert.deepEqual(empty,{succeeded:[],failed:[]}));}
  const survey=source('src/pages/SurveyReviewPage.tsx');
  const install=source('src/pages/InstallationReviewPage.tsx');
  const stepper=source('src/components/ReviewBatchStepper.tsx');
  check('Survey has one-click Review page entry',()=> assert.ok(survey.includes('Review page (${rows.length})')));
  check('Installation has one-click Review page entry',()=> assert.ok(install.includes('Review page (${rows.length})')));
  check('Both submit only explicitly queued targets',()=>assert.ok(survey.includes('decisionTargets(rows.filter')&&install.includes('decisionTargets(rows.filter')));
  check('Both report actual per-shop progress',()=>assert.ok(survey.includes('setBatchProgress({ done, total })')&&install.includes('setBatchProgress({done,total})')));
  check('Survey removes only confirmed successes',()=> assert.ok(survey.includes('const completed = new Set(succeeded.map')));
  check('Installation removes only confirmed successes',()=> assert.ok(install.includes('const successful = new Set(result.succeeded.map')));
  check('No stale undefined modal callback remains',()=>assert.ok(!survey.includes('setBulkPreviewId')));
  check('Both preserve company-approval interface',()=>assert.ok(survey.includes('<CompanyApprovalHandoff stage="survey" refId={activeBulkSurvey.id}')&&install.includes('<CompanyApprovalHandoff stage="installation" refId={activeBatchJob.id}')));
  check('Batch navigator has search, pending-jump and flags',()=>assert.ok(stepper.includes('type="search"')&&stepper.includes('Next pending')&&stepper.includes('flagged, unchecked')));
  check('Both require loaded evidence before bulk approval',()=>assert.ok(survey.includes("validateShopDecision(decision, 'survey', evidenceReadyIds.has(survey.id))")&&install.includes("validateShopDecision(batchDecisions[job.id], 'installation', evidenceReadyIds.has(job.id))")));
  check('UI does not select all shops across pages',()=>assert.ok(survey.includes('new Set(rows.map(row => row.id))')&&install.includes('new Set(rows.map(row => row.id))')));
  check('Installation thumbnails lazy-load',()=>assert.ok(install.includes('loading="lazy" decoding="async"')));
  check('Navigation freezes while running database batch',()=>assert.ok(stepper.includes('disabled?: boolean')&&survey.includes('disabled={bulkMutation.isPending}')&&install.includes('disabled={bulkBusy}')));
  for(const file of ['src/lib/reviewBatchSafety.ts','src/components/ReviewBatchStepper.tsx','src/pages/SurveyReviewPage.tsx','src/pages/InstallationReviewPage.tsx','src/components/CompanyApprovalHandoff.tsx']){
    check(`Parse ${file}`,()=>{const sf=ts.createSourceFile(file,source(file),ts.ScriptTarget.Latest,true,file.endsWith('.tsx')?ts.ScriptKind.TSX:ts.ScriptKind.TS);assert.equal(sf.parseDiagnostics.length,0);});
  }
  console.log(`ALL ${passed} REVIEW V3 CHECKS PASSED`);
})().catch(e=>{console.error(e);process.exitCode=1;});
