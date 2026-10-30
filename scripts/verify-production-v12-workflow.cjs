/** V12 Production: focused source and behavior tests. Run with npm deps installed. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const path = require('node:path');
const src = fs.readFileSync(path.resolve(__dirname,'../src/pages/ProductionPage.tsx'),'utf8');
let checks=0; const verify=(label,fn)=>{fn(); checks++; console.log('PASS',label);};
const ast = ts.createSourceFile('ProductionPage.tsx',src,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
verify('Production TSX parser',()=>assert.equal(ast.parseDiagnostics.length,0));
const must=(label,fragment)=>verify(label,()=>assert(src.includes(fragment),`Missing ${fragment}`));
must('Active Action Queue is default',"const [activeTab, setActiveTab] = useState('active')");
must('Active filter excludes completed and held orders',"statuses: ['pending', 'in_production', 'ready']");
must('Completed history remains accessible',"{ key: 'completed', label: 'Completed'");
must('Shop row records real quantities', 'saveProducedBoard(currentRow, board, qty');
must('User-provided actual integer required', '!Number.isSafeInteger(qty) || qty < 0');
must('Materials and quantities cannot be bypassed on completion','(!b.qtyMet || !b.componentsReady)');
must('Atomic completion RPC stays authoritative', "await completeProductionOrder(currentRow, installer, currentRow.notes || '')");
must('Production writes retain org/role checks','if (!canLogProduction || !orgId)');
must('Other roles not added to write privileges', "const isProduction = profile?.role === 'printing'");
must('Approved artwork requires exact Work Item mapping','if (!allowed.has(link.work_item_id)) continue');
must('Avoid recycled page-1 task', 'const currentIndex = rows.findIndex(row => row.production_order_id === currentOrderId)');
must('Cross-page next uses same filtered production fetch', 'const result = await fetchProductionPage(nextPage, pageSize)');
must('Next-page select updates visible page', 'setPage(nextPage)');
must('Next-page fetch scopes assigned role','if (assignedFilterValue) q = q.eq(\'assigned_to\', assignedFilterValue)');
must('Next-page query still paginates', 'q = q.range(pageNumber * size, pageNumber * size + size - 1)');
must('Re-edit compares latest locally saved baseline','persisted.produced_qty !== expected');
must('Compare-and-swap persistence retained',"request.eq('produced_qty', persisted.produced_qty)");
must('No automatic actual from plan','if (!raw || !Number.isSafeInteger(qty) || qty < 0)');
must('Approved artwork without valid mapping not invented', "No approved artwork linked");
must('Single row quantity UI retains correct work and dimensions', "board.item.work_type_name || 'Work Item'");
must('Single sheet shows number of ready quantities', 'quantity targets recorded');
must('Primary button guides next shop','Save & next shop');
must('Partial failures preserved for retry','Successful quantities won\'t be re-submitted');
must('Double-save / hotkey race is synchronously guarded','workbenchActionLock.current = true');
must('Folder browser remains optional','enabled: !!orgId && !browsingList && !debouncedSearch');
const functionStart=src.indexOf('  async function openNextProductionTask(currentOrderId: string) {');
assert(functionStart>=0);
const finish=src.indexOf('\n  // ---- Folder browser',functionStart);
assert(finish>functionStart);
const expression=src.slice(functionStart,finish);
const fnEnd=expression.indexOf('\n  }\n')+5;
assert(fnEnd>4);
const fnOnly=expression.slice(0,fnEnd);
const compiled=ts.transpileModule(fnOnly+'\nglobalThis.__openNextProductionTask=openNextProductionTask;', {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
async function simulate({rowIds, currentId, visited=[], page=0, size=2, count, pages=[], selected=[]}) {
 const opened=[], fetched=[], setPages=[];let closed=false; const selectedOrderIds=new Set(selected); let selectedAfter=new Set(selected);
 const mkRow=(id)=>typeof id==='string'?{production_order_id:id,status:'pending',pending_boards:1}:id;
 const state={rows:rowIds.map(mkRow),visitedProductionIds:{current:new Set(visited)},selectedOrderIds,page,pageSize:size,totalCount:count,
   openQuantityWorkbench:async(row)=>opened.push(row.production_order_id),
   fetchProductionPage:async(next,size)=>{fetched.push([next,size]);return{rows:(pages[next]||[]).map(mkRow)};},
   setPage:(next)=>setPages.push(next),setQuantityWorkbench:(next)=>{if(next===null)closed=true;}, setSelectedOrderIds:(updater)=>{selectedAfter=updater(selectedAfter);}};
 const ctx=vm.createContext({...state,Set});vm.runInContext(compiled,ctx);await ctx.__openNextProductionTask(currentId);
 return {opened,fetched,setPages,closed,selectedAfter,visited:ctx.visitedProductionIds.current};
}
(async()=>{
 let r=await simulate({rowIds:['A','B','C'],currentId:'B',count:3,size:3});
 verify('Next from B goes to C, never restarts A',()=>assert.deepEqual(r.opened,['C']));
 verify('Current shop tracked as visited',()=>assert(r.visited.has('B')));
 r=await simulate({rowIds:['A','B','C'],currentId:'B',visited:['C'],count:3,size:3});
 verify('Already visited C not reopened',()=>assert.deepEqual(r.opened,[]));
 verify('No unvisited later shop cleanly ends workset',()=>assert(r.closed));
 r=await simulate({rowIds:['A','B'],currentId:'B',count:5,size:2,pages:{1:[{production_order_id:'C',pending_boards:0,status:'ready'},'D'],2:['E']}});
 verify('Across page moves to D skipping no-pending C',()=>assert.deepEqual(r.opened,['D']));
 verify('Cross-page cursor moves to visible page 2',()=>assert.deepEqual(r.setPages,[1]));
 verify('Only one next page fetched when ready',()=>assert.deepEqual(r.fetched,[[1,2]]));
 r=await simulate({rowIds:['A','B'],currentId:'B',count:6,size:2,pages:{1:[{production_order_id:'C',pending_boards:0,status:'completed'},{production_order_id:'D',pending_boards:0,status:'hold'}],2:['E','F']}});
 verify('Skips entire empty page and advances',()=>assert.deepEqual(r.opened,['E']));
 verify('No previous page reopened',()=>assert.deepEqual(r.setPages,[2]));
 const compiledFile=ts.transpileModule(src,{fileName:'ProductionPage.tsx',compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX},reportDiagnostics:true});
 verify('TypeScript transpilation diagnostics',()=>assert.equal(compiledFile.diagnostics?.filter(x=>x.category===ts.DiagnosticCategory.Error).length||0,0));
 console.log(`PRODUCTION V12: ${checks} checks passed`);
})().catch(err=>{console.error(err);process.exitCode=1});
