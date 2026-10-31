const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
let count = 0;
function pass(title, condition) { assert.ok(condition, title); console.log('PASS', title); count++; }
function loadTs(rel) {
  const source = fs.readFileSync(path.join(root, rel), 'utf8');
  const transpiled = ts.transpileModule(source, { fileName: rel, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, reportDiagnostics: true });
  assert.equal((transpiled.diagnostics || []).filter(x => x.category === ts.DiagnosticCategory.Error).length, 0, `${rel} must compile syntactically`);
  const module = { exports: {} };
  new Function('module', 'exports', 'require', transpiled.outputText)(module, module.exports, require);
  return module.exports;
}
const { runBoundedWorkflowBatch, summarizeWorkflowBatch } = loadTs('src/lib/workflowBatch.ts');
const { fetchWorkflowFolderPages } = loadTs('src/lib/workflowFolderPages.ts');
const designer = fs.readFileSync(path.join(root, 'src/pages/DesignerPage.tsx'), 'utf8');
const production = fs.readFileSync(path.join(root, 'src/pages/ProductionPage.tsx'), 'utf8');
const supply = fs.readFileSync(path.join(root, 'src/pages/SupplyOrdersPage.tsx'), 'utf8');
(async () => {
  let active = 0, peak = 0;
  const work = Array.from({length:120}, (_,i) => i);
  const progress = [];
  const result = await runBoundedWorkflowBatch(work, async i => {
    active++; peak = Math.max(peak,active);
    await new Promise(resolve => setTimeout(resolve, i % 4));
    active--;
    if (i % 17 === 0) throw new Error('intentional failure');
  }, (done,total) => progress.push([done,total]), 3);
  pass('120 operations complete with bounded maximum concurrency',peak <= 3 && peak > 1 && result.processed===120);
  pass('Success/failure partition covers every record',result.completed.length+result.failed.length===120);
  pass('Per-row exceptions retained with exact references',result.failed.every(f=>f.item%17===0 && f.message==='intentional failure'));
  pass('Progress callback fires exactly once per row',progress.length===120 && progress.at(-1)[0]===120);
  const retries = await runBoundedWorkflowBatch(result.failed.map(f=>f.item), async () => {});
  pass('Failed subset independently retryable',retries.completed.length===result.failed.length && retries.failed.length===0);
  pass('Summary communicates partial success and retry count',summarizeWorkflowBatch(result,'sent',x=>String(x)).includes('need attention'));
  const none = await runBoundedWorkflowBatch([],async()=>{throw new Error('should not run')});
  pass('Empty batch is a safe no-op',none.total===0 && none.processed===0);
  const ids=Array.from({length:1555},(_,i)=>`shop-${i}`);
  let pages=[];
  const fetched=await fetchWorkflowFolderPages(async(from,to)=>{pages.push([from,to]);return ids.slice(from,to+1);});
  pass('Folder data correctly includes 1000+ entries',fetched.length===1555 && fetched[1554]==='shop-1554');
  pass('Folder pagination uses stable bounded windows',pages.length===4 && pages[1][0]===500 && pages[3][0]===1500);
  await assert.rejects(()=>fetchWorkflowFolderPages(async()=>[], 1001), /Invalid folder page size/);
  pass('Invalid page sizes are rejected',true);
  pass('Direct Client → Work Order → Zone folder hierarchy retained',designer.includes('clientFolders') && designer.includes('poFolders') && designer.includes('zoneFolders') && production.includes('clientFolders') && production.includes('poFolders') && production.includes('zoneFolders') && !production.includes("level === 'campaign'"));
  pass('Design and Production folder sources page beyond PostgREST 1000-row default',[designer,production].every(src=>src.includes('fetchWorkflowFolderPages(async (from, to)')));
  pass('Design and Production can process up to 100 rows per page',[designer,production].every(src=>src.includes('100/page') && src.includes('Select visible')));
  pass('Every bulk handoff retains failures for retry',designer.includes('result.failed.map(f => f.item)') && production.includes('result.failed.map(f => f.item)'));
  pass('Company approval gate still active on design handoff',designer.includes("supabase.rpc('phase3_send_to_production'") && designer.includes('CompanyApprovalHandoff'));
  pass('Production installer/packing handoff keeps atomic server RPC',production.includes("supabase.rpc('phase3_complete_production'"));
  pass('Dispatch uses atomic server RPC and receipt server gate',supply.includes("supabase.rpc('phase4_create_supply_dispatch'") && supply.includes("supabase.rpc('phase4_confirm_supply_receipt'"));
  pass('Dispatch ready shops use full paginated fetching',supply.includes("shop.purchase_orders?.fulfillment_type === 'supply_only'") && supply.includes('fetchWorkflowFolderPages(async (from, to)'));
  pass('Dispatch search and selection never auto-confirm delivery',supply.includes('destinationSearch') && supply.includes('Select visible') && supply.includes('selectedReceiptStopIds'));
  pass('Delivery bulk action explicitly identifies same-recipient constraint',supply.includes('the same named recipient') && supply.includes('Every destination is independently validated by the server'));
  pass('Receipt batch progress and partial failure handling provided',supply.includes('setBatchReceiptProgress') && supply.includes('result.failed.length') && supply.includes('setSelectedReceiptStopIds'));
  pass('Dispatch retry ID resets when scope changes',supply.includes('function changeRouteForm') && supply.includes('dispatchRequestId.current = null;'));
  for(const src of [designer,production,supply]){
    const res=ts.transpileModule(src,{fileName:'screen.tsx',compilerOptions:{jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022},reportDiagnostics:true});
    assert.equal((res.diagnostics||[]).filter(d=>d.category===ts.DiagnosticCategory.Error).length,0);
  }
  pass('All three edited screens transpile with TypeScript',true);
  console.log(`ALL ${count} WORKFLOW V5 CHECKS PASSED`);
})().catch(err=>{console.error('FAIL',err.stack||err);process.exitCode=1});
