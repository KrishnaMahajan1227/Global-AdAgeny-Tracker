/** Demo regression: source contracts plus real pure completion calculations.
 * No network access, user secrets, or test database mutations.
 */
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
let ts; try {ts=require('typescript');} catch {ts=require('/opt/nvm/versions/node/v22.16.0/lib/node_modules/typescript');}
const root=path.resolve(__dirname,'..');
const source=fs.readFileSync(path.join(root,'src/pages/DashboardPage.tsx'),'utf8');
const app=fs.readFileSync(path.join(root,'src/App.tsx'),'utf8');
const navigation=fs.readFileSync(path.join(root,'src/components/AdminLayout.tsx'),'utf8');
let count=0;
function check(name, run){run();count++;console.log('PASS',name);}
const read=(name)=>fs.readFileSync(path.join(root,'src/lib',`${name}.ts`),'utf8');
const cache={};
function load(name){
  if(cache[name])return cache[name].exports;
  const mod={exports:{}};cache[name]=mod;
  const js=ts.transpileModule(read(name),{fileName:name+'.ts',compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS}}).outputText;
  const req=(dep)=>{if(dep==='./workCompletion')return load('workCompletion');throw new Error('Unexpected dependency: '+dep);};
  new Function('require','exports','module',js)(req,mod.exports,mod);
  return mod.exports;
}
const {deliveryByOrder,deliveryForOrder,deliveryForOrders}=load('agencyDelivery');
check('No Attention required panel, Site pipeline card or repeated navigation links',()=>{
  for(const old of ['id="owner-attention"','Attention required</h2>','Site pipeline</h2>','Quick access</span>']) assert.ok(!source.includes(old),`Unexpected duplicate: ${old}`);
});
check('Keeps approved compact Work Orders and Client delivery sections',()=>{
  assert.match(source,/id="owner-work-orders"/);assert.match(source,/aria-label="Client delivery summary"/);
  assert.match(source,/Key delivery indicators/);assert.match(source,/min-h-9/);
});
check('Four independent KPI cards are linked, accessible and accurate in scope',()=>{
  for(const title of ['Open Work Orders','Active clients','Sites delivered','Linked sites pending'])assert.ok(source.includes(`label: '${title}'`));
  assert.match(source,/snapshot\.portfolio\.deliveredSites/);
  assert.match(source,/snapshot\.unfinishedSites/);
  assert.match(source,/href: '\/shops\?stage=complete'/);
  assert.match(source,/href: '\/clients'/);
});
check('Needs action filter remains, with direct next-stage link and search',()=>{
  assert.match(source,/\['attention','Needs action'\]/);
  assert.match(source,/orderNextActionPath\(item.order, item.next, item.delivery.total > 0\)/);
  assert.match(source,/setOrderSearch/);assert.match(source,/setShowAllOrders/);
  assert.match(source,/relevantOrders\.slice\(0, 6\)/);
});
check('Client delivery is aggregate-only, without the same Work Orders repeated below',()=>{
  assert.doesNotMatch(source,/client\.work\.slice/);
  assert.match(source,/client\.deliveredSites/);
  assert.match(source,/Open client orders/);
  assert.match(source,/ordersByClient = new Map/);
  assert.match(source,/actionsByClient = new Map/);
});
check('Privacy: financial amounts require owner opt-in, operational view does not load amounts',()=>{
  assert.match(source,/const financialView = Boolean\(isOwner && privateFinance\)/);
  assert.match(source,/financialView \? ',total_amount' : ''/);
  assert.match(source,/useAgencyFinancials\(orgId, financialView\)/);
  assert.match(source,/!financialView \? <>/);
});
check('Old Campaign bookmarks safely redirect and Campaigns never render in agency navigation',()=>{
  assert.match(app,/path="\/campaigns" element=\{<Navigate to="\/purchase-orders" replace/);
  assert.doesNotMatch(navigation,/label: 'Campaigns'/);
});
check('Status and quantity remain distinct: mixed installation and supply-only orders',()=>{
  const orders=[
    {id:'install',client_id:'c1',fulfillment_type:'survey_install',status:'open'},
    {id:'supply',client_id:'c1',fulfillment_type:'supply_only',status:'open'},
    {id:'unlinked',client_id:'c2',fulfillment_type:'survey_install',status:'open'},
    {id:'legacyClosed',client_id:'c2',fulfillment_type:'survey_install',status:'closed'},
    {id:'cancelled',client_id:'c1',fulfillment_type:'survey_install',status:'cancelled'},
  ];
  const shops=[
    {purchase_order_id:'install',status:'installed'},
    {purchase_order_id:'install',status:'dispatched'},
    {purchase_order_id:'supply',status:'dispatched'},
    {purchase_order_id:'cancelled',status:'installed'},
  ];
  const group=deliveryByOrder(orders,shops);
  const summary=deliveryForOrders(orders,group);
  assert.deepEqual({total:summary.total,done:summary.done,open:summary.open,sites:summary.sites,deliveredSites:summary.deliveredSites,percentage:summary.percentage},{total:4,done:2,open:2,sites:3,deliveredSites:2,percentage:67});
  assert.equal(deliveryForOrder(orders[0],group).delivered,false);
  assert.equal(deliveryForOrder(orders[1],group).delivered,true);
  assert.equal(deliveryForOrder(orders[2],group).percentage,0);
  assert.equal(deliveryForOrder(orders[3],group).percentage,100);
});
check('Delivery receipt requirement prevents falsely completing dispatched supply',()=>{
  const order={id:'s',fulfillment_type:'supply_only',status:'open',delivery_receipt_required:true};
  const grouped=deliveryByOrder([order],[{purchase_order_id:'s',status:'dispatched'}]);
  assert.equal(deliveryForOrder(order,grouped).percentage,0);
  assert.equal(deliveryForOrder(order,grouped).delivered,false);
});
check('Empty, excluded and fully delivered portfolios avoid divide-by-zero and false pending',()=>{
  const nothing=deliveryForOrders([],deliveryByOrder([],[]));
  assert.equal(nothing.percentage,0);assert.equal(nothing.sites,0);assert.equal(nothing.open,0);
  const done={id:'done',fulfillment_type:'direct_install',status:'open'};
  const grp=deliveryByOrder([done],[{purchase_order_id:'done',status:'installed'},{purchase_order_id:'done',status:'cancelled'}]);
  const sum=deliveryForOrders([done],grp);
  assert.equal(sum.percentage,100);assert.equal(sum.sites,1);assert.equal(sum.deliveredSites,1);
  assert.equal(sum.open,0);assert.equal(sum.done,1);
});
console.log(`ALL ${count} OWNER DEMO DASHBOARD REGRESSIONS PASSED`);
