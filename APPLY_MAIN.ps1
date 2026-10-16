[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$ProjectRoot, [string]$PatchRoot=$PSScriptRoot)
$ErrorActionPreference='Stop'
Set-Location $ProjectRoot
if (!(Test-Path 'package.json') -or !(Test-Path '.git')) { throw 'Not the AdRoute Git project root.' }
if ((git branch --show-current).Trim() -ne 'main') { throw 'Switch to existing main first. Nothing changed.' }
if (git status --porcelain) { throw 'Commit or safely stash existing changes before applying. Nothing changed.' }
$expectedBilling='7257bf47cda1c3907900bec3f9f909d1147cda448a63e4d178b9c108058f5335'
$expectedHelper='13e0669f73e34ca031ef23fb0dbf7cb924abcec79502041a49d30804c2c75cd3'
$versions=@{
  'src/pages/BillingPage.tsx'=$expectedBilling
  'src/lib/poBilling.ts'=$expectedHelper
}
foreach($file in $versions.Keys) {
  if (!(Test-Path $file)) { throw "Previous completed-work Billing patch is required: $file. Nothing changed." }
  $actual=(Get-FileHash $file -Algorithm SHA256).Hash.ToLowerInvariant()
  if($actual -ne $versions[$file]) { throw "Source version differs: $file. Newer changes must be merged; no overwrite performed." }
}
$backup=Join-Path $ProjectRoot ('.git\billing-safe-backup-'+(Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Force -Path $backup | Out-Null
foreach($file in $versions.Keys) {
  $out=Join-Path $backup $file
  New-Item -ItemType Directory -Force -Path (Split-Path $out -Parent) | Out-Null
  Copy-Item $file $out
}
$paths=@(
 'src/pages/BillingPage.tsx', 'src/lib/poBilling.ts',
 'scripts/verify-po-billing-final.mjs', 'scripts/verify-billing-safe-ui.mjs',
 'supabase/migrations/20261026110000_0096_invoice_archive_delete_rpc.sql',
 'supabase/manual/PREVIEW_OLD_BILLING.sql',
 'supabase/manual/ARCHIVE_AND_CLEAR_OLD_BILLING.sql',
 'RESET_OLD_BILLING.ps1', 'README.md', 'CHANGES.md', 'QA_CHECKLIST.md'
)
foreach($file in $paths) {
  $source=Join-Path $PatchRoot $file
  if (!(Test-Path $source)) { throw "Patch missing file: $file" }
  $destination=Join-Path $ProjectRoot $file
  New-Item -ItemType Directory -Force -Path (Split-Path $destination -Parent) | Out-Null
  Copy-Item -LiteralPath $source -Destination $destination -Force
}
Write-Host "Billing-only patch applied; backup: $backup" -ForegroundColor Green
Write-Host 'Next: run regression tests, typecheck and build. Apply the RPC SQL separately after staging QA.'
