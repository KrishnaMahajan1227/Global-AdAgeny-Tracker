const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const cache = new Map();
function load(file) {
  if (cache.has(file)) return cache.get(file);
  const output = ts.transpileModule(fs.readFileSync(path.join(root,'src',file),'utf8'), {
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}
  }).outputText;
  const mod={exports:{}};
  cache.set(file,mod.exports);
  function fakeRequire(id) {
    if(id==='./workCompletion') return load('lib/workCompletion.ts');
    if(id==='./poBilling') return load('lib/poBilling.ts');
    return {};
  }
  new Function('require','exports','module',output)(fakeRequire,mod.exports,mod);
  return mod.exports;
}
const {milestoneProgress, getShopCompletion, shopStage} = load('lib/workCompletion.ts');
const {summarizeBillingReadiness} = load('lib/billingReadiness.ts');
const {buildPendingAllocations} = load('lib/poBilling.ts');
let passes=0;
function test(label,action){action();passes++;console.log('PASS',label);}
const rate=(props={})=>({po_line_item_id:'line1',description:'Outdoor branding',uom:'piece',rate:50,budgeted_qty:100,requires_survey:true,requires_design:true,requires_production:true,requires_installation:true,...props});
const work=(props={})=>({id:'item1',shop_id:'shop1',shop_status:'installed',po_line_item_id:'line1',status:'installed',installed_quantity:10,approved_quantity:10,produced_quantity:10,...props});
const shop=(status='installed')=>[{id:'shop1',status,client_id:'client1',purchase_order_id:'po1'}];
const sum=(shops,items,rates,billed=[],type='survey_install')=>summarizeBillingReadiness(shops,items,rates,billed,type);
test('Installation implies all five applicable milestones without writing approvals',()=>{
 const x=milestoneProgress(shop(), 'survey_install');
 assert.equal(x.milestones.length,5);
 assert.ok(x.milestones.every(step=>step.percentage===100));
});
test('Partial delivery percentages cascade into upstream stages',()=>{
 const x=milestoneProgress([{status:'installed'},{status:'production_done'}],'survey_install');
 assert.deepEqual(x.milestones.map(a=>a.percentage),[100,100,100,50,50]);
});
test('Unapproved survey and unfinished production cannot pass validation prematurely',()=>{
 assert.equal(milestoneProgress([{status:'surveyed'},{status:'approval_pending'}],'survey_install').milestones[0].percentage,0);
 assert.equal(milestoneProgress([{status:'production_ready'}],'survey_install').milestones.find(s=>s.stage==='production').percentage,0);
});
test('Supply-only dispatch implies completed production and dispatch',()=>{
 assert.deepEqual(milestoneProgress(shop('dispatched'),'supply_only').milestones.map(x=>x.percentage),[100,100]);
});
test('Direct-install only shows installation milestone',()=>{
 assert.deepEqual(milestoneProgress(shop(),'direct_install').milestones.map(x=>x.stage),['installation']);
});
test('Design approved enters production queue rather than remaining in design stage',()=>{
 assert.equal(shopStage('survey_install','design_approved'),'production');
});
test('Custom production-only scope does not invent installation requirement',()=>{
 const r=rate({requires_survey:false,requires_design:false,requires_production:true,requires_installation:false});
 assert.equal(getShopCompletion(shop('production_done'),'custom',[r]).percentage,100);
 assert.deepEqual(milestoneProgress(shop('production_done'),'custom',[r]).milestones.map(x=>x.stage),['production']);
 const x=sum(shop('production_done'),[work({status:'production_done',shop_status:'production_done',installed_quantity:0,produced_quantity:5})],[r],[],'custom');
 assert.equal(x.readyAmount,250);
});
test('Custom design-only completion uses approved measured quantities',()=>{
 const r=rate({requires_survey:false,requires_design:true,requires_production:false,requires_installation:false});
 assert.equal(sum(shop('design_approved'),[work({shop_status:'design_approved',approved_quantity:4,installed_quantity:0})],[r],[],'custom').readyAmount,200);
});
test('Custom survey-only completion uses surveyed measured quantities',()=>{
 const r=rate({requires_survey:true,requires_design:false,requires_production:false,requires_installation:false});
 assert.equal(sum(shop('approved'),[work({shop_status:'approved',survey_quantity:6,installed_quantity:0})],[r],[],'custom').readyAmount,300);
});
test('Mixed custom scope cannot finish before its required installation',()=>{
 const r1=rate({requires_installation:false});
 const r2=rate({po_line_item_id:'line2',requires_installation:true});
 assert.equal(getShopCompletion(shop('production_done'),'custom',[r1,r2]).percentage,0);
});
test('Installed but no measurements is not invoice-ready',()=>{
 const x=sum(shop(),[work({installed_quantity:0,approved_quantity:0})],[rate()]);
 assert.equal(x.readyAmount,0);assert.equal(x.needsReviewShops,1);
});
test('Completed and unbilled work becomes invoice-ready by rate x quantity',()=>{
 const x=sum(shop(),[work()],[rate()]);
 assert.equal(x.readyAmount,500);assert.equal(x.readyShops,1);assert.equal(x.plannedAmount,5000);
});
test('Owner financial line breakdown reconciles exactly with total readiness',()=>{
 const rows=[rate(),rate({po_line_item_id:'line2',description:'Second design',rate:80})];
 const works=[work(),work({id:'item2',po_line_item_id:'line2',installed_quantity:5})];
 const x=sum(shop(),works,rows);
 assert.equal(x.readyLines.length,2);
 assert.equal(x.readyLines[0].amount,500);
 assert.equal(x.readyLines[1].amount,400);
 assert.equal(x.readyLines.reduce((n,row)=>n+row.amount,0),x.readyAmount);
 assert.equal(x.readyLines[1].workItems,1);
 assert.equal(x.readyLines[1].sites,1);
});
test('Part-invoiced works subtract historical billed unit quantity',()=>{
 const x=sum(shop(),[work()],[rate()],[{work_item_id:'item1',po_line_item_id:'line1',quantity:3}]);
 assert.equal(x.readyAmount,350);
 assert.equal(x.billedShops,0);
});
test('A partially ready shop stays flagged when another work item has missing measurements',()=>{
 const x=sum(shop(),[work({id:'item1'}),work({id:'item2',installed_quantity:0,approved_quantity:0})],[rate()]);
 assert.equal(x.readyAmount,500);assert.equal(x.readyShops,1);assert.equal(x.needsReviewShops,1);
});
test('Fully invoiced shops do not appear ready or needing reconciliation',()=>{
 const x=sum(shop(),[work()],[rate()],[{work_item_id:'item1',po_line_item_id:'line1',quantity:10}]);
 assert.equal(x.readyAmount,0);assert.equal(x.billedShops,1);assert.equal(x.needsReviewShops,0);
});
test('Supply dispatch bills produced units without pretending installation',()=>{
 const x=sum(shop('dispatched'),[work({shop_status:'dispatched',installed_quantity:0,produced_quantity:8})],[rate()],[],'supply_only');
 assert.equal(x.readyAmount,400);
});
test('No ready value before direct installation is completed',()=>{
 const x=sum(shop('installation_review'),[work({shop_status:'installation_review'})],[rate()],[],'direct_install');
 assert.equal(x.readyAmount,0);
});
test('Missing rate and scope blocks financial percentage',()=>{
 const x=sum(shop(),[work()],[rate({rate:null})]);
 assert.equal(x.plannedAmount,null); assert.equal(x.readyAmount,0);
});
test('Old unlinked invoice allocations are flagged instead of double billed',()=>{
 const x=sum(shop(),[work()],[rate()],[{shop_id:'shop1',po_line_item_id:'line1',quantity:3}]);
 assert.equal(x.readyAmount,0);assert.ok(x.issues.length);
});
test('Cancelled shops cannot inflate stage completion',()=>{
 assert.equal(shopStage('survey_install','cancelled'),'excluded');
 assert.equal(getShopCompletion([{status:'installed'},{status:'cancelled'}],'survey_install').percentage,100);
});
test('Square-foot invoices use measured actual area and subtract billed area',()=>{
 const r=rate({uom:'sqft',rate:125,budgeted_qty:null,budgeted_area:100});
 const x=sum(shop(),[work({installed_area:20,installed_quantity:1})],[r],[{work_item_id:'item1',po_line_item_id:'line1',area:8}]);
 assert.equal(x.readyAmount,1500);
});
test('Custom survey-only stage cannot bill without surveyed measurements',()=>{
 const r=rate({requires_survey:true,requires_design:false,requires_production:false,requires_installation:false});
 assert.equal(buildPendingAllocations([work({shop_status:'approved',survey_quantity:0})],[r],[],['shop1'],'custom').allocations.length,0);
});
console.log(`ALL ${passes} OWNER READINESS REGRESSIONS PASSED`);
