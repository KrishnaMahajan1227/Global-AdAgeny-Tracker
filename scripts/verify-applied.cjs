// Current source structure verification; older patch-marker snapshots were obsolete after phases 1–7.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(process.argv[2] || path.join(__dirname,'..'));
const markers = {
  'src/lib/workCompletion.ts': ['groupShopCompletion', 'isShopFinished', 'receiptRequired'],
  'src/pages/PurchaseOrdersPage.tsx': ['milestoneProgress', 'po_line_items'],
  'src/pages/WorkProgressPage.tsx': ['isShopFinished'],
  'src/pages/DesignerPage.tsx': ['fetchWorkflowFolderPages', 'sendDesignTaskToProduction'],
  'src/pages/ProductionPage.tsx': ['fetchWorkflowFolderPages', 'completeProductionOrder'],
  'src/pages/SupplyOrdersPage.tsx': ['phase4_create_supply_dispatch', 'phase4_confirm_supply_receipt'],
};
for (const [file, values] of Object.entries(markers)) {
  const text = fs.readFileSync(path.join(root, file), 'utf8');
  for (const value of values) assert.ok(text.includes(value), `${file}: missing ${value}`);
  console.log('PASS', file);
}
console.log('Current workflow source markers present. Full build and browser/database tests remain separate release gates.');
