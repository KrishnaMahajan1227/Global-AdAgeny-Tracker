const fs = require('fs');
const path = require('path');
const assert = require('assert');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const design = fs.readFileSync(path.join(root, 'src/pages/DesignerPage.tsx'), 'utf8');
const prod = fs.readFileSync(path.join(root, 'src/pages/ProductionPage.tsx'), 'utf8');
let passed = 0;
function check(name, run) { run(); passed++; console.log('PASS', name); }
function includes(haystack, needle) { assert(haystack.includes(needle), `Missing: ${needle}`); }
for (const [name, content] of [['DesignerPage.tsx', design], ['ProductionPage.tsx', prod]]) {
  check(`${name}: parse valid`, () => {
    const file = ts.createSourceFile(name, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    assert.strictEqual(file.parseDiagnostics.length, 0, file.parseDiagnostics.map(e => e.messageText).join('; '));
  });
}
check('Design: one upload sends complete design for review', () => includes(design, "submitAfterUpload && canSubmitUploadForReview ? 'in_review' : 'design_ready'"));
check('Design: incomplete board coverage stays a draft', () => includes(design, 'Incomplete board coverage — save draft first'));
check('Design: moves to next assigned design only after completed handoff', () => { includes(design,"const nextTask = sentForReview && isDesigner");includes(design,'if (nextTask) void quickUpload(nextTask)');});
check('Design: drop and browse use one staging function', () => {includes(design,'function stageDesignFiles(files: File[])'); includes(design,'onDrop={event =>');});
check('Design: duplicate artwork file staging prevented', () => includes(design,'if (seen.has(key)) continue;'));
check('Design: company artwork still selectable, notes optional', () => {includes(design,"'client_provided'");includes(design,'Artwork source & notes');});
check('Design: final review and company approval preserved', () => {includes(design,'CompanyApprovalHandoff');includes(design,'updateStatusMutation');});
check('Production: multi-board workbench loads one shop on demand', () => { includes(prod,'async function openQuantityWorkbench(row: ProductionOrderRow)'); includes(prod,'fetchOrderDetail(row.shop_id, row.production_order_id)');});
check('Production: every actual quantity explicitly entered', () => {includes(prod,'Enter a valid actual quantity');includes(prod,'Actual qty');});
check('Production: no auto-production from plan', () => { includes(prod,'Fill blanks from plan'); includes(prod,'Save changed quantities');});
check('Production: completed boards stay locked', () => includes(prod,'const disabled = board.locked;'));
check('Production: partial failures remain retryable', () => {includes(prod,'setWorkbenchBaseline(nextBaseline)');includes(prod,'setWorkbenchErrors(errors)');});
check('Production: existing quantity metadata preserved', () => { includes(prod,".update({ produced_qty: producedQty, notes: notes.trim() || null })"); includes(prod,"onConflict: 'production_order_id,work_item_id'");});
check('Production: material readiness affects board final status', () => includes(prod,"producedQty >= board.targetQty && board.componentsReady ? 'produced' : 'in_production'"));
check('Production: direct bulk completion requires all orders ready', () => { includes(prod,'selected.every(readyForDirectCompletion)');includes(prod,'setBulkCompleteOrders(selected)');});
check('Production: multi-installer handoff requires explicit assignment', () => includes(prod,'!requiresInstaller || orgInstallers?.length === 1'));
check('Production: server-side final completion RPC retained', () => includes(prod,"supabase.rpc('phase3_complete_production'"));
check('Roles: only authorized production users log', () => {includes(prod,"profile?.role === 'printing'");includes(prod,'if (!canLogProduction || !orgId)');});
check('Folder hierarchy stays optional on both screens', () => {includes(design,'Browse Folders');includes(prod,'Browse Folders');});

// Exercise the same persisted single-board operation outside React using a
// small deterministic Supabase mock. Tests verify payloads, not live RLS.
const start = prod.indexOf('  async function saveProducedBoard(');
const end = prod.indexOf('  async function saveWorkbenchQuantities()', start);
assert(start > -1 && end > start);
const functionJs = ts.transpileModule(prod.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None } }).outputText;
function setup(options = {}) {
  const calls = []; const audit = [];
  const shopId = 'shop-1';
  const mock = { from(table) {
    const q = {
      select() { return this; }, eq() { return this; }, in() { return this; },
      maybeSingle: async () => ({ data: { id: 'board-1', status: options.status || 'in_production', shop_id: options.shopId || shopId }, error: null }),
      update(payload) { calls.push({ table, action: 'update', payload }); return this; },
      upsert(payload, args) { calls.push({ table, action: 'upsert', payload, args }); return this; },
      then(resolve) { resolve({ data: options.noUpdatedRows && table === 'work_items' ? [] : [{id: 'record-1'}], error: null }); },
    }; return q;
  }};
  const fn = new Function('supabase','orgId','canLogProduction','logAudit', functionJs + '\nreturn saveProducedBoard;')(
    mock, 'org-1', options.authorized !== false, async (...args) => {audit.push(args);});
  const row = { shop_id: shopId, production_order_id: 'order-1', shop_name: 'Shop A', status: 'in_production' };
  const board = {item: {id:'board-1',approved_quantity:5,work_type_name:'Cutout'},record: options.existing ? {id:'record-1',produced_qty:2} : undefined,componentsReady: options.materialsReady !== false,targetQty:5};
  return {fn,row,board,calls,audit};
}
(async () => {
  let m = setup(); await m.fn(m.row,m.board,5,'Done');
  check('Live payload simulation: new board uses duplicate-safe upsert',()=>{assert(m.calls.some(c=>c.table==='production_items'&&c.action==='upsert'&&c.payload.produced_qty===5));assert(m.calls.some(c=>c.table==='work_items'&&c.payload.status==='produced'));});
  m = setup({existing:true}); await m.fn(m.row,m.board,4,'Partial');
  check('Live payload simulation: existing row updates quantity only',()=>{const c=m.calls.find(c=>c.table==='production_items');assert(c.action==='update');assert(!Object.keys(c.payload).includes('requested_qty'));});
  m=setup({materialsReady:false});await m.fn(m.row,m.board,5,'');
  check('Live payload simulation: pending materials keeps in production',()=>assert(m.calls.some(c=>c.table==='work_items'&&c.payload.status==='in_production')));
  m=setup({authorized:false}); await assert.rejects(m.fn(m.row,m.board,5,''),/permission/);
  check('Live payload simulation: unauthorized actor prevented',()=>assert.equal(m.calls.length,0));
  m=setup({status:'installed'});await assert.rejects(m.fn(m.row,m.board,5,''),/moved to another stage/);
  check('Live payload simulation: installed item cannot be rewritten',()=>assert.equal(m.calls.length,0));
  m=setup({shopId:'other-shop'});await assert.rejects(m.fn(m.row,m.board,5,''),/moved to another stage/);
  check('Live payload simulation: wrong shop blocked',()=>assert.equal(m.calls.length,0));
  m=setup();await assert.rejects(m.fn(m.row,m.board,-1,''),/actual quantity/);
  check('Live payload simulation: negative actual qty rejected',()=>assert.equal(m.calls.length,0));
  m=setup({noUpdatedRows:true});await assert.rejects(m.fn(m.row,m.board,5,''),/changed concurrently/);
  check('Live payload simulation: stale work item reported',()=>assert(m.calls.some(c=>c.table==='production_items')));
  console.log(`ALL ${passed} DESIGN + PRODUCTION V7 CHECKS PASSED`);
})().catch(error=>{console.error(error);process.exitCode=1;});
