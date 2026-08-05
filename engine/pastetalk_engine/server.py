"""HTTP-сервер движка.

Слушает только localhost на случайном порту и требует токен, который знает
лишь запустивший его процесс. Порт и токен печатаются в stdout одной
строкой — приложение читает её и дальше общается по HTTP.

Библиотек сверх стандартных здесь нет намеренно: чем меньше в движке
лишнего, тем меньше он весит в установщике и тем меньше может сломаться.
"""

from __future__ import annotations

import argparse
import json
import os
import secrets
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from . import __version__
from .audio import SAMPLE_RATE, ffmpeg_path
from .files import FileJob
from .models import CATALOG, ModelManager, available_devices
from .session import Session

READY_PREFIX = "PASTETALK_ENGINE "
MAX_BODY = 64 * 1024 * 1024


class Engine:
    def __init__(self, cache_dir: str | None) -> None:
        self.models = ModelManager(cache_dir)
        self.sessions: dict[str, Session] = {}
        self.jobs: dict[str, FileJob] = {}
        self.started_at = time.time()
        self.lock = threading.Lock()

    def health(self) -> dict[str, Any]:
        return {
            "ok": True,
            "version": __version__,
            "uptimeS": round(time.time() - self.started_at, 1),
            "model": self.models.status(),
            "devices": available_devices(),
            "ffmpeg": ffmpeg_path(),
            "catalog": [
                {"id": key, "title": item["title"], "sizeMb": item["size_mb"],
                 "cached": self.models.is_cached(key)}
                for key, item in CATALOG.items()
            ],
        }

    def benchmark(self) -> dict[str, Any]:
        """Сколько времени уходит на минуту звука — на этом железе, а не в таблице.

        Гоняем минуту синтетического сигнала с выключенным VAD: так модель
        честно прогоняет весь энкодер, а не пропускает тишину. Цифра
        показывает пропускную способность, а не скорость набора текста, —
        и в интерфейсе так и написано.
        """
        import time

        import numpy as np

        if not self.models.is_ready():
            raise RuntimeError("Модель ещё не загружена")

        seconds = 60
        t = np.arange(seconds * SAMPLE_RATE, dtype=np.float32) / SAMPLE_RATE
        wobble = 140 + 60 * np.sin(2 * np.pi * 0.7 * t)
        signal = 0.25 * np.sin(2 * np.pi * wobble * t) * (0.6 + 0.4 * np.sin(2 * np.pi * 2.3 * t))

        started = time.perf_counter()
        segments, _info = self.models.transcribe(
            signal.astype(np.float32),
            language="ru",
            vad_filter=False,
            beam_size=1,
            without_timestamps=True,
            condition_on_previous_text=False,
        )
        list(segments)
        elapsed = time.perf_counter() - started

        status = self.models.status()
        return {
            "secondsPerMinute": round(elapsed * 60 / seconds, 2),
            "device": status["device"],
            "model": status["title"],
            "computeType": status["computeType"],
        }

    def forget_finished_jobs(self) -> None:
        with self.lock:
            done = [k for k, j in self.jobs.items() if j.state in ("done", "error")]
            for key in done[:-5]:
                self.jobs.pop(key, None)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    engine: Engine
    token: str

    # ---------- инфраструктура ----------

    def log_message(self, *_args) -> None:
        """Молчим: каждая строка отсюда попала бы в журнал приложения."""

    def _reject(self, code: int, message: str) -> None:
        self._send(code, {"error": message})

    def _send(self, code: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self) -> bytes:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return b""
        if length > MAX_BODY:
            raise ValueError("Тело запроса слишком большое")
        return self.rfile.read(length)

    def _json(self) -> dict[str, Any]:
        raw = self._body()
        if not raw:
            return {}
        return json.loads(raw.decode("utf-8"))

    def _authorised(self) -> bool:
        return secrets.compare_digest(self.headers.get("X-PasteTalk-Token", ""), self.token)

    # ---------- маршруты ----------

    def do_GET(self) -> None:  # noqa: N802
        self._route("GET")

    def do_POST(self) -> None:  # noqa: N802
        self._route("POST")

    def do_DELETE(self) -> None:  # noqa: N802
        self._route("DELETE")

    def _route(self, method: str) -> None:
        if not self._authorised():
            self._reject(401, "Неверный токен")
            return
        parts = [p for p in self.path.split("?")[0].split("/") if p]
        try:
            self._dispatch(method, parts)
        except json.JSONDecodeError:
            self._reject(400, "Тело запроса не разобрать")
        except KeyError as exc:
            self._reject(404, f"Не найдено: {exc}")
        except Exception as exc:  # noqa: BLE001
            self._reject(500, str(exc))

    def _dispatch(self, method: str, parts: list[str]) -> None:
        engine = self.engine
        head = parts[0] if parts else ""

        if method == "GET" and head == "health":
            self._send(200, engine.health())

        elif method == "GET" and head == "model":
            self._send(200, engine.models.status())

        elif method == "POST" and head == "model":
            payload = self._json()
            engine.models.request(
                payload.get("name", ""),
                payload.get("device", "cuda"),
                payload.get("computeType", ""),
            )
            self._send(200, engine.models.status())

        elif method == "DELETE" and head == "model" and len(parts) == 2:
            freed = engine.models.remove(parts[1])
            self._send(200, {"ok": True, "freedMb": round(freed, 1)})

        elif method == "POST" and head == "benchmark":
            self._send(200, engine.benchmark())

        elif method == "POST" and head == "session" and len(parts) == 1:
            if not engine.models.is_ready():
                self._reject(409, "MODEL_NOT_READY")
                return
            payload = self._json()
            session = Session(
                engine.models,
                payload.get("language") or None,
                payload.get("prompt", ""),
            )
            engine.sessions[session.id] = session
            self._send(200, {"id": session.id})

        elif head == "session" and len(parts) >= 2:
            session = engine.sessions.get(parts[1])
            if session is None:
                self._reject(404, "Запись не найдена")
                return
            action = parts[2] if len(parts) > 2 else ""

            if method == "POST" and action == "audio":
                self._send(200, session.push(self._body()))
            elif method == "POST" and action == "stop":
                result = session.stop()
                engine.sessions.pop(session.id, None)
                self._send(200, result)
            elif method == "DELETE":
                session.cancel()
                engine.sessions.pop(session.id, None)
                self._send(200, {"ok": True})
            else:
                self._reject(404, "Нет такого действия")

        elif method == "POST" and head == "file" and len(parts) == 1:
            if not engine.models.is_ready():
                self._reject(409, "MODEL_NOT_READY")
                return
            payload = self._json()
            path = payload.get("path", "")
            if not os.path.isfile(path):
                self._reject(400, "Файл не найден")
                return
            engine.forget_finished_jobs()
            job = FileJob(
                engine.models,
                path,
                payload.get("language"),
                bool(payload.get("timestamps")),
                payload.get("model"),
            )
            engine.jobs[job.id] = job
            self._send(200, job.as_dict(with_segments=False))

        elif head == "file" and len(parts) == 2:
            job = engine.jobs.get(parts[1])
            if job is None:
                self._reject(404, "Задача не найдена")
                return
            if method == "DELETE":
                job.cancel()
                self._send(200, {"ok": True})
            else:
                self._send(200, job.as_dict())

        elif method == "POST" and head == "shutdown":
            self._send(200, {"ok": True})
            threading.Thread(target=self.server.shutdown, daemon=True).start()

        else:
            self._reject(404, "Нет такого адреса")


