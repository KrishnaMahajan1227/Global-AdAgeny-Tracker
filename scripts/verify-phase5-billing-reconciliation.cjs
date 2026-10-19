const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const cache = new Map();
function load(file) {
  if (cache.has(file)) return cache.get(file);
  const code = ts.transpileModule(fs.readFileSync(path.join(root,'src',file),'utf8'),
    {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
  const module = {exports:{}}; cache.set(file,module.exports);
  const requireFile = id => id === './workCompletion' ? load('lib/workCompletion.ts')
    : id === './poBilling' ? load('lib/poBilling.ts')
    : id === './poUtilization' ? load('lib/poUtilization.ts')
    : id === './supabase' || id === '@tanstack/react-query' || id === './paginatedQuery' || id === './useRealtimeInvalidate' || id === './poBillingHistory' ? {} : {};
  new Function('require','exports','module',code)(requireFile,module.exports,module);
  return module.exports;
}
const {buildPendingAllocations,validateInvoiceAllocationSelection}=load('lib/poBilling.ts');
const {summarizeBillingReadiness}=load('lib/billingReadiness.ts');
const {reconcileOrderExecution}=load('lib/poExecutionReconciliation.ts');
const rate=(p={})=>({po_line_item_id:'l1',description:'Printed Board',uom:'piece',rate:200,budgeted_qty:100,requires_survey:false,requires_design:true,requires_production:true,requires_installation:false,...p});
const shop=(status='delivered')=>({id:'s1',status,client_id:'c1',purchase_order_id:'po1'});
const work=(p={})=>({id:'w1',shop_id:'s1',shop_status:'delivered',status:'production_done',po_line_item_id:'l1',produced_quantity:10,approved_quantity:10,approved_area:50,...p});
const rows = [rate()];
let count = 0;
const test=(name,func)=>{func();count++;console.log('PASS',name);};
const get=(shops=[shop()],items=[work()],billed=[],required=true)=>summarizeBillingReadiness(shops,items,rows,billed,'supply_only',required);
const invoice=(a,overrides={})=>({work_item_id:a.workItemId,po_line_item_id:a.poLineId,shop_id:a.shopId,quantity:a.pending,area:null,rate:a.rate,amount:a.amount,...overrides});
test('new supply order awaiting receipt is not billed',()=>assert.equal(get([shop('dispatched')]).readyAmount,0));
test('historical supply order still bills dispatched production',()=>assert.equal(get([shop('dispatched')],[work({shop_status:'dispatched'})],[],false).readyAmount,2000));
test('received new supply order becomes eligible only with measured work',()=>{assert.equal(get().readyAmount,2000);assert.equal(get([shop()],[work({produced_quantity:0})]).readyAmount,0);});
test('allocation engine independently blocks a selected dispatched shop',()=>{
 const a=buildPendingAllocations([work({shop_status:'dispatched'})],rows,[],['s1'],'supply_only',rows,true);
 assert.equal(a.allocations.length,0);assert(a.issues.length>0);
});
test('selected supply work requires receipt evidence status',()=>assert.equal(buildPendingAllocations([work({shop_status:null})],rows,[],['s1'],'supply_only',rows,true).allocations.length,0));
test('partial invoice within eligible quantity is permitted',()=>{
 const a=buildPendingAllocations([work()],rows,[],['s1'],'supply_only',rows,true).allocations[0];
 assert.equal(validateInvoiceAllocationSelection([invoice(a,{quantity:3,amount:600})],[a]).valid,true);
});
test('over-billing quantity is rejected',()=>{
 const a=buildPendingAllocations([work()],rows,[],['s1'],'supply_only',rows,true).allocations[0];
 assert.equal(validateInvoiceAllocationSelection([invoice(a,{quantity:11,amount:2200})],[a]).valid,false);
});
test('wrong PO line is rejected even with equal amount',()=>{
 const a=buildPendingAllocations([work()],rows,[],['s1'],'supply_only',rows,true).allocations[0];
 assert.equal(validateInvoiceAllocationSelection([invoice(a,{po_line_item_id:'foreign'})],[a]).valid,false);
});
test('duplicate work item on the same invoice is rejected',()=>{
 const a=buildPendingAllocations([work()],rows,[],['s1'],'supply_only',rows,true).allocations[0];
 assert.equal(validateInvoiceAllocationSelection([invoice(a),invoice(a)],[a]).valid,false);
});
test('changed rate or manipulated amount is rejected',()=>{
 const a=buildPendingAllocations([work()],rows,[],['s1'],'supply_only',rows,true).allocations[0];
 assert.equal(validateInvoiceAllocationSelection([invoice(a,{rate:100})],[a]).valid,false);
 assert.equal(validateInvoiceAllocationSelection([invoice(a,{amount:1200})],[a]).valid,false);
});
test('historically billed quantity is deducted before a partial new invoice',()=>{
 const a=buildPendingAllocations([work()],rows,[{id:'hist',work_item_id:'w1',po_line_item_id:'l1',quantity:6}],['s1'],'supply_only',rows,true).allocations[0];
 assert.equal(a.pending,4);assert.equal(validateInvoiceAllocationSelection([invoice(a,{quantity:4,amount:800})],[a]).valid,true);
});
test('legacy shop-level invoice without work-item ID blocks repeat billing',()=>{
 const a=buildPendingAllocations([work()],rows,[{id:'hist',shop_id:'s1',quantity:5}],['s1'],'supply_only',rows,true);
 assert.equal(a.allocations.length,0);assert(a.issues.some(x=>x.includes('work-item allocation')));
});
test('unapproved installation work item stays blocked despite a completed parent shop',()=>{
 const installRate=rate({requires_installation:true});
 const item=work({status:'installation_review',shop_status:'installed',installed_quantity:8});
 const result=buildPendingAllocations([item],[installRate],[],['s1'],'production_install',[installRate]);
 assert.equal(result.allocations.length,0);
 assert(result.issues.some(issue=>issue.includes('still requires review')));
});
test('square-foot pending area is not multiplied by unit count',()=>{
 const r=rate({uom:'sqft',budgeted_area:500,rate:50});
 const a=buildPendingAllocations([work()], [r], [{work_item_id:'w1',po_line_item_id:'l1',area:20}], ['s1'],'supply_only',[r],true).allocations[0];
 assert.equal(a.pending,30);assert.equal(a.amount,1500);
 assert.equal(validateInvoiceAllocationSelection([invoice(a,{quantity:10,area:15,amount:750})],[a]).valid,true);
});
test('fully invoiced item does not return in readiness queue',()=>assert.equal(get([shop()],[work()],[{work_item_id:'w1',po_line_item_id:'l1',quantity:10}]).readyAmount,0));
test('progress-reconciliation respects receipt requirement',()=>{
 const line={po_line_item_id:'l1',work_type_id:null,description:'Printed Board',uom:'piece',budgeted_qty:100,budgeted_area:null,rate:200,invoiced_amount:0};
 const base=[{id:'w1',shop_id:'s1',po_line_item_id:'l1',status:'production_done',produced_quantity:10}];
 const before=reconcileOrderExecution([line],[shop('dispatched')],base,'supply_only',[],true);
 const after=reconcileOrderExecution([line],[shop('delivered')],base,'supply_only',[],true);
 assert.equal(before.finalSites,0);assert.equal(after.finalSites,1);
});
test('source uses same receipt policy and history in preview and final save',()=>{
 const billing=fs.readFileSync(path.join(root,'src/pages/BillingPage.tsx'),'utf8');
 const ready=fs.readFileSync(path.join(root,'src/lib/billingReadiness.ts'),'utf8');
 assert(billing.includes('validateInvoiceAllocationSelection(items, latestBatch.allocations)'));
 assert(billing.includes('selectedPO.delivery_receipt_required === true'));
 assert(ready.includes('const receiptRequired = orderPolicy.data?.delivery_receipt_required === true'));
 assert(!ready.includes('rates, receiptRequired));\n      const workItems'));
});
test('history fetch additionally checks work-item and ambiguous shop-only invoices',()=>{
 const history=fs.readFileSync(path.join(root,'src/lib/poBillingHistory.ts'),'utf8');
 assert(history.includes(".in('work_item_id',ids)"));assert(history.includes(".is('work_item_id',null).in('shop_id',ids)"));
});
console.log(`ALL ${count} PHASE 5 RECONCILIATION REGRESSIONS PASSED`);
