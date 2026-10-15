param(
  [Parameter(Mandatory=$true)][string]$ProjectRoot,
  [Parameter(Mandatory=$true)][string]$ExtractedPatchRoot
)
$ErrorActionPreference = 'Stop'
$ProjectRoot = (Resolve-Path $ProjectRoot).Path
$ExtractedPatchRoot = (Resolve-Path $ExtractedPatchRoot).Path
$target = Join-Path $ProjectRoot 'src/pages/InstallerPage.tsx'
$source = Join-Path $ExtractedPatchRoot 'src/pages/InstallerPage.tsx'
if (!(Test-Path (Join-Path $ProjectRoot 'package.json'))) { throw 'Not an AdRoute project root.' }
if (!(Test-Path $target) -or !(Test-Path $source)) { throw 'InstallerPage source missing.' }
Push-Location $ProjectRoot
try {
  $gitStatus = (git status --porcelain)
  if ($LASTEXITCODE -ne 0) { throw 'Git working tree unavailable.' }
  if ($gitStatus) { throw 'Git working tree contains changes. Save/commit/stash them before patching.' }
  $expectedSha = '9c909d560cecf8e724533e8288aefe048809e1fc9a457362e0d79e0aac259cd5'
  $actual = (Get-FileHash $target -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $expectedSha) { throw "InstallerPage version differs (SHA256 $actual). Do not overwrite newer/custom code; merge this fix manually." }
  $backupDir = Join-Path $env:TEMP ('adroute-installer-backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
  New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
  Copy-Item $target (Join-Path $backupDir 'InstallerPage.tsx')
  Copy-Item $source $target -Force
  Write-Host "Source patched. Backup: $backupDir" -ForegroundColor Green
  git diff --check
  if ($LASTEXITCODE -ne 0) { throw 'git diff check failed' }
} finally { Pop-Location }
