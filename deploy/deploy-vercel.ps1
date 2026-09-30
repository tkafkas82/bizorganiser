<#
  BizOrganiser - deploy to Vercel (database: Turso).

  First deployment and every update use the same command, from the bizorganiser folder:
     powershell -ExecutionPolicy Bypass -File deploy\deploy-vercel.ps1

  What it does:
    1. signs you in to Vercel (opens the browser the first time)
    2. links this folder to a Vercel project called "bizorganiser"
    3. sets the environment variables that are still missing:
         TURSO_DATABASE_URL, TURSO_AUTH_TOKEN  (asked once)
         ADMIN_EMAIL, ADMIN_PASSWORD           (first administrator)
         BIZ_SECRET_KEY, CRON_SECRET           (generated)
       Existing variables are never overwritten - changing BIZ_SECRET_KEY would make
       the stored integration passwords unreadable.
    4. deploys to production and prints the address
#>
param([string]$Project = 'bizorganiser')
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

function Vercel { & npx --yes vercel@61 @args; if ($LASTEXITCODE -ne 0) { throw "vercel $($args -join ' ') failed." } }
function NewSecret([int]$bytes = 32) {
  $b = New-Object byte[] $bytes
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
  ([Convert]::ToBase64String($b)).Replace('+', 'x').Replace('/', 'y').TrimEnd('=')
}
function Plain([Security.SecureString]$s) {
  $p = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
  try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($p) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p) }
}
function SetEnv([string]$name, [string]$value) {
  # the value goes through a temporary file so that no newline is added and it never appears on the command line
  $tmp = [IO.Path]::GetTempFileName()
  try {
    [IO.File]::WriteAllText($tmp, $value)
    cmd /c "npx --yes vercel@61 env add $name production < `"$tmp`""
    if ($LASTEXITCODE -ne 0) { throw "Could not set $name automatically. Add it by hand in Vercel -> Project -> Settings -> Environment Variables (environment: Production), then run this script again." }
  } finally { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }
}

if (-not (Get-Command npx -ErrorAction SilentlyContinue)) { throw 'Node.js (npx) was not found. Install Node.js 22.13 or newer from https://nodejs.org/' }

Write-Host '1/4  Vercel sign-in' -ForegroundColor Cyan
& npx --yes vercel@61 whoami 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) { Vercel login }

Write-Host '2/4  Linking this folder to the Vercel project' -ForegroundColor Cyan
if (-not (Test-Path (Join-Path $root '.vercel\project.json'))) { Vercel link --yes --project $Project }

Write-Host '3/4  Environment variables' -ForegroundColor Cyan
$existing = (& npx --yes vercel@61 env ls production 2>&1 | Out-String)
$has = { param($n) $existing -match "(?m)^\s*$n\s" }
$adminPassword = $null

if (-not (& $has 'TURSO_DATABASE_URL')) {
  $url = Read-Host 'Turso database URL (starts with libsql://)'
  if ($url -notmatch '^libsql://[A-Za-z0-9.-]+$') { throw 'That does not look like a Turso URL (libsql://<name>-<org>.turso.io).' }
  SetEnv 'TURSO_DATABASE_URL' $url
}
if (-not (& $has 'TURSO_AUTH_TOKEN')) {
  $token = Plain (Read-Host 'Turso auth token (input hidden)' -AsSecureString)
  if ($token.Length -lt 20) { throw 'The token looks too short.' }
  SetEnv 'TURSO_AUTH_TOKEN' $token
}
if (-not (& $has 'ADMIN_EMAIL')) {
  $email = Read-Host 'Email address for the first administrator'
  if ($email -notmatch '^[^@\s]+@[^@\s]+\.[^@\s]+$') { throw 'Please enter a valid email address.' }
  SetEnv 'ADMIN_EMAIL' $email.ToLower()
}
if (-not (& $has 'ADMIN_PASSWORD')) { $adminPassword = (NewSecret 12) + '7a'; SetEnv 'ADMIN_PASSWORD' $adminPassword }
if (-not (& $has 'BIZ_SECRET_KEY')) { SetEnv 'BIZ_SECRET_KEY' (NewSecret 32) }
if (-not (& $has 'CRON_SECRET')) { SetEnv 'CRON_SECRET' (NewSecret 24) }

Write-Host '4/4  Deploying to production (takes about a minute)' -ForegroundColor Cyan
$out = & npx --yes vercel@61 deploy --prod --yes 2>&1 | Tee-Object -Variable log | Out-String
if ($LASTEXITCODE -ne 0) { throw 'Deployment failed - see the messages above.' }
$url = ([regex]::Matches($out, 'https://[A-Za-z0-9.-]+\.vercel\.app') | Select-Object -Last 1).Value

Write-Host ''
Write-Host 'Deployment finished.' -ForegroundColor Green
if ($url) { Write-Host "  Address:      $url   (customer portal: /b2b/   e-shop: /shop/)" }
if ($adminPassword) {
  Write-Host "  First sign-in: the email you entered, temporary password: $adminPassword" -ForegroundColor Yellow
  Write-Host '  You must choose a new password at first sign-in. The temporary one is not shown again.'
}
Write-Host '  Tip: set a stable address in Vercel -> Project -> Settings -> Domains.'
