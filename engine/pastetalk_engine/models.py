"""Загрузка и хранение моделей Whisper.

Модель живёт в памяти между записями: её загрузка занимает секунды,
и делать это на каждое нажатие горячей клавиши нельзя.
"""

from __future__ import annotations

import gc
import os
import threading
import time
from dataclasses import dataclass, field
from typing import Any

import ctranslate2
import numpy as np
from faster_whisper import WhisperModel

from . import cuda_libs

# Что показываем человеку в настройках. Размер — сколько займёт на диске.
CATALOG: dict[str, dict[str, Any]] = {
    "large-v3": {"repo": "Systran/faster-whisper-large-v3", "size_mb": 3090, "title": "Large-v3"},
    # Turbo: точность почти как у large-v3, а весит и считает как medium.
    # Отдельно ценна тем, кто делит видеокарту с играми или сидит на CPU.
    "large-v3-turbo": {"repo": "deepdml/faster-whisper-large-v3-turbo-ct2", "size_mb": 1620, "title": "Large-v3 Turbo"},
    "medium":   {"repo": "Systran/faster-whisper-medium",   "size_mb": 1530, "title": "Medium"},
    "small":    {"repo": "Systran/faster-whisper-small",    "size_mb": 484,  "title": "Small"},
    "base":     {"repo": "Systran/faster-whisper-base",     "size_mb": 145,  "title": "Base"},
    "tiny":     {"repo": "Systran/faster-whisper-tiny",     "size_mb": 75,   "title": "Tiny"},
}

