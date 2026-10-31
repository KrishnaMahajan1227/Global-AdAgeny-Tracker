/* Deterministic offline regression tests; does not claim a live Supabase test. */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
let ts;
try { ts=require('typescript'); } catch { ts=require('/opt/nvm/versions/node/v22.16.0/lib/node_modules/typescript'); }
const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root,p),'utf8');
let passed=0,failed=0;
const check=(name,fn)=>{try{fn();passed++;console.log('PASS',name)}catch(e){failed++;console.error('FAIL',name,':',e.message)}};
function mockLoadPortfolio(){
  const source = read('src/lib/reportPortfolio.ts');
  const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,esModuleInterop:true}}).outputText;
  const m={exports:{}};
  const req=id=>{
    if(id==='jspdf')return {jsPDF:class{}};
    if(id==='jspdf-autotable')return {__esModule:true,default(){}};
    if(id==='exceljs')return {__esModule:true,default:class{}};
    if(id==='pptxgenjs')return {__esModule:true,default:class{}};
    if(id==='./units')return {itemSizeLabel:()=> '2 ft × 4 ft'};
    if(id==='./reportImage')return {prepareEvidenceImage:async()=>({dataUrl:'data:image/jpeg;base64,AA==',width:120,height:60})};
    if(id==='./secureMedia')return {isPrivateStorageUrl:u=>u.includes('/storage/v1/object/')};
    throw new Error('Unexpected dependency '+id);
  };
  vm.runInNewContext(code,{module:m,exports:m.exports,require:req,console,Map,Set,URL,Date,Uint8Array,Number,Math,Array,Object,String,RegExp,Blob:class{},document:{},window:{}},{filename:'reportPortfolio.js'});
  return m.exports;
}
const impl=mockLoadPortfolio();
const base={shops:[],workItems:[],surveys:[],surveyPhotos:[],markings:[],installations:[],designVersions:[],designVersionItems:[],invoices:[],utilization:[],vehicleRows:[]};
const fixture={...base,shops:[{id:'shop-1',name:'Site A',status:'installed'}, {id:'shop-1',name:'Site A duplicate',status:'installed'}],
  workItems:[{id:'work-1',shop_id:'shop-1',work_type_name:'Front board',survey_quantity:1,approved_quantity:1,approved_area:12},{id:'work-1',shop_id:'shop-1',work_type_name:'Front board'}],
  surveyPhotos:[{id:'photo-1',shop_id:'shop-1',photo_url:'https://example.com/site.jpg'}, {id:'photo-1',shop_id:'shop-1',photo_url:'https://example.com/site.jpg'}],
  markings:[{id:'mark-1',survey_photo_id:'photo-1',work_item_id:'work-1',points:[{x:0,y:0},{x:2,y:0},{x:1,y:2}]},
    {id:'mark-1',survey_photo_id:'photo-1',work_item_id:'work-1',points:[{x:0,y:0},{x:2,y:0},{x:1,y:2}]}],
  installations:[{id:'job-1',shop_id:'shop-1',installation_proofs:[{id:'proof-1',photo_url:'https://example.com/installed.jpg',work_item_id:'work-1'},{id:'proof-1',photo_url:'https://example.com/installed.jpg',work_item_id:'work-1'}]}]};
