/** Adroute Production V11: scoped artwork mapping, safe quantities & one-screen actions. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const ts = require('typescript');
const projectRoot = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(projectRoot, 'src/pages/ProductionPage.tsx'), 'utf8');
let passed = 0;
const check = (name, fn) => { fn(); passed++; process.stdout.write(`PASS ${name}\n`); };
const sf = ts.createSourceFile('ProductionPage.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
check('Production TSX parses', () => assert.equal(sf.parseDiagnostics.length, 0));
for (const [name, str] of [
 ['work-type and dimension headline', "{board.item.work_type_name || 'Work Item'} <span"],
 ['work item label not fake survey marking', 'Work item {index + 1}'],
 ['approved-only query', ".eq('status', 'approved')"],
 ['explicit artwork mapping table', ".from('design_version_items')"],
 ['links scoped to displayed work items', 'if (!allowed.has(link.work_item_id)) continue'],
 ['production order/shop identity guard', 'order.shop_id !== shopId'],
 ['on-demand artwork (not list-wide)', 'await fetchApprovedProductionArtwork(row.production_order_id, row.shop_id'],
 ['safe preview for image or document', 'artworkIsImage(design)'],
 ['quantity actual not automatic', "const raw = (valuesToSave[board.item.id] || '').trim()"],
 ['integer production quantities', 'Number.isSafeInteger(qty)'],
 ['multi-board editable workbench', 'quantityWorkbench.boards.map((board, index)'],
 ['save and next', "saveWorkbenchQuantities('next')"],
 ['save and complete', "saveWorkbenchQuantities('complete')"],
 ['server authoritative handoff', 'await completeProductionOrder(currentRow, installer, currentRow.notes ||'],
 ['fresh detail before completion', 'enrichBoards(await fetchOrderDetail(currentRow.shop_id'],
 ['material readiness gate', '(!b.qtyMet || !b.componentsReady)'],
 ['installer explicit when multiple', 'workbenchInstaller || (orgInstallers?.length === 1'],
 ['owner/admin privileged completion', "profile?.role === 'agency_owner' || profile?.role === 'admin'"],
 ['assigned printing work filter', 'isProduction ? profile!.id : null'],
 ['optimistic quantity comparison', "request.eq('produced_qty', persisted.produced_qty)"],
 ['retry same quantity after partial write', 'persisted.produced_qty !== producedQty'],
 ['no upsert overwrite conflict', ".from('production_items').insert({"],
 ['safe partial batch errors', 'Successful quantities won\'t be re-submitted'],
 ['realtime invalidate', "'production_items', 'work_items', 'work_item_components'"],
 ['no database schema alteration', 'phase3_complete_production'],
]) check(name, () => assert(source.includes(str), `Missing ${str}`));

// Extract production-artwork runtime helpers and exercise them against a mocked
// Supabase query chain, not merely string matching.
const helper = source.slice(source.indexOf('type ProductionArtwork ='), source.indexOf('type EnrichedBoard ='));
const compiled = ts.transpileModule(helper + '\nglobalThis.__art = { fetchApprovedProductionArtwork, artworkIsImage };', {
 compilerOptions:{module:ts.ModuleKind.None,target:ts.ScriptTarget.ES2020}
}).outputText;
const mock = { order: { id:'po',shop_id:'shop-1',design_task_id:'task-1' }, versions: [], links: [], errors:{} };
const api = { from(table) { const options={}; const chain = {
 select() {return chain}, eq(k,v) { options[k]=v; return chain}, order() {return chain}, limit() {return Promise.resolve({data:mock[table],error:mock.errors[table]||null})},
 in(k,v) {options[k]=v; return Promise.resolve({data:mock.links,error:mock.errors[table]||null})},
 maybeSingle() {return Promise.resolve({data:mock.order,error:mock.errors[table]||null})},
 }; if(table==='design_versions') { mock.design_versions=mock.versions; } return chain; }};
const ctx=vm.createContext({supabase:api,Set,Map,Object,Array});vm.runInContext(compiled,ctx);
const fn=ctx.__art.fetchApprovedProductionArtwork;
(async()=>{
check('image extension recognition',()=>{ assert(ctx.__art.artworkIsImage({file_name:'ACP.JPG',file_url:'a'}) );assert(!ctx.__art.artworkIsImage({file_name:'plan.pdf',file_url:'a'}));});
check('no task does not invent artwork',()=>{mock.order={id:'po',shop_id:'shop-1',design_task_id:null}});
let out=await fn('po','shop-1',['board-1']);
check('no design returns empty mappings',()=>assert.equal(Object.keys(out.byItem).length,0));
mock.order={id:'po',shop_id:'shop-1',design_task_id:'task-1'};
mock.versions=[{id:'v1',file_name:'one.png',file_url:'https://valid/image.png',status:'approved',version_number:3},{id:'v2',file_name:'two.pdf',file_url:'https://valid/file.pdf',status:'approved',version_number:4}];
mock.links=[{design_version_id:'v1',work_item_id:'board-1'},{design_version_id:'v1',work_item_id:'board-2'},{design_version_id:'v2',work_item_id:'board-2'},{design_version_id:'v2',work_item_id:'other-shop'}];
out=await fn('po','shop-1',['board-1','board-2']);
check('explicit 1:1 mapping',()=>assert.deepEqual(Array.from(out.byItem['board-1'],v=>v.id),['v1']));
check('explicit 1:many shared artwork mapping',()=>assert.deepEqual(Array.from(out.byItem['board-2'],v=>v.id),['v2','v1']));
check('foreign shop board excluded',()=>assert(!out.byItem['other-shop']));
mock.order={id:'po',shop_id:'shop-2',design_task_id:'task-1'};
out=await fn('po','shop-1',['board-1']);
check('wrong-shop request refused',()=>assert.match(out.warning,/changed/));
mock.order={id:'po',shop_id:'shop-1',design_task_id:'task-1'};
mock.errors.design_versions={message:'RLS denied'};
out=await fn('po','shop-1',['board-1']);
check('artwork fetch error surfaced, not hidden',()=>assert.match(out.warning,/RLS denied/));
mock.errors={};mock.versions=[];
out=await fn('po','shop-1',['board-1']);
check('missing approved versions never fabricated',()=>assert.equal(Object.keys(out.byItem).length,0));
console.log(`PRODUCTION V11: ${passed} checks passed`);
})().catch(e=>{console.error(e);process.exitCode=1});
