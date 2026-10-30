const fs = require('fs');
const path = require('path');
const ts = require('typescript');
const assert = require('assert/strict');
const root = process.cwd();
const design = fs.readFileSync(path.join(root,'src/pages/DesignerPage.tsx'),'utf8');
const production = fs.readFileSync(path.join(root,'src/pages/ProductionPage.tsx'),'utf8');
let checks = 0;
function test(label, fn){ fn(); checks++; console.log('PASS',label); }
function has(source, pattern, message){ assert.ok(pattern.test(source), message || `Missing source contract: ${pattern}`); }
for (const [name, source] of [['Design',design],['Production',production]]) {
 test(`${name} TSX parses`, () => {
  const file=ts.createSourceFile(`${name}.tsx`,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  assert.equal(file.parseDiagnostics.length,0,file.parseDiagnostics.map(x=>ts.flattenDiagnosticMessageText(x.messageText,' ')).join('; '));
 });
}
test('Design sends all-covered upload to review in same save',()=> has(design,/submitAfterUpload && canSubmitUploadForReview \? 'in_review' : 'design_ready'/));
test('Upload default enabled but optional',()=> has(design,/useState\(true\);\n  const \[selectedItemIds/));
test('Designer must supply files',()=> has(design,/if \(stagedFiles\.length === 0\) throw/));
test('Design upload checks server state before writing',()=> has(design,/select\('status'\)\.eq\('id', uploadTask\.design_task_id\)\.maybeSingle\(\)/));
test('Already-finalized design cannot accept a new upload',()=> has(design,/\['assigned', 'designing', 'design_ready', 'in_review'\]\.includes\(currentTask\.status\)/));
test('No automatic review with incomplete survey',()=> has(design,/!uploadTask\.items\.some\(\(item\) => NOT_READY_STATUSES\.includes\(item\.status\)\)/));
test('No automatic review with missing board selection',()=> has(design,/eligibleUploadItems\.every\(\(item\) => selectedItemIds\.has\(item\.id\)\)/));
test('Changed design task is not silently overwritten',()=> has(design,/if \(!changedTask\?\.length\) throw new Error/));
test('Reviewers notified on automatic send',()=> has(design,/if \(nextTaskStatus === 'in_review'\)[\s\S]*?notifyDesignReviewers/));
test('Design UI has one-step handoff label',()=> has(design,/& Send for Review/));
test('Designer can still save partial draft',()=> has(design,/Files will save as a design draft/));
test('Owner approve and next advances only after success',()=> has(design,/onSuccess: \(_result, variables\) => \{\n      const nextReview =[\s\S]*?if \(nextReview\) void quickReview\(nextReview\)/));
test('Design keeps company-approval path unchanged',()=> has(design,/phase3_send_to_production/));
test('Design retains item coverage links',()=> has(design,/from\('design_version_items'\)\.insert\(links\)/));
test('Design retains per-item selected IDs',()=> has(design,/selectedItemIds\.size === 0/));
test('Design row actions accommodate narrow screens',()=> has(design,/order-last sm:order-none w-full sm:w-auto/));
const match=production.match(/function readyForDirectCompletion\(row: ProductionOrderRow\): boolean \{([\s\S]*?)\n\}/);
assert.ok(match,'No direct completion helper');
const ready=new Function('row',match[1]);
const example={total_boards:4,pending_boards:0,materials_pending_boards:0,status:'ready'};
test('Recorded and material-ready production is one-click eligible',()=> assert.equal(ready(example),true));
test('In-production fully recorded order can be completed',()=> assert.equal(ready({...example,status:'in_production'}),true));
test('Zero-work-item order is never one-click complete',()=> assert.equal(ready({...example,total_boards:0}),false));
test('Missing quantity prevents direct completion',()=> assert.equal(ready({...example,pending_boards:1}),false));
test('Pending materials prevents direct completion',()=> assert.equal(ready({...example,materials_pending_boards:1}),false));
test('On-hold order prevents direct completion',()=> assert.equal(ready({...example,status:'hold'}),false));
test('Already-completed order is not sent back',()=> assert.equal(ready({...example,status:'completed'}),false));
test('Production only performs privileged direct completion',()=> has(production,/if \(!canApprove\) throw new Error\('Only Owner\/Admin may complete production/));
test('Production reuses atomic backend RPC',()=> has(production,/supabase\.rpc\('phase3_complete_production'/));
test('Direct completion requires exactly one matching installer when needed',()=> has(production,/orgInstallers\?\.length !== 1 \|\| orgInstallers\[0\]\.id !== installer/));
test('Multiple installers fall back to explicit assignment UI',()=> has(production,/if \(ready && \(!needsInstaller \|\| orgInstallers\?\.length === 1\)\)/));
test('Supply-only skips installer assignment',()=> has(production,/row\.fulfillment_type !== 'supply_only' && !row\.requires_installation_all_false/));
test('Production one-click calls same complete helper',()=> has(production,/await completeProductionOrder\(row, installer, row\.notes \|\| ''\)/));
test('Production queries installer list for action queue',()=> has(production,/mainView === 'production'/));
test('Production quick-log selects first unfinished board',()=> has(production,/enrichBoards\(loaded\)\.find\(\(board\) => !board\.locked && !board\.isDone\)/));
test('Production quick-log uses item editor',()=> has(production,/openItemEditor\(row\.production_order_id, next\)/));
test('Production quick-log shows actual-quantity editor, not guessed auto posts',()=> has(production,/Log Qty/));
test('Production quick-log errors visible',()=> has(production,/\{quickLogError && <div role="alert"/));
test('Production mutations invalidate list and stats',()=> has(production,/instantCompleteMutation = useMutation\([\s\S]*?invalidateQueries\(\{ queryKey: \['production-order-stats', orgId\]/));
console.log(`ALL ${checks} DESIGN + PRODUCTION ONE-CLICK CHECKS PASSED`);
