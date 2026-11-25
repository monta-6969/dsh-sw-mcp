param(
    [Parameter(Mandatory=$true)][string]$Left,
    [Parameter(Mandatory=$true)][string]$Right,
    [Parameter(Mandatory=$true)][string]$Out,
    [string]$LabelLeft = "",
    [string]$LabelRight = "",
    [int]$Height = 900,
    [int]$Gap = 24,
    [string]$Caption = ""
)

# PowerShell 默认按控制台代码页（中文系统上是 GBK）写 stdout，Node 按 utf8 读会把
# 中文路径解成乱码。这一段让本脚本的所有输出都是 UTF-8。
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$OutputEncoding = [Console]::OutputEncoding
Add-Type -AssemblyName System.Drawing

$leftImg = [System.Drawing.Bitmap]::FromFile($Left)
$rightImg = [System.Drawing.Bitmap]::FromFile($Right)

$targetHeight = [double]$Height
$lw = [int][math]::Max(1, [math]::Round([double]$leftImg.Width * ($targetHeight / [double]$leftImg.Height)))
$rw = [int][math]::Max(1, [math]::Round([double]$rightImg.Width * ($targetHeight / [double]$rightImg.Height)))
$lh = $Height
$rh = $Height

$pad = 16
$labelH = 46
$captionH = 0
if ($Caption -ne "") { $captionH = 44 }
$width = $pad * 2 + $lw + $Gap + $rw
$contentH = $pad + $labelH + $Height + $pad + $captionH

$bmp = New-Object System.Drawing.Bitmap($width, $contentH)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.Clear([System.Drawing.Color]::FromArgb(250, 250, 250))

$titleFont = New-Object System.Drawing.Font("Segoe UI", 15, [System.Drawing.FontStyle]::Bold)
$captionFont = New-Object System.Drawing.Font("Segoe UI", 12, [System.Drawing.FontStyle]::Regular)
$brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(40, 40, 40))
$muted = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(110, 110, 110))
$pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(205, 205, 205), 1)

if ($Caption -ne "") { $g.DrawString($Caption, $captionFont, $muted, $pad, $pad) }
if ($LabelLeft -ne "") { $g.DrawString($LabelLeft, $titleFont, $brush, $pad, $pad + $captionH) }
if ($LabelRight -ne "") { $g.DrawString($LabelRight, $titleFont, $brush, ($pad + $lw + $Gap), ($pad + $captionH)) }

$imgY = $pad + $captionH + $labelH
$rectLeft = New-Object System.Drawing.Rectangle($pad, $imgY, $lw, $lh)
$rectRight = New-Object System.Drawing.Rectangle(($pad + $lw + $Gap), $imgY, $rw, $rh)
$g.DrawImage($leftImg, $rectLeft)
$g.DrawImage($rightImg, $rectRight)
$g.DrawRectangle($pen, $pad, $imgY, ($lw - 1), ($lh - 1))
$g.DrawRectangle($pen, ($pad + $lw + $Gap), $imgY, ($rw - 1), ($rh - 1))

$dir = [System.IO.Path]::GetDirectoryName($Out)
if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)

$g.Dispose()
$bmp.Dispose()
$pen.Dispose()
$brush.Dispose()
$muted.Dispose()
$titleFont.Dispose()
$captionFont.Dispose()
$leftImg.Dispose()
$rightImg.Dispose()

[pscustomobject]@{
    ok = $true
    output = $Out
    left = $Left
    right = $Right
    leftSize = @($lw, $lh)
    rightSize = @($rw, $rh)
    width = $width
    height = $contentH
} | ConvertTo-Json -Compress
