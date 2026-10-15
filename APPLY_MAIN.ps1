param(
  [string]$ProjectRoot = 'D:\DarshanAdField',
  [string]$PatchRoot = $PSScriptRoot
)
$ErrorActionPreference = 'Stop'
$files = @(
 'src/App.tsx',
 'src/components/AdminLayout.tsx',
 'src/pages/PurchaseOrdersPage.tsx',
 'src/pages/SupplyOrdersPage.tsx'
)
$allowed = @{
 'src/App.tsx' = @('994435cfad2b67b4e69691485195d40b87b0cd28','dae666206aeb8c9dce0497a3076e5dda6d158911')
 'src/components/AdminLayout.tsx' = @('e52a7722978ca6186953d842611e3f49cc3fe672','8ef5ba124d9be1a1cbebdf28bbe93b613b352894')
 'src/pages/PurchaseOrdersPage.tsx' = @('3431406ddd701959028c8ea5be8f24031dbf7c67','7c27e031f7cc0a023e7fd8568a48d0378cc25b81')
 'src/pages/SupplyOrdersPage.tsx' = @('0a37687759c9d64460877425cabff1466bdccc15','9073ea2b0aed8fc1b04688a0dc034642273f690c')
}
if (!(Test-Path (Join-Path $ProjectRoot 'package.json'))) { throw 'Project root is incorrect.' }
Push-Location $ProjectRoot
try {
  $branch = (git branch --show-current).Trim()
  if ($LASTEXITCODE -ne 0 -or $branch -ne 'main') { throw "Run on existing main branch only (found: $branch)." }
  $dirty = git status --porcelain
  if ($LASTEXITCODE -ne 0 -or $dirty) { throw 'Working tree must be clean. Commit or safely back up edits first.' }
  foreach ($file in $files) {
    $source = Join-Path $PatchRoot ($file.Replace('/',[IO.Path]::DirectorySeparatorChar))
    if (!(Test-Path $source)) { throw "Patch incomplete: $file" }
    if (!(Test-Path $file)) { throw "Missing project source: $file" }
    $sha = (git rev-parse "HEAD:$file").Trim()
    if ($LASTEXITCODE -ne 0 -or $sha -notin $allowed[$file]) { throw "Different source version: $file ($sha). Refusing overwrite; merge into latest source." }
  }
  $backup = Join-Path (Join-Path $ProjectRoot '.git') ('adroute-workorders-backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
  foreach ($file in $files) {
    $original = Join-Path $ProjectRoot ($file.Replace('/',[IO.Path]::DirectorySeparatorChar))
    $b = Join-Path $backup ($file.Replace('/',[IO.Path]::DirectorySeparatorChar))
    New-Item -ItemType Directory -Path (Split-Path $b -Parent) -Force | Out-Null
    Copy-Item -LiteralPath $original -Destination $b -Force
  }
  foreach ($file in $files) {
    $source = Join-Path $PatchRoot ($file.Replace('/',[IO.Path]::DirectorySeparatorChar))
    $destination = Join-Path $ProjectRoot ($file.Replace('/',[IO.Path]::DirectorySeparatorChar))
    Copy-Item -LiteralPath $source -Destination $destination -Force
  }
  Write-Host "Applied 4 files to main. Backups: $backup"
  git diff --check
  if ($LASTEXITCODE -ne 0) { throw 'Git whitespace check failed: review diff before committing.' }
  git diff --stat
} finally { Pop-Location }
