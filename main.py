import json

with open("config.json", "r", encoding="utf-8") as f:
    config = json.load(f)

API_ID = config["api_id"]
API_HASH = config["api_hash"]
TARGET_CHAT = config["target_chat_name"]
GIGA_USERNAME = config["giga_username"]
USE_CLIPBOARD = config["clipboard_enabled"]
MIN_TEXT_LENGTH = config["min_text_length"]
LOG_ENABLED = config["log_messages"]
