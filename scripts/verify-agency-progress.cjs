/** Run with: node scripts/verify-agency-progress.cjs (after npm install). */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
let ts;
try { ts = require('typescript'); }
catch { ts = require('/opt/nvm/versions/node/v22.16.0/lib/node_modules/typescript'); }
const root = path.resolve(__dirname, '..');
const modules = {};
function load(filename) {
  if (modules[filename]) return modules[filename];
  const contents = fs.readFileSync(path.join(root, 'src', filename), 'utf8');
  const js = ts.transpileModule(contents, {fileName: filename, compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020}}).outputText;
  const mod = {exports:{}};
  function fakeRequire(id) {
    if (id === './workCompletion') return load('lib/workCompletion.ts');
    if (id === './types') return {};
    if (id.includes('react-query') || id.includes('supabase') || id.includes('paginatedQuery') || id.includes('useRealtimeInvalidate')) return {};
    return {};
  }
  new Function('require','exports','module',js)(fakeRequire,mod.exports,mod);
  modules[filename]=mod.exports;
  return mod.exports;
}
const { getShopCompletion, orderOperationalPercent } = load('lib/workCompletion.ts');
const { deliveryByOrder, deliveryForOrder, deliveryForOrders, deliveryPipeline } = load('lib/agencyDelivery.ts');
const { financeForOrder, financeForOrders } = load('lib/agencyFinance.ts');
const { calculatePoProgress } = load('lib/poUtilization.ts');
const wo = (id, fulfillment_type='survey_install') => ({id,client_id:'client-a',status:'active',assignment_status:'in_progress',fulfillment_type});
const shops = Array.from({length:144},(_,index) => ({id:String(index), purchase_order_id:'po-1', status:index < 96 ? 'installed' : 'dispatched'}));
const orders = [wo('po-1')];
const grouped=deliveryByOrder(orders,shops);
const first=deliveryForOrder(orders[0],grouped);
assert.equal(first.total,144);
assert.equal(first.completed,96);
assert.equal(first.percentage,67,'site percentage must reflect installed shops');
assert.equal(first.delivered,false,'partially installed order is not done');
assert.equal(deliveryForOrders(orders,grouped).done,0);
const weighted = deliveryForOrders([wo('po-1'),wo('one-site')], deliveryByOrder([wo('po-1'),wo('one-site')], [...shops,{status:'installed',purchase_order_id:'one-site'}]));
assert.equal(weighted.percentage, 67,'portfolio site percentage must be weighted by actual linked sites');
assert.equal(deliveryPipeline([{status:'installed',purchase_order_id:'cancel-order'}],[{...wo('cancel-order'),status:'cancelled'}]).excluded,1,'cancelled-order sites cannot inflate active delivery');
assert.deepEqual([deliveryPipeline(shops,orders).dispatch,deliveryPipeline(shops,orders).complete],[48,96]);
const supply=wo('supply-1','supply_only');
const supplyMap=deliveryByOrder([supply],[{status:'dispatched',purchase_order_id:'supply-1'}]);
assert.equal(deliveryForOrder(supply,supplyMap).percentage,100,'supply-only dispatch is the terminal stage');
assert.equal(deliveryForOrder(supply,supplyMap).delivered,true);
const shopWithCancelled=[...shops,{status:'cancelled',purchase_order_id:'po-1'}];
assert.equal(deliveryByOrder(orders,shopWithCancelled).get('po-1').total,144,'cancelled sites are excluded');
assert.equal(orderOperationalPercent(wo('empty'),undefined),0,'unknown site counts must not fabricate completion');
const same=Array.from({length:4},(_,index)=>({status:'installed',purchase_order_id:'other',id:String(index)}));
assert.equal(deliveryByOrder([wo('po-1'),wo('other')],[...shops,...same]).get('po-1').total,144,'POs must never share shops');
const invoiced=new Map([['po-1',25000],['po-2',5000]]);
assert.deepEqual(financeForOrder({...wo('po-1'),total_amount:100000},invoiced),{planned:100000,invoiced:25000,remaining:75000,percentage:25});
assert.equal(financeForOrders([{...wo('po-1'),total_amount:100000},{...wo('po-2'),total_amount:20000}],invoiced).percentage,25);
assert.equal(financeForOrder({...wo('po-1'),total_amount:null},invoiced).percentage,null,'missing budget cannot invent percent');
const measured = [{po_line_item_id:'line-a',uom:'piece',budgeted_qty:100,budgeted_area:null,rate:200,surveyed_qty:100,surveyed_area:0,approved_qty:100,approved_area:0,produced_qty:100,installed_qty:0,installed_area:0,invoiced_amount:0}];
assert.equal(calculatePoProgress(measured,'installed',1).workPct,0,'shop status is not a measured quantity');
assert.equal(first.percentage,67,'site-based progress remains visible when measured qty is zero');
console.log('PASS: agency site delivery, stage grouping, cancellations, PO separation, financial reconciliation and no invented quantities');
