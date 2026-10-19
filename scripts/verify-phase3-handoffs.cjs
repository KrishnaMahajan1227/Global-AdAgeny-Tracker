/* Phase 3 source-level regression guards. DB/browser acceptance is separate. */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(root,p),'utf8');
const sql = read('supabase/migrations/20261029100000_0099_phase3_atomic_department_handoffs.sql');
const designer = read('src/pages/DesignerPage.tsx');
const prod = read('src/pages/ProductionPage.tsx');
const survey = read('src/pages/SurveyReviewPage.tsx');
const cases = [
  ['Atomic Design->Production RPC',()=>assert(sql.includes('CREATE OR REPLACE FUNCTION public.phase3_send_to_production'))],
  ['Atomic Production->Field/Delivery RPC',()=>assert(sql.includes('CREATE OR REPLACE FUNCTION public.phase3_complete_production'))],
  ['RPC updates shop, work items and assignments in one transaction',()=>{assert(sql.includes("UPDATE public.shops SET status='production_pending'"));assert(sql.includes("UPDATE public.work_items SET status='production_done'"));assert(sql.includes('INSERT INTO public.shop_assignments'));}],
  ['Only Owner/Admin can send design to production',()=>assert(sql.includes("v_role NOT IN ('agency_owner','admin')"))],
  ['Printing team can only complete assigned production',()=>assert(sql.includes('v_order.assigned_to IS DISTINCT FROM auth.uid()'))],
  ['Assignees must be active, role-matched and same org',()=>{assert(sql.includes("role='printing' AND is_active=true"));assert(sql.includes("role='installer' AND is_active=true"));assert(sql.includes('organization_id=public.current_org_id()'));}],
  ['New orders cannot bypass server-side completion RPC',()=>{assert(sql.includes('phase3_guard_direct_handoff'));assert(sql.includes('trg_phase3_production_handoff'));assert(sql.includes('trg_phase3_design_handoff'));}],
  ['Company artwork approval cannot be bypassed',()=>{assert(sql.includes('v_has_artwork'));assert(sql.includes('(v_requires_design OR v_has_artwork)'));assert(sql.includes("phase2_handoff_is_valid('design'"));}],
  ['Single printer auto-assigns only on approved new PO',()=>{assert(sql.includes('phase3_auto_assign_single_printer'));assert(sql.includes('v_team_count<>1'));assert(sql.includes('company_approval_required'));}],
  ['Production completion validates measured quantity and components',()=>{assert(sql.includes('pi.produced_qty>=COALESCE(w.approved_quantity,w.survey_quantity,1)'));assert(sql.includes("c.status IS DISTINCT FROM 'ready'"));}],
  ['Owner override cannot be used by printing or silent empty scope',()=>{assert(sql.includes("v_role NOT IN ('agency_owner','admin')"));assert(sql.includes('v_active=0'));}],
  ['Idempotent production handoff does not overwrite started work',()=>{assert(sql.includes("v_order.status IN ('completed','in_production','ready','hold')"));assert(sql.includes('v_existing_count>1'));}],
  ['Retry completion sends no duplicate notification',()=>{assert(sql.includes("IF v_order.status='completed' THEN"));assert(sql.indexOf("IF v_order.status='completed' THEN") < sql.indexOf("INSERT INTO public.notifications(organization_id,user_id,title,message,type,link)", sql.indexOf('CREATE OR REPLACE FUNCTION public.phase3_complete_production')));}],
  ['Supply only packs without installer; installation types require installer',()=>{assert(sql.includes("v_po.fulfillment_type='supply_only'"));assert(sql.includes("v_po.fulfillment_type IN ('survey_install','production_install')"));}],
  ['Legacy/custom modes retained',()=>{assert(sql.includes("v_po.fulfillment_type='supply_only'"));assert(sql.includes('requires_installation IS TRUE'));}],
  ['UI single and bulk design handoffs use one RPC',()=>{assert(designer.includes("supabase.rpc('phase3_send_to_production'"));assert(!/async function sendDesignTaskToProduction[\s\S]*?supabase\.from\('production_orders'\)/.test(designer.match(/async function sendDesignTaskToProduction[\s\S]*?\n\}\n\nexport default/)[0]));}],
  ['UI single and bulk production completion use same RPC',()=>{assert(prod.includes("supabase.rpc('phase3_complete_production'"));assert(prod.includes('await completeProductionOrder(editOrder'));assert(prod.includes('await completeProductionOrder(row'));}],
  ['One-assignee automatic selection, multi-assignee explicit selection',()=>{assert(designer.includes('productionPeople?.length === 1'));assert(prod.includes('orgInstallers?.length === 1'));assert(survey.includes('designers?.length === 1'));}],
  ['No automatic invoice creation during handoff',()=>assert(!/INSERT INTO public\.(invoices|invoice_items)/i.test(sql))],
  ['Migration is additive and does not touch historic data rows',()=>{assert(!/DELETE FROM public\./.test(sql));assert(!/TRUNCATE|DROP TABLE/.test(sql));}],
  ['No account secrets packaged',()=>assert(!fs.existsSync(path.join(root,'.env')))],
];
let failed = 0;
for(const [label,fn] of cases){try{fn();console.log('PASS',label);}catch(err){failed++;console.error('FAIL',label,err.message)}}
for(const file of ['src/pages/SurveyReviewPage.tsx','src/pages/DesignerPage.tsx','src/pages/ProductionPage.tsx']){
  const source=read(file); const result=ts.transpileModule(source,{fileName:file,reportDiagnostics:true,compilerOptions:{jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}});
  const errors=(result.diagnostics||[]).filter(e=>e.category===ts.DiagnosticCategory.Error);
  if(errors.length){failed+=errors.length;errors.forEach(e=>console.error('FAIL TSX',file,ts.flattenDiagnosticMessageText(e.messageText,'\n')))}
  else console.log('PASS TSX',file);
}
if(failed){console.error(`${failed} failures`);process.exitCode=1;}else console.log(`ALL ${cases.length} PHASE 3 SOURCE CHECKS + 3 TSX PARSES PASSED`);
