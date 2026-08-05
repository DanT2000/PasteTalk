"""Работа со звуком: приведение к формату Whisper и поиск пауз.

Whisper ждёт моно 16 кГц float32 в диапазоне [-1, 1]. Всё, что приходит
из окна записи, уже в этом формате, но как int16 — так вдвое меньше
трафика между процессами.
"""

from __future__ import annotations

import shutil
import subprocess

import numpy as np

SAMPLE_RATE = 16000
FRAME_MS = 20
FRAME_LEN = SAMPLE_RATE * FRAME_MS // 1000


def pcm16_to_float32(raw: bytes) -> np.ndarray:
    """Байты int16 → float32 [-1, 1]."""
    if not raw:
        return np.zeros(0, dtype=np.float32)
    return np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0


def frame_energies(audio: np.ndarray) -> np.ndarray:
    """Среднеквадратичный уровень по кадрам в 20 мс."""
    usable = len(audio) - len(audio) % FRAME_LEN
    if usable <= 0:
        return np.zeros(0, dtype=np.float32)
    frames = audio[:usable].reshape(-1, FRAME_LEN)
    return np.sqrt(np.mean(frames * frames, axis=1) + 1e-12)


class SilenceTracker:
    """Простой детектор речи по уровню сигнала.

    Полноценный VAD включается позже, на финальном проходе Whisper.
    Здесь задача другая и куда проще: понять, где закончилась фраза,
    чтобы отдать её на распознавание, не дожидаясь конца записи.

    Порог не фиксированный, а привязан к шуму комнаты: держим оценку
    тишины и считаем речью всё, что заметно громче неё. Иначе на
    шумном микрофоне речь не находится вовсе, а на тихом — находится
    всегда.
    """

    NOISE_RISE = 0.02   # к шуму подстраиваемся медленно
    NOISE_FALL = 0.25   # а к тишине быстро
    MARGIN = 3.0        # во сколько раз речь громче шума
    FLOOR = 0.004       # ниже этого — точно тишина

    def __init__(self) -> None:
        self.noise = 0.01
        self.silence_frames = 0
        self.speech_frames = 0
        self.level = 0.0
        # Говорил ли человек вообще хоть раз за эту запись. По этому флагу
        # приложение отличает «замолчал» от «нажал и не сказал ни слова».
        self.ever_spoke = False

    def push(self, audio: np.ndarray) -> None:
        for energy in frame_energies(audio):
            speaking = energy > max(self.noise * self.MARGIN, self.FLOOR)
            if speaking:
                self.speech_frames += 1
                self.silence_frames = 0
                self.ever_spoke = True
            else:
                self.silence_frames += 1
                rate = self.NOISE_FALL if energy < self.noise else self.NOISE_RISE
                self.noise += (energy - self.noise) * rate
            self.level = float(energy)

    @property
    def silence_ms(self) -> int:
        return self.silence_frames * FRAME_MS

    @property
    def speech_ms(self) -> int:
        return self.speech_frames * FRAME_MS

    def reset_speech(self) -> None:
        self.speech_frames = 0


def ffmpeg_path() -> str | None:
    return shutil.which("ffmpeg")


def decode_file(path: str) -> np.ndarray:
    """Любой файл → моно 16 кГц float32 через ffmpeg."""
    ffmpeg = ffmpeg_path()
    if not ffmpeg:
        raise RuntimeError("FFMPEG_MISSING")

    process = subprocess.run(
        [
            ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error",
            "-i", path,
            "-f", "s16le", "-acodec", "pcm_s16le",
            "-ac", "1", "-ar", str(SAMPLE_RATE),
            "-",
        ],
        capture_output=True,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    if process.returncode != 0:
        detail = process.stderr.decode("utf-8", "replace").strip().splitlines()
        raise RuntimeError(detail[-1] if detail else "ffmpeg не смог прочитать файл")
    return pcm16_to_float32(process.stdout)
