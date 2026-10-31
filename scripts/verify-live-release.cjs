/** No credentials, database writes, or cookies. Verify the public, currently deployed release. */
const { readFileSync } = require('node:fs');
const path = require('node:path');
const releaseSource = readFileSync(path.join(__dirname, '../src/lib/release.ts'), 'utf8');
const expected = releaseSource.match(/APP_RELEASE\s*=\s*'([^']+)'/)?.[1];
if (!expected) throw new Error('No version tag in src/lib/release.ts');
const input = process.argv[2];
if (!input) {
  console.error('Usage: node scripts/verify-live-release.cjs https://your-deployed-domain.com');
  process.exit(2);
}
let url;
try { url = new URL(input); } catch { console.error('Not a valid deployment URL.'); process.exit(2); }
if (!['https:', 'http:'].includes(url.protocol) || (url.protocol === 'http:' && !['localhost','127.0.0.1'].includes(url.hostname))) {
  console.error('HTTPS required for public deployments.'); process.exit(2);
}
(async () => {
  const statusUrl = new URL('/version.json',url);
  const response = await fetch(statusUrl, { cache:'no-store', redirect:'error', headers: {'Cache-Control':'no-cache'}, signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`GET ${statusUrl} returned HTTP ${response.status}`);
  const text = await response.text();
  let result; try { result = JSON.parse(text); } catch { throw new Error('version.json did not return valid JSON. Your server may be serving an old SPA fallback.'); }
  const actual = result.release || '(not provided by deployed build)';
  console.log(`Expected release: ${expected}\nDeployed release: ${actual}\nBuild: ${result.buildId || 'unknown'}`);
  if (actual !== expected || result.features?.directWorkOrders !== true || result.features?.campaignsModule !== false) {
    console.error('FAIL: Your live URL is NOT serving this updated Work Orders release. Redeploy the new ZIP with a fresh production build.');
    process.exitCode=1; return;
  }
  console.log('PASS: The public deployment reports the expected Work Orders-only release. Sign in to visually verify navigation using a test account.');
})().catch(err => { console.error('Deployment could not be verified:',err.message); process.exitCode=1; });
