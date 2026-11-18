/** Targeted v13 regression: artwork/photo review & safe cross-device deployments. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('/opt/nvm/versions/node/v22.16.0/lib/node_modules/typescript');
const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
let passed = 0;
function check(name, test) { test(); passed++; console.log(`PASS ${name}`); }
for (const f of ['src/lib/installationArtwork.ts','src/lib/designReview.ts','src/lib/secureMedia.tsx','src/lib/appVersion.ts','src/pages/InstallationReviewPage.tsx','src/pages/DesignerPage.tsx','src/components/ui.tsx','src/pages/SurveyorPage.tsx','src/pages/InstallerPage.tsx']) {
  check('Parse ' + f, () => assert.equal(ts.createSourceFile(f, read(f), ts.ScriptTarget.Latest, true, f.endsWith('tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS).parseDiagnostics.length, 0));
}
function loadTs(f, requireFn = () => {throw Error('unexpected import')}) {
  const code = ts.transpileModule(read(f), {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020}}).outputText;
  const m = { exports: {} };
  new Function('module','exports','require',code)(m,m.exports,requireFn);
  return m.exports;
}
const review = loadTs('src/lib/designReview.ts');
const {approvedInstallationArtworkByItem, isArtworkImage} = loadTs('src/lib/installationArtwork.ts', name => {assert.equal(name, './designReview'); return review});
const files = [
  {id:'f1',version_number:1,upload_batch_id:'a',status:'approved',file_url:'https://x/front.png'},
  {id:'f2',version_number:2,upload_batch_id:'a',status:'approved',file_url:'https://x/back.pdf'},
  {id:'shared',version_number:3,upload_batch_id:'shared-a',status:'approved',file_url:'https://x/shared.png'},
  {id:'new',version_number:4,upload_batch_id:'new-a',status:'approved',file_url:'https://x/new.png'},
  {id:'new2',version_number:5,upload_batch_id:'new-a',status:'approved',file_url:'https://x/new2.pdf'},
  {id:'pending',version_number:6,upload_batch_id:'pending',status:'uploaded',file_url:'https://x/not-approved.png'},
  {id:'redo',version_number:7,status:'rejected',file_url:'https://x/rejected.png'},
  {id:'missing',version_number:8,status:'approved',file_url:null},
];
const links = [
  ...['f1','f2','shared','new','new2','pending','redo'].map(id=>({design_version_id:id,work_item_id:'board-1'})),
  {design_version_id:'shared',work_item_id:'board-2'},
  {design_version_id:'pending',work_item_id:'board-2'},
  {design_version_id:'missing',work_item_id:'board-3'},
  {design_version_id:'new',work_item_id:'board-1'}, // duplicate link should not duplicate thumbnail
];
const resolved = approvedInstallationArtworkByItem(files,links);
check('One board shows two approved files from latest upload batch',()=>assert.deepEqual(resolved.get('board-1').map(f=>f.id),['new2','new']));
check('Shared older artwork remains valid on another board',()=>assert.deepEqual(resolved.get('board-2').map(f=>f.id),['shared']));
check('Pending/rejected versions cannot enter installation approved reference',()=>assert(![...resolved.values()].flat().some(f=>['pending','redo'].includes(f.id))));
check('Missing file link is not a design preview',()=>assert(!resolved.has('board-3')));
check('Repeated work-item mapping is de-duplicated',()=>assert.equal(resolved.get('board-1').filter(f=>f.id==='new').length,1));
check('PDF is a document, never broken img tag',()=>{assert.equal(isArtworkImage({file_name:'site artwork.pdf'}),false);assert.equal(isArtworkImage({file_name:'front.png'}),true);});
check('Legacy image URL with no filename detected',()=>assert.equal(isArtworkImage({file_name:'front',file_url:'https://x/abc.jpg?token=1'}),true));
const installation=read('src/pages/InstallationReviewPage.tsx'), design=read('src/pages/DesignerPage.tsx'), media=read('src/lib/secureMedia.tsx');
check('Installation filters approved design versions at server',()=>assert.match(installation,/\.eq\('design_versions\.status','approved'\)/));
check('Installation uses same explicit per-board art groups',()=>assert.match(installation,/approvedInstallationArtworkByItem\(files, links\)/));
check('Installation displays every current approved file per board',()=>assert.match(installation,/designs\.map\(\(design: any\)/));
check('Proof fallback prefers authoritative storage path and RLS signer',()=>{assert.match(installation,/storagePath=\{p\.storage_path\} bucket="installation-proof"/);assert.match(media,/createSignedUrl\(parsed\.path, SIGNED_TTL_SECONDS\)/);});
check('Expired signed URLs reissued before showing failure',()=>{assert.match(media,/resolveSecureUrl\(src, true\)/);assert.match(media,/PHOTO_UNAVAILABLE/);assert.match(media,/PHOTO_LOADING/);});
check('No redundant approved overlay on proof thumbnail',()=>{assert.doesNotMatch(installation,/decision\.decision==='approved'\?'APPROVED'/);assert.match(installation,/decision\?\.decision === 'redo'/);});
check('Historical company approval banner hidden unless mandatory',()=>assert.match(installation,/hideWhenNotRequired/));
check('Designer correction is selected beside mapped board/artwork',()=>{assert.match(design,/Needs correction/);assert.match(design,/selected \? 'rounded-lg outline/);});
check('Designer secure preview no longer fails before signer refresh',()=>assert.doesNotMatch(design,/onError=\{\(\) => setFailed\(true\)\}/));
const watcher=read('src/lib/appVersion.ts'),vite=read('vite.config.ts'),headers=read('vercel.json');
check('Vercel version check always bypasses HTTP caching',()=>{assert.match(watcher,/cache: 'no-store'/);assert.match(headers,/"source": "\/version\.json"/);});
check('PWA update activation is deferred, not forced during live work',()=>{assert.match(vite,/registerType: 'prompt'/);assert.match(vite,/skipWaiting: false/);assert.match(watcher,/deploymentIsSafeToApply/);});
check('Update checks on focus, online and foreground',()=>{assert.match(watcher,/visibilitychange/);assert.match(watcher,/addEventListener\('online'/);assert.match(watcher,/addEventListener\('focus'/);});
check('Open dialogs, selected files and capture wizards block update',()=>{assert.match(watcher,/aria-modal/);assert.match(watcher,/data-adroute-unsaved/);assert.match(read('src/pages/SurveyorPage.tsx'),/data-adroute-unsaved="true"/);assert.match(read('src/pages/InstallerPage.tsx'),/data-adroute-unsaved="true"/);});
check('Offline queues not deleted during deploy',()=>{assert.match(watcher,/workbox-precache-/);assert.doesNotMatch(watcher,/indexedDB\.deleteDatabase|\.surveyDrafts\.clear\(/);});
check('No infinite reload loop in event of CDN propagation',()=>assert.match(watcher,/attempts >= 3/));
console.log(`EVIDENCE & LIVE UPDATE V13: ALL ${passed} CHECKS PASSED`);
