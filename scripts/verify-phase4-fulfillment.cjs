/* Phase 4: executable policy regression + static database/UX contract checks.
 * Requires TypeScript (npm ci). Does NOT replace live Postgres integration tests.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const ts = require('typescript');
const root = path.resolve(__dirname,'..');
const read = p => fs.readFileSync(path.join(root,p),'utf8');
function load(file, imports={}) {
  const result = ts.transpileModule(read(file),{fileName:file,compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS}});
  const mod = {exports:{}};
  vm.runInNewContext(result.outputText,{module:mod,exports:mod.exports,require:id=>imports[id]||{},console,Set,Map,Math,Number}, {filename:file});
  return mod.exports;
}
const work=load('src/lib/workCompletion.ts');
const billing=load('src/lib/poBilling.ts',{'./workCompletion':work});
const sql=read('supabase/migrations/20261030100000_0100_phase4_supply_delivery_integrity.sql');
const supply=read('src/pages/SupplyOrdersPage.tsx');
const billingPage=read('src/pages/BillingPage.tsx');
const checks=[
  ['New supply dispatch is NOT delivery',()=>assert.equal(work.isShopFinished('supply_only','dispatched',[],true),false)],
  ['Legacy supply dispatch keeps old behavior',()=>assert.equal(work.isShopFinished('supply_only','dispatched',[],false),true)],
  ['New supply delivered counts final',()=>assert.equal(work.isShopFinished('supply_only','delivered',[],true),true)],
  ['Production & Installation dispatch not final',()=>assert.equal(work.isShopFinished('production_install','dispatched',[]),false)],
  ['New supply pipeline categorizes dispatch as in-flight',()=>assert.equal(work.shopStage('supply_only','dispatched',[],true),'dispatch')],
  ['Receipt-gated PO = one delivered out of two',()=>{
    const order={id:'p',fulfillment_type:'supply_only',delivery_receipt_required:true};
    const progress=work.groupShopCompletion([order],[{purchase_order_id:'p',status:'delivered'},{purchase_order_id:'p',status:'dispatched'}]).get('p');
    assert.equal(progress.completed,1);assert.equal(progress.pending,1);assert.equal(progress.percentage,50);
  }],
  ['Legacy PO preserves two completed',()=>{
    const progress=work.groupShopCompletion([{id:'p',fulfillment_type:'supply_only'}],[{purchase_order_id:'p',status:'delivered'},{purchase_order_id:'p',status:'dispatched'}]).get('p');
    assert.equal(progress.completed,2);
  }],
  ['Billing eligibility obeys receipt policy',()=>{assert.equal(billing.isFinalizedShop('supply_only','dispatched',[],true),false);assert.equal(billing.isFinalizedShop('supply_only','delivered',[],true),true)}],
  ['New-order policy applies on insert, old rows not backfilled',()=>{assert(sql.includes("IF TG_OP='INSERT'"));assert(sql.includes("NEW.fulfillment_type='supply_only'"));assert(!/UPDATE public\.purchase_orders SET delivery_receipt_required/i.test(sql))}],
  ['Dispatch is atomic and retry keyed',()=>{assert(sql.includes('phase4_create_supply_dispatch'));assert(sql.includes('pg_advisory_xact_lock'));assert(sql.includes('phase4_request_id'));assert(sql.includes("RETURN jsonb_build_object('outcome','already_dispatched'"))}],
  ['Dispatch validates same-org staff, supply scope and stage',()=>{assert(sql.includes('organization_id=v_org'));assert(sql.includes("po.fulfillment_type IS DISTINCT FROM 'supply_only'"));assert(sql.includes("s.status<>'production_done'"))}],
  ['Receipt requires Owner/Admin and records receiver and audit',()=>{assert(sql.includes('phase4_confirm_supply_receipt'));assert(sql.includes("('agency_owner','admin')"));assert(sql.includes('received_by text NOT NULL'));assert(sql.includes('supply_delivery_receipts'))}],
  ['Atomic On-site Execution creates all linked records with one retry key',()=>{assert(sql.includes('phase4_create_direct_install_site'));assert(sql.includes('phase4_field_request_id'));assert(sql.includes('INSERT INTO public.installation_jobs'));assert(sql.includes('INSERT INTO public.work_items'));assert(sql.includes('phase4_submit_direct_install'));assert(sql.includes('phase4_submitted_at'))}],
  ['Database prevents direct final-stage bypass',()=>assert(sql.includes('trg_phase4_supply_final_guard'))],
  ['Invoice line server gate requires receipt',()=>{assert(sql.includes('trg_phase4_guard_invoice_delivery'));assert(sql.includes('Delivery receipt required before this Work Order can be invoiced'))}],
  ['Browser uses server RPCs, not piecemeal dispatch writes',()=>{assert(supply.includes("supabase.rpc('phase4_create_supply_dispatch'"));assert(supply.includes("supabase.rpc('phase4_confirm_supply_receipt'"));assert(!supply.includes(".from('route_stops').insert(stopsPayload)"))}],
  ['UI supports zone select-all and delivery details',()=>{assert(supply.includes('Select all'));assert(supply.includes('Received by *'));assert(supply.includes('proof_reference'))}],
  ['Billing page and readiness both use delivery receipt policy',()=>{assert(billingPage.includes('selectedPO?.delivery_receipt_required === true'));assert(read('src/lib/billingReadiness.ts').includes('orderPolicy.data?.delivery_receipt_required === true'))}],
  ['Field wizard prevents duplicate rapid taps',()=>{assert(read('src/pages/InstallerPage.tsx').includes('createInFlight.current = true'));assert(read('src/pages/InstallerPage.tsx').includes("supabase.rpc('phase4_create_direct_install_site'"))}],
];
let failures=0;
for(const [name,fn] of checks){try{fn();console.log('PASS',name)}catch(e){failures++;console.error('FAIL',name,e.message)}}
for(const file of ['src/pages/SupplyOrdersPage.tsx','src/pages/InstallerPage.tsx','src/pages/BillingPage.tsx','src/pages/DashboardPage.tsx','src/pages/client/ClientOverviewPage.tsx','src/pages/client/ClientMapFeedPage.tsx','src/lib/billingReadiness.ts']){
  const result=ts.transpileModule(read(file),{fileName:file,compilerOptions:{target:ts.ScriptTarget.ES2020,jsx:ts.JsxEmit.ReactJSX},reportDiagnostics:true});
  const errs=result.diagnostics.filter(d=>d.category===ts.DiagnosticCategory.Error);
  if(errs.length){failures+=errs.length;errs.forEach(x=>console.error('FAIL',file,ts.flattenDiagnosticMessageText(x.messageText,' ')))}else console.log('PASS TSX/TS',file);
}
if(failures)process.exitCode=1;
else console.log(`ALL ${checks.length} PHASE 4 REGRESSIONS + 7 SYNTAX CHECKS PASSED`);
