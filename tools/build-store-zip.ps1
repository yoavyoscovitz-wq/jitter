# Build a Chrome Web Store upload zip: runtime files only (excludes dev folders).
# Run from anywhere:  powershell -ExecutionPolicy Bypass -File "c:\...\JITTER_MVP\build-store-zip.ps1"

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$manifestPath = Join-Path $root "manifest.json"
if (-not (Test-Path $manifestPath)) {
  throw "manifest.json not found next to this script."
}

$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
$ver = [string]$manifest.version
if (-not $ver) { throw "manifest.json missing version." }

$temp = Join-Path $env:TEMP ("jitter_cws_pack_" + $ver + "_" + [Guid]::NewGuid().ToString("N").Substring(0, 8))
if (Test-Path $temp) { Remove-Item $temp -Recurse -Force }
New-Item -ItemType Directory -Path $temp | Out-Null

# /E = subdirs; /XD = exclude dirs; /XF = exclude files (dev-only)
$xd = @(
  "tools",
  "NOT PACK",
  ".git",
  ".vscode",
  "node_modules",
  "Edit tool"
)
$xf = @(
  "build-store-zip.ps1",
  "chrome-web-store-dashboard.md"
)

$robocopyArgs = @($root, $temp, "/E", "/NFL", "/NDL", "/NJH", "/NJS", "/NC", "/NS")
foreach ($d in $xd) { $robocopyArgs += "/XD"; $robocopyArgs += $d }
foreach ($f in $xf) { $robocopyArgs += "/XF"; $robocopyArgs += $f }

& robocopy @robocopyArgs
$rc = $LASTEXITCODE
if ($rc -ge 8) { throw "robocopy failed with exit code $rc" }

$parent = Split-Path $root -Parent
$zipName = "JITTER_MVP-chrome-web-store-v$ver.zip"
$zipPath = Join-Path $parent $zipName
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }

Compress-Archive -Path (Join-Path $temp "*") -DestinationPath $zipPath -CompressionLevel Optimal -Force
Remove-Item $temp -Recurse -Force

Write-Host "OK: $zipPath"
