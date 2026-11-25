param(
  [Parameter(Mandatory=$true)][string]$In,
  [Parameter(Mandatory=$true)][string]$Out,
  [string]$Crop = "",          # "x0,y0,x1,y1" in source pixels
  [double]$Scale = 1.0,
  [int]$Grid = 0,              # 0 = no grid, otherwise grid step in SOURCE pixels
  [int]$Contrast = 0,          # 0..100 stretch towards black/white
  [string]$Tint = "",
  [switch]$Probe               # report the size only, do not write a file
)

# PowerShell 默认按控制台代码页（中文系统上是 GBK）写 stdout，Node 按 utf8 读会把
# 中文路径解成乱码。这一段让本脚本的所有输出都是 UTF-8。
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$OutputEncoding = [Console]::OutputEncoding

# Crops, zooms and (optionally) grids a region of a drawing so an agent can read
# dimension text that is illegible at full-page size. Output is always PNG:
# the MCP image part must be a format clients can display.

Add-Type -AssemblyName System.Drawing
$ErrorActionPreference = 'Stop'

# 扩展名会说谎：实测那张「.png」里装的是 GIF89a。GDI+ 按内容解码，所以图照样取得
# 出来；但别的读图工具会先对扩展名，对不上就整条拒读。这里把文件头里的真实格式
# 报出来（contentFormat / extensionMatchesContent），调用方才知道该不该换一条路。
function Get-ContentFormat([string]$Path) {
  $head = New-Object byte[] 12
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    $read = $stream.Read($head, 0, $head.Length)
  } finally {
    $stream.Dispose()
  }
  if ($read -ge 4 -and $head[0] -eq 0x89 -and $head[1] -eq 0x50 -and $head[2] -eq 0x4E -and $head[3] -eq 0x47) { return 'png' }
  if ($read -ge 4 -and $head[0] -eq 0x47 -and $head[1] -eq 0x49 -and $head[2] -eq 0x46 -and $head[3] -eq 0x38) { return 'gif' }
  if ($read -ge 3 -and $head[0] -eq 0xFF -and $head[1] -eq 0xD8 -and $head[2] -eq 0xFF) { return 'jpeg' }
  if ($read -ge 2 -and $head[0] -eq 0x42 -and $head[1] -eq 0x4D) { return 'bmp' }
  if ($read -ge 12 -and $head[0] -eq 0x52 -and $head[1] -eq 0x49 -and $head[2] -eq 0x46 -and $head[3] -eq 0x46 -and $head[8] -eq 0x57 -and $head[9] -eq 0x45 -and $head[10] -eq 0x42 -and $head[11] -eq 0x50) { return 'webp' }
  if ($read -ge 4 -and (($head[0] -eq 0x49 -and $head[1] -eq 0x49 -and $head[2] -eq 0x2A -and $head[3] -eq 0x00) -or ($head[0] -eq 0x4D -and $head[1] -eq 0x4D -and $head[2] -eq 0x00 -and $head[3] -eq 0x2A))) { return 'tiff' }
  return 'unknown'
}

function Get-ExtensionFormat([string]$Path) {
  $ext = [System.IO.Path]::GetExtension($Path)
  if ([string]::IsNullOrEmpty($ext)) { return 'unknown' }
  switch ($ext.ToLowerInvariant()) {
    '.png' { return 'png' }
    '.gif' { return 'gif' }
    '.jpg' { return 'jpeg' }
    '.jpeg' { return 'jpeg' }
    '.jpe' { return 'jpeg' }
    '.bmp' { return 'bmp' }
    '.webp' { return 'webp' }
    '.tif' { return 'tiff' }
    '.tiff' { return 'tiff' }
    default { return 'unknown' }
  }
}

$contentFormat = Get-ContentFormat $In
$extensionFormat = Get-ExtensionFormat $In
# 两边都认得才敢说「不符」：扩展名是 .psd 这种不认识的，不算说谎。
$extensionMatchesContent = -not ($contentFormat -ne 'unknown' -and $extensionFormat -ne 'unknown' -and $contentFormat -ne $extensionFormat)

