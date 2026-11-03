# gmdi-token-meter: встановлення з GitHub з автооновленням (Windows).
# Для кожного акаунта Claude (%USERPROFILE%\.claude, .claude-*, CLAUDE_CONFIG_DIR):
#   1. settings.json: extraKnownMarketplaces.gmdi (github gennadijkhimij/gmdi-token-meter, autoUpdate: true)
#      і enabledPlugins."gmdi-token-meter@gmdi" = true; інші поля запису gmdi зберігаються;
#   2. встановлює мод рушієм застосунку Claude (claude.exe) і перевіряє, що він є в installed_plugins.json;
#   3. лише після цього прибирає стару копію з архіву-інсталятора з env.CLAUDE_CODE_PLUGIN_DIRS.
# Не вдалося встановити — settings.json повертається як був, стара версія лишається.
# Пропускає акаунт, де мод підключено з робочої копії розробника, і акаунт, де маркетплейс gmdi веде на інше джерело.
# Стару теку %LOCALAPPDATA%\claude-mods\gmdi-token-meter видаляє, коли на неї не посилається жоден акаунт ПК.
# Перед зміною — резервна копія settings.json.bak-<дата>; якщо хоч один settings.json зіпсований, не змінює нічого.
#
#   install.ps1 [-ConfigDir <тека налаштувань Claude>] [-Quiet]
#   -Quiet: фоновий запуск (щогодинне оновлення скілів). Акаунт, де мод уже раз налаштовано,
#           не чіпає: вимкнений чи видалений у Claude мод не повертається сам.

param(
  [string]$ConfigDir,
  [switch]$Quiet
)

$ErrorActionPreference = 'Stop'

$Plugin = 'gmdi-token-meter'
$Market = 'gmdi'
$Repo = 'gennadijkhimij/gmdi-token-meter'
$Key = "$Plugin@$Market"
$Marker = ".$Plugin-setup"
$OldCopy = Join-Path $env:LOCALAPPDATA "claude-mods\$Plugin"

function Fail([string]$text) {
  Write-Host ''
  Write-Host "ПОМИЛКА: $text" -ForegroundColor Red
  exit 1
}

function Say([string]$text, [string]$color = 'Gray') {
  if (-not $Quiet) { Write-Host $text -ForegroundColor $color }
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

# claude.exe застосунку Claude (найновіша версія), інакше claude з PATH.
function Find-Engine {
  $exe = Get-ChildItem -Path $env:APPDATA -Directory -Filter 'Claude*' -ErrorAction SilentlyContinue |
    ForEach-Object { Get-ChildItem (Join-Path $_.FullName 'claude-code') -Recurse -Filter claude.exe -ErrorAction SilentlyContinue } |
    Sort-Object { try { [version]($_.Directory.Parent.Name -replace '[^\d.]', '') } catch { [version]'0.0' } } -Descending |
    Select-Object -First 1 -ExpandProperty FullName
  if ($exe) { return $exe }
  $cmd = Get-Command claude -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
}

# Мод справді встановлено: запис user у реєстрі, і в його теці є маніфест мода.
function Test-Installed([string]$dir) {
  $list = Join-Path $dir 'plugins\installed_plugins.json'
  if (-not (Test-Path -LiteralPath $list)) { return $false }
  try { $reg = [IO.File]::ReadAllText($list, $utf8) | ConvertFrom-Json } catch { return $false }
  if (-not $reg.plugins -or -not $reg.plugins.PSObject.Properties[$Key]) { return $false }
  foreach ($i in @($reg.plugins.$Key)) {
    if ($i.scope -eq 'user' -and $i.installPath -and (Test-Path -LiteralPath (Join-Path $i.installPath '.claude-plugin\plugin.json'))) { return $true }
  }
  return $false
}

function Get-InstalledVersion([string]$dir) {
  try { $reg = [IO.File]::ReadAllText((Join-Path $dir 'plugins\installed_plugins.json'), $utf8) | ConvertFrom-Json } catch { return '?' }
  $v = @($reg.plugins.$Key | Where-Object { $_.scope -eq 'user' } | ForEach-Object { $_.version })
  if ($v) { $v[0] } else { '?' }
}

# Команда рушія без винятків від stderr (PowerShell 5.1); повертає код завершення і вивід.
function Invoke-Engine([string]$dir, [string[]]$arguments) {
  $savedConfig = $env:CLAUDE_CONFIG_DIR
  $savedDirs = $env:CLAUDE_CODE_PLUGIN_DIRS
  $savedPref = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    Remove-Item Env:CLAUDE_CODE_PLUGIN_DIRS -ErrorAction SilentlyContinue
    $env:CLAUDE_CONFIG_DIR = $dir
    $out = (& $engine @arguments 2>&1 | ForEach-Object { "$_" }) -join "`n"
    [pscustomobject]@{ Code = $LASTEXITCODE; Out = $out.Trim() }
  } catch {
    [pscustomobject]@{ Code = -1; Out = "$_" }
  } finally {
    $ErrorActionPreference = $savedPref
    $env:CLAUDE_CONFIG_DIR = $savedConfig
    if ($savedDirs) { $env:CLAUDE_CODE_PLUGIN_DIRS = $savedDirs }
  }
}

