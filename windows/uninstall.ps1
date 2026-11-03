# gmdi-token-meter: відключення (Windows).
# Прибирає з settings.json кожного акаунта Claude маркетплейс gmdi і запис gmdi-token-meter@gmdi.
# Робочу копію розробника в CLAUDE_CODE_PLUGIN_DIRS не чіпає. Резервна копія settings.json.bak-<дата>.
#
#   uninstall.ps1 [-ConfigDir <тека налаштувань Claude>]

param([string]$ConfigDir)

$ErrorActionPreference = 'Stop'
$Plugin = 'gmdi-token-meter'
$Market = 'gmdi'

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

$utf8 = New-Object System.Text.UTF8Encoding $false
if ($ConfigDir) { $configDirs = @(Norm $ConfigDir) } else { $configDirs = @(Find-ConfigDirs) }
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

foreach ($dir in $configDirs) {
  $path = Join-Path $dir 'settings.json'
  $label = Split-Path $dir -Leaf
  if (-not (Test-Path -LiteralPath $path)) { continue }
  $raw = [IO.File]::ReadAllText($path, $utf8)
  if (-not $raw.Trim()) { continue }
  try { $settings = $raw | ConvertFrom-Json } catch { Write-Host "[$label] пропущено: settings.json не читається як JSON." -ForegroundColor Yellow; continue }

  $changed = $false
  if ($settings.PSObject.Properties['enabledPlugins'] -and $settings.enabledPlugins.PSObject.Properties["$Plugin@$Market"]) {
    $settings.enabledPlugins.PSObject.Properties.Remove("$Plugin@$Market"); $changed = $true
  }
  if ($settings.PSObject.Properties['extraKnownMarketplaces'] -and $settings.extraKnownMarketplaces.PSObject.Properties[$Market]) {
    $settings.extraKnownMarketplaces.PSObject.Properties.Remove($Market); $changed = $true
  }
  if (-not $changed) { Write-Host "[$label] мод не був підключений."; continue }
  Copy-Item -LiteralPath $path -Destination "$path.bak-$stamp"
  [IO.File]::WriteAllText($path, ($settings | ConvertTo-Json -Depth 100), $utf8)
  Write-Host "[$label] відключено." -ForegroundColor Green
}

Write-Host ''
Write-Host 'Готово. Перезапустіть Claude. Повністю прибрати встановлену копію: /plugin -> Installed -> gmdi-token-meter -> Uninstall.'
