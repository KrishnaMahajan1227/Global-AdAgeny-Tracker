import ts from 'typescript';
import fs from 'node:fs';
import assert from 'node:assert/strict';
const files = ['src/pages/SurveyReviewPage.tsx', 'src/components/ItemLevelReviewPanel.tsx'];
for (const file of files) {
  const source = fs.readFileSync(file, 'utf8');
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  assert.equal(parsed.parseDiagnostics.length, 0, `${file} failed TSX parsing`);
  console.log(`PASS TSX parse: ${file}`);
}
const page = fs.readFileSync(files[0], 'utf8');
const item = fs.readFileSync(files[1], 'utf8');
const tests = [
  [!page.includes('setSelectMode('), 'No hidden select mode'],
  [page.includes('aria-label="Select all surveys on this page"'), 'Permanent leftmost select-all'],
  [page.includes('selectedIds.has(s.id)'), 'Controlled row selection'],
  [page.includes('const canConfirmBulk = !!bulkDesignerId'), 'Bulk approve requires designer'],
  [page.includes('setSelectedIds((prev) => {'), 'Bulk approval removes succeeded IDs'],
  [page.includes('bulkMutation.isError'), 'Bulk error surfaced'],
  [page.includes('ReviewMarkedPhotos surveyId={bulkPreviewId}'), 'Inline marked evidence for bulk preview'],
  [page.includes('ItemLevelReviewPanel stage="survey"'), 'One canonical item-level review control'],
  [!page.includes('<SurveyMeasurementsTable'), 'No duplicate measurements table'],
  [!page.includes('openBulk(\'correction\')'), 'Unsafe bulk redo removed'],
  [page.includes('Final rejection (cannot be corrected)'), 'Separate final rejection control'],
  [item.includes('reviewLoading || reviewError'), 'Incomplete/error review data blocks decisions'],
  [!item.includes('Reject / redo all'), 'Ambiguous mass reject control removed'],
  [!item.includes("window.confirm('Sab"), 'No native bulk redo confirm'],
];
for (const [pass, title] of tests) { assert.ok(pass, title); console.log('PASS', title); }
