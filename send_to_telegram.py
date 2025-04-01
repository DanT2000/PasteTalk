from telethon import TelegramClient
import asyncio
import json
import os

CONFIG_FILE = "config.json"
AUDIO_FILE = "recording.wav"

# Загружаем конфиг
with open(CONFIG_FILE, "r", encoding="utf-8") as f:
    config = json.load(f)

API_ID = config["api_id"]
API_HASH = config["api_hash"]
TARGET_CHAT_NAME = config["target_chat_name"]
client = TelegramClient("giga_clipboard_session", API_ID, API_HASH)

async def send_audio():
    await client.start()
    print("🔍 Ищем чат...")
    dialogs = await client.get_dialogs()

    chat = None
    for d in dialogs:
        if d.is_group and TARGET_CHAT_NAME.lower() in d.name.lower():
            chat = d
            break

    if not chat:
        print("❌ Чат не найден. Проверь config.json -> target_chat_name")
        return

    if not os.path.exists(AUDIO_FILE):
        print(f"❌ Файл {AUDIO_FILE} не найден")
        return

    print(f"📤 Отправка {AUDIO_FILE} в чат '{chat.name}'...")
    await client.send_file(chat.entity, AUDIO_FILE, voice_note=True)
    print("✅ Отправлено!")

if __name__ == "__main__":
    asyncio.run(send_audio())
