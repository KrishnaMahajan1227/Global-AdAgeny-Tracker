/** Offline bulk shop / site import regression tests against the actual TypeScript helper.
 * No credentials or installed npm dependencies needed; Supabase is mocked.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
let ts;
try { ts = require('typescript'); }
catch { ts = require('/opt/nvm/versions/node/v22.16.0/lib/node_modules/typescript'); }
const root = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'src/lib/shopBulkUpload.ts'), 'utf8');
const code = ts.transpileModule(src, {fileName:'shopBulkUpload.ts', compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2021}}).outputText;
let zoneRecords = [];
let nextZoneId = 100;
let failInsert = null;
let afterRace = null;
const supabase = {
  from(table) {
    assert.equal(table, 'zones');
    return {
      select() {
        const where = {};
        const query = {
          eq(key,value) {where[key]=value;return query;},
          is(key,value) {where[key]=value;return query;},
          order() {return query;},
          async range(from,to) {return {data:zoneRecords.filter(z => Object.keys(where).every(k => z[k] === where[k])).slice(from,to+1),error:null};},
          then(resolve,reject) { return Promise.resolve({data:zoneRecords.filter(z => Object.keys(where).every(k => z[k] === where[k])),error:null}).then(resolve,reject); },
        };
        return query;
      },
      insert(payload) {
        return {
          async select() {
            if (failInsert) {
              const error = {code:failInsert,message:'Zone conflict'};
              failInsert=null;
              if (afterRace) { afterRace(payload); afterRace=null; }
              return {data:null,error};
            }
            const created = payload.map(row=>({...row,id:`z${nextZoneId++}`}));
            zoneRecords.push(...created);
            return {data:created,error:null};
          },
        };
      },
    };
  },
};
const helperExports = {};
vm.runInNewContext(code, {exports:helperExports, require:(id)=>{
  assert.equal(id,'./supabase');
  return {supabase};
}});
const {
 findShopHeaderRow, findShopWorkbookTable, findExtraHeaders, buildShopRows, findMissingShopNames,
 findDuplicateBulkShopRows, assertBulkShopRows, buildBulkShopRecords,
 validateBulkShopScope, resolveZoneIds, shopMapsUrl,
} = helperExports;
let passes=0;
async function check(name,fn) {await fn();passes++;console.log('PASS',name);}
function parse(aoa) {
 const {headerRowIndex,headers}=findShopHeaderRow(aoa);
 return buildShopRows(aoa,headerRowIndex,headers,new Set(findExtraHeaders(headers)));
}
const projects=[{id:'proj-a',client_id:'client-a'},{id:'proj-b',client_id:'client-b'},{id:'proj-c',client_id:'client-a'}];
const orders=[{id:'po-a',client_id:'client-a',project_id:'proj-a'},{id:'po-b',client_id:'client-b',project_id:'proj-b'},{id:'po-null',client_id:'client-a',project_id:null}];
const baseScope={organizationId:'agency-1',clientId:'client-a',projectId:null,purchaseOrderId:'po-a'};
(async()=>{
 await check('Find Excel header after title/blank rows and varied aliases',()=>{
   const a=[['Advertisement Sites for November'],[],['Site Name','Mobile No','Village','Zone','Extra 1'],['One','09812345678','Village A','North','note']];
   const f=findShopHeaderRow(a); assert.equal(f.headerRowIndex,2);
   const rows=parse(a); assert.equal(rows.length,1); assert.equal(rows[0].known.name,'One');
   assert.equal(rows[0].known.village,'Village A'); assert.equal(rows[0].known.contact_phone,'09812345678');assert.equal(rows[0].extra['Extra 1'],'note');
   assert.equal(rows[0].sourceRowNumber,4);
 });
 await check('Workbook with title sheet imports actual shop table on later worksheet',()=>{
   const sheets={Intro:[['Welcome'],['Instructions']], Sites:[['Shop Name','City'],['A','Jalgaon']]};
   const matched=findShopWorkbookTable(['Intro','Sites'],name=>sheets[name]);
   assert.equal(matched.sheetName,'Sites');assert.equal(matched.aoa.length,2);
 });
 await check('Multiple Name aliases never overwrite a nonempty shop name',()=>{
   const rows=parse([['Name','Shop Name','Contact Phone'],['','Secondary Name','0123456789'],['Primary Name','','0999000000']]);
   assert.equal(rows.length,2);assert.equal(rows[0].known.name,'Secondary Name');assert.equal(rows[1].known.name,'Primary Name');
 });
 await check('Missing shop name rows explicitly reported with Excel row numbers',()=>{
   const a=[['Banner'],['Shop Name','City'],['Valid','Pune'],['','Nashik'],['',''],['Another','Mumbai']];
   const {headerRowIndex,headers}=findShopHeaderRow(a);
   assert.equal(JSON.stringify(findMissingShopNames(a,headerRowIndex,headers)),'[4]');
 });
 await check('Duplicate exact sites detected while chain stores with same name in different cities allowed',()=>{
   const rows=parse([['Shop Name','Full Address','City','Zone'],['My Store','123 Main Street','Mumbai','West'],['My Store','123 Main Street','Mumbai','West'],['My Store','456 Main Street','Pune','West']]);
   const dup=findDuplicateBulkShopRows(rows); assert.equal(dup.length,1);
   assert.equal(dup[0].first,2);assert.equal(dup[0].repeated,3);
   assert.throws(()=>assertBulkShopRows(rows),/Duplicate shop rows 2 and 3/);
   assert.equal(findDuplicateBulkShopRows([rows[0],rows[2]]).length,0);
 });
 await check('Agency Work Order automatically supplies correct Project mapping',()=>{
   const scope=validateBulkShopScope(baseScope,projects,orders);
   assert.equal(scope.projectId,'proj-a');assert.equal(scope.purchaseOrderId,'po-a');
 });
 await check('Wrong Project, wrong Work Order, and conflicting Project are rejected',()=>{
   assert.throws(()=>validateBulkShopScope({...baseScope,projectId:'proj-b'},projects,orders),/project does not belong/);
   assert.throws(()=>validateBulkShopScope({...baseScope,purchaseOrderId:'po-b'},projects,orders),/Work Order does not belong/);
   assert.throws(()=>validateBulkShopScope({...baseScope,projectId:'proj-c'},projects,orders),/different project/);
 });
 await check('Unlinked Work Order may retain explicitly chosen client project',()=>{
   const scope=validateBulkShopScope({...baseScope,projectId:'proj-c',purchaseOrderId:'po-null'},projects,orders);
   assert.equal(scope.projectId,'proj-c');
 });
 await check('Existing zone reused only within same organization and Project',async()=>{
   zoneRecords=[{id:'z-A',organization_id:'agency-1',project_id:'proj-a',name:'North'},
   {id:'z-B',organization_id:'agency-1',project_id:'proj-b',name:'East'},
   {id:'z-X',organization_id:'different-org',project_id:'proj-a',name:'South'}];
   const ids=await resolveZoneIds('agency-1','proj-a',[' NORTH ','north','East','South']);
   assert.equal(ids.get('north'),'z-A');assert.notEqual(ids.get('east'),'z-B');assert.notEqual(ids.get('south'),'z-X');
   const east=zoneRecords.find(z=>z.id===ids.get('east'));
   assert.equal(east.project_id,'proj-a');assert.equal(east.organization_id,'agency-1');
 });
 await check('Unique-constraint race must never map another Project zone',async()=>{
   zoneRecords=[{id:'z-other',organization_id:'agency-1',project_id:'proj-b',name:'Central'}];
   failInsert='23505';
   afterRace=(payload)=>zoneRecords.push({...payload[0],id:'z-new'});
   const ids=await resolveZoneIds('agency-1','proj-a',['Central']);
   assert.equal(ids.get('central'),'z-new');
   assert.notEqual(ids.get('central'),'z-other');
 });
 await check('Non-conflict zone insert failures propagate, not swallowed',async()=>{
   zoneRecords=[];failInsert='42501';
   await assert.rejects(resolveZoneIds('agency-1','proj-a',['Broken']),error=>error.code === '42501');
 });
 await check('Missing resolved zone must block all shops instead of silently saving null zone_id',()=>{
   const rows=parse([['Shop Name','Full Address','Zone'],['Site A','Shop 1, Market Road','Missing']]);
   assert.throws(()=>buildBulkShopRecords(rows,baseScope,new Map()),/could not be mapped/);
 });
 await check('500-shop payload retains client, Work Order, Project, zone and other fields for EVERY shop',()=>{
   const a=[['Name','Full Address','Mobile','City','Zone','Special Asset']];
   for(let i=1;i<=500;i++) a.push([`Site ${i}`,`Shop ${i}, Main Road, Jalgaon`,`0987${String(i).padStart(6,'0')}`,'Jalgaon',i%2?'North':'South',`Material ${i}`]);
   const rows=parse(a); assert.equal(rows.length,500);
   const scope=validateBulkShopScope(baseScope,projects,orders);
   const records=buildBulkShopRecords(rows,scope,new Map([['north','z1'],['south','z2']]));
   assert.equal(records.length,500);
   records.forEach((r,i)=>{
     assert.equal(r.organization_id,'agency-1');assert.equal(r.client_id,'client-a');
     assert.equal(r.project_id,'proj-a');assert.equal(r.purchase_order_id,'po-a');
     assert.equal(r.name,`Site ${i+1}`);assert.equal(r.extra_details['Special Asset'],`Material ${i+1}`);
     assert.equal(r.zone_id,(i+1)%2?'z1':'z2');
   });
 });
 await check('Template aliases keep Taluka distinct from District, and handle PIN and GPS',()=>{
   const rows=parse([['Shop Name','Full Address','Taluka','District','PIN Code','Latitude','Longitude'],
     ['Store A','2 Market Road, Jalgaon','Bhusawal','Jalgaon','0425201','21.045','75.80']]);
   const r=rows[0];assert.equal(r.known.taluka,'Bhusawal'); assert.equal(r.known.district,'Jalgaon');
   assert.equal(r.known.pincode,'0425201');assert.equal(r.known.latitude,'21.045');
   const saved=buildBulkShopRecords(rows,baseScope,new Map())[0];
   assert.equal(saved.taluka,'Bhusawal');assert.equal(saved.district,'Jalgaon');
   assert.equal(saved.pincode,'0425201');assert.equal(saved.latitude,21.045);assert.equal(saved.longitude,75.80);
 });
 await check('Address required, but City, Taluka, District, Zone, PIN may all be missing',()=>{
   const rows=parse([['Shop Name','Full Address'],['Shop only','Shop 9, Railway Road, Maharashtra']]);
   assertBulkShopRows(rows);
   const record=buildBulkShopRecords(rows,baseScope,new Map())[0];
   assert.equal(record.city,null);assert.equal(record.taluka,null);assert.equal(record.district,null);
   assert.equal(record.address,'Shop 9, Railway Road, Maharashtra');
   assert.equal(record.latitude,null);assert.equal(record.longitude,null);
 });
 await check('Blank/missing placeholder address rejected with row-specific error',()=>{
   for(const address of ['', 'N/A', 'TBD', '-']) {
     const rows=parse([['Name','Address'],['Store 1',address]]);
     assert.throws(()=>assertBulkShopRows(rows),/Full Address is required in spreadsheet row 2/);
   }
 });
 await check('Partial and invalid GPS rejected; valid zero coordinates accepted',()=>{
   for(const [lat,lng] of [['21',''],['','75'],['91','76'],['21','181'],['abc','76']]) {
     const rows=parse([['Name','Address','Latitude','Longitude'],['Store 1','1 Market Road',lat,lng]]);
     assert.throws(()=>assertBulkShopRows(rows),/row 2/i);
   }
   const rows=parse([['Name','Address','Latitude','Longitude'],['Store 1','1 Market Road','0','0']]);
   assertBulkShopRows(rows);
   assert.equal(buildBulkShopRecords(rows,baseScope,new Map())[0].latitude,0);
 });
 await check('Extra custom Excel columns persist into DB JSONB while optional values can be blank',()=>{
   const rows=parse([['Shop Name','Full Address','Site Segment','Site Notes'],['First','1 Road','Premium',''],['Second','2 Road','','Check entry']]);
   const result=buildBulkShopRecords(rows,baseScope,new Map());
   assert.equal(result[0].extra_details['Site Segment'],'Premium');
   assert.equal(result[0].extra_details['Site Notes'],undefined);
   assert.equal(result[1].extra_details['Site Notes'],'Check entry');
 });
 await check('Map link uses supplied GPS exactly; address-only shops receive explicit address search',()=>{
   const gps=shopMapsUrl({latitude:21.0,longitude:75.5,address:'Wrong Address'});
   assert.match(gps,/21,75\.5/); assert.ok(!gps.includes('Wrong'));
   const address=shopMapsUrl({latitude:null,longitude:null,address:'House 1, Main Road',taluka:'Bhusawal',district:'Jalgaon',pincode:'425201'});
   assert.match(address,/House%201%2C%20Main%20Road/);
   assert.match(address,/Bhusawal/);assert.match(address,/425201/);
   assert.equal(shopMapsUrl({}),null);
 });
 await check('Geocode query does not invent a country-center pin for blank address',()=>{
   const file=path.join(root,'src/lib/geocode.ts');
   const compiled=ts.transpileModule(fs.readFileSync(file,'utf8'),{fileName:file,compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2021}}).outputText;
   const result={};
   vm.runInNewContext(compiled,{exports:result,require:(id)=>({})});
   assert.equal(result.buildAddressQuery({}), '');
   assert.equal(result.buildAddressQuery({address:'Shop 9, Road',taluka:'Bhusawal',district:'Jalgaon',pincode:'425201'}),'Shop 9, Road, Bhusawal, Jalgaon, 425201, India');
 });
 await check('All bulk dialogs link the same downloadable Excel, validate before upload and prompt for custom fields',()=>{
   for(const p of ['src/pages/ShopsPages.tsx','src/pages/client/ClientShopsPage.tsx','src/pages/client/ClientPODetailPage.tsx']){
     const txt=fs.readFileSync(path.join(root,p),'utf8');
     assert.match(txt,/AdRoute_Universal_Shops_Bulk_Upload_Template.xlsx/);
     assert.match(txt,/assertBulkShopRows\(previewRows\)/);
     assert.match(txt,/setBulkIncludedExtra\(Object.fromEntries\(extras.map/);
   }
   assert.ok(fs.statSync(path.join(root,'public/templates/AdRoute_Universal_Shops_Bulk_Upload_Template.xlsx')).size>5000);
 });
 await check('New nullable DB migration and JSONB storage are present',()=>{
   const sql=fs.readFileSync(path.join(root,'supabase/migrations/20261117170000_0115_shop_bulk_location_fields.sql'),'utf8');
   assert.match(sql,/ADD COLUMN IF NOT EXISTS taluka text/);
   assert.match(sql,/ADD COLUMN IF NOT EXISTS pincode text/);
   const jsonb=fs.readFileSync(path.join(root,'supabase/migrations/20260920090000_0054_shops_extra_details.sql'),'utf8');
   assert.match(jsonb,/extra_details jsonb/);
 });
 await check('All three bulk entry points call common payload logic and retain phone formatting',()=>{
   const paths=['src/pages/ShopsPages.tsx','src/pages/client/ClientShopsPage.tsx','src/pages/client/ClientPODetailPage.tsx'];
   for(const p of paths) {
     const source=fs.readFileSync(path.join(root,p),'utf8');
     assert.match(source,/buildBulkShopRecords\(bulkParsedRows, scope, zoneIds\)/,p);
     assert.match(source,/assertBulkShopRows\(bulkParsedRows\)/,p);
     assert.match(source,/findMissingShopNames\(aoa, found.headerRowIndex, found.headers\)/,p);
     assert.match(source,/range: 0, raw: false, blankrows: true/,p);
   }
 });
 await check('Agency selector clears old client project/order and fetches Work Order project_id',()=>{
   const source=fs.readFileSync(path.join(root,'src/pages/ShopsPages.tsx'),'utf8');
   assert.match(source,/setBulkClientId\(v\); setBulkProjectId\(''\); setBulkPurchaseOrderId\(''\);/);
   assert.match(source,/select\('id, po_number, client_id, project_id, fulfillment_type, status'\)/);
 });
 await check('Client single-shop insertion also preserves parent project mapping',()=>{
   for(const p of ['src/pages/client/ClientShopsPage.tsx','src/pages/client/ClientPODetailPage.tsx']) {
     const source=fs.readFileSync(path.join(root,p),'utf8');
     assert.match(source,/project_id: po\.project_id \|\| null,\s*purchase_order_id: po\.id/);
   }
 });
 // Execute the actual bulk-upload mutation bodies (not a reimplementation) with a mocked DB.
 async function runActualUpload(pagePath, mutationName, setup, parsedRows, expectedScope, shouldFail=false) {
   const filename=path.join(root,pagePath);
   const source=fs.readFileSync(filename,'utf8');
   const ast=ts.createSourceFile(filename,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
   let declaration;
   function visit(node) {
     if (ts.isVariableDeclaration(node) && node.name.getText(ast) === mutationName) declaration=node;
     ts.forEachChild(node, visit);
   }
   visit(ast);
   assert.ok(declaration,`Cannot find ${mutationName} in ${pagePath}`);
   const declarationCode=ts.transpileModule(`const ${declaration.getText(ast)}; this.mutation = ${mutationName};`, {
     fileName:filename,compilerOptions:{module:ts.ModuleKind.None,target:ts.ScriptTarget.ES2021,jsx:ts.JsxEmit.React}
   }).outputText;
   const inserts=[];const invalidations=[];const audits=[];
   const ctx={
     ...setup, bulkParsedRows:parsedRows, bulkExtraHeaders:[], bulkIncludedExtra:{},
     useMutation:options=>options,
     assertBulkShopRows, validateBulkShopScope, buildBulkShopRecords,
     resolveZoneIds:async()=>new Map([['north','z-north'],['south','z-south']]),
     supabase:{from(table){assert.equal(table,'shops');return {async insert(rows){inserts.push(...rows);return {error:null};}};}},
     logAudit:async(...args)=>audits.push(args),
     queryClient:{invalidateQueries:({queryKey})=>{invalidations.push(queryKey.join('|'));return Promise.resolve();}},
     setBulkUploadResult:()=>{},resetBulkState:()=>{},setBulkOpen:()=>{},setBulkUploadOpen:()=>{},
   };
   vm.runInNewContext(declarationCode,ctx);
   if(shouldFail) {
     await assert.rejects(ctx.mutation.mutationFn());
     assert.equal(inserts.length,0,'Invalid context must not write shops');
     return;
   }
   const count=await ctx.mutation.mutationFn();
   ctx.mutation.onSuccess?.(count);
   assert.equal(inserts.length,parsedRows.length,`${pagePath}: row count`);
   inserts.forEach(row=>{
     assert.equal(row.organization_id,expectedScope.organizationId);
     assert.equal(row.client_id,expectedScope.clientId);
     assert.equal(row.project_id,expectedScope.projectId);
     assert.equal(row.purchase_order_id,expectedScope.purchaseOrderId);
     assert.equal(row.status,'pending');
     assert.equal(row.zone_id,'z-north');
   });
   assert.ok(audits.length===1);
   assert.ok(invalidations.length>=2);
 }
 const sampleRows=parse([['Shop Name','Full Address','City','Zone'],['Store 1','11 Bazaar Road, Jalgaon','Jalgaon','North'],['Store 2','2 Camp Road, Pune','Pune','North']]);
 await check('Actual agency bulk mutation writes 2 shops to correct Work Order and Project',()=>
   runActualUpload('src/pages/ShopsPages.tsx','bulkUploadMutation',{
     orgId:'agency-1',bulkClientId:'client-a',bulkProjectId:'',bulkPurchaseOrderId:'po-a',projects,purchaseOrders:orders,
   },sampleRows,{organizationId:'agency-1',clientId:'client-a',projectId:'proj-a',purchaseOrderId:'po-a'})
 );
 await check('Actual agency mutation prevents stale wrong-client Project without an insert',()=>
   runActualUpload('src/pages/ShopsPages.tsx','bulkUploadMutation',{
     orgId:'agency-1',bulkClientId:'client-a',bulkProjectId:'proj-b',bulkPurchaseOrderId:'po-a',projects,purchaseOrders:orders,
   },sampleRows,null,true)
 );
 await check('Actual client Shops mutation maps both shops to agency org, client, PO and Project',()=>
   runActualUpload('src/pages/client/ClientShopsPage.tsx','bulkMutation',{
     orgId:'client-org', bulkWorkOrderId:'po-a', poById:new Map([['po-a',{id:'po-a',origin:'client_created',assigned_agency_id:'agency-1',project_id:'proj-a'}]]),
     linkByAgency:new Map([['agency-1',{agency_client_id:'client-a'}]]),
   },sampleRows,{organizationId:'agency-1',clientId:'client-a',projectId:'proj-a',purchaseOrderId:'po-a'})
 );
 await check('Actual client Work Order details mutation saves correct scope',()=>
   runActualUpload('src/pages/client/ClientPODetailPage.tsx','bulkAddShopsMutation',{
     orgId:'client-org',poId:'po-a', po:{id:'po-a',origin:'client_created',assigned_agency_id:'agency-1',project_id:'proj-a'},
     agencyLink:{agency_client_id:'client-a'},
   },sampleRows,{organizationId:'agency-1',clientId:'client-a',projectId:'proj-a',purchaseOrderId:'po-a'})
 );
 await check('Actual client mutation refuses non-client-created Work Order',()=>
   runActualUpload('src/pages/client/ClientPODetailPage.tsx','bulkAddShopsMutation',{
     orgId:'client-org',poId:'po-a', po:{id:'po-a',origin:'agency_created',assigned_agency_id:'agency-1',project_id:'proj-a'},
     agencyLink:{agency_client_id:'client-a'},
   },sampleRows,null,true)
 );
 console.log(`PASS: ${passes} shop bulk mapping regression scenarios`);
})().catch(e=>{console.error('FAIL',e);process.exitCode=1;});
