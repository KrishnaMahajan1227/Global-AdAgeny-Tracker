param(
  [Parameter(Mandatory=$true)][string]$ProjectRoot,
  [switch]$VerifyOnly
)
$ErrorActionPreference = 'Stop'
$ProjectRoot = (Resolve-Path $ProjectRoot).Path
$patchRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not (Test-Path (Join-Path $ProjectRoot 'package.json'))) {
  throw 'ProjectRoot must be the existing DarshanAdField project directory.'
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js is required.' }
$code = Join-Path $patchRoot 'scripts\apply-main.cjs'
if ($VerifyOnly) {
  & node $code $ProjectRoot --verify
} else {
  & node $code $ProjectRoot
}
if ($LASTEXITCODE -ne 0) { throw "Safe patch failed. Existing files should remain unchanged. Exit: $LASTEXITCODE" }
if (-not $VerifyOnly) {
  & node (Join-Path $patchRoot 'scripts\verify-applied.cjs') $ProjectRoot
  if ($LASTEXITCODE -ne 0) { throw 'Post-install source verification failed. Do not push.' }
}
Write-Host 'No SQL or live database mutation has been performed.' -ForegroundColor Cyan
