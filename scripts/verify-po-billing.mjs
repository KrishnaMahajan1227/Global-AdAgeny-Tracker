import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createContext, runInContext } from 'node:vm';

// Transpile only the pure helper, so these regression checks run without
// depending on Vite or Supabase credentials.
const require = createRequire(import.meta.url);
let ts;
try { ts = require('typescript'); }
catch { ts = require('/opt/nvm/versions/node/v22.16.0/lib/node_modules/typescript/lib/typescript.js'); }
const source = readFileSync(new URL('../src/lib/poBilling.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const exports = {};
const context = createContext({ exports });
runInContext(js, context);
const { buildPendingAllocations, consolidateInvoiceLines, money2 } = exports;
const rate = [{ po_line_item_id:'po1', description:'ACP display', uom:'sqft', rate:125, hsn_code:'9983' },{po_line_item_id:'po2',description:'Frames',uom:'piece',rate:200,hsn_code:'9983'}];
const shop='shop1';
const item=(id, overrides={})=>({id,shop_id:shop,po_line_item_id:'po1',installed_area:50,installed_quantity:1,produced_quantity:1,approved_area:50,approved_quantity:1,...overrides});
const calc=(items,billed=[],ids=[shop],type='survey_install')=>buildPendingAllocations(items,rate,billed,ids,type);
let checks=0;
const check=(desc,fn)=>{fn();checks++;console.log('PASS',desc)};
check('completed sqft from installed, not approved',()=>{const x=calc([item('a',{installed_area:20,approved_area:50})]);assert.equal(x.allocations[0].pending,20)});
check('reconciles previously invoiced sqft',()=>{const x=calc([item('a')],[{work_item_id:'a',shop_id:shop,po_line_item_id:'po1',area:30,quantity:1}]);assert.equal(x.allocations[0].pending,20);assert.equal(x.allocations[0].amount,2500)});
check('fully invoiced item not billed twice',()=>{const x=calc([item('a')],[{work_item_id:'a',shop_id:shop,po_line_item_id:'po1',area:50}]);assert.equal(x.allocations.length,0)});
check('unselected shop excluded',()=>assert.equal(calc([item('a')],[],['other']).allocations.length,0));
check('excluded work item skipped',()=>assert.equal(calc([item('a',{excluded_from_calculations:true})]).allocations.length,0));
check('missing PO line blocked',()=>assert.ok(calc([item('a',{po_line_item_id:null})]).issues.length));
check('missing rate blocked',()=>assert.ok(buildPendingAllocations([item('a')],[{...rate[0],rate:0}],[],[shop],'survey_install').issues.length));
check('legacy shop allocation blocked',()=>assert.ok(calc([item('a')],[{shop_id:shop,po_line_item_id:'po1',area:10}]).issues.length));
check('legacy unlinked PO allocation blocked',()=>assert.ok(calc([item('a')],[{po_line_item_id:'po1',area:10}]).issues.length));
check('overbilling detected',()=>assert.ok(calc([item('a')],[{work_item_id:'a',shop_id:shop,po_line_item_id:'po1',area:100}]).issues.length));
check('supply sqft uses proportionally produced approved area',()=>{const x=calc([item('a',{produced_quantity:2,approved_quantity:4,approved_area:40,installed_area:0})],[],[shop],'supply_only');assert.equal(x.allocations[0].pending,20)});
check('supply sqft without approved area is blocked',()=>assert.ok(calc([item('a',{installed_area:0,approved_area:0,approved_quantity:4})],[],[shop],'supply_only').issues.length));
check('supply pieces use produced quantity, not installed',()=>{const x=calc([item('b',{po_line_item_id:'po2',installed_quantity:0,produced_quantity:3})],[],[shop],'supply_only');assert.equal(x.allocations[0].pending,3);assert.equal(x.allocations[0].amount,600)});
check('mixed existing work items remain independent',()=>{const x=calc([item('a'),item('b',{po_line_item_id:'po2',installed_quantity:2})]);assert.equal(x.allocations.length,2)});
check('consolidation groups same PO line',()=>{const res=consolidateInvoiceLines([{po_line_item_id:'po1',description:'ACP',rate:125,quantity:1,area:20,amount:2500,shop_id:'a',work_item_id:'x'}, {po_line_item_id:'po1',description:'ACP',rate:125,quantity:1,area:10,amount:1250,shop_id:'b',work_item_id:'y'}]);assert.equal(res.length,1);assert.equal(res[0].area,30);assert.equal(res[0].amount,3750);assert.equal(res[0].shop_id,null)});
check('different PO lines never consolidate',()=>assert.equal(consolidateInvoiceLines([{po_line_item_id:'po1',description:'A',rate:1,quantity:1,amount:1},{po_line_item_id:'po2',description:'B',rate:1,quantity:1,amount:1}]).length,2));
check('currency rounds at 2 decimals',()=>assert.equal(money2(0.1+0.2),0.3));
console.log(`${checks} calculation checks passed`);
