#!/usr/bin/env node
'use strict';
/** Canonical survey/installation review action wiring regression. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

const galleryText = fs.readFileSync('src/components/SurveyReviewGallery.tsx', 'utf8');
const reviewText = fs.readFileSync('src/lib/reviewApi.ts', 'utf8');
const dbText = fs.readFileSync('supabase/migrations/20261023090000_0090_final_review_redo_availability.sql', 'utf8');
let checks = 0;
function check(label, condition) {
  assert.ok(condition, label);
  console.log('PASS', label); checks++;
}
const source = ts.createSourceFile('SurveyReviewGallery.tsx', galleryText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let confirmType = '', confirmationCall = null, submitType = '', decisions = [];
function walk(node) {
  if (ts.isVariableDeclaration(node) && ts.isArrayBindingPattern(node.name) && node.name.elements.some(el => el.name.getText(source) === 'setConfirm')) {
    confirmType = node.initializer?.typeArguments?.[0]?.getText(source) || '';
  }
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'submit') submitType = node.parameters[0]?.type?.getText(source) || '';
  if (ts.isCallExpression(node) && node.expression.getText(source) === 'setConfirm') {
    decisions.push(node.arguments[0]?.getText(source));
  }
  if (ts.isCallExpression(node) && node.expression.getText(source) === 'submit') confirmationCall = node.arguments[0]?.getText(source);
  ts.forEachChild(node, walk);
}
walk(source);
check('Confirm state uses only backend-approved/redo values', confirmType === "'approved' | 'redo' | null");
check('Survey approval button queues approved (not approve)', decisions.includes("'approved'") && !decisions.includes("'approve'"));
check('Redo button still queues redo', decisions.includes("'redo'"));
check('Submission function accepts same canonical decision union', submitType === "'approved' | 'redo'");
check('Confirmation forwards selected action without lossy mapping', confirmationCall === 'confirm');
check('Approval awaits existing server-validated reviewApply', galleryText.includes("await reviewApply({ stage: 'survey'") && galleryText.includes('entities: targets, decision'));
check('Client RPC guards against unsupported actions', reviewText.includes("!['approved', 'redo'].includes(args.decision)"));
check('Database also accepts canonical actions', dbText.includes("p_decision NOT IN ('approved','redo')"));
check('Installation review retains canonical decisions', fs.readFileSync('src/pages/InstallationReviewPage.tsx','utf8').includes("decision: 'approved'"));

// Exercise the actual TypeScript request wrapper without network access.
const calls = [];
const rpcModule = ts.transpileModule(reviewText, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const moduleExports = {};
const context = {
  exports: moduleExports,
  require: (id) => {
    if (id === '@/lib/supabase') return { supabase: { rpc: async (fn, params) => {
      calls.push({ fn, params });
      return { data: { finalized: false, pending: 1, redo: 0, open_corrections: 0 }, error: null };
    } } };
    throw new Error('Unexpected import: ' + id);
  },
};
vm.runInNewContext(rpcModule, context, { filename:'reviewApi.transpiled.cjs' });
(async () => {
  const payload = { stage:'survey', shopId:'shop-1', refId:'survey-1', decision:'approved', entities:[{type:'measurement',id:'item-1'}], designerId:'designer-1' };
  await moduleExports.reviewApply(payload);
  check('Approval RPC sends approved and exact measurement', calls[0].fn === 'review_apply' && calls[0].params.p_decision === 'approved' && calls[0].params.p_entities[0].id === 'item-1');
  await moduleExports.reviewApply({ stage:'survey', shopId:'shop-1', refId:'survey-1', decision:'redo', note:'Needs correction' });
  check('Redo RPC sends redo with correction note', calls[1].params.p_decision === 'redo' && calls[1].params.p_note === 'Needs correction');
  await moduleExports.reviewApply({ stage:'installation', shopId:'shop-1', refId:'job-1', decision:'approved' });
  check('Installation RPC keeps approved decision', calls[2].params.p_stage === 'installation' && calls[2].params.p_decision === 'approved');
  const count = calls.length;
  await assert.rejects(() => moduleExports.reviewApply({ ...payload, decision:'approve' }), /Unsupported review decision/);
  check('Old invalid approve alias rejected locally without DB call', calls.length === count);
  await assert.rejects(() => moduleExports.reviewApply({ ...payload, stage:'other' }), /Unsupported review decision/);
  check('Unknown review stage rejected without DB call', calls.length === count);
  console.log(`All ${checks} review action contract checks passed.`);
})().catch(err => { console.error(err); process.exitCode = 1; });
