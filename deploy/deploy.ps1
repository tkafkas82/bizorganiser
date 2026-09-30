<#
  BizOrganiser - deploy or update from this Windows PC to an Ubuntu server over SSH.

  First deployment and every update use the same command:
     powershell -ExecutionPolicy Bypass -File deploy\deploy.ps1 -Server 203.0.113.10

  Options:
     -Server  public IP (or host name) of the server            (required)
     -User    SSH user name - "ubuntu" on Oracle's Ubuntu images (default)
     -Key     private key that matches the key given to Oracle  (default: ~\.ssh\id_ed25519)
     -Domain  your own domain name; leave empty to use <ip>.sslip.io
#>
param(
  [Parameter(Mandatory = $true)][string]$Server,
  [string]$User = 'ubuntu',
  [string]$Key = "$HOME\.ssh\id_ed25519",
  [string]$Domain = ''
)
$ErrorActionPreference = 'Stop'

if ($Domain -and $Domain -notmatch '^[A-Za-z0-9.-]+$') { throw "Domain may only contain letters, digits, dots and hyphens." }
if ($Server -notmatch '^[A-Za-z0-9.:-]+$') { throw "Server must be an IP address or host name." }
if ($User -notmatch '^[a-z_][a-z0-9_-]*$') { throw "User must be a plain Linux user name such as ubuntu." }
foreach ($tool in 'ssh', 'scp', 'tar') {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "$tool was not found. On Windows 10/11 enable 'OpenSSH Client' under Settings > Apps > Optional features." }
}
if (-not (Test-Path $Key)) { throw "SSH key $Key not found. Create one with: ssh-keygen -t ed25519" }

$root = Split-Path $PSScriptRoot -Parent
$pkg = Join-Path $env:TEMP 'bizorganiser.tgz'
Write-Host "Packaging $root (without the local data folder)..." -ForegroundColor Cyan
if (Test-Path $pkg) { Remove-Item $pkg }
tar -czf $pkg --exclude=./data --exclude=./.git --exclude=./node_modules -C $root .
if ($LASTEXITCODE -ne 0) { throw "Packaging failed." }

$target = "$User@$Server"
Write-Host "Uploading to $target..." -ForegroundColor Cyan
scp -i $Key -o StrictHostKeyChecking=accept-new $pkg "$PSScriptRoot\install.sh" "${target}:/tmp/"
if ($LASTEXITCODE -ne 0) { throw "Upload failed. Check the IP, the user name and that port 22 is reachable." }

Write-Host "Installing on the server (the first run takes a few minutes)..." -ForegroundColor Cyan
ssh -i $Key -o StrictHostKeyChecking=accept-new $target "sed -i 's/\r$//' /tmp/install.sh && sudo DOMAIN='$Domain' bash /tmp/install.sh /tmp/bizorganiser.tgz"
if ($LASTEXITCODE -ne 0) { throw "Installation failed - see the messages above." }
Write-Host "Deployment finished." -ForegroundColor Green
