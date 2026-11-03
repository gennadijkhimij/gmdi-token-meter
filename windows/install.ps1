# gmdi-token-meter: підключення з GitHub з автооновленням (Windows).
# У settings.json кожного акаунта Claude (%USERPROFILE%\.claude, .claude-*, CLAUDE_CONFIG_DIR):
#   extraKnownMarketplaces.gmdi = github gennadijkhimij/gmdi-token-meter, autoUpdate: true
#   enabledPlugins."gmdi-token-meter@gmdi" = true
# Claude сам ставить мод під час наступного запуску й оновлює його під час кожного наступного.
# Стару копію з архіву-інсталятора (%LOCALAPPDATA%\claude-mods\gmdi-token-meter) прибирає з env і з диска.
# Акаунт, де мод підключено з робочої копії розробника (інша тека в CLAUDE_CODE_PLUGIN_DIRS), не чіпає.
# Перед зміною — резервна копія settings.json.bak-<дата>; якщо хоч один settings.json зіпсований, не змінює нічого.
#
#   install.ps1 [-ConfigDir <тека налаштувань Claude>] [-Quiet]

param(
  [string]$ConfigDir,
  [switch]$Quiet
)

$ErrorActionPreference = 'Stop'

$Plugin = 'gmdi-token-meter'
$Market = 'gmdi'
$Repo = 'gennadijkhimij/gmdi-token-meter'
$OldCopy = Join-Path $env:LOCALAPPDATA "claude-mods\$Plugin"

function Fail([string]$text) {
  Write-Host ''
  Write-Host "ПОМИЛКА: $text" -ForegroundColor Red
  exit 1
}

function Set-Prop($obj, [string]$name, $value) {
  if ($obj.PSObject.Properties[$name]) { $obj.$name = $value }
  else { $obj | Add-Member -NotePropertyName $name -NotePropertyValue $value }
}

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
  if (-not $dirs) { $dirs = @(Join-Path $env:USERPROFILE '.claude') }
  $seen = @{}
  foreach ($d in $dirs) { $k = (Norm $d).ToLowerInvariant(); if (-not $seen[$k]) { $seen[$k] = $true; Norm $d } }
}

$utf8 = New-Object System.Text.UTF8Encoding $false
if ($ConfigDir) { $configDirs = @(Norm $ConfigDir) } else { $configDirs = @(Find-ConfigDirs) }

if (-not $Quiet) {
  Write-Host "Мод:           $Plugin (github.com/$Repo)"
  Write-Host 'Акаунти Claude:'
  $configDirs | ForEach-Object { Write-Host "  $_" }
  Write-Host ''
}

# 1. Прочитати всі settings.json до будь-яких змін.
$accounts = @()
foreach ($dir in $configDirs) {
  $path = Join-Path $dir 'settings.json'
  $settings = $null
  if (Test-Path -LiteralPath $path) {
    $raw = [IO.File]::ReadAllText($path, $utf8)
    if ($raw.Trim()) {
      try { $settings = $raw | ConvertFrom-Json }
      catch { Fail "не вдалося прочитати $path як JSON. Виправте файл або запустіть з -ConfigDir для іншого акаунта. Нічого не змінено." }
    }
  }
  if (-not $settings) { $settings = New-Object PSObject }
  $accounts += [pscustomobject]@{ Dir = $dir; Path = $path; Settings = $settings; Raw = ($settings | ConvertTo-Json -Depth 100) }
}

