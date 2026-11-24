# 把这份预设装到本机：更新 cordis.patch.yml 中每个 MCP 服务条目的路径，装依赖。
#
# 只做两件事：
#   1. command / args 里的 node 与 server.mjs 路径 → 本机真实路径（解压到哪都能跑）
#   2. npm install --omit=dev（只装 zod 与 MCP SDK）
#
# 它**不**动你的 DSH profile：profile 的 dependencies / bundles 由你手动加，
# 脚本最后会把该粘的那段打印出来。原因是改别人的 profile 属于不可逆操作，
# 出问题时很难说清是谁改的。
param(
  [string]$Dir = $PSScriptRoot,
  [string]$NodeExe = '',
  [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$OutputEncoding = [Console]::OutputEncoding
$Dir = (Resolve-Path $Dir).Path
$patch = Join-Path $Dir 'cordis.patch.yml'
if (-not (Test-Path $patch)) { throw "找不到 $patch" }

if (-not $NodeExe) {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $cmd) { throw 'PATH 里没有 node；用 -NodeExe 指一个' }
  $NodeExe = $cmd.Source
}
$server = Join-Path $Dir 'server\server.mjs'
if (-not (Test-Path $server)) { throw "找不到 $server（包解压不完整？）" }

# 只改每个 MCP 服务条目的 command 和 server.mjs 参数。
# 条目不写死：cordis.patch.yml 里有几个 serverName 就改几个（历史上曾经有 sw 与
# sw-ro 两个，2026-11-23 只读视图合并后只剩 sw；写死两个会让脚本站在这里抛错）。
$lines = [System.IO.File]::ReadAllLines($patch)
$command = "'" + $NodeExe.Replace("'", "''") + "'"
$entry = "'" + $server.Replace("'", "''") + "'"
$servers = @()
for ($i = 0; $i -lt $lines.Length; $i++) {
  $match = [regex]::Match($lines[$i], '^\s*serverName:\s*(\S+)\s*$')
  if ($match.Success) { $servers += $match.Groups[1].Value }
}
if ($servers.Count -eq 0) { throw "cordis.patch.yml 里一个 serverName 都没找到" }
foreach ($serverName in $servers) {
  $serverPattern = '^\s*serverName:\s*' + [regex]::Escape($serverName) + '\s*$'
  $serverIndex = [Array]::FindIndex($lines, [Predicate[string]] { param($line) $line -match $serverPattern })
  if ($serverIndex -lt 0) { throw "cordis.patch.yml 里没找到 serverName: $serverName" }
  $commandIndex = -1
  $entryIndex = -1
  for ($i = $serverIndex + 1; $i -lt [Math]::Min($serverIndex + 12, $lines.Length); $i++) {
    if ($lines[$i] -match "^\s*command:\s*'") { $commandIndex = $i }
    elseif ($lines[$i] -match "^\s*-\s*'.*server\.mjs'\s*$") { $entryIndex = $i }
    elseif ($lines[$i] -match '^\s*toolCallTimeoutMs:') { break }
  }
  if ($commandIndex -lt 0 -or $entryIndex -lt 0) { throw "找不到 $serverName 的 command 或 server.mjs 参数" }
  $indent = [regex]::Match($lines[$commandIndex], '^\s*').Value
  $lines[$commandIndex] = $indent + "command: $command"
  $indent = [regex]::Match($lines[$entryIndex], '^\s*').Value
  $lines[$entryIndex] = $indent + "- $entry"
}

[System.IO.File]::WriteAllLines($patch, $lines)
Write-Host ("已更新 {0}：{1}" -f ($servers -join ', '), $patch)
Write-Host "  node   : $NodeExe"
Write-Host "  server : $server"

if (-not $SkipInstall) {
  Write-Host '安装依赖（zod + MCP SDK）…'
  Push-Location $Dir
  try {
    & npm.cmd install --omit=dev --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "npm install 退出码：$LASTEXITCODE" }
  } finally { Pop-Location }
}

Write-Host ''
Write-Host '最后一步（手动）：把下面两处加进 C:\Users\<你>\.dsh\profiles\desktop\package.json，然后重启 DeepSeek Harness。'
Write-Host ''
$forJson = $Dir.Replace('\', '/')
Write-Host ('  "dependencies": { "@local/dsh-sw-preset": "file:' + $forJson + '" }')
Write-Host '  "dsh": { "profile": { "bundles": ["@local/dsh-sw-preset"] } }'
Write-Host ''
Write-Host '重启后模式列表里会出现「SW 建模（原生单步）」。'
