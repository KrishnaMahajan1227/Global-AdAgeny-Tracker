const fs=require('fs');const path=require('path');const assert=require('assert');const ts=require('typescript');
const root=path.join(__dirname,'..');let count=0;
function check(name,condition){assert.ok(condition,name);console.log('PASS',name);count++}
function textfile(file){return fs.readFileSync(path.join(root,file),'utf8')}
const safety=textfile('src/lib/reviewBatchSafety.ts');
const js=ts.transpileModule(safety,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
const mod={exports:{}};new Function('module','exports',js)(mod,mod.exports);
const {allInspected}=mod.exports;
check('Zero selected can never be bulk-approved',!allInspected([],new Set()));
check('One inspected of two selected cannot be bulk-approved',!allInspected([{id:'one'},{id:'two'}],new Set(['one'])));
check('Every selected shop must be inspected',allInspected([{id:'one'},{id:'two'}],new Set(['one','two'])));
check('A removed inspection invalidates the batch',!allInspected([{id:'one'},{id:'two'}],new Set(['two'])));
check('Only current selected shops affect the batch',allInspected([{id:'one'}],new Set(['one','old'])));
const survey=textfile('src/pages/SurveyReviewPage.tsx');const gallery=textfile('src/components/SurveyReviewGallery.tsx');
const install=textfile('src/pages/InstallationReviewPage.tsx');const stepper=textfile('src/components/ReviewBatchStepper.tsx');
check('Survey batch applies explicit inspected guard in mutation',survey.includes("if (!allInspected(targets, inspectedIds)) throw"));
check('Survey batch approval button is gated',survey.includes('const canConfirmBulk = !!effectiveBulkDesignerId && allInspected(selectedSurveys, inspectedIds)'));
check('Survey displays internal and company approval inside batch',survey.includes('<CompanyApprovalHandoff stage="survey" refId={activeBulkSurvey.id}'));
check('Survey batch supports per-item redo without another modal',survey.includes('surveyId={activeBulkSurvey.id} shopId={activeBulkSurvey.shop_id} onEvidenceChanged='));
check('Survey evidence cannot be checked before photos and work items load',gallery.includes('evidence.data.photos.length > 0 && evidence.data.items.length > 0'));
check('Survey change clears evidence inspected flag',gallery.includes('onEvidenceChanged?.()'));
check('Survey single review continues to next shop',survey.includes('afterSingleReview(selectedSurvey.id)'));
check('Installation batch mutation and retry action both guard inspection',install.includes("if (!allInspected(targets, inspectedIds)) throw") && install.includes('if (!allInspected(targets, inspectedIds)) { setBulkResult'));
check('Installation requires all shops inspected to enable bulk approval',install.includes('disabled={bulkBusy || !allInspected(selectedJobs, inspectedIds)}'));
check('Installation requires explanatory note before bulk redo',install.includes('!allInspected(selectedJobs, inspectedIds) || !bulkNote.trim()'));
check('Installation batch embeds company approval and per-item correction',install.includes('<CompanyApprovalHandoff stage="installation" refId={activeBatchJob.id}') && install.includes('onEvidenceChanged={() => { setInspectedIds'));
check('Installation shows all linked survey photos',install.includes('linkedSurvey.map((p:any)'));
check('Installation batch requires linked evidence',install.includes('const hasReviewableEvidence =') && install.includes('hasReviewableEvidence) onEvidenceReady?.()'));
check('Installation single review remounts item selection per job',install.includes('key={reviewModal.id} onOpenPhoto={setLightbox}'));
check('Installation single review opens next pending job',install.includes('nextSingleReview(reviewModal.id)'));
check('Installation inline approvals reject missing linked proofs',install.includes("One or more selected Work Items have no linked installation photos"));
check('Both review queues use same focused navigation',survey.includes('<ReviewBatchStepper') && install.includes('<ReviewBatchStepper'));
check('Stepper offers accessible previous/next navigation and compact shop jump',stepper.includes('aria-label="Previous shop"') && stepper.includes('aria-label="Next shop"') && stepper.includes('aria-label="Jump to selected shop"'));
check('Navigation alone never counts as reviewing evidence',!stepper.includes('onInspectedChange') && stepper.includes('onIndexChange'));
check('One Reviewed and next action intentionally confirms each shop',survey.includes('Reviewed & next shop') && install.includes('Reviewed & next shop') && survey.includes('setInspectedIds(prev => new Set(prev).add(activeBulkSurvey.id))') && install.includes('setInspectedIds(prev => new Set(prev).add(activeBatchJob.id))'));
check('Evidence readiness gates Reviewed and next action',survey.includes('!evidenceReadyIds.has(activeBulkSurvey.id)') && install.includes('!evidenceReadyIds.has(activeBatchJob.id)'));
check('No giant numbered button strip for 250 shops',!stepper.includes('role="group" aria-label="Jump to selected shop"') && stepper.includes('<select id="batch-shop-jump"'));
check('Large batches have 250 item page option',survey.includes('10, 25, 50, 100, 250') && install.includes('20, 50, 100, 250'));
check('Batch modal uses one vertical scroller, not nested scrollbars', !survey.includes('max-h-[55vh]') && !install.includes('max-h-[58vh]'));
check('Survey pending items automatically selected on load',gallery.includes('setSelected(new Set(selectionPlan.choices.map(choice => choice.key)))'));
check('Installation pending Work Items automatically selected on load',install.includes('setSelected(new Set(pendingReviewKeys))'));
for(const f of ['src/components/ReviewBatchStepper.tsx','src/components/SurveyReviewGallery.tsx','src/pages/SurveyReviewPage.tsx','src/pages/InstallationReviewPage.tsx']) {
 const source=ts.createSourceFile(f,textfile(f),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 check(`Parse ${f}`,source.parseDiagnostics.length===0);
}
console.log(`ALL ${count} FOCUSED REVIEW WORKSPACE CHECKS PASSED`);
