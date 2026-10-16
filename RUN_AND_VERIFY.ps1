param(
  [string]$ProjectRoot = 'D:\DarshanAdField',
  [switch]$SkipBuild
)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path $ProjectRoot).Path
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Write-Host "Checking current main source without modifying it..." -ForegroundColor Cyan
& (Join-Path $scriptDir 'APPLY_MAIN.ps1') -ProjectRoot $root -VerifyOnly
if ($LASTEXITCODE -ne 0) { throw 'Preflight failed, nothing changed.' }
Write-Host "Applying five existing-screen changes (not replacing unrelated features)..." -ForegroundColor Cyan
& (Join-Path $scriptDir 'APPLY_MAIN.ps1') -ProjectRoot $root
if ($LASTEXITCODE -ne 0) { throw 'Application failed.' }
Push-Location $root
try {
  & node (Join-Path $scriptDir 'scripts\verify-applied.cjs') $root
  if ($LASTEXITCODE -ne 0) { throw 'Source verification failed' }
  & node (Join-Path $scriptDir 'scripts\verify-unified-progress.cjs') $root
  if ($LASTEXITCODE -ne 0) { throw 'Regression tests failed' }
  & git diff --check
  if ($LASTEXITCODE -ne 0) { throw 'Git whitespace check failed' }
  & git diff --stat
  if (-not $SkipBuild) {
    & npm run typecheck
    if ($LASTEXITCODE -ne 0) { throw 'Typecheck failed — do NOT commit/push' }
    & npm run build
    if ($LASTEXITCODE -ne 0) { throw 'Build failed — do NOT commit/push' }
  }
  Write-Host "Source verified. Next: browser QA, commit, push main, verify Vercel." -ForegroundColor Green
} finally { Pop-Location }
