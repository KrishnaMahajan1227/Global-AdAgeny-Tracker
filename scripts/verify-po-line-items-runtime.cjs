/**
 * Work Order line-item regression harness. Executes the *actual* JSX modal
 * function using a tiny React-hook mock. No credentials/network/dependency
 * installation is needed, so it also catches runtime shadowing problems that
 * TypeScript transpilation by itself does not catch.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
let ts;
try { ts = require('typescript'); }
catch { ts = require('/opt/nvm/versions/node/v22.16.0/lib/node_modules/typescript'); }

const root = path.resolve(__dirname, '..');
const srcPath = path.join(root, 'src/pages/PurchaseOrdersPage.tsx');
const src = fs.readFileSync(srcPath, 'utf8');
const ast = ts.createSourceFile(srcPath, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const modal = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'POLineItemsModal');
assert.ok(modal, 'Expected the actual POLineItemsModal component in PurchaseOrdersPage');
const getConst = name => ast.statements.find(n => ts.isVariableStatement(n) && n.declarationList.declarations.some(d => d.name.getText(ast) === name));
const uomOptions = getConst('UOM_OPTIONS');
const emptyLineForm = getConst('emptyLineForm');
assert.ok(uomOptions && emptyLineForm, 'Actual modal must retain its original form and UOM options');
const transpiled = ts.transpileModule([uomOptions, emptyLineForm, modal].map(n => n.getText(ast)).join('\n'), {
  fileName: srcPath,
  compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.React },
}).outputText;
const helperCode = ts.transpileModule(fs.readFileSync(path.join(root, 'src/lib/poUtilization.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const helperExports = {};
vm.runInNewContext(helperCode, { exports: helperExports });
assert.equal(typeof helperExports.isAreaUom, 'function');

const rows = [];
const recorded = [];
const refreshed = [];
let failNext = false;
const supabase = {
  from(table) {
    assert.equal(table, 'po_line_items');
    return {
      async insert(payload) {
        if (failNext) { failNext = false; return { error: new Error('Permission denied') }; }
        const newRow = { ...payload, id: `line-${rows.length + 1}`, work_types: null };
        rows.push(newRow); recorded.push({ operation: 'insert', payload });
        return { error: null };
      },
      update(payload) {
        return { async eq(column, id) {
          assert.equal(column, 'id');
          if (failNext) { failNext = false; return { error: new Error('Permission denied') }; }
          const i = rows.findIndex(row => row.id === id);
          assert.ok(i >= 0);
          rows[i] = { ...rows[i], ...payload };
          recorded.push({ operation: 'update', payload, id });
          return { error: null };
        } };
      },
      delete() {
        return { async eq(column, id) {
          assert.equal(column, 'id');
          if (failNext) { failNext = false; return { error: new Error('Permission denied') }; }
          const i = rows.findIndex(row => row.id === id);
          assert.ok(i >= 0);
          rows.splice(i, 1);
          recorded.push({ operation: 'delete', id });
          return { error: null };
        } };
      },
    };
  },
};

let states = [];
let index = 0;
let mutationIndex = 0;
function useState(initial) {
  const slot = index++;
  if (!(slot in states)) states[slot] = typeof initial === 'function' ? initial() : initial;
  return [states[slot], change => {
    states[slot] = typeof change === 'function' ? change(states[slot]) : change;
  }];
}
function useQuery({queryKey}) {
  if (queryKey[0] === 'po_line_items') return { data: rows };
  return { data: [] };
}
const mutations = [];
function useMutation(options) {
  const slot = mutationIndex++;
  const mutation = mutations[slot] || {
    isPending: false,
    isError: false,
    error: null,
    reset() { this.isError = false; this.error = null; },
  };
  mutation.mutate = async function(argument) {
    this.isPending = true;
    this.isError = false;
    this.error = null;
    try {
      await options.mutationFn(argument);
      options.onSuccess?.();
    } catch(error) {
      this.error = error;
      this.isError = true;
    } finally {
      this.isPending = false;
      options.onSettled?.();
    }
  };
  mutations[slot] = mutation;
  return mutation;
}
const React = { createElement(type, props, ...children) {
  return {type, props: { ...(props || {}), children }};
}};
const context = vm.createContext({
  React, supabase, useState, useQuery, useMutation,
  useAuth: () => ({ profile: { organization_id: 'org-1', role: 'agency_owner' } }),
  useQueryClient: () => ({ invalidateQueries({queryKey}) { refreshed.push(Array.from(queryKey).join('|')); } }),
  isAreaUom: helperExports.isAreaUom,
  defaultUtilizationStage: helperExports.defaultUtilizationStage,
  formatRupees: helperExports.formatRupees,
  Modal:'Modal', ConfirmDialog:'ConfirmDialog', Input:'Input', Select:'Select',
  PoStageProgressChart:'PoStageProgressChart', PoUtilizationTable:'PoUtilizationTable',
  Plus:'Plus', X:'X', Pencil:'Pencil', Trash2:'Trash2',
});
vm.runInContext(`${transpiled}\nthis.__renderModal = POLineItemsModal;`, context);
function render() {
  index=0;
  mutationIndex=0;
  return context.__renderModal({
    po: { id:'po-1', client_id:'client-1', po_number:'PO-1', name:'Demo', fulfillment_type:'survey_install' },
    onClose() {}, canDelete: true, utilization: [],
  });
}
function descendants(node, result = []) {
  if (node == null || typeof node === 'boolean') return result;
  if (Array.isArray(node)) { node.forEach(n => descendants(n, result)); return result; }
  if (typeof node !== 'object') return result;
  result.push(node);
  descendants(node.props?.children, result);
  return result;
}
function field(tree, name) {
  const node = descendants(tree).find(n => (n.type === 'Input' || n.type === 'Select') && n.props.label === name);
  assert.ok(node, `Expected form input ${name}`);
  return node;
}
function button(tree, label) {
  const node = descendants(tree).find(n => n.type === 'button' && descendants(n).some(x => (x.props?.children || []).some(c => typeof c === 'string' && c.includes(label))));
  assert.ok(node, `Expected ${label} button`);
  return node;
}
function set(name, value) { field(render(),name).props.onChange(value); }
function checksForRefresh() {
  const wanted = ['po_line_items|po-1','purchase_orders|org-1','po-utilization|org-1','po-execution-reconciliation|org-1','po-billing-items|org-1'];
  for (const key of wanted) assert.ok(refreshed.includes(key), `Missing invalidation of ${key}`);
  refreshed.length = 0;
}
function check(name, fn) {
  return Promise.resolve().then(fn).then(() => console.log('PASS',name));
}
async function fillAndSave(uom, amount, rate) {
  set('Description',`Test ${uom}`);
  set('UOM',uom);
  set(uom === 'sqft' ? 'Budgeted Area (sqft)' : 'Budgeted Qty',String(amount));
  set('Rate (₹)', String(rate));
  const tree=render();
  const save=button(tree,'Add Line Item');
  assert.equal(save.props.disabled,false,`save should be enabled for ${uom}`);
  await save.props.onClick();
  checksForRefresh();
  return recorded.at(-1).payload;
}
(async () => {
  await check('modal renders without isAreaUom2 runtime TypeError', () => {
    assert.ok(render());
    assert.ok(field(render(),'Budgeted Area (sqft)'));
  });
  await check('sqft creates area-only payload and resets form', async () => {
    const p=await fillAndSave('sqft', 25.5, 100);
    assert.equal(p.budgeted_area,25.5);
    assert.equal(p.budgeted_qty,null);
    assert.equal(p.rate,100);
    assert.equal(rows.length,1);
    assert.equal(field(render(),'Description').props.value,'');
  });
  await check('piece creates quantity-only payload; zero rate is valid', async () => {
    const p=await fillAndSave('piece',6,0);
    assert.equal(p.budgeted_qty,6);
    assert.equal(p.budgeted_area,null);
    assert.equal(p.rate,0);
  });
  await check('lot creates quantity-only payload', async () => {
    const p=await fillAndSave('lot',2,350);
    assert.equal(p.budgeted_qty,2);
    assert.equal(p.budgeted_area,null);
  });
  await check('switching UOM clears irrelevant budget and blocks incomplete form', () => {
    set('Description','Switch test');
    set('Budgeted Area (sqft)','15');
    set('Rate (₹)','150');
    set('UOM','piece');
    assert.equal(field(render(),'Budgeted Qty').props.value,'');
    assert.equal(button(render(),'Add Line Item').props.disabled,true);
    set('Budgeted Qty','5');
    assert.equal(button(render(),'Add Line Item').props.disabled,false);
  });
  await check('negative, zero and non-finite quantities and negative rates are rejected', () => {
    set('Budgeted Qty','-10');
    assert.equal(button(render(),'Add Line Item').props.disabled,true);
    set('Budgeted Qty','0');
    assert.equal(button(render(),'Add Line Item').props.disabled,true);
    set('Budgeted Qty','1e999');
    assert.equal(button(render(),'Add Line Item').props.disabled,true);
    set('Budgeted Qty','4');
    set('Rate (₹)','-5');
    assert.equal(button(render(),'Add Line Item').props.disabled,true);
  });
  await check('editing piece into sqft removes stale quantity', async () => {
    const editButton=descendants(render()).find(n => n.type === 'button' && n.props.className?.includes('hover:text-blue-600'));
    assert.ok(editButton);
    editButton.props.onClick();
    assert.equal(button(render(),'Update Line Item').props.disabled,false);
    set('UOM','sqft');
    set('Budgeted Area (sqft)','42');
    await button(render(),'Update Line Item').props.onClick();
    assert.equal(recorded.at(-1).operation,'update');
    assert.equal(recorded.at(-1).payload.budgeted_area,42);
    assert.equal(recorded.at(-1).payload.budgeted_qty,null);
    checksForRefresh();
  });
  await check('failed line-item insert leaves form intact and shows error', async () => {
    set('Description','Failure simulation');
    set('Budgeted Area (sqft)','5');
    set('Rate (₹)','100');
    failNext=true;
    await button(render(),'Add Line Item').props.onClick();
    assert.equal(field(render(),'Description').props.value,'Failure simulation');
    assert.ok(descendants(render()).some(n => (n.props?.children || []).some(c => c === 'Permission denied')));
    assert.equal(recorded.at(-1).operation,'update');
    assert.equal(rows.length,3);
  });
  await check('failed delete keeps the confirmation open and resyncs cached queries', async () => {
    const trash=descendants(render()).find(n=> n.type==='button' && n.props.className?.includes('hover:text-red-600'));
    assert.ok(trash);
    trash.props.onClick();
    failNext=true;
    const dialog=descendants(render()).find(n=>n.type==='ConfirmDialog');
    assert.equal(dialog?.props.open,true);
    await dialog.props.onConfirm();
    assert.equal(rows.length,3);
    checksForRefresh();
    assert.equal(descendants(render()).find(n=>n.type==='ConfirmDialog').props.open,true);
    assert.equal(descendants(render()).find(n=>n.type==='ConfirmDialog').props.error,'Permission denied');
  });
  await check('delete invalidates utilization, billing and Work Order totals', async () => {
    const trash=descendants(render()).find(n=> n.type==='button' && n.props.className?.includes('hover:text-red-600'));
    assert.ok(trash);
    trash.props.onClick();
    const dialog=descendants(render()).find(n=>n.type==='ConfirmDialog');
    assert.equal(dialog?.props.open,true);
    await dialog.props.onConfirm();
    assert.equal(recorded.at(-1).operation,'delete');
    checksForRefresh();
    assert.equal(rows.length,2);
  });
  console.log('PASS: 10 Work Order line-item runtime regression scenarios');
})().catch(error => { console.error(error); process.exitCode = 1; });
