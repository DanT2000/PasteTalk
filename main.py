import sounddevice as sd
from scipy.io.wavfile import write
from pynput import keyboard
import numpy as np
import threading
import time
import tkinter as tk
import json
import os
import pyperclip
import asyncio
import subprocess
import sys
from telethon import TelegramClient, events
import sqlite3
import psutil
from queue import Queue

# === Конфиг ===
with open("config.json", "r", encoding="utf-8") as f:
    config = json.load(f)

API_ID = config["api_id"]
API_HASH = config["api_hash"]
TARGET_CHAT = config["target_chat_name"].lower()
GIGA_USERNAME = config["giga_username"].lower()
USE_CLIPBOARD = config["clipboard_enabled"]
MIN_TEXT_LENGTH = config["min_text_length"]
LOG_ENABLED = config["log_messages"]
INDICATOR_WIDTH = config.get("indicator_width", 40)
INDICATOR_HEIGHT = config.get("indicator_height", 40)
INDICATOR_POSITION = config.get("indicator_position", "top-right")
INDICATOR_MARGIN = config.get("indicator_margin", 20)
HOTKEYS = set(config.get("hotkeys", ["ctrl", "win"]))

WAV_FILE = "recording.wav"
OGG_FILE = "recording.ogg"
SAMPLERATE = 44100
is_recording = threading.Event()
recording = []

client = TelegramClient("giga_clipboard_session", API_ID, API_HASH)
chat_id_cache = None
processing_lock = asyncio.Lock()
LOCKFILE = "PasteTalk.lock"

# === Индикатор ===
indicator_queue = Queue()

def start_indicator_thread():
    def run_indicator_loop():
        root = tk.Tk()
        root.overrideredirect(True)
        root.attributes("-topmost", True)
        root.configure(bg='white')

        canvas = tk.Canvas(root, width=INDICATOR_WIDTH, height=INDICATOR_HEIGHT, highlightthickness=0, bg='white')
        canvas.pack()
        rect = canvas.create_rectangle(0, 0, INDICATOR_WIDTH, INDICATOR_HEIGHT, fill='white', outline='')

        screen_width = root.winfo_screenwidth()
        screen_height = root.winfo_screenheight()

        if INDICATOR_POSITION == "top-left":
            x, y = INDICATOR_MARGIN, INDICATOR_MARGIN
        elif INDICATOR_POSITION == "top-right":
            x, y = screen_width - INDICATOR_WIDTH - INDICATOR_MARGIN, INDICATOR_MARGIN
        elif INDICATOR_POSITION == "bottom-left":
            x, y = INDICATOR_MARGIN, screen_height - INDICATOR_HEIGHT - INDICATOR_MARGIN
        elif INDICATOR_POSITION == "bottom-right":
            x, y = screen_width - INDICATOR_WIDTH - INDICATOR_MARGIN, screen_height - INDICATOR_HEIGHT - INDICATOR_MARGIN
        else:
            x, y = 100, 100

        root.geometry(f"{INDICATOR_WIDTH}x{INDICATOR_HEIGHT}+{x}+{y}")

        last_color_time = [time.time()]  # список, чтобы быть мутабельным

        def update():
            try:
                color = indicator_queue.get_nowait()
                if color == "clear":
                    root.withdraw()
                else:
                    canvas.itemconfig(rect, fill=color)
                    root.deiconify()
                    last_color_time[0] = time.time()
                    if color in ("green", "blue"):
                        root.after(1000, lambda: indicator_queue.put("clear"))
            except:
                pass

            # если прошло более 5 секунд с последнего сигнала — скрыть
            if time.time() - last_color_time[0] > 5:
                root.withdraw()

            root.after(100, update)


        update()
        root.mainloop()

    threading.Thread(target=run_indicator_loop, daemon=True).start()

def show_indicator(color):
    indicator_queue.put(color)

# === Утилиты ===
def kill_other_instances():
    current_pid = os.getpid()
    for proc in psutil.process_iter(['pid', 'name']):
        try:
            if proc.info['name'] in ["PasteTalk.exe", "main.exe", "python.exe"] and proc.pid != current_pid:
                proc.kill()
        except Exception:
            continue

def is_already_running():
    if os.path.exists(LOCKFILE):
        try:
            with open(LOCKFILE, "r") as f:
                old_pid = int(f.read().strip())
            if psutil.pid_exists(old_pid):
                print("⚠️ Приложение уже запущено.")
                return True
        except:
            pass
        os.remove(LOCKFILE)
    with open(LOCKFILE, "w") as f:
        f.write(str(os.getpid()))
    return False

