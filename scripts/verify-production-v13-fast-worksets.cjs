/** Production V13: runtime tests for selected worksets & explicit planned quantity confirmation. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const file = path.resolve(__dirname, '../src/pages/ProductionPage.tsx');
const source = fs.readFileSync(file, 'utf8');
const ast = ts.createSourceFile('ProductionPage.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
assert.equal(ast.parseDiagnostics.length, 0, 'TSX syntax must parse');
let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log('PASS', name); };
function extract(start, end, exportName) {
  const begin = source.indexOf(start), finish = source.indexOf(end, begin);
  assert(begin >= 0 && finish > begin, `Cannot extract ${exportName}`);
  const compiled = ts.transpileModule(source.slice(begin, finish) + `\nglobalThis.__testFn=${exportName};`, {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}});
  assert.equal(compiled.diagnostics?.length || 0, 0);
  return compiled.outputText;
}
const planCode = extract('function hasRecordedProductionPlan(item: WorkItem): boolean {', '\nfunction boardLabel', 'hasRecordedProductionPlan');
const nextCode = extract('  async function openNextProductionTask(currentOrderId: string) {', '\n  // ---- Folder browser', 'openNextProductionTask');
const saveCode = extract('  async function saveWorkbenchQuantities(', '\n  useEffect(() => {', 'saveWorkbenchQuantities');
const makeRow = id => ({production_order_id:id,pending_boards:1,status:'pending'});
async function nextState({selected=[], rowIds=['A','B','C','D'],current='B', pages={}} = {}) {
 const state={opened:[], fetched:[], closed:false, removed:new Set(selected)};
 const variables={
  rows:rowIds.map(makeRow), selectedOrderIds:new Set(selected),visitedProductionIds:{current:new Set()},totalCount:20,page:0,pageSize:4,
  openQuantityWorkbench:async row=>{state.opened.push(row.production_order_id)},
  fetchProductionPage:async pg=>{state.fetched.push(pg);return {rows:(pages[pg]||[]).map(makeRow)}},
  setSelectedOrderIds:fn=>{state.removed=fn(state.removed)},setPage:()=>{},setQuantityWorkbench:next=>{if(next===null)state.closed=true},
 };
 const ctx=vm.createContext({...variables,Set});vm.runInContext(nextCode,ctx);
 await ctx.__testFn(current);
 return state;
}
async function saveState({confirm=false,values={A:'',B:'2'},baselines={A:'',B:'2'},fail=[],missingPlan=false}={}) {
 const produced=[], transitions=[], message=[], errors=[];
 const board=(id,qty)=>({item:{id,approved_quantity:missingPlan && id==='A'?null:qty}, targetQty:qty,locked:false,record:{notes:''},componentsReady:true});
 const wb={row:{production_order_id:'ORDER1',shop_id:'SHOP1'},boards:[board('A',5),board('B',3)]};
 const state={quantityWorkbench:wb,workbenchSaving:false,workbenchActionLock:{current:false},workbenchValues:values,workbenchBaseline:baselines,orgId:'ORG',canApprove:false,
  setWorkbenchValues:x=>{state.workbenchValues=x},setWorkbenchMessage:x=>message.push(x),setWorkbenchSaving:()=>{},setWorkbenchErrors:x=>errors.push(x),setWorkbenchBaseline:x=>{state.workbenchBaseline=x},
  saveProducedBoard:async(_row, b, qty)=>{if(fail.includes(b.item.id))throw new Error('simulated database failure'); produced.push([b.item.id,qty])},
  queryClient:{invalidateQueries:()=>{}},setQuantityWorkbench:()=>{},openNextProductionTask:async id=>transitions.push(id),
  runBoundedWorkflowBatch:async(items,worker,_progress,limit)=>{ assert.equal(limit,3); const completed=[],failed=[]; for(const item of items){try{await worker(item);completed.push(item)}catch(error){failed.push({item,message:error.message})}}return{completed,failed}},
 };
 const ctx=vm.createContext({...state,Number,Object,Set,Error,console});vm.runInContext(planCode,ctx);vm.runInContext(saveCode,ctx);
 await ctx.__testFn('next',confirm);
 return {produced,transitions,message,errors, state};
}
(async()=>{
 check('Production permission is only owner/admin and assigned printing',()=>{
  assert(source.includes("const canApprove = profile?.role === 'agency_owner' || profile?.role === 'admin'"));
  assert(source.includes("const isProduction = profile?.role === 'printing'"));
  assert(source.includes("const assignedFilterValue = isProduction ? profile!.id : null"));
 });
 check('Missing approved quantity is not treated as an actual planned amount',()=>{ const ctx=vm.createContext({Number});vm.runInContext(planCode,ctx); assert(!ctx.__testFn({id:'A'})); assert(ctx.__testFn({id:'B',approved_quantity:5})); assert(!ctx.__testFn({id:'C',survey_quantity:0})); });
 check('Exactly mapped approved artwork, no inferred links',()=>{
  assert(source.includes(".eq('status', 'approved')"));assert(source.includes('if (!allowed.has(link.work_item_id)) continue;'));
 });
 check('Only explicit click passes planned confirmation',()=>{
  assert(source.includes("onClick={() => void saveWorkbenchQuantities('next', true)}"));
  assert(source.includes('if (confirmBlankPlans) {'));
  assert(!source.includes('useEffect(() => saveWorkbenchQuantities')); assert(source.includes('hasRecordedProductionPlan(board.item)'));
 });
 check('Selected workset primary action exists',()=>assert(source.includes('Process selected shops')));
 check('Existing queue pagination remains',()=>assert(source.includes('await fetchProductionPage(nextPage, pageSize)')));
 let r=await nextState({selected:['B','D']});
 check('Selected B skips unselected C and opens selected D',()=>assert.deepEqual(r.opened,['D']));
 check('Processed selected shop drops out of focus',()=>assert(!r.removed.has('B') && r.removed.has('D')));
 r=await nextState({selected:['B']});
 check('Last selected closes without fetching unrelated pages',()=>{assert(r.closed);assert.equal(r.fetched.length,0);assert.equal(r.removed.size,0)});
 r=await nextState({selected:[]});
 check('Unselected queue continues to next C normally',()=>assert.deepEqual(r.opened,['C']));
 r=await saveState({confirm:true});
 check('Explicit plan confirmation saves only blank A',()=>assert.deepEqual(r.produced,[['A',5]]));
 check('Existing recorded B remains untouched',()=>assert.equal(r.state.workbenchValues.B,'2'));
 check('Successful quantity save advances only after save',()=>assert.deepEqual(r.transitions,['ORDER1']));
 r=await saveState({confirm:true,missingPlan:true});
 check('Missing approved/survey plan refuses shortcut without a write',()=>{assert.equal(r.produced.length,0);assert.equal(r.transitions.length,0);assert(r.message.some(m=>m.includes('verified planned quantity')))});
 r=await saveState({confirm:false});
 check('No automatic planned quantity without explicit click',()=>assert.equal(r.produced.length,0));
 r=await saveState({confirm:true,values:{A:'',B:'4'}});
 check('Operator-entered partial/custom B never replaced by plan',()=>assert.deepEqual(r.produced,[['A',5],['B',4]]));
 r=await saveState({confirm:true,fail:['B'],values:{A:'',B:'4'}});
 check('Partial failed write blocks next shop',()=>assert.equal(r.transitions.length,0));
 check('Partial failure retains A successful baseline for safe retry',()=>assert.equal(r.state.workbenchBaseline.A,'5'));
 check('Failed B stays unchanged in baseline',()=>assert.equal(r.state.workbenchBaseline.B,'2'));
 check('Independent board saves use bounded parallel processing',()=>assert(source.includes('runBoundedWorkflowBatch(changed, async board =>')));
 check('Server rechecks status and compare-and-swap actuals',()=>{
  assert(source.includes('persisted.produced_qty !== expected'));assert(source.includes(".eq('produced_qty', persisted.produced_qty)"));
 });
 check('Completion uses atomic RPC and materials gate',()=>{
  assert(source.includes("phase3_complete_production"));assert(source.includes('(!b.qtyMet || !b.componentsReady)'));
 });
 check('No automatic material or approval bypass',()=>{
  assert(!source.includes('setAllMaterialsReady'));assert(source.includes("if (!canApprove) throw new Error('Only Owner/Admin may complete production.')"));
 });
 const result=ts.transpileModule(source,{fileName:'ProductionPage.tsx',reportDiagnostics:true,compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.ReactJSX}});
 check('TSX transpiles without diagnostic errors',()=>assert.equal(result.diagnostics?.filter(x=>x.category===ts.DiagnosticCategory.Error).length || 0,0));
 console.log(`PRODUCTION V13: ${passed} checks passed`);
})().catch(error=>{console.error(error);process.exitCode=1});
