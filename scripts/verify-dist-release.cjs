/** Run after `npm run build`: catches accidental deployment of stale/old dist assets. */
const fs = require('node:fs'); const path = require('node:path'); const assert=require('node:assert/strict');
const dist=path.resolve(__dirname,'../dist');
assert.ok(fs.existsSync(path.join(dist,'index.html')), 'dist/index.html missing. First run npm run build.');
const actual=JSON.parse(fs.readFileSync(path.join(dist,'version.json'),'utf8'));
const expected=fs.readFileSync(path.join(__dirname,'../src/lib/release.ts'),'utf8').match(/APP_RELEASE\s*=\s*'([^']+)'/)?.[1];
assert.equal(actual.release,expected, 'dist is from an old release: do a CLEAN build');
assert.deepEqual(actual.features,{directWorkOrders:true,campaignsModule:false}, 'dist does not declare correct features');
const js=[]; const search=p=>{for(const entry of fs.readdirSync(p,{withFileTypes:true})){const target=path.join(p,entry.name);if(entry.isDirectory())search(target);else if(/\.js$/.test(entry.name)) js.push(target);}};search(dist);
assert.ok(js.length>0,'No generated JS in dist');
let hasReleaseMarker=false;
for(const file of js){const content=fs.readFileSync(file,'utf8');
  assert.ok(!content.includes('Your own campaigns, plus every client campaign'),`Stale Campaigns page found in ${file}`);
  assert.ok(!content.includes('Add Campaign'),`Stale Campaigns button found in ${file}`);
  if(content.includes(`Work Orders · v`) && content.includes(expected)) hasReleaseMarker=true;
}
assert.ok(hasReleaseMarker,'Compiled app is missing the Work Orders release marker.');
console.log(`PASS: dist contains release ${expected}, no old Campaigns screen. Generated JS files: ${js.length}`);
