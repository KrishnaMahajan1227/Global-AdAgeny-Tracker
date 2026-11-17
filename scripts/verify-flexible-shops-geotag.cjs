/** Flexible shop/photographic proof regression tests — no live DB or browser dependency. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const root=path.resolve(__dirname,'..');
const read=(file)=>fs.readFileSync(path.join(root,file),'utf8');
const load=(file, deps={})=>{
 const js=ts.transpileModule(read(file),{fileName:file,compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
 const module={exports:{}};
 new Function('module','exports','require',js)(module,module.exports,(name)=>{
  if(name in deps) return deps[name];
  if(name==='./supabase') return {supabase:{}};
  throw new Error(`Unexpected runtime import ${name}`);
 });
 return module.exports;
};
const bulk=load('src/lib/shopBulkUpload.ts');
const base=[...bulk.NEW_SHOP_TEMPLATE_FIELDS];
const scope={organizationId:'agency1',clientId:'client1',projectId:'project1',purchaseOrderId:'po1'};
let passed=0;
const test=(name,fn)=>{fn();passed++;console.log(`PASS ${name}`);};
function parse(headers,row,include){
 const data=[headers,row],f=bulk.findShopHeaderRow(data);
 bulk.validateNewShopBulkHeaders(headers);
 return bulk.buildShopRows(data,f.headerRowIndex,f.headers,new Set(include));
}
test('11 base fields include separate Contact Person and both phone numbers',()=>{
 assert.deepEqual(base,['Shop Name','Address','Owner Number','Contact Person','Contact Person Number','Zone','State','Village','Taluka','City','District']);
});
test('FMM/FSM Name and arbitrary new columns accepted without schema changes',()=>{
 assert.doesNotThrow(()=>bulk.validateNewShopBulkHeaders([...base,'FMM/FSM Name','Store Code','Hoarding Width']));
});
test('Required headers still validated',()=>{
 assert.throws(()=>bulk.validateNewShopBulkHeaders(['Contact Person','Address']),/Shop Name/);
 assert.throws(()=>bulk.validateNewShopBulkHeaders(['Shop Name','FMM\/FSM Name']),/Address/);
});
test('Duplicate known aliases and normalized arbitrary headers blocked',()=>{
 assert.throws(()=>bulk.validateNewShopBulkHeaders([...base,'site name']),/Duplicate Excel/);
 assert.throws(()=>bulk.validateNewShopBulkHeaders([...base,'FMM/FSM Name',' fmm\/fsm  name ']),/Duplicate Excel/);
});
test('Prototype injection names rejected without database insert',()=>{
 for(const name of ['__proto__','constructor','prototype']) assert.throws(()=>bulk.validateNewShopBulkHeaders([...base,name]),/Unsafe/);
});
test('Proper field columns save Contact Person separately, not owner_name',()=>{
 const r=parse(base,['Ravi Shop','Main Road','09876543210','Nisha','09123456780','North','Maharashtra','','','',''])[0];
 const out=bulk.buildBulkShopRecords([r],scope,new Map([['north','zone1']]))[0];
 assert.equal(out.contact_person_name,'Nisha');assert.equal(out.contact_phone,'09123456780');assert.equal(out.owner_phone,'09876543210');assert.equal(out.owner_name,null);
 assert.equal(out.purchase_order_id,'po1');assert.equal(out.project_id,'project1');assert.equal(out.zone_id,'zone1');
});
test('All optional columns may be blank, address is required',()=>{
 const arr=parse(base,['One','7 Market Road','','','','','','','','','']);
 assert.doesNotThrow(()=>bulk.assertBulkShopRows(arr));
 assert.equal(bulk.buildBulkShopRecords(arr,scope,new Map())[0].contact_person_name,null);
 assert.throws(()=>bulk.assertBulkShopRows(parse(base,['One','','','','','','','','','',''])),/Full Address/);
});
test('Additional columns stored with original header and per-shop values, not silently dropped',()=>{
 const headers=[...base,'FMM/FSM Name','Custom Approval'];
 const row=['A','Market road','','Priya','','','','','','','','Ramesh','YES'];
 const extras=bulk.findExtraHeaders(headers,[headers,row],0);
 assert.deepEqual(extras,['FMM/FSM Name','Custom Approval']);
 const r=parse(headers,row,extras)[0];
 assert.equal(r.extra['FMM/FSM Name'],'Ramesh');
 assert.equal(r.extra['Custom Approval'],'YES');
 const out=bulk.buildBulkShopRecords([r],scope,new Map())[0];
 assert.equal(out.extra_details['FMM/FSM Name'],'Ramesh');
 assert.equal(out.extra_details['Custom Approval'],'YES');
});
test('Missing extra values are not fabricated',()=>{
 const h=[...base,'FMM/FSM Name'];
 const rows=parse(h,['A','A street','','','','','','','','','',''],['FMM/FSM Name']);
 assert.equal('FMM/FSM Name' in rows[0].extra,false);
});
test('Scope cannot be overwritten by unexpected spreadsheet fields',()=>{
 const h=[...base,'client_id','project_id','purchase_order_id','zone_id'];
 const r=parse(h,['A','A Street','','','','','','','','','','EVIL','EVIL','EVIL','EVIL'],h.slice(-4));
 const x=bulk.buildBulkShopRecords(r,scope,new Map())[0];
 assert.equal(x.client_id,'client1');assert.equal(x.project_id,'project1');assert.equal(x.purchase_order_id,'po1');assert.equal(x.zone_id,null);
 assert.equal(x.extra_details.client_id,'EVIL');
});
test('Duplicate rows rejected across FMM/FSM values only when identical',()=>{
 const h=[...base,'FMM/FSM Name'];
 const r1=['A','Main Rd','','','','','','','','','','Kiran'];
 const r2=['A','Main Rd','','','','','','','','','','Deepak'];
 const rows=[...parse(h,r1,['FMM/FSM Name']),...parse(h,r2,['FMM/FSM Name'])];
 assert.deepEqual(bulk.findDuplicateBulkShopRows(rows),[]);
});
test('Large 500-shop payload preserves contacts/custom values/work-order mapping',()=>{
 const h=[...base,'FMM/FSM Name'];
 const data=[h,...Array.from({length:500},(_,i)=>[`Shop ${i}`,`Street ${i}`,`0${i}`,`C ${i}`,`09${i}`,'North','Maharashtra','','','','',`FMM ${i}`])];
 const parsed=bulk.buildShopRows(data,0,h,new Set(['FMM/FSM Name']));
 const out=bulk.buildBulkShopRecords(parsed,scope,new Map([['north','zone1']]));
 assert.equal(out.length,500);assert.equal(out[499].contact_person_name,'C 499');assert.equal(out[499].extra_details['FMM/FSM Name'],'FMM 499');assert.equal(out[0].project_id,'project1');
});
test('All three upload dialogs auto-select custom fields and save original scope',()=>{
 for(const f of ['src/pages/ShopsPages.tsx','src/pages/client/ClientShopsPage.tsx','src/pages/client/ClientPODetailPage.tsx']) {
  const s=read(f);
  assert(s.includes('setBulkIncludedExtra(Object.fromEntries(extras.map((h) => [h, true])))'));
  assert(s.includes('validateNewShopBulkHeaders(found.headers)'));
  assert(s.includes('buildBulkShopRecords('));
  assert(s.includes('/templates/AdRoute_Universal_Shops_Bulk_Upload_Template.xlsx'));
 }
});
test('Separate contact-person DB migration additive, existing owner/name untouched',()=>{
 const sql=read('supabase/migrations/20261117190000_0117_shop_contact_person_name.sql');
 assert(/ADD COLUMN IF NOT EXISTS contact_person_name text/.test(sql));
 assert(!/\bDROP\b|\bTRUNCATE\b|\bDELETE\b/.test(sql));
});
test('Field assignments and reports can read custom details',()=>{
 assert(read('src/pages/SurveyorPage.tsx').includes('ShopAdditionalDetails'));
 assert(read('src/pages/InstallerPage.tsx').includes('ShopAdditionalDetails'));
 assert(read('src/pages/client/ClientShopsPage.tsx').includes('drawerShop.extra_details'));
 assert(read('src/pages/client/ClientReportsPage.tsx').includes('extra_details'));
 assert(read('src/lib/reports.ts').includes('`Extra: ${key}`'));
});
test('Camera metadata distinguishes live shutter from gallery/native file',()=>{
 const s=read('src/components/CameraCapture.tsx');
 assert(s.includes("source: 'camera'"));assert(s.includes("source: 'gallery'"));assert(s.includes("source: 'native-picker'"));
 assert(s.includes('shotCapturedAt.current'));
});
test('Live field proof uses fresh GPS, imported proof explicitly leaves GPS unverified',()=>{
 const s=read('src/pages/SurveyorPage.tsx'),i=read('src/pages/InstallerPage.tsx');
 assert(s.includes("meta?.source === 'camera' ? await capturePhotoLocation(null) : null"));
 assert(i.includes("meta?.source === 'camera' ? await capturePhotoLocation(null) : null"));
 assert(i.includes("timestampLabel: meta?.source === 'camera' ? 'Captured' : 'Imported'"));
 assert(s.includes("timestampLabel: meta?.source === 'camera' ? 'Captured' : 'Imported'"));
});
test('Agency back-office survey and installation evidence receives imported stamp',()=>{
 const s=read('src/pages/ShopsPages.tsx');
 assert(s.includes("stampImportedShopPhoto(file, shop || {})"));
 assert(s.includes(".from('survey-photos').upload(imagePath, evidenceFile)"));
 assert(s.includes(".from('installation-proof').upload(imagePath, evidenceFile)"));
});
test('Shared map draws real tiles only when coordinate pair passes verification',()=>{
 const s=read('src/lib/geoStamp.ts');
 assert(s.includes('https://tile.openstreetmap.org/'));
 assert(s.includes('ctx.drawImage(map, mx, my, mapSize, mapSize)'));
 assert(s.includes('MAP UNAVAILABLE'));
 assert(s.includes('GPS UNAVAILABLE'));
 assert(s.includes('text right')||s.includes('map-left-text-right'));
});
test('Published Excel workbook and migrations exist',()=>{
 assert(fs.statSync(path.join(root,'public/templates/AdRoute_Universal_Shops_Bulk_Upload_Template.xlsx')).size > 2000);
 for (const mig of ['0115_shop_bulk_location_fields.sql','0116_shop_owner_number.sql','0117_shop_contact_person_name.sql']) {
  assert(fs.readdirSync(path.join(root,'supabase/migrations')).some(f=>f.endsWith(mig)));
 }
});
console.log(`PASS ${passed} flexible-shop+geotag integration checks`);

// Render the real shared compositor against deterministic mock canvases.
(async () => {
  const labels=[];
  const draws=[];
  let tilesRequested=0;
  global.document={createElement(name){
    assert.equal(name,'canvas');
    const canvas={width:0,height:0,toDataURL(){return 'data:image/jpeg;base64,TEST';}};
    const ctx={
      save(){},restore(){},beginPath(){},roundRect(){},fill(){},clip(){},stroke(){},arc(){},fillRect(){},
      translate(){},rotate(){},
      fillText(text,x,y){labels.push({text:String(text),x,y});},
      measureText(text){return {width:String(text).length*9};},
      drawImage(...args){draws.push({width:canvas.width,args});},
    };
    canvas.getContext=()=>ctx;
    return canvas;
  }};
  global.Image=class Image {set src(value){tilesRequested++;queueMicrotask(()=>this.onload?.());}};
  const geo=load('src/lib/geoStamp.ts',{'./markingUtils':{loadImage:async()=>({naturalWidth:1600,naturalHeight:1200})}});
  assert(geo.verifiedGeoPoint(20.284787,79.022848));
  assert(!geo.verifiedGeoPoint(100,79));
  assert(!geo.verifiedGeoPoint(null,79));
  const stamp1=await geo.stampGeoTag('data:image/jpeg;base64,source', {
    siteName:'Adani Shop',addressLine:'Market Road, Maharashtra',lat:20.284787,lng:79.022848,
    timestamp:new Date('2026-11-17T11:29:00+05:30'),timestampLabel:'Captured',
  });
  assert.equal(stamp1,'data:image/jpeg;base64,TEST');
  assert(tilesRequested>0 && tilesRequested<=4,'should load up to four map tiles');
  assert(labels.some(x=>x.text.includes('© OpenStreetMap contributors')),'must attribute map source');
  assert(labels.some(x=>x.text.includes('Adani Shop')));
  assert(labels.some(x=>x.text.includes('Market Road')));
  assert(labels.some(x=>x.text.includes('Lat 20.284787')));
  assert(labels.some(x=>x.text.includes('Long 79.022848')));
  assert(labels.some(x=>x.text.includes('Captured:')));
  assert(draws.some(x=>x.width===1600),'should compose final photo canvas');
  const requestedBefore=tilesRequested;
  labels.length=0;
  await geo.stampGeoTag('data:image/jpeg;base64,source',{
    siteName:'Archive Site',addressLine:'1 Old Road',lat:null,lng:null,
    timestamp:new Date('2026-11-17T10:00:00+05:30'),timestampLabel:'Imported',
  });
  assert.equal(tilesRequested,requestedBefore,'unverified images must not request misleading map tiles');
  assert(labels.some(x=>x.text==='GPS UNAVAILABLE'));
  assert(labels.some(x=>x.text.includes('GPS location not captured / verified')));
  assert(labels.some(x=>x.text.includes('Imported:')));
  console.log('PASS real map tiles canvas and 4-field rendered photo labels');
  console.log('PASS gallery imported stamp avoids falsely attributed GPS/tile map');
})().catch(error=>{console.error(error);process.exitCode=1;});
