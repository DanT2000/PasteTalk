"""Расшифровка готовых файлов: видео, аудио, диктофонные записи.

От живой записи отличается тем, что звук известен целиком, а значит
можно честно показывать процент готовности и отдавать метки времени.
"""

from __future__ import annotations

import os
import threading
import time
import uuid
from typing import Any

from . import cleanup
from .audio import SAMPLE_RATE, decode_file
from .models import ModelManager


class FileJob:
    def __init__(
        self,
        models: ModelManager,
        path: str,
        language: str | None,
        timestamps: bool,
        model: str | None = None,
        initial_prompt: str = "",
    ) -> None:
        self.id = uuid.uuid4().hex[:12]
        self.models = models
        self.path = path
        self.language = language or None
        self.timestamps = timestamps
        self.model = model or None
        self.initial_prompt = initial_prompt

        self.state = "queued"     # queued | switching | decoding | working | done | error
        self.progress = 0.0
        self.segments: list[dict[str, Any]] = []
        self.error = ""
        self.duration_s = 0.0
        self.cancelled = False

        threading.Thread(target=self._run, daemon=True).start()

    def as_dict(self, with_segments: bool = True) -> dict[str, Any]:
        payload = {
            "id": self.id,
            "file": os.path.basename(self.path),
            "state": self.state,
            "progress": round(self.progress, 4),
            "durationS": round(self.duration_s, 2),
            "error": self.error,
            "timestamps": self.timestamps,
        }
        if with_segments:
            payload["segments"] = list(self.segments)
            payload["text"] = self.text()
        return payload

    def text(self) -> str:
        if not self.timestamps:
            return " ".join(s["text"] for s in self.segments).strip()
        lines = [f"[{_stamp(s['start'])}] {s['text']}" for s in self.segments]
        return "\n".join(lines)

    def cancel(self) -> None:
        self.cancelled = True

    def _run(self) -> None:
        try:
            # Для файла можно взять другую модель, чем для диктовки. Тогда
            # сперва дожидаемся, пока она встанет в память: гонять две
            # модели одновременно на одной видеокарте — верный путь
            # упереться в нехватку памяти.
            if self.model and self.models.status()["name"] != self.model:
                self.state = "switching"
                status = self.models.status()
                self.models.request(self.model, status["device"], status["computeType"])
                waited = 0.0
                while self.models.status()["state"] not in ("ready", "error", "sleeping") and waited < 1800:
                    time.sleep(0.5)
                    waited += 0.5
                    self.progress = min(self.models.status().get("progress", 0.0), 0.99)
                if self.models.status()["state"] != "ready":
                    raise RuntimeError(self.models.status()["error"] or "Модель не загрузилась")
                self.progress = 0.0

            self.state = "decoding"
            audio = decode_file(self.path)
            self.duration_s = len(audio) / SAMPLE_RATE
            if self.duration_s < 0.1:
                raise RuntimeError("В файле не нашлось звуковой дорожки")

            self.state = "working"
            segments, _info = self.models.transcribe(
                audio,
                language=self.language,
                vad_filter=True,
                no_speech_threshold=0.6,
                log_prob_threshold=-1.0,
                beam_size=5,
                condition_on_previous_text=True,
                initial_prompt=self.initial_prompt or None,
            )
            for segment in segments:
                if self.cancelled:
                    self.state = "error"
                    self.error = "Отменено"
                    return
                text = cleanup.keep(segment)
                if text:
                    self.segments.append({
                        "text": text,
                        "start": round(segment.start, 2),
                        "end": round(segment.end, 2),
                    })
                if self.duration_s:
                    self.progress = min(segment.end / self.duration_s, 0.999)
            self.progress = 1.0
            self.state = "done"
        except RuntimeError as exc:
            self.state = "error"
            self.error = "FFMPEG_MISSING" if str(exc) == "FFMPEG_MISSING" else str(exc)
        except Exception as exc:  # noqa: BLE001
            self.state = "error"
            self.error = str(exc)


def _stamp(seconds: float) -> str:
    total = int(seconds)
    if total >= 3600:
        return f"{total // 3600}:{total % 3600 // 60:02d}:{total % 60:02d}"
    return f"{total // 60:02d}:{total % 60:02d}"
