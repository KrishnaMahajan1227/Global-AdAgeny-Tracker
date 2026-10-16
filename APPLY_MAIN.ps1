param(
  [Parameter(Mandatory=$true)][string]$ProjectRoot,
  [Parameter(Mandatory=$true)][string]$PatchRoot
)
$ErrorActionPreference = 'Stop'
$ProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
$PatchRoot = (Resolve-Path -LiteralPath $PatchRoot).Path
if (!(Test-Path (Join-Path $ProjectRoot 'package.json'))) { throw 'Not an AdRoute project root.' }
Push-Location $ProjectRoot
try {
  $branch = (git branch --show-current).Trim()
  if ($LASTEXITCODE -ne 0 -or $branch -ne 'main') { throw "Expected main branch, found '$branch'." }
  $dirty = git status --porcelain
  if ($LASTEXITCODE -ne 0 -or $dirty) { throw 'Working tree is not clean. Commit/stash changes before applying this patch.' }
  $expected = @{
    'src/pages/BillingPage.tsx' = '5f63d5ff03ac008518fa5882cc032a719961e1b9bcdfc3b10a7e8ec46fa9d5ce'
    'src/lib/poBilling.ts' = '28994175d4dad358e815772813354fdf76e4efb1eacc93f4c678b9f84d1ec9ca'
  }
  foreach ($entry in $expected.GetEnumerator()) {
    $path = Join-Path $ProjectRoot $entry.Key
    if (!(Test-Path -LiteralPath $path)) { throw "Missing $($entry.Key). Apply prior PO Billing patch first." }
    $hash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($hash -ne $entry.Value) { throw "Version mismatch: $($entry.Key). No files changed. Merge manually against the latest main code." }
  }
  $backup = Join-Path $ProjectRoot ('.git\adroute-backups\billing-final-' + (Get-Date -Format 'yyyyMMddHHmmss'))
  foreach ($entry in $expected.GetEnumerator()) {
    $path = Join-Path $ProjectRoot $entry.Key
    $dst = Join-Path $backup $entry.Key
    New-Item -ItemType Directory -Path (Split-Path -Parent $dst) -Force | Out-Null
    Copy-Item -LiteralPath $path -Destination $dst -Force
  }
  $files = @(
    'src/pages/BillingPage.tsx',
    'src/lib/poBilling.ts',
    'scripts/verify-po-billing-final.mjs',
    'supabase/manual/BILLING_RESET_PREVIEW_READ_ONLY.sql',
    'supabase/manual/ARCHIVE_AND_CLEAR_OLD_BILLING.sql',
    'supabase/manual/BACKFILL_FINAL_STAGE_RECONCILIATION_READ_ONLY.sql',
    'BILLING_FINAL_README.md',
    'CHANGES.md',
    'QA_CHECKLIST.md'
  )
  foreach ($item in $files) {
    $source = Join-Path $PatchRoot $item
    if (!(Test-Path -LiteralPath $source)) { throw "Patch file missing: $item" }
    $target = Join-Path $ProjectRoot $item
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
    Copy-Item -LiteralPath $source -Destination $target -Force
  }
  Write-Host "Patch applied to main. Backup: $backup"
  Write-Host 'No SQL was executed. Run tests before committing.'
} finally { Pop-Location }
