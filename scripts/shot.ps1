# Снимок окна по заголовку — чтобы смотреть на настоящее приложение,
# а не на макет в браузере.
param(
    [string]$Title = '',
    [string]$Process = 'electron',
    [string]$Out = "$env:TEMP\pastetalk-shot.png"
)

Add-Type -AssemblyName System.Drawing, System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class Win {
    [DllImport("user32.dll")] public static extern IntPtr FindWindow(string cls, string name);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
    [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hWnd, int attr, out RECT rect, int size);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    public delegate bool EnumProc(IntPtr h, IntPtr p);
}
'@

# Ищем окно по процессу, а не по заголовку: слово «Настройки» есть у
# половины программ в системе, и по нему легко снять чужое окно.
$pids = @(Get-Process -Name $Process -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
if (-not $pids) { Write-Output "процесс '$Process' не запущен"; exit 1 }

$found = [IntPtr]::Zero
$matched = ''
$callback = [Win+EnumProc] {
    param($handle, $param)
    if (-not [Win]::IsWindowVisible($handle)) { return $true }
    $owner = 0
    [void][Win]::GetWindowThreadProcessId($handle, [ref]$owner)
    if ($pids -notcontains [int]$owner) { return $true }

    $sb = New-Object System.Text.StringBuilder 512
    [void][Win]::GetWindowText($handle, $sb, 512)
    $text = $sb.ToString()
    if (-not $text) { return $true }
    if ($Title -and ($text -notlike "*$Title*")) { return $true }
    $script:found = $handle
    $script:matched = $text
    return $false
}
[void][Win]::EnumWindows($callback, [IntPtr]::Zero)

if ($found -eq [IntPtr]::Zero) { Write-Output "у процесса '$Process' нет подходящего окна"; exit 1 }

[void][Win]::ShowWindow($found, 5)
Start-Sleep -Milliseconds 500

$rect = New-Object Win+RECT
# DWMWA_EXTENDED_FRAME_BOUNDS = 9: без него в кадр попадают невидимые поля тени.
[void][Win]::DwmGetWindowAttribute($found, 9, [ref]$rect, 16)
$w = $rect.R - $rect.L
$h = $rect.B - $rect.T
if ($w -le 0 -or $h -le 0) { Write-Output 'окно свёрнуто'; exit 1 }

# Рисуем содержимое самого окна, а не участок экрана: снимок не зависит от
# того, что лежит сверху, и в кадр не попадает ничего постороннего.
$bmp = New-Object System.Drawing.Bitmap($w, $h)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
$ok = [Win]::PrintWindow($found, $hdc, 2)   # PW_RENDERFULLCONTENT
$g.ReleaseHdc($hdc)
$g.Dispose()
if (-not $ok) { Write-Output 'PrintWindow не отдал содержимое'; exit 1 }
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output "снято '$matched' → $Out ($w x $h)"
