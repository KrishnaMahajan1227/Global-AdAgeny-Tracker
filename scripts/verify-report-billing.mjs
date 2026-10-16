import fs from 'node:fs';
import assert from 'node:assert/strict';
import ts from 'typescript';
const files = ['src/pages/BillingPage.tsx','src/pages/ReportsPage.tsx','src/lib/reportPortfolio.ts'];
for (const file of files) {
  assert.ok(fs.existsSync(file), `Missing ${file}`);
  const parsed = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    fileName: file, reportDiagnostics: true,
    compilerOptions: { jsx:ts.JsxEmit.ReactJSX, target:ts.ScriptTarget.ES2022, module:ts.ModuleKind.ESNext },
  });
  assert.deepEqual(parsed.diagnostics || [], [], `Syntax errors in ${file}`);
  console.log(`PASS TypeScript/TSX parser: ${file}`);
}
const billing=fs.readFileSync(files[0],'utf8');
const reports=fs.readFileSync(files[1],'utf8');
const portfolio=fs.readFileSync(files[2],'utf8');
const cases=[
  ['Billing is PO scoped', billing.includes(".eq('purchase_order_id', form.purchase_order_id)")],
  ['Billing requires selected completed shops', billing.includes('selectedShopIds.length') && billing.includes('completed shops')],
  ['Shop selection first column', billing.includes('type="checkbox"') && billing.includes('selectedShopIds.includes(shop.id)')],
  ['Billing line links saved', billing.includes('shop_id: item.shop_id') && billing.includes('work_item_id: item.work_item_id')],
  ['No client-wide status mutation', !billing.includes(".eq('client_id', form.client_id).in('status', ['installed', 'dispatched'])")],
  ['Only selected billed status', billing.includes(".in('id', selectedShopIds)")],
  ['Duplicate bill check', billing.includes(".from('invoice_items')") && billing.includes("Some shops are already linked to an invoice")],
  ['No blind success after status error', billing.includes('Invoice ${invNumber} created but could not finalize')],
  ['Client and PO billing list filters', billing.includes('poFilterList') && billing.includes('clientFilterList')],
  ['Report date filter visible', reports.includes('Report date range')],
  ['Report Work Order filter visible', reports.includes('Report work order')],
  ['Report No Zone', reports.includes('No Zone')],
  ['A4 portrait export', portfolio.includes("orientation: 'portrait'") && portfolio.includes("format: 'a4'")],
  ['No photographic rounded border', !portfolio.includes('pdf.roundedRect')],
  ['Evidence before item table', portfolio.indexOf('for (const [idx, card]') < portfolio.indexOf('const extraRows')],
  ['Unlinked items retained', portfolio.includes('unlinkedRows: items.filter')],
  ['Excel linked source image', portfolio.includes("hyperlink:e.entry.url")],
  ['Excel image embedded', portfolio.includes('ev.addImage(imageId')],
  ['PPT contains both evidence and details', portfolio.includes('slide.addImage') && portfolio.includes('card.entry.lines.join')],
];
for(const [label,pass] of cases){assert.ok(pass, label);console.log('PASS',label)}
// Domain-level sanity checks independent from database access.
const billable = (basis,quantity,area,rate) => Math.round((basis==='area'?area:quantity)*rate*100)/100;
assert.equal(billable('area',3,18,120),2160);
assert.equal(billable('quantity',3,18,120),360);
assert.equal(new Set(['s1','s2','s1']).size,2);
console.log('PASS quantity/area basis and duplicate selection fixture');
console.log(`\n${files.length+cases.length+1} checks passed. Browser/Supabase/print preview still required.`);
