# Run from PowerShell 7/Windows PowerShell after installing PostgreSQL tools.
# Examples: .\RESET_OLD_BILLING.ps1 -DbHost "aws-0-...pooler.supabase.com" -DbPort 5432 -DbUser "postgres.PROJECTREF" -AgencyId "..." 
# Does NOT automatically execute cleanup without a second explicit confirmation.
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$DbHost,
    [int]$DbPort=5432,
    [string]$DbName='postgres',
    [Parameter(Mandatory=$true)][string]$DbUser,
    [Parameter(Mandatory=$true)][ValidatePattern('^[0-9a-fA-F-]{36}$')][string]$AgencyId,
    [string]$BackupFolder="$HOME\AdRoute-Billing-Backups"
)
$ErrorActionPreference='Stop'
$folder=Join-Path $PSScriptRoot 'supabase\manual'
foreach($exe in @('psql','pg_dump','pg_restore')) {
    if (!(Get-Command $exe -ErrorAction SilentlyContinue)) {
        throw "Missing $exe. Install PostgreSQL command-line tools and add their bin folder to PATH. Nothing was deleted."
    }
}
$password=Read-Host 'Supabase database password (NOT anon/service key)' -AsSecureString
$bstr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($password)
try {
    $env:PGPASSWORD=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    $env:PGSSLMODE='require'
} finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
$stamp=Get-Date -Format 'yyyyMMdd-HHmmss'
New-Item -ItemType Directory -Force -Path $BackupFolder | Out-Null
$backup=Join-Path $BackupFolder "adroute-full-$stamp.dump"
try {
    Write-Host "`n[1/4] Read-only agency billing preview" -ForegroundColor Cyan
    & psql -X -h $DbHost -p $DbPort -U $DbUser -d $DbName -v ON_ERROR_STOP=1 -v "org_id=$AgencyId" -f (Join-Path $folder 'PREVIEW_OLD_BILLING.sql')
    if($LASTEXITCODE -ne 0){ throw 'Preview failed. Nothing deleted.' }

    Write-Host "`n[2/4] Full external database backup" -ForegroundColor Cyan
    & pg_dump -h $DbHost -p $DbPort -U $DbUser -d $DbName -Fc -f $backup
    if($LASTEXITCODE -ne 0 -or !(Test-Path $backup) -or (Get-Item $backup).Length -lt 1024) { throw 'Backup failed. Nothing deleted.' }
    & pg_restore --list $backup | Out-Null
    if($LASTEXITCODE -ne 0){ throw 'Backup catalog verification failed. Nothing deleted.' }
    Write-Host "Backup created: $backup" -ForegroundColor Green
    Write-Host 'Copy the backup securely off the machine; verify a restore in staging before proceeding.' -ForegroundColor Yellow

    Write-Host "`n[3/4] Legal/accounting checkpoint" -ForegroundColor Cyan
    Write-Host 'Issued/paid invoices may need GST retention or credit-note treatment. Consult accounts before active-record removal.' -ForegroundColor Yellow
    $inputConfirmation=Read-Host 'For ACTIVE BILLING removal, type: ARCHIVE AND CLEAR THIS AGENCY BILLING (otherwise press Enter to stop)'
    if($inputConfirmation -cne 'ARCHIVE AND CLEAR THIS AGENCY BILLING'){
      Write-Host 'Stopped after preview and backup. No records deleted.' -ForegroundColor Yellow
      return
    }
    $verifyAgency=Read-Host 'Retype the EXACT agency UUID shown in preview'
    if($verifyAgency -ne $AgencyId) { throw 'Agency confirmation mismatch. Nothing deleted.' }

    Write-Host "`n[4/4] Transactional archive and active-billing cleanup" -ForegroundColor Cyan
    & psql -X -h $DbHost -p $DbPort -U $DbUser -d $DbName -v ON_ERROR_STOP=1 -v "org_id=$AgencyId" -v "approval=$inputConfirmation" -f (Join-Path $folder 'ARCHIVE_AND_CLEAR_OLD_BILLING.sql')
    if($LASTEXITCODE -ne 0){ throw 'SQL transaction failed. Check PostgreSQL messages. Do not retry blindly.' }
    Write-Host 'Active billing cleanup completed; private SQL archive and external backup retained.' -ForegroundColor Green
} finally {
    Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
    Remove-Item Env:PGSSLMODE -ErrorAction SilentlyContinue
}
