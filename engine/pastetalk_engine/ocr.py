"""Распознавание текста на картинках средствами Windows.

Берём то, что уже стоит в системе: Windows.Media.Ocr. Он работает без
интернета, знает языки, установленные в Windows, и справляется за доли
секунды — тащить ради этого Tesseract с наборами данных незачем.

Почему это живёт в движке, а не в приложении: из основного процесса
Electron асинхронные вызовы WinRT падают с AggregateException, а из
обычного процесса — работают. Движок как раз обычный процесс, и заодно
всё распознавание, речи и текста, оказывается в одном месте.
"""

from __future__ import annotations

import os
import subprocess
import tempfile

_SCRIPT = r"""
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.StorageFile, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null

$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]

function Await($operation, $type) {
    $task = $asTask.MakeGenericMethod($type).Invoke($null, @($operation))
    [void]$task.Wait(-1)
    $task.Result
}

if ($env:PT_MODE -eq 'languages') {
    $out = New-Object System.Text.StringBuilder
    foreach ($lang in [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages) {
        [void]$out.AppendLine($lang.LanguageTag + '|' + $lang.DisplayName)
    }
    [System.IO.File]::WriteAllText($env:PT_RESULT, $out.ToString(), [System.Text.UTF8Encoding]::new($false))
    exit 0
}

# Картинку читаем сами и подсовываем как поток в памяти.
# StorageFile.GetFileFromPathAsync ходит через брокер Windows, и когда
# процесс запущен из приложения, этот путь отваливается с
# AggregateException. Чтению байтов .NET брокер не нужен.
$bytes = [System.IO.File]::ReadAllBytes($env:PT_IMAGE)
$stream = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
$writer = New-Object Windows.Storage.Streams.DataWriter($stream)
$writer.WriteBytes($bytes)
[void](Await ($writer.StoreAsync()) ([uint32]))
[void]$writer.DetachStream()
$writer.Dispose()
[void]$stream.Seek(0)

$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])

$engine = if ($env:PT_OCR_LANG) {
    [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new($env:PT_OCR_LANG))
} else {
    [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
}
if (-not $engine) {
    [System.IO.File]::WriteAllText($env:PT_RESULT, 'PT_NO_ENGINE', [System.Text.UTF8Encoding]::new($false))
    exit 0
}

$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
$out = New-Object System.Text.StringBuilder
foreach ($line in $result.Lines) { [void]$out.AppendLine($line.Text) }
[System.IO.File]::WriteAllText($env:PT_RESULT, $out.ToString(), [System.Text.UTF8Encoding]::new($false))
"""

_script_path: str | None = None


def _script() -> str:
    """Скрипт кладём во временный файл: -EncodedCommand ломает WinRT."""
    global _script_path
    if _script_path and os.path.exists(_script_path):
        return _script_path
    directory = os.path.join(tempfile.gettempdir(), "pastetalk")
    os.makedirs(directory, exist_ok=True)
    path = os.path.join(directory, "pastetalk-ocr.ps1")
    # BOM обязателен: без него PowerShell 5.1 читает файл как ANSI.
    with open(path, "w", encoding="utf-8-sig") as handle:
        handle.write(_SCRIPT)
    _script_path = path
    return path


def _run(mode: str, image: str = "", language: str = "", timeout: float = 60.0) -> str:
    result_path = os.path.join(tempfile.gettempdir(), "pastetalk", f"ocr-{os.getpid()}-{id(mode)}.txt")
    env = dict(os.environ, PT_MODE=mode, PT_IMAGE=image, PT_OCR_LANG=language, PT_RESULT=result_path)

    process = subprocess.run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-STA",
         "-ExecutionPolicy", "Bypass", "-File", _script()],
        capture_output=True,
        env=env,
        timeout=timeout,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )

    try:
        with open(result_path, encoding="utf-8") as handle:
            text = handle.read()
        os.remove(result_path)
    except OSError:
        text = ""

    if not text and process.returncode != 0:
        detail = process.stderr.decode("utf-8", "replace").strip().splitlines()
        raise RuntimeError(detail[-1] if detail else f"PowerShell вернул код {process.returncode}")
    return text


def languages() -> list[dict[str, str]]:
    """Какие языки Windows умеет читать на этой машине."""
    try:
        raw = _run("languages", timeout=30)
    except Exception:
        return []
    found = []
    for line in raw.splitlines():
        if "|" in line:
            tag, title = line.split("|", 1)
            found.append({"tag": tag.strip(), "title": title.strip()})
    return found


def recognize(path: str, language: str = "") -> str:
    if not os.path.isfile(path):
        raise ValueError("Файл не найден")
    text = _run("recognize", image=path, language=language)
    if text.strip() == "PT_NO_ENGINE":
        raise RuntimeError(
            "Windows не умеет распознавать этот язык. Добавьте его в параметрах языка и региона."
        )
    return text.replace("\r\n", "\n").strip()
