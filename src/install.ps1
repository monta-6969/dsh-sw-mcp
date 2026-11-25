# 把这份预设装到本机：更新 cordis.patch.yml 里每个 MCP 服务条目的路径，装依赖。
#
# 只做两件事：
#   1. 每个 serverName 块里的 command / args → 本机真实 node 与 server.mjs 路径
#   2. npm install --omit=dev（只装 zod 与 MCP SDK）
#
# 它**不**动你的 DSH profile：profile 的 dependencies / bundles 由你手动加，
# 脚本最后会把该粘的那段打印出来。改别人的 profile 属于不可逆操作，出问题很难说清是谁改的。
#
# cordis.patch.yml 里有两个预设（sw建模自动化 / sw装配体自动化），各有自己的 mcp-sw 块。
# 所以这里按「出现几次 serverName 就改几处」处理 —— 只改第一处会让另一个预设起不来。
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

$lines = [System.IO.File]::ReadAllLines($patch)
$command = "'" + $NodeExe.Replace("'", "''") + "'"
$entry = "'" + $server.Replace("'", "''") + "'"
$servers = @()
$patched = 0

for ($i = 0; $i -lt $lines.Length; $i++) {
  $match = [regex]::Match($lines[$i], '^\s*serverName:\s*(\S+)\s*$')
  if (-not $match.Success) { continue }
  $servers += $match.Groups[1].Value

  $commandIndex = -1
  $entryIndex = -1
  for ($j = $i + 1; $j -lt [Math]::Min($i + 12, $lines.Length); $j++) {
    if ($lines[$j] -match "^\s*command:\s*'") { $commandIndex = $j }
    elseif ($lines[$j] -match "^\s*-\s*'.*server\.mjs'\s*$") { $entryIndex = $j }
    elseif ($lines[$j] -match '^\s*toolCallTimeoutMs:') { break }
  }
  if ($commandIndex -lt 0 -or $entryIndex -lt 0) {
    throw "第 $($i + 1) 行的 serverName: $($match.Groups[1].Value) 找不到 command 或 server.mjs 参数"
  }
  $indent = [regex]::Match($lines[$commandIndex], '^\s*').Value
  $lines[$commandIndex] = $indent + "command: $command"
  $indent = [regex]::Match($lines[$entryIndex], '^\s*').Value
  $lines[$entryIndex] = $indent + "- $entry"
  $patched++
}

if ($patched -eq 0) { throw 'cordis.patch.yml 里一个 serverName 都没找到' }

# 按 LF 写回：仓库里 .gitattributes 统一 text eol=lf，WriteAllLines 会写成 CRLF，
# 于是每次 install 之后 cordis.patch.yml 都变成 CRLF 文件，被语法检查挑出来。
[System.IO.File]::WriteAllText($patch, (($lines -join "`n") + "`n"), (New-Object System.Text.UTF8Encoding($false)))
Write-Host ("已更新 {0} 处 mcp 服务条目（{1}）：{2}" -f $patched, ($servers -join ', '), $patch)
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
Write-Host '（预设清单在启动时读一次，改完不重启看不到新预设。）'
Write-Host ''
$forJson = $Dir.Replace('\', '/')
Write-Host ('  "dependencies": { "@local/dsh-sw-preset": "link:' + $forJson + '" }')
Write-Host '  "dsh": { "profile": { "bundles": ["@local/dsh-sw-preset"] } }'
Write-Host ''
Write-Host '重启后模式列表里会出现「sw建模自动化」与「sw装配体自动化」。'