function Get-PluginDirs($settings) {
  if (-not $settings.PSObject.Properties['env'] -or -not $settings.env) { return @() }
  @(([string]$settings.env.CLAUDE_CODE_PLUGIN_DIRS) -split ';' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
}

$utf8 = New-Object System.Text.UTF8Encoding $false
if ($ConfigDir) { $configDirs = @(Norm $ConfigDir) } else { $configDirs = @(Find-ConfigDirs) }

Say "Мод:           $Plugin (github.com/$Repo)"
Say 'Акаунти Claude:'
$configDirs | ForEach-Object { Say "  $_" }
Say ''

# 1. Прочитати всі settings.json до будь-яких змін.
$accounts = @()
foreach ($dir in $configDirs) {
  $path = Join-Path $dir 'settings.json'
  $raw = $null
  $settings = $null
  if (Test-Path -LiteralPath $path) {
    $raw = [IO.File]::ReadAllText($path, $utf8)
    if ($raw.Trim()) {
      try { $settings = $raw | ConvertFrom-Json }
      catch { Fail "не вдалося прочитати $path як JSON. Виправте файл або запустіть з -ConfigDir для іншого акаунта. Нічого не змінено." }
    }
  }
  if (-not $settings) { $settings = New-Object PSObject }
  $accounts += [pscustomobject]@{ Dir = $dir; Path = $path; Raw = $raw; Settings = $settings }
}

$engine = Find-Engine
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$oldNorm = Norm $OldCopy
$failed = 0

foreach ($a in $accounts) {
  $s = $a.Settings
  $label = Split-Path $a.Dir -Leaf
  $markerPath = Join-Path $a.Dir $Marker

  if ($Quiet -and (Test-Path -LiteralPath $markerPath)) { continue }
  # Мод, вимкнений у Claude (enabledPlugins = false), фоновий запуск не вмикає.
  if ($Quiet -and $s.PSObject.Properties['enabledPlugins'] -and $s.enabledPlugins -and $s.enabledPlugins.PSObject.Properties[$Key] -and $s.enabledPlugins.$Key -eq $false) { continue }

  $entries = Get-PluginDirs $s
  $same = @($entries | Where-Object { (Split-Path $_.TrimEnd('\', '/') -Leaf) -eq $Plugin })
  $dev = @($same | Where-Object { (Norm $_) -ne $oldNorm -and (Test-Path -LiteralPath (Join-Path $_ '.claude-plugin\plugin.json')) })
  if ($dev) { Say "[$label] пропущено: мод підключено з робочої копії $($dev[0])" Yellow; continue }

  $known = if ($s.PSObject.Properties['extraKnownMarketplaces'] -and $s.extraKnownMarketplaces) { $s.extraKnownMarketplaces.PSObject.Properties[$Market] } else { $null }
  if ($known -and $known.Value.source -and ([string]$known.Value.source.repo) -ne $Repo) {
    Write-Host "[$label] пропущено: маркетплейс «$Market» уже веде на інше джерело. Встановіть вручну: /plugin install $Plugin --marketplace $Repo" -ForegroundColor Yellow
    continue
  }

  # 2. Маркетплейс і мод у settings.json; стару копію в env поки не чіпаємо.
  if (-not $s.PSObject.Properties['extraKnownMarketplaces'] -or -not $s.extraKnownMarketplaces) { Set-Prop $s 'extraKnownMarketplaces' (New-Object PSObject) }
  $entry = if ($known) { $known.Value } else { New-Object PSObject }
  if (-not $entry.PSObject.Properties['source'] -or -not $entry.source) { Set-Prop $entry 'source' ([pscustomobject]@{ source = 'github'; repo = $Repo }) }
  Set-Prop $entry 'autoUpdate' $true
  Set-Prop $s.extraKnownMarketplaces $Market $entry
  if (-not $s.PSObject.Properties['enabledPlugins'] -or -not $s.enabledPlugins) { Set-Prop $s 'enabledPlugins' (New-Object PSObject) }
  Set-Prop $s.enabledPlugins $Key $true

  $backup = $null
  if (Test-Path -LiteralPath $a.Path) {
    $backup = "$($a.Path).bak-$stamp"
    Copy-Item -LiteralPath $a.Path -Destination $backup
  }

  # 3–4 як одна дія: будь-який збій повертає settings.json як був, стара версія лишається.
  try {
    New-Item -ItemType Directory -Force -Path $a.Dir | Out-Null
    [IO.File]::WriteAllText($a.Path, ($s | ConvertTo-Json -Depth 100), $utf8)

    # 3. Встановити рушієм і переконатися, що мод на місці.
    $why = $null
    if ((Test-Installed $a.Dir) -and $engine) {
      # Уже встановлено: підтягнути останню версію з GitHub (невдача тут не скасовує решту).
      $null = Invoke-Engine $a.Dir @('plugin', 'marketplace', 'update', $Market)
      $r = Invoke-Engine $a.Dir @('plugin', 'update', $Key, '--scope', 'user')
      if ($r.Code -ne 0) { Write-Host "[$label] не вдалося оновити: $($r.Out)" -ForegroundColor Yellow }
    }
    if (-not (Test-Installed $a.Dir)) {
      if (-not $engine) { throw 'не знайдено застосунок Claude (claude.exe)' }
      $r = Invoke-Engine $a.Dir @('plugin', 'marketplace', 'add', $Repo)
      if ($r.Code -ne 0) { $why = "plugin marketplace add: $($r.Out)" }
      $r = Invoke-Engine $a.Dir @('plugin', 'install', $Key, '--scope', 'user')
      if ($r.Code -ne 0) { $why = "plugin install: $($r.Out)" }
    }
    if (-not (Test-Installed $a.Dir)) {
      if (-not $why) { $why = 'після встановлення мода немає в реєстрі Claude' }
      throw $why
    }

    # 4. Новий мод на місці. `plugin marketplace add` переписує settings.json і буває губить autoUpdate:
    #    перечитати файл, повернути autoUpdate і прибрати стару копію з env.
    $now = [IO.File]::ReadAllText($a.Path, $utf8)
    $s = $now | ConvertFrom-Json
    if ($s.extraKnownMarketplaces -and $s.extraKnownMarketplaces.PSObject.Properties[$Market]) {
      Set-Prop $s.extraKnownMarketplaces.$Market 'autoUpdate' $true
    }
    $entries = Get-PluginDirs $s
    if (@($entries | Where-Object { (Norm $_) -eq $oldNorm })) {
      $rest = @($entries | Where-Object { (Norm $_) -ne $oldNorm })
      if ($rest) { Set-Prop $s.env 'CLAUDE_CODE_PLUGIN_DIRS' ($rest -join ';') }
      else { $s.env.PSObject.Properties.Remove('CLAUDE_CODE_PLUGIN_DIRS') }
    }
    $json = $s | ConvertTo-Json -Depth 100
    if (($now | ConvertFrom-Json | ConvertTo-Json -Depth 100) -ne $json) { [IO.File]::WriteAllText($a.Path, $json, $utf8) }
  } catch {
    if ($null -eq $a.Raw) { Remove-Item -LiteralPath $a.Path -Force -ErrorAction SilentlyContinue } else { [IO.File]::WriteAllText($a.Path, $a.Raw, $utf8) }
    if ($backup) { Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue }
    Write-Host "[$label] мод не встановлено: $($_.Exception.Message). Налаштування не змінено, стара версія (якщо була) лишається." -ForegroundColor Yellow
    $failed++
    continue
  }

  [IO.File]::WriteAllText($markerPath, "$stamp $Repo`n", $utf8)
  if ($backup -and $a.Raw -eq [IO.File]::ReadAllText($a.Path, $utf8)) { Remove-Item -LiteralPath $backup -Force }
  Write-Host "[$label] мод встановлено (версія $(Get-InstalledVersion $a.Dir)), автооновлення ввімкнено." -ForegroundColor Green
}

# 5. Стара копія з архіву-інсталятора: видалити, якщо на неї не посилається жоден акаунт ПК.
if (Test-Path -LiteralPath $OldCopy) {
  $used = $false
  foreach ($dir in @(@(Find-ConfigDirs) + $configDirs)) {
    $path = Join-Path $dir 'settings.json'
    if (-not (Test-Path -LiteralPath $path)) { continue }
    try { $cfg = [IO.File]::ReadAllText($path, $utf8) | ConvertFrom-Json } catch { $used = $true; continue }
    if (-not $cfg) { continue }
    foreach ($p in (Get-PluginDirs $cfg)) { if ((Norm $p) -eq $oldNorm) { $used = $true } }
  }
  if (-not $used) {
    Remove-Item -LiteralPath $OldCopy -Recurse -Force
    Write-Host "Стару копію $OldCopy видалено." -ForegroundColor Green
  }
}

if ($Quiet) { return }
Write-Host ''
if ($failed) { Write-Host "Не встановлено в акаунтах: $failed. Причина — вище; повторіть, коли буде доступ до github.com." -ForegroundColor Yellow; exit 2 }
Write-Host 'Готово. Закрийте й знову відкрийте застосунок Claude: смуга з''явиться над полем вводу.'
Write-Host 'Далі Claude перевірятиме оновлення під час кожного запуску й ставитиме їх сам.'
