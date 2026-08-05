# Кладёт снимок панели записи на фон, похожий на рабочий стол.
#
# Сама панель прозрачная, и на белой странице GitHub она выглядела бы
# висящей в пустоте. На подложке сразу видно, что это окошко поверх
# остальных, а не картинка в вакууме.

param(
    [Parameter(Mandatory = $true)][string[]]$Panels,
    [Parameter(Mandatory = $true)][string]$Out,
    [int]$Width = 1000,
    [int]$Pad = 56
)

Add-Type -AssemblyName System.Drawing

$images = @($Panels | ForEach-Object { [System.Drawing.Image]::FromFile((Resolve-Path $_).Path) })
$gap = 28
$height = $Pad * 2 + ($images | Measure-Object Height -Sum).Sum + $gap * ($images.Count - 1)

$bmp = New-Object System.Drawing.Bitmap($Width, $height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic

# Диагональный градиент — спокойный фон, не спорящий с самой панелью.
$rect = New-Object System.Drawing.Rectangle(0, 0, $Width, $height)
$brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    $rect,
    [System.Drawing.Color]::FromArgb(255, 46, 49, 64),
    [System.Drawing.Color]::FromArgb(255, 16, 17, 22),
    45.0)
$g.FillRectangle($brush, $rect)

$y = $Pad
foreach ($image in $images) {
    $x = [int](($Width - $image.Width) / 2)

    # Тень не рисуем: у панели прозрачные поля и скруглённые углы, любая
    # подложка под ней вылезает чёрной рамкой. Своя тень у неё уже есть.
    $g.DrawImage($image, $x, $y, $image.Width, $image.Height)
    $y += $image.Height + $gap
}

$g.Dispose()
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
$images | ForEach-Object { $_.Dispose() }

Write-Output "$Out — $((Get-Item $Out).Length) байт, $Width x $height"
