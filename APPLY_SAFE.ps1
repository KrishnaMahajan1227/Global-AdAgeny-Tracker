param([Parameter(Mandatory=$true)][string]$ProjectRoot)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath $ProjectRoot).Path
if (!(Test-Path -LiteralPath (Join-Path $root 'package.json'))) { throw 'Not a project root: package.json missing' }
if (!(Test-Path -LiteralPath (Join-Path $PSScriptRoot 'PATCH_FILES.txt'))) { throw 'PATCH_FILES.txt not found beside this script' }
$expected = @{
    "src/pages/SurveyorPage.tsx" = "572b845cfbd4a01d93233e73daf763254a2dcc51ea664598d795d4417accb2c4"
    "src/pages/InstallerPage.tsx" = "d781f0f5ca05493d7556c375f3a9ebb82d31c5b0f97414faa2714c40ceb8d7e6"
    "src/components/SurveyCorrectionFixer.tsx" = "defbc59c6882b08873a48a30c686cb2d9a8de2c38f72235be171b8c42d62dc53"
    "src/components/CameraCapture.tsx" = "5155f4e50c6f0f89a34d2c54cd5c7c8a729365eda5198efdc8fae3cbfb592b87"
    "src/lib/units.ts" = "96c533e67f6fa532a4d8ef622744744ce840a0da5bd3b7904b43891f91a2adcb"
    "src/lib/markingUtils.ts" = "95bc5343c41c1e557d0a71005a915b77251f4f7dbd37d4423e646d8dcfb35108"
    "src/lib/offlineDb.ts" = "54e3d54430c9dba8e6345c841086aeb091b954d9451c6d57a4a970803d5d9096"
}
$files = Get-Content (Join-Path $PSScriptRoot 'PATCH_FILES.txt') | Where-Object { $_.Trim() -and -not $_.StartsWith('#') }
$dirty = git -C $root status --porcelain
if ($LASTEXITCODE -ne 0) { throw 'Git repository not available' }
if ($dirty) { throw 'Working tree is not clean. Save current work before applying.' }
foreach ($file in $files) {
    $rel = $file.Trim().Replace('/','\')
    $source = Join-Path $PSScriptRoot $rel
    if (!(Test-Path -LiteralPath $source)) { throw "Patch missing: $file" }
    if ($expected.ContainsKey($file)) {
        $destination = Join-Path $root $rel
        if (!(Test-Path -LiteralPath $destination)) { throw "Existing file missing: $file" }
        $actual = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actual -ne $expected[$file]) { throw "Source version differs: $file. Merge manually against your latest source; nothing was overwritten." }
    }
}
$backup = Join-Path $env:TEMP ("AdRoute_Field_Backup_" + (Get-Date -Format 'yyyyMMdd_HHmmss'))
New-Item -ItemType Directory -Force $backup | Out-Null
foreach ($file in $files) {
    $rel = $file.Trim().Replace('/','\')
    $target = Join-Path $root $rel
    if (Test-Path -LiteralPath $target) {
        $backupPath = Join-Path $backup $rel
        New-Item -ItemType Directory -Force (Split-Path $backupPath -Parent) | Out-Null
        Copy-Item -LiteralPath $target -Destination $backupPath -Force
    }
}
git -C $root switch -c fix/field-capture-marking-units
if ($LASTEXITCODE -ne 0) { throw 'Cannot create Git branch' }
foreach ($file in $files) {
    $rel = $file.Trim().Replace('/','\')
    $target = Join-Path $root $rel
    New-Item -ItemType Directory -Force (Split-Path $target -Parent) | Out-Null
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $rel) -Destination $target -Force
}
Write-Host "Source files copied. External pre-update backup: $backup"
Write-Host 'No SQL executed. Run tests and stage the migration on a backed-up staging project first.'
git -C $root diff --check
if ($LASTEXITCODE -ne 0) { throw 'git diff check failed' }
