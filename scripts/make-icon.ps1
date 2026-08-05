# Рисует иконку PasteTalk и собирает многоразмерный .ico.
# Один источник правды: если понадобится другой оттенок или форма —
# правим здесь, а не подкладываем картинку руками.

Add-Type -AssemblyName System.Drawing

$Out = Join-Path $PSScriptRoot '..\build'
New-Item -ItemType Directory -Force -Path $Out | Out-Null

$Back   = [System.Drawing.Color]::FromArgb(255, 27, 27, 31)    # #1B1B1F
$Brass  = [System.Drawing.Color]::FromArgb(255, 233, 167, 44)  # #E9A72C
$Edge   = [System.Drawing.Color]::FromArgb(46, 233, 167, 44)

function New-RoundedPath([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $r * 2
    $path.AddArc($x, $y, $d, $d, 180, 90)
    $path.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
    $path.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
    $path.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
    $path.CloseFigure()
    return $path
}

function New-IconBitmap([int]$size, [bool]$Plain = $false, $Ink = $null) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)

    $u = $size / 256.0   # всё считаем в долях от 256, чтобы форма не плыла

    # Значку в трее подложка не нужна: там он живёт на панели задач рядом
    # с системными и должен быть просто силуэтом микрофона.
    if (-not $Plain) {
        $plate = New-RoundedPath 0 0 $size $size (56 * $u)
        $g.FillPath((New-Object System.Drawing.SolidBrush($Back)), $plate)
        # Ширина пера обязана быть Single: от Double PowerShell не найдёт конструктор.
        $pen = New-Object System.Drawing.Pen($Edge, [float][Math]::Max(1.0, 2 * $u))
        $g.DrawPath($pen, $plate)
    }

    $color = if ($null -ne $Ink) { $Ink } else { $Brass }
    $brush = New-Object System.Drawing.SolidBrush($color)
    $stroke = New-Object System.Drawing.Pen($color, [float](16 * $u))
    $stroke.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $stroke.EndCap   = [System.Drawing.Drawing2D.LineCap]::Round

    # капсула микрофона
    $capW = 62 * $u; $capH = 104 * $u
    $capX = ($size - $capW) / 2; $capY = 44 * $u
    $g.FillPath($brush, (New-RoundedPath $capX $capY $capW $capH ($capW / 2)))

    # Дуга-держатель. Её низ приходится на y = arcY + arcSize, и ножка
    # должна начинаться именно оттуда, иначе получается не микрофон, а смайл.
    $arcSize = 124 * $u
    $arcX = ($size - $arcSize) / 2; $arcY = 88 * $u
    $g.DrawArc($stroke, $arcX, $arcY, $arcSize, $arcSize, 20, 140)

    # ножка
    $g.DrawLine($stroke, $size / 2, ($arcY + $arcSize), $size / 2, 236 * $u)

    $g.Dispose()
    return $bmp
}

# ICO с PNG-кадрами внутри: так Windows берёт нужный размер сама.
function Save-Ico($path, $sizes, [bool]$plain, $ink, $pngPath) {
    $frames = @()
    foreach ($size in $sizes) {
        $bmp = New-IconBitmap $size $plain $ink
        $ms = New-Object System.IO.MemoryStream
        $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
        $frames += , @{ size = $size; bytes = $ms.ToArray() }
        if ($pngPath -and $size -eq ($sizes | Measure-Object -Maximum).Maximum) {
            $bmp.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)
        }
        $ms.Dispose(); $bmp.Dispose()
    }

    $fs = [System.IO.File]::Create($path)
    $bw = New-Object System.IO.BinaryWriter($fs)
    $bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]$frames.Count)

    $offset = 6 + 16 * $frames.Count
    foreach ($frame in $frames) {
        $dim = if ($frame.size -ge 256) { 0 } else { $frame.size }
        $bw.Write([byte]$dim); $bw.Write([byte]$dim)
        $bw.Write([byte]0); $bw.Write([byte]0)
        $bw.Write([uint16]1); $bw.Write([uint16]32)
        $bw.Write([uint32]$frame.bytes.Length)
        $bw.Write([uint32]$offset)
        $offset += $frame.bytes.Length
    }
    foreach ($frame in $frames) { $bw.Write($frame.bytes) }
    $bw.Flush(); $bw.Dispose(); $fs.Dispose()
    Write-Output "$([System.IO.Path]::GetFileName($path)): $((Get-Item $path).Length) байт, размеры: $($sizes -join ', ')"
}

# Иконка приложения — на подложке, её видно в меню «Пуск» и на ярлыке.
Save-Ico (Join-Path $Out 'icon.ico') @(256, 128, 64, 48, 32, 16) $false $null (Join-Path $Out 'icon.png')

# Значок в трее — только микрофон. Два варианта под светлую и тёмную
# панель задач: Windows тему панели не сообщает, приложение выбирает само.
$Light = [System.Drawing.Color]::FromArgb(255, 240, 240, 245)
$Dark  = [System.Drawing.Color]::FromArgb(255, 32, 32, 36)
Save-Ico (Join-Path $Out 'tray-light.ico') @(32, 24, 20, 16) $true $Light $null
Save-Ico (Join-Path $Out 'tray-dark.ico')  @(32, 24, 20, 16) $true $Dark  $null
