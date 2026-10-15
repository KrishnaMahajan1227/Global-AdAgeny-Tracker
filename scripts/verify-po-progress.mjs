/** Run after `npm ci`: node scripts/verify-po-progress.mjs. No new dependencies. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';

const tsSource = readFileSync(resolve('src/lib/poUtilization.ts'), 'utf8');
const js = ts.transpileModule(tsSource, { compilerOptions: {
  module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022,
}}).outputText;
const { calculatePoProgress } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
const line = (values = {}) => ({
  po_line_item_id: 'line-a', purchase_order_id: 'po-a',
  uom: 'sqft', budgeted_area: 100, budgeted_qty: null, rate: 20,
  surveyed_area: 50, surveyed_qty: 0, approved_area: 40, approved_qty: 0,
  produced_qty: 10, installed_area: 40, installed_qty: 0, invoiced_amount: 600,
  ...values,
});
let passed = 0;
function check(label, test) { test(); passed++; process.stdout.write(`PASS ${label}\n`); }
check('work is independent of invoicing', () => { const p = calculatePoProgress([line()], 'installed'); assert.equal(p.workPct, 40); assert.equal(p.financialPct, 30); });
check('mixed UOM uses normalized unit groups', () => { const p = calculatePoProgress([line(), line({po_line_item_id: 'b', uom:'piece', budgeted_area:null,budgeted_qty:10,installed_area:0,installed_qty:5, rate:100,invoiced_amount:100})], 'installed'); assert.equal(p.workPct,45); assert.equal(p.budgetedAmount,3000); });
check('same UOM weights by quantity', () => { const p=calculatePoProgress([line(),line({po_line_item_id:'b',budgeted_area:300,installed_area:0})],'installed'); assert.equal(p.workPct,10); });
check('work still calculates without a rate', () => { const p=calculatePoProgress([line({rate:null})],'installed'); assert.equal(p.workPct,40); assert.equal(p.financialPct,null); });
check('missing scope does not invent percentage', () => assert.equal(calculatePoProgress([line({budgeted_area:null})],'installed').workPct,null));
check('empty PO does not show misleading 0%', () => assert.equal(calculatePoProgress([],'installed',0).workPct,null));
check('missing view rows prevent partial tally', () => assert.equal(calculatePoProgress([line()],'installed',2).workPct,null));
check('over-completion capped and flagged', () => { const p=calculatePoProgress([line({installed_area:150})],'installed'); assert.equal(p.workPct,100); assert.equal(p.excessScope,true); });
check('over-invoicing capped and explicitly tracked', () => { const p=calculatePoProgress([line({invoiced_amount:2500})],'installed'); assert.equal(p.financialPct,100); assert.equal(p.overInvoicedAmount,500); });
check('supply-only piece scope uses produced', () => assert.equal(calculatePoProgress([line({uom:'piece',budgeted_area:null,budgeted_qty:10,produced_qty:7})],'produced').workPct,70));
check('production pieces cannot be divided by sqft', () => assert.equal(calculatePoProgress([line()],'produced').workPct,null));
check('PO-level invoices can replace linked-only sum', () => assert.equal(calculatePoProgress([line({invoiced_amount:0})],'installed',1,1200).financialPct,60));
check('no positive financial budget means unavailable', () => assert.equal(calculatePoProgress([line({rate:0})],'installed').financialPct,null));
check('negative actual and NaN billed never propagate', () => {const p=calculatePoProgress([line({installed_area:-2,invoiced_amount:NaN})],'installed'); assert.equal(p.workPct,0); assert.equal(p.financialPct,0);});
console.log(`${passed} tests passed`);
