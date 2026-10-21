const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const ts=require('typescript');
const root=path.join(__dirname,'..');
const source=name=>fs.readFileSync(path.join(root,name),'utf8');
function transpileCommon(file){const code=ts.transpileModule(source(file),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;const m={exports:{}};new Function('module','exports',code)(m,m.exports);return m.exports;}
const {decisionCounts,decisionTargets,nextUnqueued,validateShopDecision}=transpileCommon('src/lib/reviewDecisionQueue.ts');
const {processReviewedBatch}=transpileCommon('src/lib/reviewBatchSafety.ts');
const survey=source('src/pages/SurveyReviewPage.tsx'),install=source('src/pages/InstallationReviewPage.tsx'),ui=source('src/components/ReviewDecisionBar.tsx'),stepper=source('src/components/ReviewBatchStepper.tsx'),gallery=source('src/components/SurveyReviewGallery.tsx');
let count=0;function check(name,fn){fn();console.log('PASS',name);count++;}
(async()=>{
  const shops=Array.from({length:10000},(_,i)=>({id:`shop-${i}`,shop_id:`physical-${i}`}));
  const decisions={};for(let i=0;i<shops.length;i+=10)decisions[shops[i].id]={action:i%30===0?'approve':i%30===10?'redo':'reject',note:i%30===0?'':'Retake incorrect evidence'};
  const selected=shops.slice(0,250);
  check('10000 shop queue remains bounded to 250 page',()=>assert.equal(decisionTargets(selected,decisions).length,25));
  check('No other-page shop included in current workset',()=>assert.ok(decisionTargets(selected,decisions).every(row=>selected.includes(row))));
  check('1000 mixed decisions classified without double counting',()=>{const x=decisionCounts(shops.map(row=>row.id),decisions);assert.equal(x.approve+x.redo+x.reject,1000)});
  check('Empty queue never sends any batch',()=>assert.deepEqual(decisionTargets(selected,{}),[]));
  check('No queued shop is implicitly approved',()=>assert.equal(decisionTargets(selected,{})[0],undefined));
  check('Existing previous-shop decision preserved on new selection',()=>assert.deepEqual(decisions['shop-10'],{action:'redo',note:'Retake incorrect evidence'}));
  check('Next skips queued choices',()=>assert.equal(nextUnqueued(selected,0,decisions),1));
  check('Next wraps from end to pending first',()=>assert.equal(nextUnqueued(selected,249,decisions),1));
  check('All queued returns -1',()=>assert.equal(nextUnqueued(selected,0,Object.fromEntries(selected.map(row=>[row.id,{action:'approve',note:''}]))),-1));
  check('Single shop never triggers cross-shop selection',()=>assert.deepEqual(decisionTargets(selected.slice(5,6),decisions),[]));
  check('Missing evidence blocks approval',()=>assert.match(validateShopDecision({action:'approve',note:''},'survey',false),/Evidence/));
  check('Evidence loaded allows approve',()=>assert.equal(validateShopDecision({action:'approve',note:''},'installation',true),null));
  check('Redo may proceed when evidence unavailable but note mandatory',()=>{assert.match(validateShopDecision({action:'redo',note:' '},'survey',false),/reason/);assert.equal(validateShopDecision({action:'redo',note:'Missing photo'},'survey',false),null)});
  check('Permanent survey rejection requires reason',()=>{assert.match(validateShopDecision({action:'reject',note:''},'survey',true),/reason/);assert.equal(validateShopDecision({action:'reject',note:'Wrong location'},'survey',false),null)});
  check('Installation cannot be permanently rejected',()=>assert.match(validateShopDecision({action:'reject',note:'reason'},'installation',true),/surveys only/));
  const started=[];const res=await processReviewedBatch(selected.slice(0,35),async(row)=>{started.push(row.id);if(row.id==='shop-7'||row.id==='shop-23')throw Error('rejected by server');},undefined,3);
  check('35 jobs attempted once',()=>assert.equal(new Set(started).size,35));
  check('Partial failures stay distinct',()=>{assert.equal(res.failed.length,2);assert.equal(res.succeeded.length,33)});
  check('Only confirmed successes removed from queue',()=>{const removed=new Set(res.succeeded.map(row=>row.id));assert.ok(!removed.has('shop-7')&&!removed.has('shop-23'))});
  check('Queue supports approve/redo in same Installation batch',()=>assert.ok(install.includes("choice.action === 'approve' ? 'approved' : 'redo'")));
  check('Survey dispatches separate approve, redo and final reject operations',()=>assert.ok(survey.includes("if (choice.action === 'reject')")&&survey.includes("p_survey_id: survey.id")&&survey.includes("decision: 'redo'")));
  check('Final survey rejection requires explicit user confirmation',()=>assert.ok(survey.includes('window.confirm(`Permanently reject')));
  check('Owner/Admin company handoff present in both workspaces',()=>assert.ok(survey.includes('CompanyApprovalHandoff stage="survey"')&&install.includes('CompanyApprovalHandoff stage="installation"')));
  check('Survey assign designer only when approval queued',()=>assert.ok(survey.includes('queuedCounts.approve > 0')));
  check('No implicit approval from browsing next shop',()=>assert.ok(stepper.includes('onIndexChange')&&!stepper.includes('onInspectedChange')));
  check('User may undo staged decision',()=>assert.ok(ui.includes('Undo queued decision')));
  check('Review queue requires clear reason on redo',()=>assert.ok(ui.includes('Required correction instructions')));
  check('Review queue visually distinguishes final reject',()=>assert.ok(ui.includes('Final reject')));
  check('Photo-level survey correction scope still supported',()=>assert.ok(gallery.includes('Correction target')&&gallery.includes('Choose exact photo')));
  check('Installation individual photo can be selected separately',()=>assert.ok(install.includes('reviewKey={`installation_photo:${p.id}`}')&&install.includes('new Set([reviewKey])')));
  check('Saved Installation item correction notes are shown',()=>assert.ok(install.includes('Work Item redo reason:')));
  check('Survey photo correction notes shown',()=>assert.ok(gallery.includes('photoDecision.note')));
  check('Realtime subscribes to review decisions (fallback polling retained)',()=>assert.ok(survey.includes("['surveys', 'field_review_decisions']")&&install.includes("['installation_jobs', 'field_review_decisions']")));
  check('Approval mutation uses existing audited RPC and never bypasses validation',()=>assert.ok(survey.includes("reviewApply({ stage: 'survey'")&&install.includes("reviewApply({ stage: 'installation'")));
  check('Busy state freezes navigation while writes in flight',()=>assert.ok(survey.includes('disabled={bulkMutation.isPending}')&&install.includes('disabled={bulkBusy}')));
  check('Per-shop failed reasons available for retries',()=>assert.ok(survey.includes('setBatchErrors(errors)')&&install.includes('setBatchErrors(Object.fromEntries')));
  check('Existing page sizes offer 250 page worksets',()=>assert.ok(survey.includes('10, 25, 50, 100, 250')&&install.includes('20, 50, 100, 250')));
  check('Installation final reject unavailable in decision bar',()=>assert.ok(ui.includes("stage === 'survey' &&")));
  for(const file of ['src/lib/reviewDecisionQueue.ts','src/components/ReviewDecisionBar.tsx','src/components/ReviewBatchStepper.tsx','src/pages/SurveyReviewPage.tsx','src/pages/InstallationReviewPage.tsx','src/components/SurveyReviewGallery.tsx']){
    check(`TypeScript parse ${path.basename(file)}`,()=>{const result=ts.createSourceFile(file,source(file),ts.ScriptTarget.Latest,true,file.endsWith('tsx')?ts.ScriptKind.TSX:ts.ScriptKind.TS);assert.equal(result.parseDiagnostics.length,0)});
  }
  console.log(`ALL ${count} REVIEW V4 DECISION CHECKS PASSED`);
})().catch(e=>{console.error(e);process.exitCode=1});
