const fs=require('fs');const path=require('path');const assert=require('assert');const projectRoot=path.resolve(process.argv[2] || path.join(__dirname,'..'));
const ts= require(path.join(projectRoot,'node_modules','typescript'));
const root=path.resolve(process.argv[2]||path.join(__dirname,'..'));
for(const p of ['src/lib/workCompletion.ts','src/lib/poBilling.ts','src/pages/BillingPage.tsx','src/pages/WorkProgressPage.tsx']){
 const full=path.join(root,p);const source=fs.readFileSync(full,'utf8');
 const f=ts.createSourceFile(p,source,ts.ScriptTarget.Latest,true,p.endsWith('tsx')?ts.ScriptKind.TSX:ts.ScriptKind.TS);
 assert.equal(f.parseDiagnostics.length,0,p+' syntax error');
}
const tsSrc=fs.readFileSync(path.join(root,'src/lib/workCompletion.ts'),'utf8');
const js=ts.transpileModule(tsSrc,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
const mod={exports:{}};new Function('exports','module',js)(mod.exports,mod);
const {isShopFinished,getShopCompletion}=mod.exports;
const cases=[['survey_install','installed',true],['survey_install','installation_pending',false],['survey_install','installation_review',false],['direct_install','installed',true],['direct_install','dispatched',false],['supply_only','dispatched',true],['supply_only','installed',false],['survey_install','surveyed',false],['survey_install','billed',true]];
for(const [type,status,expected] of cases)assert.equal(isShopFinished(type,status),expected,`${type}/${status}`);
assert.deepEqual(getShopCompletion([{status:'installed'},{status:'installation_pending'},{status:'billed'},{status:'cancelled'}],'survey_install'),{total:3,completed:2,pending:1,percentage:67});
assert.equal(getShopCompletion([],'survey_install').percentage,0);
assert.equal(getShopCompletion([{status:'dispatched'},{status:'installed'}],'supply_only').completed,1);
console.log('PASS: 12 real-stage completion and zero-denominator checks; 4 TS/TSX syntax parses');
