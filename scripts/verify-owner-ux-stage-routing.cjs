const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
let ts; try {ts = require('typescript');} catch {ts=require('/opt/nvm/versions/node/v22.16.0/lib/node_modules/typescript');}
const root = path.resolve(__dirname,'..');
const cache={};
function load(name){if(cache[name]) return cache[name];const source=fs.readFileSync(path.join(root,'src/lib',name+'.ts'),'utf8');const js=ts.transpileModule(source,{fileName:name+'.ts',compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;const module={exports:{}};cache[name]=module.exports;new Function('require','exports','module',js)((dep)=>dep==='./workCompletion'?load('workCompletion'):{},module.exports,module);return module.exports;}
const {statusesForStage,describeOrderNextStep,stageMatches}=load('ownerOperations');
const {shopStage}=load('workCompletion');
let passed=0;const t=(label,fn)=>{fn();console.log('PASS',label);passed++};
t('Supply-only dispatched is final delivered, not open dispatch',()=>{assert.ok(statusesForStage('complete','supply_only').includes('dispatched'));assert.ok(!statusesForStage('dispatch','supply_only').includes('dispatched'));});
t('Survey+install dispatched is dispatched and not complete',()=>{assert.ok(statusesForStage('dispatch','survey_install').includes('dispatched'));assert.ok(!statusesForStage('complete','survey_install').includes('dispatched'));});
t('Installation orders finish at installed/billed; supply finishes at delivered/dispatched or billed',()=>{for(const type of ['survey_install','direct_install','production_install']) for(const status of ['installed','billed']) assert.ok(statusesForStage('complete',type).includes(status));for(const status of ['dispatched','delivered','billed']) assert.ok(statusesForStage('complete','supply_only').includes(status));assert.ok(!statusesForStage('complete','supply_only').includes('installed'));});
t('Field bucket matches pending and survey, not completed',()=>{assert.ok(stageMatches('pending','field'));assert.ok(stageMatches('survey','field'));assert.ok(!stageMatches('complete','field'));});
t('All grouped status lists exactly match shopStage for each fulfillment',()=>{const cases=[['survey_install',[]],['supply_only',[]],['direct_install',[]],['custom',[{requires_survey:false,requires_design:false,requires_production:true,requires_installation:false}]]];for(const [type,flags] of cases) for(const bucket of ['field','pending','survey','design','production','dispatch','installation','review','complete','excluded']) for(const status of statusesForStage(bucket,type,flags)) assert.ok(stageMatches(shopStage(type,status,flags),bucket),`${type}:${status} mismatched ${bucket}`);});
t('Owner priority shows installation review ahead of production',()=>{assert.equal(describeOrderNextStep({review:3,pending:0,survey:0,design:0,production:5,dispatch:2,installation:0,complete:0,excluded:0}).stage,'review');});
t('Action summary has an explicit no-site reconciliation state',()=>{assert.equal(describeOrderNextStep({review:0,pending:0,survey:0,design:0,production:0,dispatch:0,installation:0,complete:0,excluded:0}).kind,'attention');});
t('Acceptance overrides all other steps',()=>{assert.equal(describeOrderNextStep({review:0,pending:0,survey:0,design:0,production:0,dispatch:0,installation:0,complete:1,excluded:0},true).label,'Accept / decline assignment');});
const read=(name)=>fs.readFileSync(path.join(root,name),'utf8');
const work=read('src/pages/PurchaseOrdersPage.tsx'),dash=read('src/pages/DashboardPage.tsx'),shops=read('src/pages/ShopsPages.tsx');
t('Default Work Order mode hides financial cards behind controlled toggle',()=>{assert.match(work,/useState<'work'\|'financial'>\('work'\)/);assert.match(work,/{financialVisible && <Link to=\{`\/billing\?po=/);assert.match(work,/!financialVisible \? <>/);});
t('List hides money unless owner opted in',()=>{assert.match(work,/financeAllowed && listFinancialVisible && <th className="text-right px-4 py-3 font-semibold">Amount/);assert.match(work,/useAgencyFinancials\(orgId, financeAllowed && listFinancialVisible\)/);});
t('Dashboard finances require explicit owner view, and amounts are fetched only then',()=>{assert.match(dash,/const financialView = Boolean\(isOwner && privateFinance\)/);assert.match(dash,/useAgencyFinancials\(orgId, financialView\)/);assert.match(dash,/financialView \? ',total_amount' : ''/);assert.match(dash,/!financialView \? <>/);assert.match(dash,/isOwner && <section/);});
t('Switching Work Orders resets financial mode',()=>{assert.match(work,/key=\{detailPo.id\}/);});
t('Work Order KPI links use PO and stage',()=>{assert.match(work,/to=\{`\/shops\?po=\$\{encodeURIComponent\(po.id\)\}&stage=\$\{item.key\}`\}/);});
t('Shop list deep links use server-side stage filtering',()=>{assert.match(shops,/const groupedStatuses = stageFilter/);assert.match(shops,/query = query.in\('status', groupedStatuses/);assert.match(shops,/fallback = fallback.in\('status', groupedStatuses/);});
t('Dashboard links to exact Work Order and current PO stage without duplicate pipeline',()=>{assert.match(dash,/poUrl\(item.order.id\)/);assert.match(dash,/shopUrl\(item.order.id,stage.key\)/);assert.doesNotMatch(dash,/stageUrl\(stage.key\)/);assert.doesNotMatch(dash,/Site pipeline<\/h2>/);});
console.log('ALL',passed,'OWNER UX / NAVIGATION CHECKS PASSED');
