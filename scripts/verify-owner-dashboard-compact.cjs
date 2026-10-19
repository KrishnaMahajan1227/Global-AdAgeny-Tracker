const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const d=fs.readFileSync(path.join(root,'src/pages/DashboardPage.tsx'),'utf8');
const s=fs.readFileSync(path.join(root,'src/components/AdminLayout.tsx'),'utf8');
const css=fs.readFileSync(path.join(root,'src/index.css'),'utf8');
const wo=fs.readFileSync(path.join(root,'src/pages/PurchaseOrdersPage.tsx'),'utf8');
let tests=0;
function check(name, fn){ fn(); ++tests; console.log('PASS',name); }
check('No tall unmatched dashboard columns',()=>{assert.doesNotMatch(d,/xl:grid-cols-\[1\.35fr_0\.95fr\]/);assert.match(d,/scroll-mt-20 overflow-hidden rounded-xl/);});
check('Dashboard has compact horizontal operations, no giant page heading',()=>{assert.doesNotMatch(d,/Operations control room/);assert.match(d,/Key delivery indicators/);assert.match(d,/Work Orders by client/);assert.match(d,/Quick access/);});
check('Client PO tracker includes site, next stage, actual links',()=>{assert.match(d,/poUrl\(item.order.id\)/);assert.match(d,/orderNextActionPath\(item.order, item.next, item.delivery.total > 0\)/);assert.match(d,/shopUrl\(item.order.id,stage.key\)/);assert.match(d,/ownerStageLabels\[stage.key\]/);});
check('All filters and common action routes have clickable destinations',()=>{for(const r of ['/survey-review','/design','/production','/installation-review','/field-map'])assert.ok(d.includes(`to: '${r}'`));assert.match(d,/setShowAllOrders/);assert.match(d,/setOrderSearch/);assert.match(d,/stageUrl\(stage.key\)/);});
check('Financial values stay out of work view until owner selects private mode',()=>{assert.match(d,/const financialView = Boolean\(isOwner && privateFinance\)/);assert.match(d,/useAgencyFinancials\(orgId, financialView\)/);assert.match(d,/!financialView \? <>/);assert.match(d,/isOwner && <section/);});
check('Sidebar flex layout has reachable footer and nav scroller',()=>{assert.match(s,/flex h-\[100dvh\] w-64 flex-col overflow-hidden/);assert.match(s,/app-sidebar-scroll min-h-0 flex-1/);assert.match(s,/shrink-0 border-t border-slate-700/);assert.doesNotMatch(s,/maxHeight: 'calc\(100vh - 200px\)'/);});
check('Scrollbar hidden but scrolling available on touch/keyboard',()=>{assert.match(css,/\.app-sidebar-scroll \{ scrollbar-width: none/);assert.match(css,/::-webkit-scrollbar/);assert.match(s,/overflow-y-auto overscroll-contain/);assert.match(s,/Escape/);});
check('Inferred historical milestones link to full site list, not empty current-stage filter',()=>{assert.match(wo,/title="This milestone is inferred from downstream status; open all linked sites"/);assert.doesNotMatch(wo,/stageFilterFor\(step.stage\)/);});
console.log(`ALL ${tests} OWNER DASHBOARD & NAVIGATION TESTS PASSED`);
