import fs from 'node:fs';
import assert from 'node:assert/strict';
import ts from 'typescript';

const sourcePath = 'src/pages/InstallerPage.tsx';
const code = fs.readFileSync(sourcePath, 'utf8');
const file = ts.createSourceFile(sourcePath, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
assert.equal(file.parseDiagnostics.length, 0, file.parseDiagnostics.map(d => ts.flattenDiagnosticMessageText(d.messageText, ' ')).join('\n'));
assert.match(code, /const online = useOnlineStatus\(\)/, 'Must define network state inside InstallationWizard');
assert.doesNotMatch(code, /\b(?:isOnline|online2)\b/, 'Undefined/out-of-order network state reference remains');
assert.match(code, /if \(!profile\?\.id \|\| !online\) return;/, 'Photo sync should use declared network state');
assert.match(code, /window\.addEventListener\('online', onReconnect\)/, 'Reconnect handler missing');
assert.match(code, /queryKey: \['installer-ready-job-queue', profile\?\.id\]/, 'Job queue must not overwrite list cache');
assert.match(code, /if \(corrections\.error\) throw/, 'Entry must fail closed on correction read errors');
assert.match(code, /if \(baseError\) throw/, 'Correction list errors must not be mistaken for no corrections');
assert.match(code, /if \(!base\?\.length\) return \[\]/, 'Normal installations must not depend on optional redo column');
assert.match(code, /if \(savedError\) throw/, 'Redo must require server acknowledgement');
assert.match(code, /if \(correctionsLoading \|\| correctionsFailed \|\| \(correctionTasks \|\| \[\]\)\.length > 0\) return;/, 'Do not create duplicate jobs during pending redo check');
console.log('Installer runtime regression checks: 10 passed.');