def watch_parent(server: ThreadingHTTPServer) -> None:
    """Приложение закрылось — движку тоже незачем жить.

    Сирота остался бы висеть в памяти вместе с моделью на несколько
    гигабайт, и следующий запуск упёрся бы в занятую видеопамять.

    Признак смерти родителя — закрытый stdin: труба рвётся сама, когда
    процесс исчезает. Проверять живость по pid нельзя: os.kill на Windows
    не «спрашивает», а завершает процесс даже с сигналом 0.
    """
    try:
        while sys.stdin.readline():
            pass
    except Exception:
        pass
    server.shutdown()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="pastetalk-engine")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=0, help="0 — занять свободный")
    parser.add_argument("--cache-dir", default=None, help="куда складывать модели")
    parser.add_argument("--parent-pid", type=int, default=0)
    parser.add_argument("--model", default="", help="загрузить сразу при старте")
    parser.add_argument("--device", default="cuda")
    args = parser.parse_args(argv)

    engine = Engine(args.cache_dir)
    token = secrets.token_urlsafe(24)

    handler = type("BoundHandler", (Handler,), {"engine": engine, "token": token})
    server = ThreadingHTTPServer((args.host, args.port), handler)
    server.daemon_threads = True

    if args.parent_pid:
        threading.Thread(target=watch_parent, args=(server,), daemon=True).start()
    if args.model:
        engine.models.request(args.model, args.device)

    print(READY_PREFIX + json.dumps({
        "port": server.server_address[1],
        "token": token,
        "pid": os.getpid(),
        "version": __version__,
    }), flush=True)

    try:
        server.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