$src = [System.Drawing.Bitmap]::FromFile($In)
try {
  if ($Probe) {
    [pscustomobject]@{ ok = $true; source = $In; width = $src.Width; height = $src.Height; contentFormat = $contentFormat; extensionMatchesContent = $extensionMatchesContent } | ConvertTo-Json -Compress
    return
  }
  $x0 = 0; $y0 = 0; $w = $src.Width; $h = $src.Height
  if ($Crop -ne "") {
    $p = $Crop.Split(',')
    if ($p.Count -ne 4) { throw "Crop must be x0,y0,x1,y1" }
    $x0 = [int]$p[0]; $y0 = [int]$p[1]
    $w = [int]$p[2] - $x0; $h = [int]$p[3] - $y0
  }
  if ($w -le 0 -or $h -le 0) { throw "empty crop rectangle" }
  # Clamp instead of failing: an agent guessing a box slightly outside the page
  # should still get the part of it that exists.
  if ($x0 -lt 0) { $w += $x0; $x0 = 0 }
  if ($y0 -lt 0) { $h += $y0; $y0 = 0 }
  if ($x0 + $w -gt $src.Width) { $w = $src.Width - $x0 }
  if ($y0 + $h -gt $src.Height) { $h = $src.Height - $y0 }
  if ($w -le 0 -or $h -le 0) { throw "crop rectangle lies outside the image" }

  $ow = [int][Math]::Round($w * $Scale)
  $oh = [int][Math]::Round($h * $Scale)

  $dst = New-Object System.Drawing.Bitmap $ow, $oh, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $g = [System.Drawing.Graphics]::FromImage($dst)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.Clear([System.Drawing.Color]::White)
  $rectSrc = New-Object System.Drawing.Rectangle $x0, $y0, $w, $h
  $rectDst = New-Object System.Drawing.Rectangle 0, 0, $ow, $oh

  $attrs = $null
  if ($Contrast -gt 0) {
    # A levels stretch: faded scans read much better as near-black-on-white.
    $c = [Math]::Min(1.0, $Contrast / 100.0)
    $s = 1.0 + 3.0 * $c
    $t = (1.0 - $s) / 2.0 - 0.08 * $c
    $attrs = New-Object System.Drawing.Imaging.ImageAttributes
    $cm = New-Object System.Drawing.Imaging.ColorMatrix
    $cm.Matrix00 = $s; $cm.Matrix11 = $s; $cm.Matrix22 = $s
    $cm.Matrix33 = 1.0
    $cm.Matrix40 = $t; $cm.Matrix41 = $t; $cm.Matrix42 = $t
    $attrs.SetColorMatrix($cm)
    $g.DrawImage($src, $rectDst, $x0, $y0, $w, $h, [System.Drawing.GraphicsUnit]::Pixel, $attrs)
  } else {
    $g.DrawImage($src, $rectDst, $rectSrc, [System.Drawing.GraphicsUnit]::Pixel)
  }

  if ($Grid -gt 0) {
    $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(90, 220, 30, 30)), 1
    $font = New-Object System.Drawing.Font "Consolas", 9
    $brush = [System.Drawing.Brushes]::DarkRed
    # Grid lines are labelled with SOURCE pixel coordinates, so a reading taken
    # off the zoomed image maps straight back without mental arithmetic.
    $sx = [Math]::Ceiling($x0 / $Grid) * $Grid
    while ($sx -lt $x0 + $w) {
      $ix = [int](($sx - $x0) * $Scale)
      $g.DrawLine($pen, $ix, 0, $ix, $oh)
      $g.DrawString([string]$sx, $font, $brush, $ix + 1, 1)
      $sx += $Grid
    }
    $sy = [Math]::Ceiling($y0 / $Grid) * $Grid
    while ($sy -lt $y0 + $h) {
      $iy = [int](($sy - $y0) * $Scale)
      $g.DrawLine($pen, 0, $iy, $ow, $iy)
      $g.DrawString([string]$sy, $font, $brush, 1, $iy + 1)
      $sy += $Grid
    }
    $pen.Dispose(); $font.Dispose()
  }

  $g.Dispose()
  $dst.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
  $dst.Dispose()

  $json = [ordered]@{
    ok = $true
    source = $In
    output = $Out
    sourceWidth = $src.Width
    sourceHeight = $src.Height
    crop = @($x0, $y0, ($x0 + $w), ($y0 + $h))
    scale = $Scale
    width = $ow
    height = $oh
    # How to turn a pixel in the output back into a pixel in the source.
    map = "srcX = $x0 + imgX / $Scale ; srcY = $y0 + imgY / $Scale"
    contentFormat = $contentFormat
    extensionMatchesContent = $extensionMatchesContent
  }
  $json | ConvertTo-Json -Compress
}
finally {
  $src.Dispose()
}
