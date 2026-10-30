/** Designer V10 source + pure display/mapping regressions. Run staging for browser/RLS proofs. */
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const Module = require('module');
let ts;
try { ts = require('typescript'); } catch { ts = require('/opt/nvm/versions/node/v22.16.0/lib/node_modules/typescript'); }
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const page = read('src/pages/DesignerPage.tsx');
const helper = read('src/lib/designPresentation.ts');
const sql = read('supabase/migrations/20261030160000_0101_designer_artwork_write_access.sql');
const app = read('src/App.tsx');
const nav = read('src/components/AdminLayout.tsx');
let passes = 0;
function test(label, fn) { fn(); console.log('PASS', label); passes++; }
for(const file of ['src/pages/DesignerPage.tsx','src/lib/designPresentation.ts','src/components/DesignMarkingPreview.tsx','src/App.tsx','src/components/AdminLayout.tsx']) {
  test('TS source parses '+file, () => { const ast=ts.createSourceFile(file,read(file),ts.ScriptTarget.Latest,true,file.endsWith('tsx')?ts.ScriptKind.TSX:ts.ScriptKind.TS);assert.equal(ast.parseDiagnostics.length,0,ast.parseDiagnostics.map(x=>x.messageText).join(',')); });
}
const fakeModule=new Module(path.join(root,'src/lib/designPresentation.ts'), module);
fakeModule.filename=path.join(root,'src/lib/designPresentation.ts');
fakeModule.require=(id)=>{
  if(id==='@/lib/units') return {
    itemSizeLabel:(it)=>it.approved_width != null && it.approved_height != null ? `${it.approved_width} × ${it.approved_height} ${it.approved_unit||'ft'}`: '—',
    trimNum:(x)=>String(x),
  };
  throw Error(`Unexpected import ${id}`);
};
fakeModule._compile(ts.transpileModule(helper, {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText, fakeModule.filename);
const { designWorkDisplay, designArtworkDisplayName, designArtworkStorageStem }=fakeModule.exports;
const work=(id,name='ACP Board',w=8,h=4)=>({id,work_type_name:name,approved_width:w,approved_height:h,approved_unit:'ft',approved_quantity:2,material:'ACP'});
const a=work('a'), b=work('b','Glow Sign',6,3), c=work('c');
test('work and approved size have priority over shop name',()=>assert.deepEqual(designWorkDisplay(a),{work:'ACP Board',size:'8 × 4 ft',meta:'ACP · Qty 2'}));
test('missing size stays explicit',()=>assert.equal(designWorkDisplay(work('x','Flex',null,null)).size,'Size not recorded'));
test('individual mapping label includes work, size and marking',()=>assert.equal(designArtworkDisplayName(['a'],[a,b],()=>({number:2})),'ACP Board · 8 × 4 ft · M2'));
test('shared artwork with identical dimensions displays size',()=>assert.equal(designArtworkDisplayName(['a','c'],[a,c]),'ACP Board · 8 × 4 ft · 2 work items'));
test('shared artwork with different dimensions warns of mixed sizes',()=>assert.match(designArtworkDisplayName(['a','b'],[a,b]),/mixed sizes/));
test('unknown foreign mapping cannot be labelled as valid',()=>assert.match(designArtworkDisplayName(['foreign'],[a,b]),/Unknown item/));
test('no mapping asks for exact work item',()=>assert.match(designArtworkDisplayName([],[a,b]),/Choose Work Item/));
test('storage filename has work and size but no unsafe symbols',()=>{let x=designArtworkStorageStem(['a'],[a]);assert.match(x,/ACP_Board_8_4_ft/);assert.match(x,/^[A-Za-z0-9_]+$/)});
test('survey and artwork appear alongside each work item',()=>{assert.match(page,/data-testid="design-work-mapping-list"/);assert.match(page,/Survey<\/figcaption>/);assert.match(page,/Artwork<\/figcaption>/);assert.match(page,/DesignMarkingPreview photoUrl=\{ref\?\.photo\?\.photo_url\}/);});
test('small thumbnails with original artwork preview',()=>{assert.match(page,/className="h-14 w-16"/);assert.match(page,/className="h-14 w-20/);assert.match(page,/loading="lazy"/);});
test('new PDF does not display old saved image',()=>{assert.match(page,/const artworkUrl = preview \? preview\.previewUrl : latestDesign\?\.file_url/);assert.match(page,/preview\.file\.type\.startsWith\('image\/'\)/);});
test('original filenames retained while storage path readable',()=>{assert.match(page,/file_name: file\.name/);assert.match(page,/designArtworkStorageStem\(entry\.workItemIds, uploadTask\.items\)/);});
test('per-item mapping is editable only for same shop',()=>{assert.match(page,/stageDesignFiles\(Array\.from\(event\.target\.files \|\| \[\]\), item\.id\)/);assert.match(page,/eq\('shop_id', uploadTask\.shop_id\)\.in\('id', mappedItemIds\)/);});
test('single/collection mapping remain explicit',()=>{assert.match(page,/entry\.workItemIds\.map\(workItemId =>/);assert.match(page,/toggleFileMarking\(entry\.id, item\.id\)/);});
test('company approval and handoff preserved',()=>{assert.match(page,/CompanyApprovalHandoff/);assert.match(page,/Upload & Send for Review/);});
test('direct design route only allowed three roles',()=>assert.match(app,/path="\/design" element=\{<ProtectedRoute allowedRoles=\{\['agency_owner', 'admin', 'designer'\]\}/));
test('demo access absent from design nav',()=>assert.match(nav,/show: isOwner \|\| profile\?\.role === 'admin' \|\| isDesigner/));
test('designer assignment protected at modal entrance and upload submit',()=>{assert.match(page,/isDesigner && row\.designer_id !== profile\?\.id/);assert.match(page,/currentTask\.designer_id !== profile\.id/);});
test('only owner/admin notified for review',()=>assert.match(page,/\.in\('role', \['agency_owner', 'admin'\]\)/));
test('Supabase art/version write roles and task assignment restricted',()=>{assert.match(sql,/public\.can_write_design_task/);assert.match(sql,/t\.designer_id = auth\.uid\(\)/);assert.match(sql,/DROP POLICY IF EXISTS design_versions_insert/);});
test('Supabase mapping enforces same shop',()=>{assert.match(sql,/t\.shop_id = w\.shop_id/);assert.match(sql,/public\.can_write_design_version_item/);});
test('Storage writes enforce org + design task',()=>{assert.match(sql,/public\.can_write_design_object/);assert.match(sql,/DROP POLICY IF EXISTS design_files_insert/);});
test('production/reporting remains read-only capable',()=>assert.doesNotMatch(sql,/DROP POLICY IF EXISTS design_files_select/));
console.log(`\n${passes} Designer V10 checks passed. Browser/RLS staging testing still required.`);
