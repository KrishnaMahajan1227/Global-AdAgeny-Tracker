param([string]$ProjectRoot='D:\DarshanAdField',[switch]$SkipProgressPatch)
$ErrorActionPreference='Stop'
$patchRoot=Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not (Test-Path (Join-Path $ProjectRoot 'package.json'))) { throw 'Invalid project root' }
Push-Location $ProjectRoot
try {
 if ((git branch --show-current).Trim() -ne 'main') {throw 'Switch to main before applying'}
 if ((git status --porcelain).Length -ne 0) {throw 'Uncommitted changes. Commit or backup before applying.'}
 $backupBranch = 'backup/before-progress-typefix-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
 git branch $backupBranch | Out-Null
 Write-Host "Created local backup branch: $backupBranch"
 if (-not $SkipProgressPatch) {
   Write-Host 'Applying audited progression patch. Source version guard may refuse mismatched files.'
   & (Join-Path $patchRoot 'APPLY_MAIN.ps1') -ProjectRoot $ProjectRoot
   if ($LASTEXITCODE -ne 0) { throw 'Progress patch failed' }
 }
 $py=Get-Command python -ErrorAction SilentlyContinue
 if (-not $py) { throw 'Python 3 is required for targeted type fixes' }
 & python (Join-Path $patchRoot 'scripts\fix-typecheck.py') $ProjectRoot
 if ($LASTEXITCODE -ne 0) {throw 'Type fixes failed'}
 npm run typecheck
 if ($LASTEXITCODE -ne 0) {throw 'Typecheck failed. Do not deploy.'}
 npm run lint --if-present
 if ($LASTEXITCODE -ne 0) {throw 'Lint failed. Do not deploy.'}
 npm run build
 if ($LASTEXITCODE -ne 0) {throw 'Build failed. Do not deploy.'}
 Write-Host 'Local typecheck, lint and build passed. Run browser validation before commit.'
} finally {Pop-Location}
