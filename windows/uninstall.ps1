# gmdi-token-meter: видалення (Windows).
# Для кожного акаунта Claude: видаляє мод рушієм застосунку (claude.exe), прибирає з settings.json
# enabledPlugins."gmdi-token-meter@gmdi" і маркетплейс gmdi — лише якщо він веде на gennadijkhimij/gmdi-token-meter.
# Робочу копію розробника в CLAUDE_CODE_PLUGIN_DIRS не чіпає. Резервна копія settings.json.bak-<дата>.
# Позначка .gmdi-token-meter-setup лишається: фонове щогодинне оновлення скілів мод не поверне.
#
#   uninstall.ps1 [-ConfigDir <тека налаштувань Claude>]

param([string]$ConfigDir)

$ErrorActionPreference = 'Stop'
$Plugin = 'gmdi-token-meter'
$Market = 'gmdi'
$Repo = 'gennadijkhimij/gmdi-token-meter'
$Key = "$Plugin@$Market"

function Norm([string]$path) {
  try { return [IO.Path]::GetFullPath($path).TrimEnd('\', '/') } catch { return $path.TrimEnd('\', '/') }
}

function Find-ConfigDirs {
  $dirs = @()
  foreach ($v in @([Environment]::GetEnvironmentVariable('CLAUDE_CONFIG_DIR', 'User'), $env:CLAUDE_CONFIG_DIR)) {
    if ($v -and (Test-Path -LiteralPath $v -PathType Container)) { $dirs += $v }
  }
  $dirs += @(Get-ChildItem -LiteralPath $env:USERPROFILE -Directory -Force -Filter '.claude*' |
    Where-Object { $_.Name -eq '.claude' -or $_.Name -like '.claude-*' } |
    ForEach-Object { $_.FullName })
  $seen = @{}
  foreach ($d in $dirs) { $k = (Norm $d).ToLowerInvariant(); if (-not $seen[$k]) { $seen[$k] = $true; Norm $d } }
}

function Find-Engine {
  $exe = Get-ChildItem -Path $env:APPDATA -Directory -Filter 'Claude*' -ErrorAction SilentlyContinue |
    ForEach-Object { Get-ChildItem (Join-Path $_.FullName 'claude-code') -Recurse -Filter claude.exe -ErrorAction SilentlyContinue } |
    Sort-Object { try { [version]($_.Directory.Parent.Name -replace '[^\d.]', '') } catch { [version]'0.0' } } -Descending |
    Select-Object -First 1 -ExpandProperty FullName
  if ($exe) { return $exe }
  $cmd = Get-Command claude -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
}

$utf8 = New-Object System.Text.UTF8Encoding $false
if ($ConfigDir) { $configDirs = @(Norm $ConfigDir) } else { $configDirs = @(Find-ConfigDirs) }
$engine = Find-Engine
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

foreach ($dir in $configDirs) {
  $label = Split-Path $dir -Leaf
  $list = Join-Path $dir 'plugins\installed_plugins.json'
  if ($engine -and (Test-Path -LiteralPath $list) -and ([IO.File]::ReadAllText($list, $utf8) -like "*`"$Key`"*")) {
    $savedConfig = $env:CLAUDE_CONFIG_DIR
    try { $env:CLAUDE_CONFIG_DIR = $dir; $null = & $engine plugin uninstall $Key --scope user 2>&1 }
    finally { $env:CLAUDE_CONFIG_DIR = $savedConfig }
  }

  # Фоновий install.ps1 -Quiet бачить позначку й не ставить мод знову.
  if (Test-Path -LiteralPath $dir) { [IO.File]::WriteAllText((Join-Path $dir ".$Plugin-setup"), "$stamp uninstalled`n", $utf8) }

  $path = Join-Path $dir 'settings.json'
  if (-not (Test-Path -LiteralPath $path)) { continue }
  $raw = [IO.File]::ReadAllText($path, $utf8)
  if (-not $raw.Trim()) { continue }
  try { $settings = $raw | ConvertFrom-Json } catch { Write-Host "[$label] пропущено: settings.json не читається як JSON." -ForegroundColor Yellow; continue }

  $changed = $false
  if ($settings.PSObject.Properties['enabledPlugins'] -and $settings.enabledPlugins -and $settings.enabledPlugins.PSObject.Properties[$Key]) {
    $settings.enabledPlugins.PSObject.Properties.Remove($Key); $changed = $true
  }
  $known = if ($settings.PSObject.Properties['extraKnownMarketplaces'] -and $settings.extraKnownMarketplaces) { $settings.extraKnownMarketplaces.PSObject.Properties[$Market] } else { $null }
  if ($known -and ([string]$known.Value.source.repo) -eq $Repo) {
    $settings.extraKnownMarketplaces.PSObject.Properties.Remove($Market); $changed = $true
  }
  if (-not $changed) { Write-Host "[$label] мод не був підключений."; continue }
  Copy-Item -LiteralPath $path -Destination "$path.bak-$stamp"
  [IO.File]::WriteAllText($path, ($settings | ConvertTo-Json -Depth 100), $utf8)
  Write-Host "[$label] мод видалено." -ForegroundColor Green
}

Write-Host ''
Write-Host 'Готово. Перезапустіть Claude.'
