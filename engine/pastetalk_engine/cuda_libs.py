"""Библиотеки CUDA для видеокарты: cuBLAS и cuDNN.

Официальные колёса ctranslate2 математику NVIDIA с собой не возят, и
сборка уезжала к людям без неё: модель «загружалась» на видеокарту
(веса копируются и без cuBLAS), а падало только первое умножение —
уже посреди диктовки. Работало только у тех, у кого системно стоит
CUDA Toolkit — то есть у разработчика.

Класть ~0.9 ГБ DLL в установщик — заставить качать их всех, включая
людей без видеокарты. Поэтому докачиваем по требованию, один раз,
с прогрессом — ровно как модели. Источник — колёса PyPI: они
версионированы, подписаны и не завязаны на huggingface.
"""

from __future__ import annotations

import ctypes
import json
import os
import urllib.request
import zipfile

# Whisper в ctranslate2 4.8 обходится одним cuBLAS: проверено на живой
# машине, где полного cuDNN нет, а распознавание на CUDA работает.
# Полный cuDNN (ещё 700 МБ) докачивается отдельно и только если
# предполётная проверка explicitly об этом попросит.
PROBES_BLAS = ("cublas64_12.dll", "cublasLt64_12.dll")
PROBES_DNN = ("cudnn_ops64_9.dll",)

PACKAGE_BLAS = ("nvidia-cublas-cu12", 530.0)
PACKAGE_DNN = ("nvidia-cudnn-cu12", 705.0)


def libs_dir(cache_dir: str | None) -> str:
    return os.path.join(cache_dir or ".", "cuda-libs")


def _loadable(name: str) -> bool:
    try:
        # winmode=0 — классический порядок поиска, включая PATH: именно
        # так свои зависимости ищет и сам ctranslate2. Python 3.8+ по
        # умолчанию PATH игнорирует, и проверка была бы строже реальности:
        # у людей с системным CUDA Toolkit она бы зря качала 900 МБ.
        ctypes.WinDLL(name, winmode=0)
        return True
    except OSError:
        return False


def _hook(cache_dir: str | None) -> None:
    """Подцепить папку докачанных библиотек к поиску DLL."""
    folder = libs_dir(cache_dir)
    if os.path.isdir(folder):
        try:
            os.add_dll_directory(folder)
            os.environ["PATH"] = folder + os.pathsep + os.environ.get("PATH", "")
        except OSError:
            pass


def ready(cache_dir: str | None) -> bool:
    """Есть ли cuBLAS — свой докачанный или системный."""
    _hook(cache_dir)
    return all(_loadable(name) for name in PROBES_BLAS)


def cudnn_ready(cache_dir: str | None) -> bool:
    _hook(cache_dir)
    return all(_loadable(name) for name in PROBES_DNN)


def _wheel_url(package: str) -> tuple[str, int]:
    """Свежее win_amd64-колесо пакета с PyPI: адрес и размер."""
    with urllib.request.urlopen(f"https://pypi.org/pypi/{package}/json", timeout=30) as reply:
        data = json.loads(reply.read().decode("utf-8"))
    for entry in reversed(data["urls"]):
        if entry["filename"].endswith("win_amd64.whl"):
            return entry["url"], int(entry.get("size") or 0)
    raise RuntimeError(f"У пакета {package} не нашлось колеса под Windows")


def _fetch(package: str, guess_mb: float, cache_dir: str | None, state) -> None:
    """Скачать колесо и вынуть из него DLL — с прогрессом, как у моделей."""
    folder = libs_dir(cache_dir)
    os.makedirs(folder, exist_ok=True)

    state.state = "downloading"
    state.progress = 0.0
    state.downloaded_mb = 0.0

    url, size = _wheel_url(package)
    total_bytes = float(size or guess_mb * 1048576)
    wheel_path = os.path.join(folder, "_wheel.tmp")
    request = urllib.request.Request(url, headers={"User-Agent": "PasteTalk"})
    done_bytes = 0
    with urllib.request.urlopen(request, timeout=60) as reply, open(wheel_path, "wb") as out:
        while True:
            piece = reply.read(1024 * 1024)
            if not piece:
                break
            out.write(piece)
            done_bytes += len(piece)
            state.downloaded_mb = done_bytes / 1048576
            state.progress = min(done_bytes / total_bytes, 0.99)

    # Колесо — обычный zip: вынимаем только DLL, остальное не нужно.
    with zipfile.ZipFile(wheel_path) as wheel:
        for entry in wheel.namelist():
            if entry.lower().endswith(".dll"):
                target = os.path.join(folder, os.path.basename(entry))
                with wheel.open(entry) as src, open(target, "wb") as dst:
                    dst.write(src.read())
    os.remove(wheel_path)


def ensure(cache_dir: str | None, state) -> None:
    """cuBLAS должен быть на месте. Долго — только в первый раз."""
    if ready(cache_dir):
        return
    _fetch(*PACKAGE_BLAS, cache_dir, state)
    if not ready(cache_dir):
        raise RuntimeError(
            "Библиотеки CUDA скачались, но не подхватились. "
            "Переключитесь на процессор — а это, похоже, наш баг."
        )


def ensure_cudnn(cache_dir: str | None, state) -> None:
    """Полный cuDNN — редкий гость: качаем, лишь когда явно попросили."""
    if cudnn_ready(cache_dir):
        return
    _fetch(*PACKAGE_DNN, cache_dir, state)
