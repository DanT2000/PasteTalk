import sounddevice as sd
from scipy.io.wavfile import write
from pynput import keyboard
import numpy as np
import threading
import time
from multiprocessing import Process, Value, Queue
import tkinter as tk
import json
import os
import pyperclip
import asyncio
import subprocess
from telethon import TelegramClient, events

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
is_recording = Value('b', False)
recording = []

client = TelegramClient("giga_clipboard_session", API_ID, API_HASH)
chat_id_cache = None
processing_lock = asyncio.Lock()
indicator_queue = Queue()

# === Индикатор ===
def indicator_process(queue: Queue):
    root = tk.Tk()
    root.overrideredirect(True)
    root.attributes("-topmost", True)
    root.configure(bg='white')
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

    canvas = tk.Canvas(root, width=INDICATOR_WIDTH, height=INDICATOR_HEIGHT, highlightthickness=0, bg='white')
    canvas.pack()
    rect = canvas.create_rectangle(0, 0, INDICATOR_WIDTH, INDICATOR_HEIGHT, fill='red', outline='')

    def update_color(color):
        canvas.itemconfig(rect, fill=color)

    def close_after_delay():
        root.after(1000, root.destroy)

    def poll_queue():
        try:
            msg = queue.get_nowait()
            if msg == "recording":
                update_color("red")
            elif msg == "processing":
                update_color("yellow")
            elif msg == "done":
                update_color("green")
                close_after_delay()
            elif msg == "error":
                update_color("blue")
                close_after_delay()
        except:
            pass
        root.after(100, poll_queue)

    poll_queue()
    root.mainloop()

# === Конвертация ===
def convert_to_ogg(wav_path, ogg_path):
    subprocess.run([
        "ffmpeg", "-y", "-i", wav_path,
        "-c:a", "libopus", "-b:a", "64k",
        ogg_path
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

# === Запись (синхронно) ===
def record_audio_blocking():
    global recording
    recording = []

    def callback(indata, frames, time, status):
        if is_recording.value:
            recording.append(indata.copy())

    with sd.InputStream(samplerate=SAMPLERATE, channels=1, callback=callback):
        while is_recording.value:
            sd.sleep(100)

    audio = np.concatenate(recording, axis=0)
    audio_int16 = np.int16(audio * 32767)
    write(WAV_FILE, SAMPLERATE, audio_int16)
    convert_to_ogg(WAV_FILE, OGG_FILE)

# === Основной цикл ===
async def process_recording():
    global chat_id_cache

    async with processing_lock:
        indicator_queue.put("recording")
        indicator_proc = Process(target=indicator_process, args=(indicator_queue,))
        indicator_proc.start()

        is_recording.value = True
        await asyncio.to_thread(record_audio_blocking)
        print("🛑 Запись завершена")
        indicator_queue.put("processing")

        if not chat_id_cache:
            dialogs = await client.get_dialogs()
            for d in dialogs:
                if d.is_group and TARGET_CHAT in d.name.lower():
                    chat_id_cache = d.entity.id
                    break
            if not chat_id_cache:
                print("❌ Чат не найден.")
                indicator_queue.put("error")
                return

        try:
            await client.send_file(chat_id_cache, OGG_FILE, voice_note=True)
        except Exception as e:
            print(f"❌ Ошибка отправки: {e}")
            indicator_queue.put("error")
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
            indicator_queue.put("done")
        except asyncio.TimeoutError:
            print("⚠️ Гигачат не ответил вовремя")
            indicator_queue.put("error")

# === Горячие клавиши ===
def start_hotkey_listener(loop):
    pressed_keys = set()

    def key_name(key):
        try:
            name = key.name
        except AttributeError:
            name = str(key).lower().replace("key.", "")

        # Нормализация
        aliases = {
            "cmd": "win", "cmd_l": "win", "cmd_r": "win",
            "control": "ctrl", "control_l": "ctrl", "control_r": "ctrl",
            "alt_l": "alt", "alt_r": "alt",
            "shift_l": "shift", "shift_r": "shift"
        }
        normalized = aliases.get(name, name)
        return normalized


    def on_hotkey(key):
        pressed_keys.add(key_name(key))

        if all(k in pressed_keys for k in HOTKEYS):
            if is_recording.value:
                is_recording.value = False
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
    await client.start()
    loop = asyncio.get_event_loop()
    start_hotkey_listener(loop)
    print(f"⌨️ Нажимай комбинацию клавиш ({' + '.join(HOTKEYS)}) для старта/остановки записи.")
    while True:
        await asyncio.sleep(1)

if __name__ == "__main__":
    asyncio.run(main())
