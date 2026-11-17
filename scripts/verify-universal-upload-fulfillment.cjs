/* Source+runtime regression. Live DB/RLS and geocoding remain staging checks. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
function load(file, injected = {}) {
  const js = ts.transpileModule(read(file), {
    fileName: file,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
  }).outputText;
  const m = { exports: {} };
  new Function('module', 'exports', 'require', js)(m, m.exports, (name) => {
    if (name in injected) return injected[name];
    throw new Error('Unexpected import ' + name);
  });
  return m.exports;
}
const shop = load('src/lib/shopBulkUpload.ts', { './supabase': {supabase: {}} });
const fulfillment = load('src/lib/fulfillment.ts');
const work = load('src/lib/workCompletion.ts');
let count = 0;
const check = (name, fn) => { fn(); count++; console.log('PASS ' + name); };
const cols = ['Shop Name','Full Address','City','Taluka','District','Latitude','Longitude','Landmark','Site code'];
const row = (name,address,landmark = '',code = '') => [name,address,'','','','','',landmark,code];
check('Blank template custom columns do not force pointless review', () =>
  assert.deepEqual(shop.findExtraHeaders(cols, [cols, row('A', 'Market Road')], 0), []));
check('Only nonempty additional columns require explicit consent', () =>
  assert.deepEqual(shop.findExtraHeaders(cols, [cols,row('A','Market Road','Opp bus stand')],0), ['Landmark']));
check('Legacy header-only unrecognized field discovery remains available', () =>
  assert.deepEqual(shop.findExtraHeaders(cols), ['Landmark','Site code']));
check('Chosen custom data persists with original column names', () => {
  const rows = shop.buildShopRows([cols,row('A','Market Road','Opp bus stand','A-001')],0,cols,new Set(['Landmark','Site code']));
  const record = shop.buildBulkShopRecords(rows, { organizationId:'org',clientId:'client',projectId:'project',purchaseOrderId:'po' },new Map())[0];
  assert.deepEqual({...record.extra_details},{Landmark:'Opp bus stand','Site code':'A-001'});
});
check('Shops without city/taluka/district remain valid', () => {
  const rows = shop.buildShopRows([cols,row('A','Shop 2, Main Road, landmark')],0,cols,new Set());
  assert.doesNotThrow(() => shop.assertBulkShopRows(rows));
});
const allowed = {
  survey_install: ['surveyor','designer','installer'],
  production_install: ['designer','installer'],
  supply_only: ['designer'],
  direct_install: ['installer']
};
for(const [type, roles] of Object.entries(allowed)) check(`${type} role eligibility`, () => {
  for(const role of ['surveyor','designer','installer']) assert.equal(
    fulfillment.allowsShopAssignment(type,role),roles.includes(role), `${type} ${role}`);
});
check('Historical custom and unlinked shops preserve existing assignment abilities', () => {
  assert(fulfillment.allowsShopAssignment('custom','installer'));
  assert(fulfillment.allowsShopAssignment(null,'surveyor'));
});
check('Supply delivery receipt gate is not mistaken for installation', () => {
  assert.equal(work.isShopFinished('supply_only','dispatched',[],true), false);
  assert.equal(work.isShopFinished('supply_only','delivered',[],true), true);
  assert.equal(work.isShopFinished('production_install','dispatched'), false);
  assert.equal(work.isShopFinished('direct_install','installed'), true);
});
const agency = read('src/pages/ShopsPages.tsx');
check('Agency bulk assignment verifies all PO fulfillment types before updates', () => {
  assert(agency.includes(".select('id, fulfillment_type').eq('organization_id', orgId).in('id', parentIds)"));
  assert(agency.includes('!allowsShopAssignment(parentType.get(shop.purchase_order_id), bulkRole)'));
});
check('Agency and Shop Detail edit require address, including newly added optional fields', () => {
  assert(agency.includes('isUsableShopAddress(form.address)'));
  assert(agency.includes('isUsableShopAddress(detailForm.address)'));
  assert(agency.includes('detailForm.taluka') && agency.includes('detailForm.pincode'));
});
const client = read('src/pages/client/ClientShopsPage.tsx');
const clientDetail = read('src/pages/client/ClientPODetailPage.tsx');
check('Direct install precreation is blocked in both client flows',()=>{
  assert(client.includes("p.fulfillment_type !== 'direct_install'"));
  assert(client.includes("po?.fulfillment_type === 'direct_install'"));
  assert(clientDetail.includes("po?.fulfillment_type === 'direct_install'"));
  assert(clientDetail.includes("po.fulfillment_type !== 'direct_install'"));
});
check('Previously active bulk assignment holder must be superseded before insert',()=>{
  assert(agency.includes(".in('id', previousHolders.map((prev) => prev.id))"));
  assert(agency.includes('if (supersedeError || (superseded || []).length !== previousHolders.length) { failed++; continue; }'));
});
check('Both database location fields additive and nullable',()=>{
  const sql=read('supabase/migrations/20261117170000_0115_shop_bulk_location_fields.sql');
  assert(sql.includes('ADD COLUMN IF NOT EXISTS taluka text'));
  assert(sql.includes('ADD COLUMN IF NOT EXISTS pincode text'));
});
check('All 3 import dialogs point to the exact same published workbook',()=>{
  for(const src of [agency, client,clientDetail]) assert(src.includes('/templates/AdRoute_Universal_Shops_Bulk_Upload_Template.xlsx'));
  assert(fs.existsSync(path.join(root,'public/templates/AdRoute_Universal_Shops_Bulk_Upload_Template.xlsx')));
});
check('Address edits invalidate stale geographic pins in agency and both client views',()=>{
  assert(agency.includes("...(locationChanged ? { latitude: null, longitude: null } : {})"));
  assert(client.includes('const locationChanged') && client.includes("latitude: null, longitude: null"));
  assert(clientDetail.includes('const locationChanged') && clientDetail.includes("latitude: null, longitude: null"));
});
check('Address-only maps remain navigable without API key',()=>{
  const map = read('src/pages/client/ClientPoSiteMap.tsx');
  assert(map.includes('Interactive pins require a Google Maps API key'));
  assert(map.includes('shopMapsUrl(shop)'));
});
console.log(`PASS ${count} universal-upload/fulfillment regression checks`);