MIN_IDLE_MS = 20_000
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
        self._wanted = 0
        # Через сколько простоя отпускать видеопамять. 0 — сразу после
        # работы, отрицательное — держать всегда.
        self._idle_ms = -1
        self._used_at = 0.0
        self._sleeping = False
        # Сколько расшифровок идёт прямо сейчас. Отпускать память под
        # работающей моделью нельзя: остальные куски диктовки упали бы на
        # пустом месте, а память всё равно бы не освободилась — на объект
        # ещё ссылается работающий вызов.
        self._busy = 0
        self._wake_lock = threading.Lock()
        self._count_lock = threading.Lock()
        threading.Thread(target=self._sweep_idle, daemon=True).start()
        self._model: WhisperModel | None = None
        # Устройство модели, которая реально лежит в памяти. state.device
        # меняется в момент запроса на переключение, то есть раньше самой
        # подмены — а ширину луча надо выбирать по тому, кто будет считать.
        self._loaded_device = ""
        self._transcribe_lock = threading.Lock()
        # Скачивания впрок: человек тянет вторую модель, пока первая
        # работает. Выбор и скачивание — независимые действия, поэтому
        # у каждой закачки свой прогресс, а state текущей модели не трогается.
        self._downloads: dict[str, dict[str, Any]] = {}
        self._downloads_lock = threading.Lock()

    # ---------- сведения ----------

    def status(self) -> dict[str, Any]:
        return self.state.as_dict()

    def loaded_device(self) -> str:
        """Устройство модели, реально лежащей в памяти. Пусто — не грузилась."""
        return self._loaded_device

    def is_ready(self) -> bool:
        """Может ли движок обслужить запрос.

        Не «лежит ли модель в памяти»: отпущенная по простою модель
        грузится обратно за секунды, и отказывать в записи из-за этого
        значило бы наказывать человека за бережливость. Модель, которая
        прямо сейчас грузится, — тоже не отказ: звук записи копится, а
        расшифровка в ensure_loaded() дождётся конца загрузки. Раньше
        нажатие клавиши в первые секунды после запуска кончалось голым
        MODEL_NOT_READY в журнале ошибок.
        """
        if self._model is not None and self.state.state == "ready":
            return True
        if self.state.state == "loading":
            return True
        return self._sleeping and self.is_cached(self.state.name)

    def set_idle_unload(self, ms: int) -> None:
        """Сколько ждать простоя перед тем, как отпустить видеопамять."""
        self._idle_ms = int(ms)
        self._used_at = time.time()

    def release(self) -> None:
        """Отпустить видеопамять, оставшись готовым загрузиться заново."""
        with self.state.lock:
            if self._model is None or self._busy:
                return
            self._model = None
        self._sleeping = True
        self.state.state = "sleeping"
        gc.collect()

    def _sweep_idle(self) -> None:
        """Не пользовались достаточно долго — отпускаем память.

        Ноль в настройке значит «сразу, как закончили», а не «всегда»:
        иначе пауза посреди речи стоила бы полной перезагрузки модели.
        Поэтому даже при нуле ждём небольшую паузу после последней работы.
        """
        while True:
            time.sleep(2)
            if self._idle_ms < 0 or self._model is None or self._busy:
                continue
            waited = (time.time() - self._used_at) * 1000
            if waited >= max(self._idle_ms, MIN_IDLE_MS):
                self.release()

    def ensure_loaded(self) -> None:
        """Загрузить модель, если её отпустили. Ждём — это секунды."""
        self._used_at = time.time()
        if self._model is not None:
            return
        # Модель уже в пути — запуск приложения или смена в настройках.
        # Дожидаемся, а не отказываем: загрузка занимает секунды, и человек,
        # нажавший клавишу сразу после старта, не должен получать ошибку.
        while self._model is None and self.state.state in ("downloading", "loading"):
            time.sleep(0.2)
        if self._model is not None:
            self._used_at = time.time()
            return
        if not self._sleeping:
            raise RuntimeError(self.state.error or "MODEL_NOT_READY")
        with self._wake_lock:
            if self._model is not None:
                return
            name = self.state.name
            device = self.state.device
            compute = self.state.compute_type
            self.state.state = "loading"
            with self._count_lock:
                self._wanted += 1
                wanted = self._wanted
            self._load(name, device, compute, wanted)
            # Не загрузилось — остаёмся спящими, чтобы попробовать ещё раз.
            # Иначе один CUDA out of memory запирал бы диктовку насовсем.
            self._sleeping = self._model is None
        if self._model is None:
            raise RuntimeError(self.state.error or "MODEL_NOT_READY")

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
        # Номер запроса. Пока грузится одна модель, человек может выбрать
        # другую — и тогда первая, дойдя до конца, не должна ни занимать
        # место второй, ни объявлять себя готовой.
        with self._count_lock:
            self._wanted += 1
            wanted = self._wanted
        threading.Thread(
            target=self._load, args=(name, device, compute_type, wanted), daemon=True,
        ).start()

    def _load(self, name: str, device: str, compute_type: str, wanted: int) -> None:
        """Загрузить модель в память.

        Замок берётся только на подмену готовой модели, а не на всю
        загрузку: иначе второй выбор человека встаёт в очередь за первым,
        и на экране навсегда остаётся «загружаю» — ровно то, что видно,
        если переключить модель и сразу вернуть обратно.
        """
        try:
            if not self.is_cached(name):
                self.state.state = "downloading"
                self._download(name)
            if wanted != self._wanted:
                return
            # Математика NVIDIA не едет в сборке: докачиваем один раз.
            # До этого CUDA «работала» только там, где системно стоит
            # CUDA Toolkit, — то есть на машине разработчика.
            if device == "cuda":
                cuda_libs.ensure(self.cache_dir, self.state)
            if wanted != self._wanted:
                return
            self.state.state = "loading"
            started = time.time()

            def build(local_only: bool) -> WhisperModel:
                return WhisperModel(
                    # Именно repo, а не имя из каталога: у faster-whisper своя
                    # таблица имён, и для turbo она указывает на ДРУГОЙ
                    # репозиторий — модель скачалась бы дважды, а удаление
                    # чистило бы не тот кэш. Строка с «/» берётся как есть.
                    CATALOG[name]["repo"],
                    device=device,
                    compute_type=compute_type,
                    download_root=self.cache_dir,
                    # Модель на диске — в интернет не ходим вовсе: без этого
                    # флага hub при каждой загрузке сверяет файлы с сервером,
                    # и запуск «ломится в сеть», хотя качать нечего.
                    local_files_only=local_only,
                    # На процессоре два ядра остаются системе: захват звука и
                    # интерфейс не должны стоять в очереди за матричными
                    # умножениями — это слышно как пропуски в записи.
                    cpu_threads=max(1, (os.cpu_count() or 4) - 2) if device == "cpu" else 0,
                )

            try:
                model = build(True)
            except Exception as exc:  # noqa: BLE001
                # Докачиваем ТОЛЬКО когда дело в файлах: неполный кэш или
                # hub не нашёл что-то офлайн. Нехватку видеопамяти и прочие
                # беды пробрасываем как есть — иначе офлайн-машина с CUDA
                # OOM получала бы враньё «нет связи с интернетом».
                text = str(exc).lower()
                cache_issue = not self.is_cached(name) or any(
                    word in text
                    for word in ("local_files_only", "not found", "no such file",
                                 "cannot find", "offline", "does not exist")
                )
                if not cache_issue:
                    raise
                self.state.state = "downloading"
                self._download(name)
                if wanted != self._wanted:
                    return
                self.state.state = "loading"
                model = build(False)
            # Предполётная кроха звука. Веса копируются на карту и без
            # cuBLAS — падает только первое умножение, то есть посреди
            # диктовки человека. Лучше упасть здесь и сказать словами.
            if device == "cuda":
                probe = np.zeros(1600, dtype=np.float32)

                def run_probe():
                    list(model.transcribe(
                        probe, language="ru", beam_size=1,
                        vad_filter=False, without_timestamps=True,
                    )[0])

                try:
                    run_probe()
                except Exception as exc:  # noqa: BLE001
                    # Обычно хватает cuBLAS. Если эта сборка ctranslate2
                    # запросила полный cuDNN — докачиваем и пробуем снова.
                    if "cudnn" not in str(exc).lower():
                        raise
                    cuda_libs.ensure_cudnn(self.cache_dir, self.state)
                    self.state.state = "loading"
                    run_probe()

            # Пока грузили, человек мог выбрать другую. Тогда эта — лишняя.
            if wanted != self._wanted:
                return
            with self.state.lock:
                self._model = model
                self._loaded_device = device
            self._sleeping = False
            self._used_at = time.time()
            self.state.state = "ready"
            self.state.progress = 1.0
            # В журнал приложения: когда «долго грузится», по этой строке
            # видно, сколько именно и на чём считаем.
            print(f"модель {name} загружена на {device} ({compute_type}) за {time.time() - started:.1f} с", flush=True)
        except Exception as exc:  # noqa: BLE001 — наружу уходит текстом
            if wanted != self._wanted:
                return
            with self.state.lock:
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
                # Докачка после обрыва начинается не с нуля — initial
                # говорит, сколько уже лежит, и прогресс не врёт.
                self.n = kwargs.get("initial") or 0
                state.downloaded_mb += self.n / (1024 * 1024)
                state.progress = min(state.downloaded_mb / total_mb, 0.999)
                self.desc = kwargs.get("desc", "")
                self.disable = True
                self.format_dict = {"rate": None, "n": self.n, "total": self.total, "elapsed": 0}

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

    # ---------- скачивание впрок ----------

    def download_status(self) -> dict[str, dict[str, Any]]:
        with self._downloads_lock:
            return {name: dict(info) for name, info in self._downloads.items()}

    def start_download(self, name: str) -> dict[str, Any]:
        """Скачать модель, не трогая текущую. Повторный вызов — no-op."""
        if name not in CATALOG:
            raise ValueError("Неизвестная модель")
        # Эту же модель прямо сейчас качает загрузчик выбранной — второй
        # поток на тот же репозиторий дал бы двойной трафик и вравший
        # прогресс. Отвечаем прогрессом идущей закачки.
        if self.state.name == name and self.state.state == "downloading":
            return {"state": "downloading", "progress": float(self.state.progress), "error": ""}
        with self._downloads_lock:
            existing = self._downloads.get(name)
            if existing and existing["state"] == "downloading":
                return dict(existing)
            entry = {"state": "downloading", "progress": 0.0, "error": ""}
            self._downloads[name] = entry
        threading.Thread(target=self._download_only, args=(name, entry), daemon=True).start()
        return dict(entry)

    def _download_only(self, name: str, entry: dict[str, Any]) -> None:
        from huggingface_hub import snapshot_download

        total_mb = float(CATALOG[name]["size_mb"]) or 1.0
        got = {"mb": 0.0}

        class Reporter:
            """Та же подделка под tqdm, что в _download, но пишет в свою
            запись, а не в state: закачка впрок не смеет трогать прогресс
            модели, которой человек пользуется прямо сейчас."""

            def __init__(self, *_args, **kwargs) -> None:
                self.total = kwargs.get("total") or 0
                # Докачка после обрыва начинается не с нуля — initial
                # говорит, сколько уже лежит, и прогресс не врёт.
                self.n = kwargs.get("initial") or 0
                got["mb"] += self.n / (1024 * 1024)
                entry["progress"] = min(got["mb"] / total_mb, 0.999)
                self.desc = kwargs.get("desc", "")
                self.disable = True
                self.format_dict = {"rate": None, "n": self.n, "total": self.total, "elapsed": 0}

            def update(self, amount: int = 1) -> None:
                self.n += amount
                self.format_dict["n"] = self.n
                got["mb"] += amount / (1024 * 1024)
                entry["progress"] = min(got["mb"] / total_mb, 0.999)

            def close(self) -> None:
                pass

            def __enter__(self):
                return self

            def __exit__(self, *_exc) -> None:
                pass

            def __getattr__(self, _name):
                return lambda *_a, **_k: None

        try:
            snapshot_download(
                CATALOG[name]["repo"],
                cache_dir=self.cache_dir,
                allow_patterns=["*.bin", "*.json", "*.txt", "*.model"],
                tqdm_class=Reporter,
            )
            entry["progress"] = 1.0
            entry["state"] = "done"
        except Exception as exc:  # noqa: BLE001
            entry["state"] = "error"
            # Причина словами, а не трассировка requests на экран человеку.
            entry["error"] = _friendly_error(exc, "cpu")

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
        self.ensure_loaded()
        with self._transcribe_lock:
            model = self._model
            if model is None:
                raise RuntimeError("MODEL_NOT_READY")
            # Ширина луча — по устройству модели, которая реально считает:
            # на видеокарте луч в 5 гипотез почти бесплатен, на процессоре
            # он умножает время в разы. setdefault не трогает вызовы, где
            # луч задан явно (замер скорости ходит с единицей).
            options.setdefault("beam_size", 5 if self._loaded_device == "cuda" else 2)
            with self.state.lock:
                self._busy += 1
            try:
                segments, info = model.transcribe(audio, **options)
                result = list(segments), info
            finally:
                with self.state.lock:
                    self._busy -= 1
                # Час расшифровки файла — это работа, а не простой.
                self._used_at = time.time()
            return result

    def transcribe_stream(self, audio, **options):
        """Ленивый проход: сегменты отдаются по мере распознавания.

        transcribe() потребляет генератор faster-whisper целиком до
        возврата — у часового файла это час без единой цифры прогресса и
        без возможности отменить. Здесь сегменты выходят наружу сразу,
        поэтому файл показывает живые проценты, текст по ходу дела и
        останавливается по первой просьбе.

        Замок модели держится, пока генератор потребляется: прочитайте его
        до конца или закройте — иначе очередь к модели встанет.
        """
        self.ensure_loaded()
        with self._transcribe_lock:
            model = self._model
            if model is None:
                raise RuntimeError("MODEL_NOT_READY")
            options.setdefault("beam_size", 5 if self._loaded_device == "cuda" else 2)
            with self.state.lock:
                self._busy += 1
            try:
                segments, _info = model.transcribe(audio, **options)
                for segment in segments:
                    yield segment
                    # Идущая расшифровка — это работа, а не простой:
                    # выгрузка по бездействию не должна сработать посреди.
                    self._used_at = time.time()
            finally:
                with self.state.lock:
                    self._busy -= 1
                self._used_at = time.time()


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
