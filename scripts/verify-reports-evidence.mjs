/** Run: node scripts/verify-reports-evidence.mjs; real output smoke-test still requires browser and Supabase. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const ts=require('typescript');
const source=fs.readFileSync(new URL('../src/lib/reportPortfolio.ts',import.meta.url),'utf8');
const tsx=fs.readFileSync(new URL('../src/pages/ReportsPage.tsx',import.meta.url),'utf8');
const img=fs.readFileSync(new URL('../src/lib/reportImage.ts',import.meta.url),'utf8');
const { outputText, diagnostics }=ts.transpileModule(source,{fileName:'reportPortfolio.ts',compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020},reportDiagnostics:true});
assert.equal(diagnostics?.length || 0,0,'Portfolio syntax diagnostics');
const transpile=(filename,contents,jsx)=>ts.createSourceFile(filename,contents,ts.ScriptTarget.Latest,true,jsx?ts.ScriptKind.TSX:ts.ScriptKind.TS).parseDiagnostics;
assert.equal(transpile('ReportsPage.tsx',tsx,true).length,0,'Page must parse');
assert.equal(transpile('reportImage.ts',img,false).length,0,'Image helpers must parse');
const m={exports:{}};
const fakeRequire=(name)=>{
  if(name==='./units')return {itemSizeLabel:(item)=>item.size||'10 ft x 6 in'};
  if(name==='./reportImage')return {prepareEvidenceImage:async()=>({dataUrl:'data:image/jpeg;base64,YQ==',width:100,height:50})};
  if(name==='./secureMedia')return {isPrivateStorageUrl:(url)=>String(url).includes('/storage/v1/object/')};
  if(name==='jspdf')return {jsPDF:class{}};
  if(name==='jspdf-autotable')return {default:()=>{}};
  if(name==='exceljs')return {default:class{}};
  if(name==='pptxgenjs')return {default:class{}};
  throw new Error(`Unexpected import ${name}`);
};
vm.runInNewContext(outputText,{module:m,exports:m.exports,require:fakeRequire,console});
const {buildSections}=m.exports;
assert.equal(typeof buildSections,'function');
const fixture={
  shops:[{id:'shop',name:'Demo shop',city:'Nagpur',state:'MH',zone_id:null,clients:{name:'Client A'},purchase_orders:{name:'Signage'}}],
  workItems:[
    {id:'one',shop_id:'shop',work_type_name:'Front sign',size:'10 ft x 6 in',survey_quantity:2,survey_area:10,material:'ACP'},
    {id:'two',shop_id:'shop',work_type_name:'Side board',size:'2 m x 3 ft',survey_quantity:1,survey_area:19.68,material:'Vinyl'},
  ],
  surveyPhotos:[{id:'photo1',shop_id:'shop',photo_url:'https://example.test/photo1.jpg',caption:'Street front'},{id:'photo2',shop_id:'shop',photo_url:'https://example.test/photo2.jpg'}],
  markings:[{survey_photo_id:'photo1',work_item_id:'one',points:[{x:1,y:1},{x:2,y:3},{x:5,y:8}]},
    {survey_photo_id:'photo1',work_item_id:'two',points:[{x:1,y:1},{x:4,y:6},{x:9,y:9}]}],
  surveyPhotoItems:[],
  installations:[{shop_id:'shop',installation_proofs:[{id:'proof1',photo_url:'https://example.test/install.jpg',work_item_id:'one',photo_type:'installed'}]}],
  designVersions:[{id:'version',file_url:'https://example.test/design.png',version_number:1}],
  designVersionItems:[{design_version_id:'version',work_item_id:'one'}],invoices:[],utilization:[],vehicleRows:[],surveys:[],
};
const survey=buildSections(fixture,'survey')[0];
assert.equal(survey.evidence.length,2,'Two survey photos, even with two polygons on one image');
assert.equal(survey.evidence[0].marks.length,2,'Both polygons on one original image');
assert.equal(survey.evidence[0].lines.length>=2,true,'Both measurements are shown next to image');
assert.match(survey.evidence[0].lines.join(' '),/Front sign/);
assert.match(survey.evidence[0].lines.join(' '),/Side board/);
assert.match(survey.evidence[0].lines.join(' '),/10 ft x 6 in/);
const install=buildSections(fixture,'installation')[0];
assert.equal(install.evidence.length,1);
assert.match(install.evidence[0].lines.join(' '),/Front sign/);
const design=buildSections(fixture,'design-approval')[0];
assert.equal(design.evidence.filter(e=>e.type.startsWith('Design')).length,1);
const final=buildSections(fixture,'final-report')[0];
assert.equal(final.evidence.length,4,'survey x2 + installation x1 + design x1');
assert.match(final.context.join(' '),/No Zone/);
assert.match(img,/storage\.from\(bucket\)\.download\(objectPath\)/,'Authenticated storage fallback');
assert.match(source,/throw new Error\(`Could not embed/,'Broken photos fail with explicit error');
assert.match(source,/wb\.addImage/,'Excel embeds evidence photos');
assert.match(source,/writeEvidencePdf/,'PDF has evidence cards');
assert.match(source,/card\.entry\.lines/,'PPT has image-linked measurements');
assert.match(tsx,/unified:\$\{rc\.id\}:\$\{format\}/,'One export workflow per format');
console.log('PASS: 16 report evidence, format, mark grouping and parsing checks.');