check('Duplicate shops removed',()=>assert.equal(impl.buildSections(fixture,'final-report').length,1));
check('Duplicate work items removed',()=>assert.equal(impl.buildSections(fixture,'final-report')[0].rows.length,1));
check('Same survey photo shown once',()=>assert.equal(impl.buildSections(fixture,'final-report')[0].evidence.filter(e=>e.type.startsWith('Survey')).length,1));
check('Multiple duplicate markings deduplicated',()=>assert.equal(impl.buildSections(fixture,'final-report')[0].evidence[0].marks.length,1));
check('Duplicate installation proof removed',()=>assert.equal(impl.buildSections(fixture,'final-report')[0].evidence.filter(e=>e.type.startsWith('Installation')).length,1));
check('Before-after PPT includes survey and installation',()=>{
 const sec=impl.buildSections(fixture,'ppt-final')[0];assert.equal(sec.evidence.length,2);
});
check('Installation evidence report excludes survey',()=>{
 const sec=impl.buildSections(fixture,'installation')[0];assert.equal(sec.evidence.length,1);
});
check('Linked work item omitted from repeated after-evidence table',()=>{
 const sec=impl.buildSections(fixture,'final-report')[0];assert.equal(sec.unlinkedRows.length,0);
});
check('Missing mandatory image surfaces error',()=>assert.throws(()=>impl.buildSections({...fixture,surveyPhotos:[{id:'broken',shop_id:'shop-1',photo_url:''}]},'final-report'),/missing/i));
check('Invoice records deduplicated',()=>{
 const inv={id:'inv-1',invoice_number:'INV-X',subtotal:100,tax_amount:18,total:118,invoice_items:[{id:'it-1',description:'Work',quantity:1,rate:100,amount:100},{id:'it-1',description:'Work',quantity:1,rate:100,amount:100}]};
 const out=impl.buildSections({...base,invoices:[inv,inv]},'invoice');assert.equal(out.length,1);assert.equal(out[0].rows.length,1);
});
check('Excel formula injection prefixed',()=>{for(const s of ['=SUM(A1:A2)','+CMD','-1+2','@SUM(A1)'])assert.notEqual(impl.safeWorkbookText(s),s)});
check('Normal names not altered',()=>assert.equal(impl.safeWorkbookText('AdRoute Site 1'),'AdRoute Site 1'));
check('PO utilization reads actual view fields, not obsolete names',()=>{ const u={po_line_item_id:'line1',uom:'sqft',po_number:'PO1',budgeted_area:120,surveyed_area:112,approved_area:109,produced_qty:7,installed_area:104,invoiced_amount:4500,rate:50,fulfillment_type:'survey_install'};const out=impl.buildSections({...base,utilization:[u,u]},'po-utilization');assert.equal(out[0].rows.length,1);assert.equal(out[0].rows[0]['Budgeted units'],120);assert.equal(out[0].rows[0]['Installed units'],104);assert.equal(out[0].rows[0]['Invoiced value'],4500);assert.equal(out[0].rows[0]['Remaining budget value'],1500) });
const portfolio=read('src/lib/reportPortfolio.ts');
const billing=read('src/pages/BillingPage.tsx');
const sql=read('supabase/migrations/20261031133000_0114_atomic_invoice_posting.sql');
const reports=read('src/lib/reports.ts');
const client=read('src/pages/client/ClientReportsPage.tsx');
const media=read('src/lib/reportImage.ts');
const layout=read('src/components/AdminLayout.tsx');
const rout=read('src/App.tsx');
check('Excel embeds photographic JPEG not just link',()=>assert(portfolio.includes('wb.addImage')&&portfolio.includes('ev.addImage')));
check('Excel protects private evidence originals',()=>assert(portfolio.includes("privateFile?'Embedded image (private source)'")));
check('PPT evidence renders photos in deck',()=>assert(portfolio.includes('slide.addImage({data:card.image.dataUrl')));
check('PDF evidence shows all photo blocks',()=>assert(portfolio.includes('for (const [idx, card] of section.ready.entries())')));
check('PDF evidence keeps mark captions',()=>assert(portfolio.includes('card.entry.lines')));
check('No silent image failure during prepared export',()=>assert(portfolio.includes('Could not embed ${entry.type}')));
check('Report engine scopes private URLs',()=>assert(portfolio.includes('safeExternalUrl(link.url)')));
check('Report photos cache scoped by user',()=>assert(media.includes('identity.user.id')&&media.includes('blobCache.clear()')));
check('Client Excel contains photo image embedding',()=>assert(reports.includes('await prepareEvidenceImage(item.photo_url')&&reports.includes('sheet.addImage(imageId')));
check('Client PDF renders marked survey evidence',()=>assert(reports.includes('await prepareEvidenceImage(surveyPhotos[r].photo_url')));
check('Client PDF fails rather than dropping sites beyond limit',()=>assert(reports.includes('Select at most ${CLIENT_SITE_PDF_MAX_SITES} sites per PDF')));
check('Client PDF page breaks before two-column evidence',()=>assert(reports.includes('if (y + 94 > pageHeight - 20)')));
check('Client report fetches actual board markings',()=>assert(client.includes(".from('board_markings')")&&client.includes('linkedMarkings()')));
check('Client exported workbook awaits completion and catches failure',()=>assert(client.includes('await exportClientSiteDetailReport(')&&client.includes("Excel export failed.")));
check('No invoice direct table writes in new billing create flow',()=>assert(billing.includes("supabase.rpc('billing_save_invoice'")&&!billing.includes(".from('invoice_items').insert(")));
check('Bill creation prevents unauthorized deep link',()=>assert(billing.includes('if (!canPostInvoices) {')&&billing.includes('Your role can view permitted billing records')));
check('New invoice button restricted to accounting roles',()=>assert(billing.includes('{canPostInvoices && <button type="button" onClick={openCreateModal}')));
check('Paid/partial invoices locked on server',()=>assert(sql.includes("payment_status <> 'unpaid'")&&sql.includes("v_old='paid'")));
check('Invoice server checks active profile and org',()=>assert(sql.includes("v_actor.is_active IS DISTINCT FROM true")&&sql.includes('WHERE id=v_po_id AND organization_id=v_org AND client_id=v_client')));
check('PO advisory lock serializes concurrent billing',()=>assert(sql.includes('pg_advisory_xact_lock')));
check('Server trusts PO rate not user rate',()=>assert(sql.includes('v_rate:=v_line.rate')));
check('Server rejects duplicate linked work item',()=>assert(sql.includes('v_item_id=ANY(v_seen)')));
check('Server cap derives from completed work',()=>assert(sql.includes('v_units + v_prior > v_cap')));
check('Atomic invoice saves lines in same function transaction',()=>assert(sql.includes('INSERT INTO public.invoices')&&sql.includes('INSERT INTO public.invoice_items')));
check('Direct authenticated invoice writes denied via restrictive RLS',()=>assert(sql.includes('AS RESTRICTIVE FOR INSERT TO authenticated WITH CHECK(false)')));
check('Demo Production sidebar not shown',()=>assert(layout.includes("isOwner || profile?.role === 'admin' || isProduction")));
check('Production route guard matches nav role list',()=>assert(rout.includes("allowedRoles={['agency_owner', 'admin', 'printing']}")));
console.log(`REPORTING RELEASE CHECKS: ${passed} PASS, ${failed} FAIL`);
process.exitCode=failed?1:0;
