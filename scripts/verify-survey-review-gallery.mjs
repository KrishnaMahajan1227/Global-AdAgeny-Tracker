import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

const survey = readFileSync('src/pages/SurveyReviewPage.tsx', 'utf8');
const gallery = readFileSync('src/components/SurveyReviewGallery.tsx', 'utf8');
const layout = readFileSync('src/components/AdminLayout.tsx', 'utf8');
const checks = [
  ['Centered survey review modal', survey.includes('<Modal open={!!selectedSurvey}')],
  ['One canonical survey evidence gallery', (survey.match(/<SurveyReviewGallery surveyId=\{selectedSurvey.id\}/g) || []).length === 1],
  ['No duplicate measurement table', !survey.includes('<SurveyMeasurementsTable')],
  ['No separate PO budget review', !survey.includes('<POBudgetReviewPanel')],
  ['First-column checkbox always available for pending surveys', survey.includes("{tab === 'pending' && <th") && !survey.includes('selectMode')],
  ['Server-scoped filters', ['shops.client_id', 'shops.purchase_order_id', 'shops.city', 'shops.state', 'surveyor_id'].every(term => survey.includes(term))],
  ['Single gallery displays a photo once per card', gallery.includes('safeGroups.cards.map') && gallery.includes('new Set<string>()')],
  ['Measurements and checkboxes accompany photos', gallery.includes("itemSizeLabel(item, 'survey')") && gallery.includes('type="checkbox"')],
  ['Multiple markings reuse renderer', gallery.includes('renderMarkedImage(photo.photo_url, valid.map(m => m.points)')],
  ['Full audit and approval data kept in RPC', gallery.includes('await reviewApply({ stage: \'survey\'' )],
  ['Modal approvals and redo ask for confirmation', gallery.includes('setConfirm(\'approve\')') && gallery.includes('setConfirm(\'redo\')')],
  ['No native browser confirmation for review', !survey.includes('window.confirm') && !gallery.includes('window.confirm')],
  ['Sidebar scroll flexible / footer fixed', layout.includes('min-h-0 flex-1') && layout.includes('shrink-0 border-t')],
  ['Recently visited links next to notification', layout.includes('recentPages.map') && layout.includes('<NotificationBell />')],
];
let failed = 0;
for (const [name, ok] of checks) { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); if (!ok) failed++; }
assert.equal(failed, 0, `${failed} gallery regression checks failed`);
