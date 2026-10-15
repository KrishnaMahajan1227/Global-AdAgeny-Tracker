param(
  [string]$ProjectRoot = 'D:\DarshanAdField'
)
$ErrorActionPreference = 'Stop'
if (!(Test-Path (Join-Path $ProjectRoot 'package.json'))) { throw 'Invalid project root.' }
Push-Location $ProjectRoot
try {
  $branch = git branch --show-current
  if ($LASTEXITCODE -ne 0 -or $branch.Trim() -ne 'main') { throw 'Switch to existing main branch first.' }
  $dirty = git status --porcelain
  if ($dirty) { throw 'Working tree contains uncommitted changes. Commit or save them before applying.' }
  $patchDir = Split-Path -Parent $MyInvocation.MyCommand.Path
  node (Join-Path $patchDir 'scripts/restore-breadcrumbs.mjs') $ProjectRoot
  if ($LASTEXITCODE -ne 0) { throw 'Breadcrumb patch failed.' }
  git diff --check
  if ($LASTEXITCODE -ne 0) { throw 'Whitespace check failed.' }
  git diff -- src/components/AdminLayout.tsx
} finally {
  Pop-Location
}
