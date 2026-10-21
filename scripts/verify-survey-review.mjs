import ts from 'typescript';
import fs from 'node:fs';
import assert from 'node:assert/strict';
// Modern survey-review regression: pre-Phase-2 drawer assumptions have been
// replaced by the shared evidence gallery, external company gate and V3 batch.
const files = ['src/pages/SurveyReviewPage.tsx', 'src/components/SurveyReviewGallery.tsx','src/components/ReviewBatchStepper.tsx'];
for (const file of files) {
  const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  assert.equal(sf.parseDiagnostics.length, 0, `Invalid TSX: ${file}`);
  console.log(`PASS TSX parse: ${file}`);
}
const page = fs.readFileSync(files[0], 'utf8');
const gallery = fs.readFileSync(files[1], 'utf8');
for (const [name, ok] of [
  ['Visible pending survey selection',page.includes('aria-label="Select all surveys on this page"')],
  ['Single evidence gallery reused for one and many shops',page.includes('<SurveyReviewGallery surveyId={selectedSurvey.id}')&&page.includes('<SurveyReviewGallery surveyId={activeBulkSurvey.id}')],
  ['Shop/item evidence loaded before inspection',gallery.includes('evidence.data.photos.length > 0 && evidence.data.items.length > 0')],
  ['Selected works retained on failed approval',page.includes('const completed = new Set(succeeded.map')],
  ['Only reviewed shops enter batch RPCs',page.includes('reviewedTargets(rows.filter')],
  ['Designer handoff stays mandatory',page.includes('if (!effectiveBulkDesignerId) throw')],
  ['Company confirmation remains in batch',page.includes('<CompanyApprovalHandoff stage="survey" refId={activeBulkSurvey.id}')],
  ['Corrections remain granular',gallery.includes("decision: 'redo'") || gallery.includes("setConfirm('redo')")],
  ['No duplicated PO measurements panel',!page.includes('<SurveyMeasurementsTable')],
  ['Final rejection separate from item correction',page.includes('Final rejection (entire survey)')],
]) { assert.ok(ok, name);console.log(`PASS ${name}`); }
console.log('ALL CURRENT SURVEY REVIEW CHECKS PASSED');
