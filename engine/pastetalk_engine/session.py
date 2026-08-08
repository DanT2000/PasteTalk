"""Живая запись: распознаём фразу, не дожидаясь конца речи.

Ждать, пока человек договорит, и только потом запускать модель — значит
подарить ему секунды ожидания на ровном месте. Поэтому запись режется по
паузам: закончилась фраза — она сразу уходит в модель, а человек
продолжает говорить дальше.
"""

from __future__ import annotations

import queue
import threading
import uuid
from typing import Any

import numpy as np

from . import cleanup
from .audio import SAMPLE_RATE, SilenceTracker, pcm16_to_float32
from .models import ModelManager

CUT_SILENCE_MS = 600      # пауза, после которой фраза считается законченной
MIN_SPEECH_MS = 700       # слишком короткие обрывки не режем
MAX_CHUNK_S = 25          # окно Whisper — 30 с, до предела не доводим
KEEP_TAIL_MS = 200        # хвост тишины оставляем: с ним модель точнее


class Session:
    def __init__(
        self,
        models: ModelManager,
        language: str | None,
        initial_prompt: str = "",
        keep_dir: str | None = None,
    ) -> None:
        self.id = uuid.uuid4().hex[:12]
        self.models = models
        self.language = language or None
        self.initial_prompt = initial_prompt
        # Куда сложить запись целиком. Нужно для проверок: живой голос —
        # единственный честный материал, а собрать его заново каждый раз
        # значит каждый раз проверять на чём-то другом.
        self.keep_dir = keep_dir
        self.saved_path = ""

        self._buffer = np.zeros(0, dtype=np.float32)
        self._cursor = 0
        self._tracker = SilenceTracker()
        self._lock = threading.Lock()

        self._jobs: queue.Queue = queue.Queue()
        self._segments: list[dict[str, Any]] = []
        # Что модель выдумала и мы выбросили — для журнала, чтобы фильтр
        # не работал вслепую.
        self.dropped: list[dict[str, str]] = []
        self._delivered = 0
        self._error = ""
        self._closed = False
        self._worker = threading.Thread(target=self._run, daemon=True)
        self._worker.start()

    # ---------- приём звука ----------

    def push(self, raw: bytes) -> dict[str, Any]:
        chunk = pcm16_to_float32(raw)
        with self._lock:
            self._buffer = np.concatenate((self._buffer, chunk))
            self._tracker.push(chunk)

            pending = len(self._buffer) - self._cursor
            long_enough = pending >= MAX_CHUNK_S * SAMPLE_RATE
            phrase_over = (
                self._tracker.silence_ms >= CUT_SILENCE_MS
                and self._tracker.speech_ms >= MIN_SPEECH_MS
            )
            if pending > 0 and (phrase_over or long_enough):
                self._cut_locked()

            silence_ms = self._tracker.silence_ms
            level = self._tracker.level
            ever_spoke = self._tracker.ever_spoke
            spoken_s = len(self._buffer) / SAMPLE_RATE

        return {
            "silenceMs": silence_ms,
            "everSpoke": ever_spoke,
            "level": round(float(level), 5),
            "durationS": round(spoken_s, 2),
            "segments": self.take_new(),
            "error": self._error,
        }

    def _cut_locked(self) -> None:
        """Отправить накопленное в очередь. Вызывается под self._lock."""
        keep = int(KEEP_TAIL_MS * SAMPLE_RATE / 1000)
        end = max(self._cursor, len(self._buffer) - 0)
        piece = self._buffer[self._cursor:end]
        if len(piece) < keep:
            return
        offset = self._cursor / SAMPLE_RATE
        self._cursor = end
        self._tracker.reset_speech()
        self._jobs.put((piece.copy(), offset))

    # ---------- выдача результата ----------

    def take_new(self) -> list[dict[str, Any]]:
        """Всё, что распозналось с прошлого раза."""
        fresh = self._segments[self._delivered:]
        self._delivered = len(self._segments)
        return fresh

    def text(self) -> str:
        return " ".join(s["text"] for s in self._segments).strip()

    def stop(self, timeout: float = 120.0) -> dict[str, Any]:
        """Дорезать хвост, дождаться очереди и отдать весь текст."""
        with self._lock:
            if len(self._buffer) > self._cursor:
                self._cut_locked()
        self._jobs.put(None)
        self._worker.join(timeout=timeout)
        self._closed = True
        if self.keep_dir:
            self._save()
        return {
            "text": self.text(),
            "segments": list(self._segments),
            "dropped": list(self.dropped),
            "durationS": round(len(self._buffer) / SAMPLE_RATE, 2),
            "savedTo": self.saved_path,
            "error": self._error,
        }

    def _save(self) -> None:
        """Сложить запись в WAV — обычный, чтобы открывался чем угодно."""
        import os
        import wave

        try:
            os.makedirs(self.keep_dir, exist_ok=True)
            path = os.path.join(self.keep_dir, f"{self.id}.wav")
            pcm = np.clip(self._buffer, -1.0, 1.0)
            with wave.open(path, "wb") as out:
                out.setnchannels(1)
                out.setsampwidth(2)
                out.setframerate(SAMPLE_RATE)
                out.writeframes((pcm * 32767).astype(np.int16).tobytes())
            self.saved_path = path
        except Exception as exc:  # noqa: BLE001 — сохранение не должно ронять запись
            self._error = self._error or f"Не удалось сохранить запись: {exc}"

    def cancel(self) -> None:
        self._closed = True
        with self._lock:
            self._buffer = np.zeros(0, dtype=np.float32)
        self._jobs.put(None)

    # ---------- фоновая работа ----------

    def _run(self) -> None:
        while True:
            job = self._jobs.get()
            if job is None:
                break
            if self._closed:
                continue
            piece, offset = job
            try:
                self._transcribe(piece, offset)
            except Exception as exc:  # noqa: BLE001
                self._error = str(exc)

    def _transcribe(self, piece: np.ndarray, offset: float) -> None:
        first = not self._segments
        segments, info = self.models.transcribe(
            piece,
            language=self.language,
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 400},
            # Пороги, за которыми Whisper перестаёт достраивать текст в
            # тишине. Со значениями по умолчанию он охотнее выдумывает.
            no_speech_threshold=0.6,
            log_prob_threshold=-1.0,
            beam_size=5,
            # Куски идут отдельно, и опора на предыдущий текст здесь скорее
            # вредит: модель начинает повторять уже сказанное.
            condition_on_previous_text=False,
            # Куски независимы, поэтому словарь нужен каждому: термин из
            # третьей фразы заслуживает подсказки не меньше первой.
            initial_prompt=self.initial_prompt or None,
        )
        for segment in segments:
            text = segment.text.strip()
            if not text:
                continue

            reason = cleanup.looks_invented(
                text,
                getattr(segment, "no_speech_prob", 0.0) or 0.0,
                getattr(segment, "avg_logprob", 0.0) or 0.0,
            )
            if reason:
                # Пишем в отброшенное, чтобы это было видно, а не молча.
                self.dropped.append({"text": text, "reason": reason})
                continue

            self._segments.append({
                "text": text,
                "start": round(offset + segment.start, 2),
                "end": round(offset + segment.end, 2),
            })
        if first and getattr(info, "language", None) and not self.language:
            self.language = info.language
