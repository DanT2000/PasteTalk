"""Загрузка и хранение моделей Whisper.

Модель живёт в памяти между записями: её загрузка занимает секунды,
и делать это на каждое нажатие горячей клавиши нельзя.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass, field
from typing import Any

import ctranslate2
from faster_whisper import WhisperModel

# Что показываем человеку в настройках. Размер — сколько займёт на диске.
CATALOG: dict[str, dict[str, Any]] = {
    "large-v3": {"repo": "Systran/faster-whisper-large-v3", "size_mb": 3090, "title": "Large-v3"},
    "medium":   {"repo": "Systran/faster-whisper-medium",   "size_mb": 1530, "title": "Medium"},
    "small":    {"repo": "Systran/faster-whisper-small",    "size_mb": 484,  "title": "Small"},
    "base":     {"repo": "Systran/faster-whisper-base",     "size_mb": 145,  "title": "Base"},
    "tiny":     {"repo": "Systran/faster-whisper-tiny",     "size_mb": 75,   "title": "Tiny"},
}

DEFAULT_MODEL = "large-v3"


def available_devices() -> list[dict[str, Any]]:
    """Что есть на этой машине для счёта."""
    devices = [{"id": "cpu", "title": "Процессор", "computeTypes": sorted(ctranslate2.get_supported_compute_types("cpu"))}]
    try:
        count = ctranslate2.get_cuda_device_count()
    except Exception:
        count = 0
    if count > 0:
        try:
            types = sorted(ctranslate2.get_supported_compute_types("cuda"))
        except Exception:
            types = []
        devices.insert(0, {"id": "cuda", "title": "Видеокарта (CUDA)", "computeTypes": types, "count": count})
    return devices


def default_compute_type(device: str) -> str:
    """Лучшее из доступного: на видеокарте float16, на процессоре int8."""
    try:
        supported = ctranslate2.get_supported_compute_types(device)
    except Exception:
        supported = set()
    for candidate in (("float16", "int8_float16") if device == "cuda" else ("int8", "float32")):
        if candidate in supported:
            return candidate
    return "default"


@dataclass
class ModelState:
    name: str = DEFAULT_MODEL
    device: str = "cuda"
    compute_type: str = ""
    state: str = "idle"          # idle | downloading | loading | ready | error
    progress: float = 0.0        # 0..1, пока качается
    downloaded_mb: float = 0.0
    error: str = ""
    lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def as_dict(self) -> dict[str, Any]:
        catalog = CATALOG.get(self.name, {})
        return {
            "name": self.name,
            "title": catalog.get("title", self.name),
            "device": self.device,
            "computeType": self.compute_type,
            "state": self.state,
            "progress": round(self.progress, 4),
            "downloadedMb": round(self.downloaded_mb, 1),
            "sizeMb": catalog.get("size_mb", 0),
            "error": self.error,
        }


class ModelManager:
    """Одна загруженная модель на процесс, смена — по запросу из настроек."""

    def __init__(self, cache_dir: str | None = None) -> None:
        self.cache_dir = cache_dir
        self.state = ModelState()
        self._model: WhisperModel | None = None
        self._transcribe_lock = threading.Lock()

    # ---------- сведения ----------

    def status(self) -> dict[str, Any]:
        return self.state.as_dict()

    def is_ready(self) -> bool:
        return self._model is not None and self.state.state == "ready"

    def is_cached(self, name: str) -> bool:
        """Лежит ли модель уже на диске — чтобы не тянуть её заново."""
        from huggingface_hub import try_to_load_from_cache

        repo = CATALOG.get(name, {}).get("repo")
        if not repo:
            return False
        found = try_to_load_from_cache(repo, "model.bin", cache_dir=self.cache_dir)
        return isinstance(found, str)

    # ---------- загрузка ----------

    def request(self, name: str, device: str, compute_type: str = "") -> None:
        """Поставить модель в работу. Возвращается сразу, грузит в фоне."""
        name = name if name in CATALOG else DEFAULT_MODEL
        if device not in ("cuda", "cpu"):
            device = "cpu"
        if device == "cuda" and not any(d["id"] == "cuda" for d in available_devices()):
            device = "cpu"
        compute_type = compute_type or default_compute_type(device)

        same = (
            self.is_ready()
            and self.state.name == name
            and self.state.device == device
            and self.state.compute_type == compute_type
        )
        if same:
            return

        self.state.name = name
        self.state.device = device
        self.state.compute_type = compute_type
        self.state.error = ""
        self.state.progress = 0.0
        self.state.state = "loading"
        threading.Thread(target=self._load, args=(name, device, compute_type), daemon=True).start()

    def _load(self, name: str, device: str, compute_type: str) -> None:
        with self.state.lock:
            try:
                if not self.is_cached(name):
                    self.state.state = "downloading"
                    self._download(name)
                self.state.state = "loading"
                self._model = WhisperModel(
                    name,
                    device=device,
                    compute_type=compute_type,
                    download_root=self.cache_dir,
                )
                self.state.state = "ready"
                self.state.progress = 1.0
            except Exception as exc:  # noqa: BLE001 — наружу уходит текстом
                self._model = None
                self.state.state = "error"
                self.state.error = _friendly_error(exc, device)

    def _download(self, name: str) -> None:
        """Тянем модель с прогрессом, чтобы окно не выглядело зависшим."""
        from huggingface_hub import snapshot_download

        state = self.state
        total_mb = float(CATALOG[name]["size_mb"]) or 1.0

        class Reporter:
            """Подделка под tqdm: huggingface_hub рисует им прогресс.

            Нам от него нужны только байты, но hub дёргает у полосы разные
            методы и поля, и набор их меняется от версии к версии. Поэтому
            всё незнакомое гасим через __getattr__, а не перечисляем руками —
            иначе очередное обновление hub снова уронит скачивание.
            """

            def __init__(self, *_args, **kwargs) -> None:
                self.total = kwargs.get("total") or 0
                self.n = 0
                self.desc = kwargs.get("desc", "")
                self.disable = True
                self.format_dict = {"rate": None, "n": 0, "total": self.total, "elapsed": 0}

            def update(self, amount: int = 1) -> None:
                self.n += amount
                self.format_dict["n"] = self.n
                state.downloaded_mb += amount / (1024 * 1024)
                state.progress = min(state.downloaded_mb / total_mb, 0.999)

            def close(self) -> None:
                pass

            def __enter__(self):
                return self

            def __exit__(self, *_exc) -> None:
                pass

            def __getattr__(self, _name):
                return lambda *_a, **_k: None

        state.downloaded_mb = 0.0
        snapshot_download(
            CATALOG[name]["repo"],
            cache_dir=self.cache_dir,
            allow_patterns=["*.bin", "*.json", "*.txt", "*.model"],
            tqdm_class=Reporter,
        )

    def remove(self, name: str) -> float:
        """Удалить скачанную модель. Возвращает освободившиеся мегабайты."""
        import shutil

        from huggingface_hub import scan_cache_dir

        repo = CATALOG.get(name, {}).get("repo")
        if not repo:
            raise ValueError("Такой модели нет в списке")
        if self.state.name == name and self._model is not None:
            # Освобождаем видеопамять до удаления файлов, иначе Windows
            # не даст стереть то, что ещё открыто процессом.
            self._model = None
            self.state.state = "idle"

        freed = 0.0
        try:
            cache = scan_cache_dir(self.cache_dir) if self.cache_dir else scan_cache_dir()
            for item in cache.repos:
                if item.repo_id == repo:
                    freed = item.size_on_disk / (1024 * 1024)
                    shutil.rmtree(item.repo_path, ignore_errors=True)
        except Exception:
            pass
        return freed

    # ---------- распознавание ----------

    def transcribe(self, audio, **options):
        """Один проход по куску звука. Модель не потокобезопасна — очередь."""
        if self._model is None:
            raise RuntimeError("MODEL_NOT_READY")
        with self._transcribe_lock:
            segments, info = self._model.transcribe(audio, **options)
            return list(segments), info


def _friendly_error(exc: Exception, device: str) -> str:
    """Понятная причина вместо трассировки — её человек и увидит в окне."""
    text = str(exc)
    lowered = text.lower()
    if "cudnn" in lowered or "cublas" in lowered:
        return (
            "Видеокарта найдена, но не хватает библиотек CUDA (cuDNN/cuBLAS). "
            "Переключитесь на процессор или доустановите их."
        )
    if "out of memory" in lowered:
        return "Модели не хватило видеопамяти. Возьмите модель поменьше или переключитесь на процессор."
    if "connection" in lowered or "resolve" in lowered or "timed out" in lowered:
        return "Не получилось скачать модель: нет связи с интернетом."
    if device == "cuda" and "cuda" in lowered:
        return f"Видеокарта не отвечает: {text}"
    return text
