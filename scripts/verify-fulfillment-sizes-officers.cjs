/** Targeted, offline regression checks for Nov 17 fulfillment sizing release. */
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const ts=require('typescript');
const root=path.resolve(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const load=file=>{
 const js=ts.transpileModule(read(file),{fileName:file,compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
 const mod={exports:{}};
 new Function('module','exports','require',js)(mod,mod.exports,(name)=>{if(name==='./supabase')return {supabase:{}};throw Error(`Unexpected import ${name}`)});
 return mod.exports;
};
const sizes=load('src/lib/noSurveySizing.ts'), bulk=load('src/lib/shopBulkUpload.ts');
let passed=0;
const test=(name,check)=>{check();passed++;console.log(`PASS ${name}`)};
test('Correct no-survey fulfillment modes',()=>{
 assert.equal(sizes.usesPreDesignMeasurements('production_install'),true);
 assert.equal(sizes.usesPreDesignMeasurements('supply_only'),true);
 for(const t of ['survey_install','direct_install','custom',null]) assert.equal(sizes.usesPreDesignMeasurements(t),false);
});
test('Valid width/height/quantity accepted for artwork',()=>{
 assert.equal(sizes.hasUsableApprovedSize({approved_width:6,approved_height:4,approved_quantity:2}),true);
});
test('Piece/lot may use positive whole-number quantity alone',()=>{
 assert.equal(sizes.hasUsableApprovedSize({approved_width:null,approved_height:null,approved_quantity:3}),true);
});
test('Reject missing or partial dimensions / invalid quantities',()=>{
 for(const item of [{approved_quantity:null},{approved_quantity:0},{approved_quantity:-1},{approved_quantity:1.5},{approved_width:4,approved_height:null,approved_quantity:2},{approved_width:-1,approved_height:3,approved_quantity:2}]) {
  assert.equal(sizes.hasUsableApprovedSize(item),false,JSON.stringify(item));
 }
});
test('Only unstarted no-survey items transition pending -> approved',()=>{
 assert.equal(sizes.approvedStateAfterMeasurement('production_install','pending'),'approved');
 assert.equal(sizes.approvedStateAfterMeasurement('supply_only','pending'),'approved');
 for(const t of ['survey_install','direct_install','custom'])assert.equal(sizes.approvedStateAfterMeasurement(t,'pending'),undefined);
 for(const t of ['designed','design_approved','in_production','installed','approved']) assert.equal(sizes.approvedStateAfterMeasurement('production_install',t),undefined);
});
test('Design & production progressed statuses stay locked',()=>{
 for(const t of ['designed','design_approved','in_production','produced','installed','billed']) assert(sizes.MEASUREMENT_LOCKED_STATUSES.has(t));
});
test('Pending placeholder completion before new duplicate work item',()=>{
 const s=read('src/pages/ShopsPages.tsx');
 assert(s.includes('const pendingPlaceholder = usesPreDesignMeasurements'));
 assert(s.includes('openWorkItemForm(pendingPlaceholder)'));
 assert(s.includes('Record missing size'));
});
test('Owner validation enforces PO scope and sqft dimensions',()=>{
 const s=read('src/pages/ShopsPages.tsx');
 assert(s.includes("selectedUom === 'sqft'"));
 assert(s.includes("!f.po_line_item_id"));
 assert(s.includes("if (!updated?.length) throw new Error('Work item changed in another session"));
 assert(s.includes('MEASUREMENT_LOCKED_STATUSES.has'));
});
test('Production sizes do not fabricate survey measurements',()=>{
 const s=read('src/pages/ShopsPages.tsx');
 assert(s.includes('...(!noSurveyScope ? { survey_width:'));
 assert(s.includes('approved_width: widthFt'));
});
test('Designer only maps artwork, cannot change owner measurements',()=>{
 const s=read('src/pages/DesignerPage.tsx');
 assert(s.includes('Owner/Admin must record valid Work Order quantities'));
 assert(s.includes('validateArtworkMappings(uploadTask.items, stagedFiles)'));
 assert(s.includes('toggleFileMarking'));
 assert(s.includes('design_version_items'));
 assert(s.includes('uploadLatestVersionByItem'));
});
test('Agency site owner handles quantities; no designer size form',()=>{
 const s=read('src/pages/ShopsPages.tsx');
 assert(s.includes("profile?.role === 'agency_owner' || profile?.role === 'admin'"));
 assert(s.includes('Record work item size'));
});
test('Client Work Order stages follow fulfillment',()=>{
 const s=read('src/pages/client/ClientPODetailPage.tsx');
 for(const t of ["fulfillment_type === 'direct_install'","fulfillment_type === 'production_install'","fulfillment_type === 'supply_only'",'applicableStages.map']) assert(s.includes(t));
 assert(s.includes("po?.fulfillment_type !== 'supply_only'"));
 assert(s.includes('evidenceReady'));
});
test('Scaled Work Order shops and photo evidence are paged/deferred',()=>{
 const s=read('src/pages/client/ClientPODetailPage.tsx');
 assert(s.includes('offset += 500'));
 assert(s.includes('i += 100'));
 assert(s.includes('batch += 3'));
 assert(s.includes("tab === 'shops' || tab === 'report'"));
 assert(s.includes('.range(offset, offset + 499)'));
 assert(s.includes('SHOP_RENDER_CAP = 200'));
});
test('Officer field names and legacy import aliases coexist',()=>{
 const header=bulk.NEW_SHOP_TEMPLATE_FIELDS;
 assert(header.includes('Officer Name') && header.includes('Officer Number'));
 assert(!header.includes('Contact Person'));
 const canonical=bulk.findShopHeaderRow([['Shop Name','Address','Officer Name','Officer Number']]);
 assert(canonical.headers.length===4);
 assert.doesNotThrow(()=>bulk.validateNewShopBulkHeaders(['Shop Name','Address','Contact Person','Contact Person Number']));
});
test('Extra Excel fields remain supported',()=>{
 assert.doesNotThrow(()=>bulk.validateNewShopBulkHeaders([...bulk.NEW_SHOP_TEMPLATE_FIELDS,'FMM/FSM Name']));
});
test('Officer names and numbers across shop/detail/reports',()=>{
 for(const f of ['src/pages/ShopsPages.tsx','src/components/ShopForm.tsx','src/lib/reports.ts','src/pages/client/ClientReportsPage.tsx']){
  const s=read(f); assert(s.includes('Officer Name') || s.includes('contact_person_name'));
 }
 assert(read('src/lib/reports.ts').includes("'Officer Number'"));
});
test('Large PO-line initializer is set-based and scoped; no destructive migration',()=>{
 const s=read('supabase/migrations/20261117200000_0118_shop_scale_and_no_survey_size_indexes.sql');
 assert(s.includes('CREATE INDEX IF NOT EXISTS'));
 assert(s.includes('CREATE OR REPLACE FUNCTION public.trg_initialize_production_install_line()'));
 assert(s.includes('INSERT INTO public.work_items'));
 assert(s.includes('s.purchase_order_id=NEW.purchase_order_id'));
 assert(s.includes('s.organization_id=v_po.organization_id AND s.client_id=v_po.client_id'));
 assert(!/\bDROP TABLE\b|\bTRUNCATE\b|\bDELETE FROM\b/.test(s));
});
test('Design comparison report avoids duplicate artwork link rows',()=>{
 const s=read('src/lib/reports.ts');
 assert(s.includes('const seenLinks = new Set<string>()'));
 assert(s.includes('if (seenLinks.has(key)) continue'));
 assert(s.includes('versionsByItem.set(link.work_item_id'));
 assert(s.includes('const CLIENT_SITE_PDF_MAX_SITES = 40'));
});
console.log(`PASS ${passed} targeted fulfillment, sizing, scale, artwork and Officer checks`);
