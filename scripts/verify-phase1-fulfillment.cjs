/* Source-only Phase 1 regression tests; DB integration requires deployed migration. */
const fs=require('node:fs');const path=require('node:path');const assert=require('node:assert/strict');const ts=require('typescript');
const root=path.resolve(__dirname,'..');
function moduleAt(relative){const code=fs.readFileSync(path.join(root,relative),'utf8');const js=ts.transpileModule(code,{fileName:relative,compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;const m={exports:{}};new Function('module','exports','require',js)(m,m.exports,(id)=>{throw Error('unexpected runtime dependency '+id)});return m.exports;}
const { FULFILLMENT_PRESETS, fulfillmentOptions }=moduleAt('src/lib/fulfillment.ts');
const { applicableMilestones, getShopCompletion, milestoneProgress }=moduleAt('src/lib/workCompletion.ts');
const { fulfillmentTypeLabel,defaultUtilizationStage }=moduleAt('src/lib/poUtilization.ts');
let passed=0;function check(desc, fn){fn();passed++;console.log('PASS',desc)}
check('Exactly four public workflow choices with unique IDs',()=>assert.deepEqual(FULFILLMENT_PRESETS.map(x=>x.value),['survey_install','production_install','supply_only','direct_install']));
check('Company or agency design is NOT another fulfillment type',()=>assert(!FULFILLMENT_PRESETS.some(x=>x.value.includes('client')||x.value.includes('agency'))));
check('Legacy custom is visible only when editing historical order',()=>{assert.equal(fulfillmentOptions().length,4);assert.equal(fulfillmentOptions('custom').length,5)});
check('No-survey production/install preset uses design, production, installation',()=>{const item=FULFILLMENT_PRESETS[1];assert.deepEqual(item.requirements,{requires_survey:false,requires_design:true,requires_production:true,requires_installation:true})});
check('No survey or design for on-site execution',()=>{assert.deepEqual(FULFILLMENT_PRESETS[3].requirements,{requires_survey:false,requires_design:false,requires_production:false,requires_installation:true})});
check('Only applicable stages shown for production+installation',()=>assert.deepEqual(applicableMilestones('production_install'),['design','production','dispatch','installation']));
check('Dispatch is not completion for installation PO',()=>{assert.equal(getShopCompletion([{status:'dispatched'},{status:'installed'}],'production_install').percentage,50)});
check('Installation infers prior milestones, not quantities',()=>assert.deepEqual(milestoneProgress([{status:'installed'}],'production_install').milestones.map(x=>x.percentage),[100,100,100,100]));
check('Supply-only legacy final-stage behavior unchanged',()=>{assert.equal(getShopCompletion([{status:'dispatched'}],'supply_only').percentage,100);assert.deepEqual(applicableMilestones('supply_only'),['production','dispatch'])});
check('Direct-install and historical custom final-stage behavior retained',()=>{assert.deepEqual(applicableMilestones('direct_install'),['installation']);assert.equal(getShopCompletion([{status:'production_done'}],'custom',[{requires_installation:false,requires_production:true,requires_design:false,requires_survey:false}]).percentage,100)});
check('All labels correspond to public selections',()=>FULFILLMENT_PRESETS.forEach(x=>assert.equal(fulfillmentTypeLabel(x.value),x.label)));
check('Billing quantity measures installed for new installation workflow',()=>assert.equal(defaultUtilizationStage('production_install'),'installed'));
const sql=fs.readFileSync(path.join(root,'supabase/migrations/20261027100000_0097_phase1_production_install.sql'),'utf8');
check('Additive migration carries guard and initialization triggers',()=>{assert(sql.includes("'production_install'"));assert(sql.includes('trg_guard_po_fulfillment_change'));assert(sql.includes('trg_phase1_production_install_shop'));assert(sql.includes('trg_phase1_production_install_line'));assert(sql.includes('trg_guard_phase1_survey_assignment'))});
check('Bootstrap does not invent billable quantity or approvals',()=>{assert(sql.includes('approved_quantity,approved_area'));assert(sql.includes("'pending',NULL,NULL,NULL"));assert(!sql.includes("SET status='approved'"));});
const supply=fs.readFileSync(path.join(root,'src/pages/SupplyOrdersPage.tsx'),'utf8');
check('Client-supplied artwork does not force assigned designer',()=>{assert(supply.includes("form.artwork_source === 'agency' && !form.designer_id"));assert(supply.includes("designer_id: form.artwork_source === 'agency' ? form.designer_id : null"));});
check('Supply entry still requires a design review record',()=>assert(supply.includes(".from('design_tasks')")));
console.log(`ALL ${passed} PHASE 1 FULFILLMENT CHECKS PASSED`);
