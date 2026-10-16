/** Node-only regression checks. Requires TypeScript (already a project devDependency).
 * These tests do not contact Supabase or modify any production data.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const ts=require('typescript');
const project=process.argv[2] || process.cwd();
function load(relative,mocks={}){
  const file=path.join(project,relative);
  const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  const module={exports:{}};
  const mockRequire=(id)=>id in mocks?mocks[id]:require(id);
  new Function('require','module','exports',code)(mockRequire,module,module.exports);
  return module.exports;
}
let passed=0;function test(n,fn){fn();passed++;console.log('PASS',n)}
const shopLib=load('src/lib/shopBulkUpload.ts',{'./supabase':{supabase:{}}});
test('detects non-first Excel header',()=>{const h=shopLib.findShopHeaderRow([['Title'],['Shop Name','Zone','District','Extra Code']]);assert.equal(h.headerRowIndex,1)});
test('preserves unknown columns',()=>{const rows=shopLib.buildShopRows([['Shop Name','Zone','District','Extra Code'],['A','','Ward','1002']],0,['Shop Name','Zone','District','Extra Code'],new Set(['Extra Code']));assert.equal(rows[0].known.zone,'');assert.equal(rows[0].extra['Extra Code'],'1002')});
test('respects named zone',()=>{const rows=shopLib.buildShopRows([['Shop Name','Zone'],['B','North']],0,['Shop Name','Zone'],new Set());assert.equal(rows[0].known.zone,'North')});
const statuses=['pending','installed'];
const XLSX={utils:{sheet_to_json:s=>s,book_new:()=>({worksheets:[]}),json_to_sheet:rows=>({rows,...Object.fromEntries(rows.map((r,i)=>[`D${i+2}`,{v:r.URL}]))}),book_append_sheet:(wb,s,name)=>wb.worksheets.push({name,rows:s.rows,cell:s.D2})},writeFile:(wb,name)=>{globalThis.__wb={wb,name}}};
const back=load('src/lib/bulkBackfillExcel.ts',{xlsx:XLSX,exceljs:{},'./backfillPipeline':{},'./types':{SHOP_STATUSES:statuses,STATUS_LABELS:{pending:'Pending',installed:'Installed'}}});
test('backfill has optional zone + custom headers',()=>{const res=back.parseBulkBackfillWorkbook({Sheets:{'Backfill Data':[['New Shop?','Shop ID','Shop Name','Zone','Current Status','Custom Site Code'],['Yes','','Test Shop','','Pending','AA101']]},SheetNames:['Backfill Data']});assert.ok(!('error' in res));assert.equal(res.shops[0].zoneName,'');assert.equal(res.shops[0].extraDetails['Custom Site Code'],'AA101');assert.deepEqual(res.extraHeaders,['Custom Site Code'])});
const rpt=load('src/lib/reportPortfolio.ts',{jspdf:{},'jspdf-autotable':{},xlsx:XLSX,pptxgenjs:{},'./markingUtils':{},'./units':{itemSizeLabel:()=>"10 ft × 5 ft"}});
const pic={id:'p1',shop_id:'s1',photo_url:'https://example.com/a.jpg',caption:'Main front'};
await rpt.generatePortfolioReport({shops:[{id:'s1',name:'A',city:'Nagpur',status:'installed',clients:{name:'C'}}],workItems:[{id:'w1',shop_id:'s1',work_type_name:'Flex',survey_quantity:2},{id:'w2',shop_id:'s1',work_type_name:'ACP'}],surveyPhotos:[pic],markings:[{survey_photo_id:'p1',work_item_id:'w1',points:[{x:0,y:0},{x:1,y:0},{x:1,y:1}]},{survey_photo_id:'p1',work_item_id:'w2',points:[{x:0,y:0},{x:1,y:0},{x:1,y:1}]}],surveys:[],installations:[],designVersions:[],designVersionItems:[],invoices:[],utilization:[],vehicleRows:[]},{kind:'survey',format:'XLSX',filePrefix:'test',organization:'Test Agency',period:'All',combined:true});
test('two work items on one photo creates one evidence row',()=>{const sheets=globalThis.__wb.wb.worksheets;assert.equal(sheets.find(s=>s.name==='Details').rows.length,2);assert.equal(sheets.find(s=>s.name==='Evidence').rows.length,1);assert.equal(globalThis.__wb.name.endsWith('.xlsx'),true)});
for (const name of ['src/pages/ReportsPage.tsx','src/pages/ShopsPages.tsx','src/lib/reportPortfolio.ts','src/lib/bulkBackfillExcel.ts','src/lib/shopBulkUpload.ts']){
 const file=path.join(project,name);const input=fs.readFileSync(file,'utf8');const sf=ts.createSourceFile(name,input,ts.ScriptTarget.Latest,true,name.endsWith('.tsx')?ts.ScriptKind.TSX:ts.ScriptKind.TS);assert.equal(sf.parseDiagnostics.length,0,`${name} syntax errors`);passed++;
}
console.log(`${passed} checks passed (syntax and import/Excel regression)`);
