param(
  [Parameter(Mandatory=$true)][string]$ProjectRoot,
  [string]$PatchRoot = $PSScriptRoot
)
$ErrorActionPreference = 'Stop'
if (!(Test-Path (Join-Path $ProjectRoot 'package.json'))) { throw 'ProjectRoot must contain package.json.' }
if (!(Test-Path (Join-Path $ProjectRoot '.git'))) { throw 'Expected existing Git project.' }
Push-Location $ProjectRoot
try {
  $branch = (git branch --show-current).Trim()
  if ($branch -ne 'main') { throw "Expected main branch, found: $branch" }
  if (git status --porcelain) { throw 'Working tree not clean; commit/save existing edits first.' }
  $baseline = (git rev-parse 'HEAD:src/pages/BillingPage.tsx').Trim()
  $allowed = @('26a7ae2404061dd8bba1b969371fde5ea9fd73a2','cb12cb7142ad4d3d08631390155c671f2d8deea9')
  if ($allowed -notcontains $baseline) {
    throw "Unexpected BillingPage version ($baseline). Stop; merge against latest main rather than overwriting."
  }
  $files = @('src/pages/BillingPage.tsx','src/lib/poBilling.ts','scripts/verify-po-billing.mjs','BILLING_PO_UPDATE_README.md','BILLING_RECORDS_AUDIT.sql')
  $backupRoot = Join-Path $ProjectRoot ('.git/adroute-billing-backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
  New-Item -Force -ItemType Directory -Path $backupRoot | Out-Null
  foreach ($file in $files) {
    $src = Join-Path $PatchRoot $file
    $dst = Join-Path $ProjectRoot $file
    if (!(Test-Path $src)) { throw "Missing patch source: $file" }
    if (Test-Path $dst) {
      $backup = Join-Path $backupRoot $file
      New-Item -ItemType Directory -Path (Split-Path $backup -Parent) -Force | Out-Null
      Copy-Item $dst $backup -Force
    }
    New-Item -ItemType Directory -Path (Split-Path $dst -Parent) -Force | Out-Null
    Copy-Item $src $dst -Force
  }
  Write-Host 'Billing patch installed on main. Backup:' $backupRoot
  Write-Host 'Run regression checks, typecheck, lint, build and staging invoice QA BEFORE pushing.'
} finally {
  Pop-Location
}
