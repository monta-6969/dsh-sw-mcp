# Build the SOLIDWORKS bridge with the only compiler available on a bare
# Windows box (csc, C# 5). The interop assemblies are copied next to the
# executable: the CLR resolves them by name from the app directory, and csc
# needs them on disk at compile time.
#
# Usage:  powershell -ExecutionPolicy Bypass -File build.ps1
$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
$src  = Join-Path $here 'src'
$bin  = Join-Path $here 'bin'
$swDir = 'C:\Program Files\SOLIDWORKS Corp\SOLIDWORKS'
$csc   = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'

if (-not (Test-Path $csc)) { throw "csc not found at $csc" }
if (-not (Test-Path $swDir)) { throw "SOLIDWORKS install dir not found at $swDir" }

New-Item -ItemType Directory -Force -Path $bin | Out-Null

# 契约常量由 contracts/enums.json 生成；编译前必须是最新的，否则桥接器会带着
# 旧的状态字符串跑，而服务端已经按新词表校验 —— 这种错只有在运行到一半才出现。
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw "node not found on PATH (needed for contract generation)" }
Push-Location $root
try {
  & $node.Source 'tools/gen-contracts.mjs'
  if ($LASTEXITCODE -ne 0) { throw "contract generation failed with exit code $LASTEXITCODE" }
  # 能力清单从真实分派表生成；手写表已经漂移过两次。
  & $node.Source 'tools/gen-dispatch.mjs'
  if ($LASTEXITCODE -ne 0) { throw "dispatch generation failed with exit code $LASTEXITCODE" }
} finally {
  Pop-Location
}

# Interop assemblies must sit beside both the compiler output and the sources.
# Skip the copy when the same version is already there: an interop assembly that
# is loaded by a running bridge cannot be overwritten, and "the DLL is busy" is
# not a reason to refuse to compile the change under test.
foreach ($name in @('SolidWorks.Interop.sldworks.dll', 'SolidWorks.Interop.swconst.dll')) {
  $from = Join-Path $swDir $name
  if (-not (Test-Path $from)) { throw "missing interop assembly: $from" }
  $dest = Join-Path $bin $name
  $needsCopy = $true
  if (Test-Path $dest) {
    try {
      $needsCopy = (Get-FileHash $from).Hash -ne (Get-FileHash $dest).Hash
    } catch { $needsCopy = $true }
  }
  if ($needsCopy) {
    try {
      Copy-Item $from $dest -Force
    } catch {
      Write-Warning "could not refresh $name (in use); keeping the copy already in bin — it is what the sources compile against"
    }
  }
}
$interop = Join-Path $bin 'SolidWorks.Interop.sldworks.dll'
$consts  = Join-Path $bin 'SolidWorks.Interop.swconst.dll'

# Timestamped output so an in-flight invocation keeps a valid binary while a
# newer build lands; the launcher always picks the newest.
$stamp = [DateTime]::UtcNow.ToString('yyyyMMddHHmmss')
$out = Join-Path $bin "SwBridge-$stamp.exe"

$files = Get-ChildItem -Path $src -Filter *.cs | ForEach-Object { $_.FullName }
if (-not $files) { throw "no sources in $src" }

& $csc -nologo -codepage:65001 -optimize+ -target:exe -out:$out `
  -r:System.Web.Extensions.dll `
  -r:System.Drawing.dll `
  -r:System.Windows.Forms.dll `
  -r:"$interop" -r:"$consts" `
  $files

if ($LASTEXITCODE -ne 0) { throw "csc failed with exit code $LASTEXITCODE" }

# A running SwBridge.exe cannot be overwritten, but it *can* be renamed. Measured:
# while a broker worker was running the old binary, Copy-Item failed with "used by
# another process" and "compiled" silently stopped meaning "deployed" — server.mjs
# kept picking up the old exe and nothing in the logs said so. Rename-away first: it
# is safer than killing the worker (an in-flight call can finish on the old image)
# and more predictable than waiting for the worker to go idle.
#
# NOTE: keep this file ASCII-only. Windows PowerShell 5.1 reads .ps1 as ANSI unless
# there is a BOM, so a non-ASCII comment here turns into parse errors at load time.
$published = Join-Path $bin 'SwBridge.exe'
try {
  Copy-Item $out $published -Force
} catch {
  if (-not (Test-Path -LiteralPath $published)) { throw }
  $retired = Join-Path $bin ("SwBridge-retired-" + [DateTime]::Now.ToString('yyyyMMddHHmmss') + ".exe")
  Write-Warning "SwBridge.exe is in use; renaming it to $(Split-Path -Leaf $retired) before publishing"
  Move-Item $published $retired -Force
  Copy-Item $out $published -Force
}
# Keep bin/ from growing without bound: every publish that lands while an old
# image is still loaded leaves a SwBridge-retired-*.exe behind (24 of them by
# 2026-11-18, 8.8 MB). Keep the two newest retired images (enough to roll back
# one step while a worker still holds the file) and the three newest
# timestamped builds.
Get-ChildItem -Path $bin -Filter 'SwBridge-retired-*.exe' |
  Sort-Object LastWriteTime -Descending |
  Select-Object -Skip 2 |
  ForEach-Object { try { Remove-Item -LiteralPath $_.FullName -Force } catch { Write-Warning "could not remove $($_.Name) (in use)" } }
Get-ChildItem -Path $bin -Filter 'SwBridge-2*.exe' |
  Where-Object { $_.Name -notlike 'SwBridge-retired-*' } |
  Sort-Object LastWriteTime -Descending |
  Select-Object -Skip 3 |
  ForEach-Object { try { Remove-Item -LiteralPath $_.FullName -Force } catch { Write-Warning "could not remove $($_.Name) (in use)" } }
$size = (Get-Item $published).Length
Write-Host "built $out"
Write-Host "published $published ($size bytes)"
