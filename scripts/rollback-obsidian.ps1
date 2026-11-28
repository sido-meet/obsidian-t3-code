[CmdletBinding()]
param(
  [string]$VaultPath = 'E:\Documents\Obsidian-Vault',
  [string]$BackupDir = '',
  [string]$BackupRoot = (Join-Path $env:LOCALAPPDATA 'T3-Codian\backups'),
  [switch]$Latest,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

$TargetPluginDir = Join-Path $VaultPath '.obsidian\plugins\t3-codian'

if (-not (Test-Path -LiteralPath $VaultPath -PathType Container)) {
  throw "Vault directory does not exist: $VaultPath"
}
if (-not (Test-Path -LiteralPath (Join-Path $VaultPath '.obsidian') -PathType Container)) {
  throw "Target does not look like an Obsidian Vault (missing '.obsidian' folder): $VaultPath"
}

if (-not $BackupDir) {
  if (-not $Latest) {
    throw 'Specify -BackupDir <path> or -Latest to select the most recent backup.'
  }
  if (-not (Test-Path -LiteralPath $BackupRoot -PathType Container)) {
    throw "Backup root does not exist: $BackupRoot"
  }
  $Candidates = @(
    Get-ChildItem -LiteralPath $BackupRoot -Directory |
      Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'backup-manifest.json') -PathType Leaf } |
      Sort-Object Name -Descending
  )
  if ($Candidates.Count -eq 0) {
    throw "No valid backup directories found under $BackupRoot"
  }
  $BackupDir = $Candidates[0].FullName
}

$ManifestPath = Join-Path $BackupDir 'backup-manifest.json'
if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) {
  throw "Backup manifest missing: $ManifestPath"
}

$BackupManifest = Get-Content -LiteralPath $ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$RestoreFiles = @($BackupManifest.files | Where-Object { $_ })
if ($RestoreFiles.Count -eq 0) {
  throw "Backup manifest contains 0 files: $ManifestPath"
}

# Preflight verification of ALL backup entries before writing anything to target
foreach ($entry in $RestoreFiles) {
  if (-not $entry.name -or [System.IO.Path]::GetFileName($entry.name) -ne $entry.name) {
    throw "Unsafe backup entry name '$($entry.name)' in $ManifestPath"
  }
  $srcFile = Join-Path $BackupDir $entry.name
  if (-not (Test-Path -LiteralPath $srcFile -PathType Leaf)) {
    throw "Backup file missing: $srcFile"
  }
  $srcHash = (Get-FileHash -LiteralPath $srcFile -Algorithm SHA256).Hash
  if ($srcHash -ne $entry.sha256) {
    throw "Backup integrity check failed for $srcFile!"
  }
}

if ($DryRun) {
  Write-Output '[rollback-obsidian] DRY RUN (zero writes performed)'
  Write-Output "  Backup dir : $BackupDir"
  Write-Output "  Target dir : $TargetPluginDir"
  foreach ($entry in $RestoreFiles) {
    Write-Output "  Would restore $($entry.name) ($($entry.bytes) bytes, SHA256=$($entry.sha256))"
  }
  exit 0
}

New-Item -ItemType Directory -Force -Path $TargetPluginDir | Out-Null

foreach ($entry in $RestoreFiles) {
  $srcFile = Join-Path $BackupDir $entry.name
  $dstFile = Join-Path $TargetPluginDir $entry.name
  Copy-Item -LiteralPath $srcFile -Destination $dstFile -Force
  $dstHash = (Get-FileHash -LiteralPath $dstFile -Algorithm SHA256).Hash
  if ($dstHash -ne $entry.sha256) {
    throw "Post-restore SHA-256 mismatch for $dstFile!"
  }
}

Write-Output '[rollback-obsidian] ROLLBACK SUCCEEDED'
Write-Output "  Restored from : $BackupDir"
Write-Output "  Target dir    : $TargetPluginDir ($($RestoreFiles.Count) file(s) restored & SHA-256 verified)"
