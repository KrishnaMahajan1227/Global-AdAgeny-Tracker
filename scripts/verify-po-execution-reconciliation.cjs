const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const ts = require('typescript');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'darshan-execution-test-'));
for (const mod of ['poExecutionReconciliation','workCompletion','poUtilization']) {
  const input = path.resolve(__dirname, '..', 'src', 'lib', `${mod}.ts`);
  const compiled = ts.transpileModule(fs.readFileSync(input, 'utf8'), {
    fileName:input,compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}
  });
  fs.writeFileSync(path.join(output, `${mod}.js`), compiled.outputText);
}
const {reconcileOrderExecution, finalLineMeasurementStage} = require(path.join(output,'poExecutionReconciliation.js'));
const {computeUtilization} = require(path.join(output,'poUtilization.js'));

const line=(id='po1',qty=1000)=>({po_line_item_id:id,description:'ACP CUTOUT STANDEE',work_type_id:'a',uom:'piece',budgeted_qty:qty,rate:250,surveyed_area:0,surveyed_qty:0,approved_area:0,approved_qty:0,produced_qty:0,installed_area:0,installed_qty:0,linked_work_item_count:0,invoiced_amount:0});
const shop=(id,status)=>({id, status,purchase_order_id:'po1'});
const wi=(id, shop_id, data={})=>({id,shop_id,po_line_item_id:null,status:'installed',installed_quantity:1, ...data});
let n=0;function test(name,fn){fn();n++;console.log('PASS',name)}
test('shop stage alone does not imply 96 measured pieces',()=>{
 const r=reconcileOrderExecution([line()],[...Array.from({length:96},(_,i)=>shop(`s${i}`,'installed')),...Array.from({length:48},(_,i)=>shop(`d${i}`,'dispatched'))],[],'survey_install');
 assert.equal(r.finalSites,96);assert.equal(r.measuredFinalSites,0);assert.equal(r.missingFinalSites,96);assert.equal(r.rows[0].installed_qty,0);
});
test('unlinked legacy item with measured qty and sole line is recovered once',()=>{
 const r=reconcileOrderExecution([line()],[shop('s1','installed')],[wi('w1','s1',{installed_quantity:2,approved_quantity:2})],'survey_install');
 assert.equal(r.rows[0].installed_qty,2);assert.equal(r.rows[0].approved_qty,2);assert.equal(r.measuredFinalSites,1);assert.equal(r.legacyItemsRecovered,1);
});
test('explicit po line ID maps without recovery',()=>{
 const r=reconcileOrderExecution([line()],[shop('s1','installed')],[wi('w1','s1',{po_line_item_id:'po1',installed_quantity:2})],'survey_install');
 assert.equal(r.rows[0].installed_qty,2);assert.equal(r.legacyItemsRecovered,0);
});
test('no invented installed quantity from approved-only work',()=>{
 const r=reconcileOrderExecution([line()],[shop('s1','installed')],[wi('w1','s1',{status:'approved',installed_quantity:0,approved_quantity:5})],'survey_install');
 assert.equal(r.rows[0].installed_qty,0);assert.equal(r.missingFinalSites,1);
});
test('documented installed work may use approved quantity fallback',()=>{
 const r=reconcileOrderExecution([line()],[shop('s1','installed')],[wi('w1','s1',{status:'installed',installed_quantity:0,approved_quantity:5})],'survey_install');
 assert.equal(r.rows[0].installed_qty,5);assert.equal(r.missingFinalSites,0);
});
test('ambiguous matches with multiple lines are not guessed',()=>{
 const rates=[line('po1'),{...line('po2'),work_type_id:'b'}];
 const r=reconcileOrderExecution(rates,[shop('s1','installed')],[wi('w1','s1',{work_type_id:null})],'survey_install');
 assert.equal(r.unmatchedItems,1);assert.equal(r.rows.reduce((a,x)=>a+x.installed_qty,0),0);
});
test('wrong explicit PO line ID is not reassigned',()=>{
 const r=reconcileOrderExecution([line()],[shop('s1','installed')],[wi('w1','s1',{po_line_item_id:'foreign'})],'survey_install');
 assert.equal(r.unmatchedItems,1);assert.equal(r.rows[0].installed_qty,0);
});
test('excluded item and rejected shops excluded',()=>{
 const r=reconcileOrderExecution([line()],[shop('s1','installed'),shop('s2','cancelled')],[wi('w1','s1',{excluded_from_calculations:true}),wi('w2','s2')],'survey_install');
 assert.equal(r.finalSites,1);assert.equal(r.rows[0].installed_qty,0);
});
test('supply only dispatch uses produced quantity, not installed count',()=>{
 const r=reconcileOrderExecution([line()],[shop('s1','dispatched')],[wi('w1','s1',{status:'production_done',installed_quantity:0,produced_quantity:3})],'supply_only');
 assert.equal(r.finalSites,1);assert.equal(r.measuredFinalSites,1);assert.equal(r.rows[0].produced_qty,3);
});
test('custom production only can measure final without install',()=>{
 const r=reconcileOrderExecution([line()],[shop('s1','production_done')],[wi('w1','s1',{status:'production_done',installed_quantity:0,produced_quantity:7})],'custom', [{id:'po1',requires_installation:false,requires_production:true}]);
 assert.equal(r.finalSites,1);assert.equal(r.measuredFinalSites,1);
});
console.log(n,'reconciliation checks passed');

test('No variance for missing survey quantity',()=>{
 assert.equal(computeUtilization(line()).hasVariance, false);
 assert.equal(computeUtilization({...line(),surveyed_qty:1100}).hasVariance, true);
});
test('per-line final evidence stage respects custom flags',()=>{
 assert.equal(finalLineMeasurementStage('supply_only'),'produced');
 assert.equal(finalLineMeasurementStage('direct_install'),'installed');
 assert.equal(finalLineMeasurementStage('custom',{requires_installation:false,requires_production:true}),'produced');
 assert.equal(finalLineMeasurementStage('custom',{requires_installation:false,requires_production:false,requires_design:true}),'approved');
});
fs.rmSync(output,{recursive:true,force:true});
