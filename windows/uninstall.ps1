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

# Стан у реєстрі Claude: 'yes', 'no' або 'error' (реєстр не читається — нічого не робимо).
function Get-RegState([string]$dir) {
  $list = Join-Path $dir 'plugins\installed_plugins.json'
  if (-not (Test-Path -LiteralPath $list)) { return 'no' }
  try { $reg = [IO.File]::ReadAllText($list, $utf8) | ConvertFrom-Json } catch { return 'error' }
  if ($reg.plugins -and $reg.plugins.PSObject.Properties[$Key] -and @($reg.plugins.$Key).Count -gt 0) { 'yes' } else { 'no' }
}

# Звідки маркетплейс gmdi в акаунті: наш repo, чужий, або його немає ('').
function Get-MarketRepo([string]$dir, $settings) {
  $repos = @()
  if ($settings -and $settings.PSObject.Properties['extraKnownMarketplaces'] -and $settings.extraKnownMarketplaces -and $settings.extraKnownMarketplaces.PSObject.Properties[$Market]) {
    $repos += [string]$settings.extraKnownMarketplaces.$Market.source.repo
  }
  $known = Join-Path $dir 'plugins\known_marketplaces.json'
  if (Test-Path -LiteralPath $known) {
    try { $k = [IO.File]::ReadAllText($known, $utf8) | ConvertFrom-Json } catch { return '?' }
    if ($k.PSObject.Properties[$Market]) { $repos += [string]$k.$Market.source.repo }
  }
  $other = @($repos | Where-Object { $_ -ne $Repo })
  if ($other) { return $other[0] }
  if ($repos) { return $Repo }
  return ''
}

$failed = 0
foreach ($dir in $configDirs) {
  $label = Split-Path $dir -Leaf
  $path = Join-Path $dir 'settings.json'
  $raw = $null
  $settings = $null
  if (Test-Path -LiteralPath $path) {
    $raw = [IO.File]::ReadAllText($path, $utf8)
    if ($raw.Trim()) {
      try { $settings = $raw | ConvertFrom-Json }
      catch { Write-Host "[$label] пропущено: settings.json не читається як JSON." -ForegroundColor Yellow; $failed++; continue }
    }
  }

  $origin = Get-MarketRepo $dir $settings
  if ($origin -and $origin -ne $Repo) {
    Write-Host "[$label] пропущено: маркетплейс «$Market» тут веде на інше джерело ($origin) — це не наш мод." -ForegroundColor Yellow
    continue
  }
  $state = Get-RegState $dir
  if ($state -eq 'error') {
    Write-Host "[$label] пропущено: не читається plugins\installed_plugins.json — стан мода невідомий, нічого не змінено." -ForegroundColor Yellow
    $failed++; continue
  }
  $enabled = $settings -and $settings.PSObject.Properties['enabledPlugins'] -and $settings.enabledPlugins -and $settings.enabledPlugins.PSObject.Properties[$Key]
  if ($state -eq 'no' -and -not $enabled -and $origin -ne $Repo) { Write-Host "[$label] мод не був підключений."; continue }

  # Резервна копія — до будь-яких змін, зокрема до uninstall рушієм (він сам змінює settings.json).
  $backup = $null
  if ($null -ne $raw) { $backup = "$path.bak-$stamp"; Copy-Item -LiteralPath $path -Destination $backup }
  $restore = {
    if ($null -ne $raw) { [IO.File]::WriteAllText($path, $raw, $utf8) }
  }

  if ($state -eq 'yes') {
    if (-not $engine) { Write-Host "[$label] не знайдено застосунок Claude (claude.exe): видаліть у Claude через /plugin -> Installed -> $Plugin -> Uninstall." -ForegroundColor Yellow; $failed++; continue }
    $savedConfig = $env:CLAUDE_CONFIG_DIR
    $savedPref = $ErrorActionPreference
    $code = -1
    $out = ''
    try {
      $ErrorActionPreference = 'Continue'
      $env:CLAUDE_CONFIG_DIR = $dir
      $out = (& $engine plugin uninstall $Key --scope user 2>&1 | ForEach-Object { "$_" }) -join "`n"
      $code = $LASTEXITCODE
    } catch { $out = "$_" }
    finally { $ErrorActionPreference = $savedPref; $env:CLAUDE_CONFIG_DIR = $savedConfig }
    if ($code -ne 0 -or (Get-RegState $dir) -ne 'no') {
      & $restore
      Write-Host "[$label] не вдалося видалити ($out). settings.json повернуто як був; видаліть у Claude через /plugin -> Installed -> $Plugin -> Uninstall." -ForegroundColor Yellow
      $failed++; continue
    }
  }

  # Прибрати підключення з settings.json (рушій міг його вже змінити — читаємо заново).
  if (Test-Path -LiteralPath $path) {
    $now = [IO.File]::ReadAllText($path, $utf8)
    $cur = if ($now.Trim()) { $now | ConvertFrom-Json } else { $null }
    if ($cur) {
      $changed = $false
      if ($cur.PSObject.Properties['enabledPlugins'] -and $cur.enabledPlugins -and $cur.enabledPlugins.PSObject.Properties[$Key]) {
        $cur.enabledPlugins.PSObject.Properties.Remove($Key); $changed = $true
      }
      if ($cur.PSObject.Properties['extraKnownMarketplaces'] -and $cur.extraKnownMarketplaces -and $cur.extraKnownMarketplaces.PSObject.Properties[$Market] -and ([string]$cur.extraKnownMarketplaces.$Market.source.repo) -eq $Repo) {
        $cur.extraKnownMarketplaces.PSObject.Properties.Remove($Market); $changed = $true
      }
      if ($changed) { [IO.File]::WriteAllText($path, ($cur | ConvertTo-Json -Depth 100), $utf8) }
    }
  }

  # Фоновий install.ps1 -Quiet бачить позначку й не ставить мод знову.
  [IO.File]::WriteAllText((Join-Path $dir ".$Plugin-setup"), "$stamp uninstalled`n", $utf8)
  Write-Host "[$label] мод видалено." -ForegroundColor Green
}

Write-Host ''
if ($failed) { Write-Host "Не вдалося в акаунтах: $failed (причина — вище)." -ForegroundColor Yellow; exit 2 }
Write-Host 'Готово. Перезапустіть Claude.'