# 2. Кожен акаунт: прибрати стару копію з env, підключити маркетплейс і мод.
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$oldNorm = Norm $OldCopy
$connected = @()
foreach ($a in $accounts) {
  $settings = $a.Settings
  $label = Split-Path $a.Dir -Leaf

  $hasEnv = $settings.PSObject.Properties['env']
  $dirsNow = if ($hasEnv -and $settings.env) { [string]$settings.env.CLAUDE_CODE_PLUGIN_DIRS } else { '' }
  $entries = @($dirsNow -split ';' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
  $same = @($entries | Where-Object { (Split-Path $_.TrimEnd('\', '/') -Leaf) -eq $Plugin })
  $dev = @($same | Where-Object { (Norm $_) -ne $oldNorm -and (Test-Path -LiteralPath (Join-Path $_ '.claude-plugin\plugin.json')) })
  if ($dev) {
    if (-not $Quiet) { Write-Host "[$label] пропущено: мод підключено з робочої копії $($dev[0])" -ForegroundColor Yellow }
    continue
  }

  if ($same) {
    $rest = @($entries | Where-Object { (Split-Path $_.TrimEnd('\', '/') -Leaf) -ne $Plugin })
    if ($rest) { Set-Prop $settings.env 'CLAUDE_CODE_PLUGIN_DIRS' ($rest -join ';') }
    else { $settings.env.PSObject.Properties.Remove('CLAUDE_CODE_PLUGIN_DIRS') }
  }

  if (-not $settings.PSObject.Properties['extraKnownMarketplaces'] -or -not $settings.extraKnownMarketplaces) {
    Set-Prop $settings 'extraKnownMarketplaces' (New-Object PSObject)
  }
  $source = [pscustomobject]@{ source = 'github'; repo = $Repo }
  Set-Prop $settings.extraKnownMarketplaces $Market ([pscustomobject]@{ source = $source; autoUpdate = $true })

  if (-not $settings.PSObject.Properties['enabledPlugins'] -or -not $settings.enabledPlugins) {
    Set-Prop $settings 'enabledPlugins' (New-Object PSObject)
  }
  Set-Prop $settings.enabledPlugins "$Plugin@$Market" $true

  $connected += $a.Dir
  $json = $settings | ConvertTo-Json -Depth 100
  if ($json -eq $a.Raw) {
    if (-not $Quiet) { Write-Host "[$label] уже підключено." -ForegroundColor Green }
    continue
  }
  if (Test-Path -LiteralPath $a.Path) { Copy-Item -LiteralPath $a.Path -Destination "$($a.Path).bak-$stamp" }
  New-Item -ItemType Directory -Force -Path $a.Dir | Out-Null
  [IO.File]::WriteAllText($a.Path, $json, $utf8)
  Write-Host "[$label] підключено з GitHub, автооновлення ввімкнено." -ForegroundColor Green
}

# 3. Поставити мод одразу, якщо знайдено claude.exe (застосунок Claude або claude у PATH).
#    Без нього Claude поставить мод сам під час наступного запуску, за записами в settings.json.
function Find-Engine {
  $exe = Get-ChildItem -Path $env:APPDATA -Directory -Filter 'Claude*' -ErrorAction SilentlyContinue |
    ForEach-Object { Get-ChildItem (Join-Path $_.FullName 'claude-code') -Recurse -Filter claude.exe -ErrorAction SilentlyContinue } |
    Sort-Object { try { [version]($_.Directory.Parent.Name -replace '[^\d.]', '') } catch { [version]'0.0' } } -Descending |
    Select-Object -First 1 -ExpandProperty FullName
  if ($exe) { return $exe }
  $cmd = Get-Command claude -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
}

$todo = @($connected | Where-Object {
  $list = Join-Path $_ 'plugins\installed_plugins.json'
  -not ((Test-Path -LiteralPath $list) -and ([IO.File]::ReadAllText($list, $utf8) -like "*`"$Plugin@$Market`"*"))
})
if ($todo) {
  $engine = Find-Engine
  if ($engine) {
    $savedConfig = $env:CLAUDE_CONFIG_DIR
    $savedDirs = $env:CLAUDE_CODE_PLUGIN_DIRS
    Remove-Item Env:CLAUDE_CODE_PLUGIN_DIRS -ErrorAction SilentlyContinue
    foreach ($dir in $todo) {
      $label = Split-Path $dir -Leaf
      $env:CLAUDE_CONFIG_DIR = $dir
      $null = & $engine plugin marketplace add $Repo 2>&1
      $out = & $engine plugin install "$Plugin@$Market" --scope user 2>&1 | Out-String
      if ($out -match 'Successfully installed|already installed') { Write-Host "[$label] мод встановлено." -ForegroundColor Green }
      else { Write-Host "[$label] не вдалося встановити зараз; Claude поставить мод під час наступного запуску." -ForegroundColor Yellow }
    }
    $env:CLAUDE_CONFIG_DIR = $savedConfig
    if ($savedDirs) { $env:CLAUDE_CODE_PLUGIN_DIRS = $savedDirs }
  }
}

# 4. Стара копія з архіву-інсталятора більше не потрібна, якщо на неї не посилається жоден акаунт.
if (Test-Path -LiteralPath $OldCopy) {
  # Перевіряємо всі акаунти ПК, а не лише ті, що змінювали (-ConfigDir).
  $used = $false
  foreach ($dir in @(@(Find-ConfigDirs) + $configDirs)) {
    $path = Join-Path $dir 'settings.json'
    if (-not (Test-Path -LiteralPath $path)) { continue }
    try { $s = [IO.File]::ReadAllText($path, $utf8) | ConvertFrom-Json } catch { $used = $true; continue }
    if (-not $s -or -not $s.PSObject.Properties['env'] -or -not $s.env) { continue }
    foreach ($p in @(([string]$s.env.CLAUDE_CODE_PLUGIN_DIRS) -split ';')) {
      if ($p.Trim() -and (Norm $p.Trim()) -eq $oldNorm) { $used = $true }
    }
  }
  if (-not $used) {
    Remove-Item -LiteralPath $OldCopy -Recurse -Force
    Write-Host "Стару копію $OldCopy видалено." -ForegroundColor Green
  }
}

if ($Quiet) { return }
Write-Host ''
Write-Host 'Готово. Закрийте й знову відкрийте застосунок Claude: мод встановиться сам і з''явиться над полем вводу.'
Write-Host 'Далі Claude перевірятиме оновлення під час кожного запуску й ставитиме їх сам.'