def cleanup_lockfile():
    if os.path.exists(LOCKFILE):
        os.remove(LOCKFILE)

def convert_to_ogg(wav_path, ogg_path):
    creation_flag = 0
    if sys.platform == "win32":
        creation_flag = subprocess.CREATE_NO_WINDOW

    subprocess.run([
        "ffmpeg", "-y", "-i", wav_path,
        "-c:a", "libopus", "-b:a", "64k",
        ogg_path
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=creation_flag)

def record_audio_blocking():
    global recording
    recording = []

    def callback(indata, frames, time, status):
        if is_recording.is_set():
            recording.append(indata.copy())

    with sd.InputStream(samplerate=SAMPLERATE, channels=1, callback=callback):
        while is_recording.is_set():
            sd.sleep(100)

    audio = np.concatenate(recording, axis=0)
    audio_int16 = np.int16(audio * 32767)
    write(WAV_FILE, SAMPLERATE, audio_int16)
    convert_to_ogg(WAV_FILE, OGG_FILE)

# === Основная логика ===
async def process_recording():
    global chat_id_cache

    async with processing_lock:
        show_indicator("red")
        is_recording.set()
        await asyncio.to_thread(record_audio_blocking)
        print("🛑 Запись завершена")
        show_indicator("yellow")

        if not chat_id_cache:
            dialogs = await client.get_dialogs()
            for d in dialogs:
                if d.is_group and TARGET_CHAT in d.name.lower():
                    chat_id_cache = d.entity.id
                    break
            if not chat_id_cache:
                print("❌ Чат не найден.")
                show_indicator("blue")
                return

        try:
            await client.send_file(chat_id_cache, OGG_FILE, voice_note=True)
        except Exception as e:
            print(f"❌ Ошибка отправки: {e}")
            show_indicator("blue")
            return

        print("⌛ Ожидание ответа от Гигачата...")
        future = asyncio.get_event_loop().create_future()

        @client.on(events.NewMessage(chats=chat_id_cache))
        async def handle_response(event):
            sender = await event.get_sender()
            if not sender.username or sender.username.lower() != GIGA_USERNAME:
                return

            text = event.raw_text.strip()
            if LOG_ENABLED:
                print(f"🤖 Гигачат: {text}")

            if USE_CLIPBOARD and len(text) >= MIN_TEXT_LENGTH:
                pyperclip.copy(text)
                print("📋 Скопировано в буфер обмена.")

            if not future.done():
                future.set_result(True)

        try:
            await asyncio.wait_for(future, timeout=30)
            show_indicator("green")
        except asyncio.TimeoutError:
            print("⚠️ Гигачат не ответил вовремя")
            show_indicator("blue")

def start_hotkey_listener(loop):
    pressed_keys = set()

    def key_name(key):
        try:
            name = key.name
        except AttributeError:
            name = str(key).lower().replace("key.", "")
        aliases = {
            "cmd": "win", "cmd_l": "win", "cmd_r": "win",
            "control": "ctrl", "control_l": "ctrl", "control_r": "ctrl",
            "alt_l": "alt", "alt_r": "alt",
            "shift_l": "shift", "shift_r": "shift"
        }
        normalized = aliases.get(name, name)
        print(f"🔑 Нажата: {normalized}")
        return normalized

    def on_hotkey(key):
        pressed_keys.add(key_name(key))
        if all(k in pressed_keys for k in HOTKEYS):
            if is_recording.is_set():
                is_recording.clear()
            else:
                asyncio.run_coroutine_threadsafe(process_recording(), loop)
            pressed_keys.clear()

    def on_release(key):
        pressed_keys.discard(key_name(key))

    listener = keyboard.Listener(on_press=on_hotkey, on_release=on_release)
    listener.start()

# === Главный запуск ===
async def main():
    print("🚀 Подключение к Telegram...")
    start_indicator_thread()
    await client.start()
    loop = asyncio.get_event_loop()
    start_hotkey_listener(loop)
    print(f"⌨️ Нажимай комбинацию клавиш ({' + '.join(HOTKEYS)}) для старта/остановки записи.")
    while True:
        await asyncio.sleep(1)

if __name__ == "__main__":
    # kill_other_instances()
    if is_already_running():
        sys.exit()

    try:
        asyncio.run(main())
    except Exception as e:
        if "database is locked" in str(e).lower():
            print("⚠️ Сессия Telegram занята другим процессом. Возможно, уже запущено другое окно.")
        else:
            print(f"❌ Ошибка: {e}")
    finally:
        cleanup_lockfile()
