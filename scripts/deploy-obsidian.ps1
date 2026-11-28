[CmdletBinding()]
param(
  [string]$VaultPath = 'E:\Documents\Obsidian-Vault',
  [string]$BackupRoot = (Join-Path $env:LOCALAPPDATA 'T3-Codian\backups'),
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
$Artifacts = @('main.js', 'manifest.json', 'styles.css')
$TargetPluginDir = Join-Path $VaultPath '.obsidian\plugins\t3-codian'

if (-not (Test-Path -LiteralPath $VaultPath -PathType Container)) {
  throw "Vault directory does not exist: $VaultPath"
}
if (-not (Test-Path -LiteralPath (Join-Path $VaultPath '.obsidian') -PathType Container)) {
  throw "Target does not look like an Obsidian Vault (missing '.obsidian' folder): $VaultPath"
}

foreach ($file in $Artifacts) {
  $srcPath = Join-Path $RepoRoot $file
  if (-not (Test-Path -LiteralPath $srcPath -PathType Leaf)) {
    throw "Missing candidate build artifact: $srcPath. Run 'npm run build' first."
  }
}

$Manifest = Get-Content -LiteralPath (Join-Path $RepoRoot 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($Manifest.id -ne 't3-codian') {
  throw "Unexpected manifest.id '$($Manifest.id)' (expected 't3-codian')."
}

$DataPath = Join-Path $TargetPluginDir 'data.json'
$LegacySummary = @{
  present = $false
  keys = @()
}

if (Test-Path -LiteralPath $DataPath -PathType Leaf) {
  $LegacySummary.present = $true
  try {
    $ParsedData = Get-Content -LiteralPath $DataPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $LegacySummary.keys = @($ParsedData.PSObject.Properties.Name)
  } catch {
    throw "Existing data.json at '$DataPath' is not valid JSON; aborting deploy so user settings are not lost."
  }
}

$SourceHashes = @{}
foreach ($file in $Artifacts) {
  $srcPath = Join-Path $RepoRoot $file
  $hash = (Get-FileHash -LiteralPath $srcPath -Algorithm SHA256).Hash
  $len = (Get-Item -LiteralPath $srcPath).Length
  $SourceHashes[$file] = @{ sha256 = $hash; bytes = $len }
}

$Timestamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$BackupDir = Join-Path $BackupRoot "t3-codian-$Timestamp"
$Suffix = 1
while (Test-Path -LiteralPath $BackupDir) {
  $BackupDir = Join-Path $BackupRoot "t3-codian-$Timestamp-$Suffix"
  $Suffix++
}

if ($DryRun) {
  Write-Output '[deploy-obsidian] DRY RUN (zero writes performed)'
  Write-Output "  Source root      : $RepoRoot"
  Write-Output "  Target plugin dir: $TargetPluginDir"
  Write-Output "  Planned backup   : $BackupDir"
  Write-Output "  data.json present: $($LegacySummary.present) (keys: $($LegacySummary.keys -join ', '))"
  foreach ($file in $Artifacts) {
    $info = $SourceHashes[$file]
    Write-Output "  Artifact $file : $($info.bytes) bytes | SHA256=$($info.sha256)"
  }
  exit 0
}

$BackedUpFiles = @()
$ExistingItems = @()
if (Test-Path -LiteralPath $TargetPluginDir -PathType Container) {
  $ExistingItems = @(Get-ChildItem -LiteralPath $TargetPluginDir -File)
}
if ($ExistingItems.Count -gt 0) {
  New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
  foreach ($item in $ExistingItems) {
    $origHash = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash
    $destBackup = Join-Path $BackupDir $item.Name
    Copy-Item -LiteralPath $item.FullName -Destination $destBackup -Force
    $bHash = (Get-FileHash -LiteralPath $destBackup -Algorithm SHA256).Hash
    if ($bHash -ne $origHash) {
      throw "Backup SHA-256 verification failed for $($item.FullName); aborting before touching target!"
    }
    $BackedUpFiles += @{
      name = $item.Name
      bytes = $item.Length
      sha256 = $bHash
    }
  }
  $BackupManifest = @{
    createdAt = (Get-Date).ToString('o')
    vaultPath = $VaultPath
    sourcePluginDir = $TargetPluginDir
    targetVersion = $Manifest.version
    files = $BackedUpFiles
  }
  $BackupManifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $BackupDir 'backup-manifest.json') -Encoding UTF8
} elseif (-not (Test-Path -LiteralPath $TargetPluginDir)) {
  New-Item -ItemType Directory -Force -Path $TargetPluginDir | Out-Null
}

$CopiedArtifacts = @()
try {
  foreach ($file in $Artifacts) {
    $srcPath = Join-Path $RepoRoot $file
    $dstPath = Join-Path $TargetPluginDir $file
    Copy-Item -LiteralPath $srcPath -Destination $dstPath -Force
    $CopiedArtifacts += $dstPath
    $dstHash = (Get-FileHash -LiteralPath $dstPath -Algorithm SHA256).Hash
    if ($dstHash -ne $SourceHashes[$file].sha256) {
      throw "Post-copy SHA-256 verification failed for $dstPath!"
    }
  }
} catch {
  $deployErr = $_
  if ($BackedUpFiles.Count -gt 0) {
    foreach ($entry in $BackedUpFiles) {
      if ($entry.name -eq 'data.json') { continue }
      $backupFile = Join-Path $BackupDir $entry.name
      if (Test-Path -LiteralPath $backupFile -PathType Leaf) {
        Copy-Item -LiteralPath $backupFile -Destination (Join-Path $TargetPluginDir $entry.name) -Force -ErrorAction SilentlyContinue
      }
    }
    throw "Deploy failed and automatically attempted restore from '$BackupDir': $($deployErr.Exception.Message)"
  } else {
    foreach ($created in $CopiedArtifacts) {
      if (Test-Path -LiteralPath $created -PathType Leaf) {
        Remove-Item -LiteralPath $created -Force -ErrorAction SilentlyContinue
      }
    }
    throw "Fresh deploy failed (partial artifacts cleaned up): $($deployErr.Exception.Message)"
  }
}

Write-Output '[deploy-obsidian] DEPLOY SUCCEEDED'
Write-Output "  Target : $TargetPluginDir"
Write-Output "  Backup : $(if ($BackedUpFiles.Count -gt 0) { $BackupDir } else { 'none (fresh install)' }) ($($BackedUpFiles.Count) file(s), data.json preserved untouched)"
foreach ($file in $Artifacts) {
  $info = $SourceHashes[$file]
  Write-Output "  Verified $file : $($info.bytes) bytes | SHA256=$($info.sha256)"
}
