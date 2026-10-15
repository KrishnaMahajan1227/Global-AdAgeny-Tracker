// Pure unit-conversion regression checks. Does not connect to Supabase.
import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import assert from 'node:assert/strict';

const code = readFileSync(new URL('../src/lib/units.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } });
const unitExports = {};
runInNewContext(compiled.outputText, { exports: unitExports, Math, Number, String, Object });
const { toFeet, areaSqFt, formatDim, trimNum, itemSizeLabel } = unitExports;
const close = (actual, expected, error = 1e-5) => assert.ok(Math.abs(actual - expected) <= error, `${actual} != ${expected}`);
let tests = 0;
function test(label, run) { run(); tests++; console.log(`PASS ${label}`); }
test('12 inches = 1 ft', () => close(toFeet(12, 'in'), 1));
test('1 meter in feet', () => close(toFeet(1, 'm'), 3.280839895));
test('100 centimeters in feet', () => close(toFeet(100, 'cm'), 3.280839895));
test('10 ft x 6 in = 5 sq.ft', () => close(areaSqFt(10, 'ft', 6, 'in'), 5));
test('2.5 ft x 12 in = 2.5 sq.ft', () => close(areaSqFt(2.5, 'ft', 12, 'in'), 2.5));
test('1 m x 100 cm = 10.7639 sq.ft', () => close(areaSqFt(1, 'm', 100, 'cm'), 10.7639));
test('multiply per-board area by quantity only once', () => close(areaSqFt(10, 'ft', 6, 'in') * 3, 15));
test('precise input 4.5 must not display as 5', () => assert.equal(formatDim('4.5'), 4.5));
test('4 decimal input precision', () => assert.equal(trimNum(4.1234), '4.1234'));
test('empty measurement remains null', () => assert.equal(formatDim(''), null));
test('entered inch/feet units are preserved in item label', () => {
  const item = { survey_width: toFeet(12, 'in'), survey_height: toFeet(6, 'ft'), entered_width:12, entered_height:6, entered_width_unit:'in', entered_height_unit:'ft' };
  assert.equal(itemSizeLabel(item, 'survey'), '12 in × 6 ft');
});
test('entered ft values remain displayed in ft', () => {
  const item = { approved_width:10, approved_height:6, entered_width:10, entered_height:6, entered_width_unit:'ft', entered_height_unit:'ft' };
  assert.equal(itemSizeLabel(item), '10 × 6 ft');
});
console.log(`${tests} calculation regression checks passed.`);
