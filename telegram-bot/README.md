# FetchWave Telegram Bot

A [Telethon](https://docs.telethon.dev) bot (logs in with a **bot token**) that
downloads **YouTube** and **Instagram** links and sends them back inside
Telegram — with a live progress bar and automatic clean-up.

## Features

- 🔗 Send any YouTube or Instagram link — the bot **auto-verifies** it
- 🎛 **Interactive inline buttons** to pick quality: Best / 1080p / 720p / MP3
- 📊 **Real-time progress** bar for both download and upload (message updates live)
- 📤 Sends the finished file straight to you (up to ~2 GB thanks to MTProto)
- ⏳ Reminds you to **forward it to Saved Messages**, then **auto-deletes**
  the link, status messages and the video after 5 minutes (configurable)
- 🛡 **Admin log**: every request is reported to the admin with the user's
  name, user id, username and phone number (if shared)
- 🍪 Reuses an optional **cookies.txt** automatically if present

> **Privacy notes (Telegram limitations):**
> - A bot can only see a user's **phone number if they tap "Share my number"**.
>   Until then the admin log shows `N/A`.
> - A bot **cannot** forward to your Saved Messages for you — it can only remind
>   you and delete its own/your messages in the chat afterwards.

## Setup

1. **Create the bot:** message [@BotFather](https://t.me/BotFather) → `/newbot`
   → copy the **bot token**.
2. **Get API credentials:** go to <https://my.telegram.org> → *API development
   tools* → copy **API_ID** and **API_HASH**.
3. **Find your admin id:** message [@userinfobot](https://t.me/userinfobot).
4. Copy `.env.example` to `.env` and fill in the values.

## Run locally

```bash
cd telegram-bot
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
# requires ffmpeg installed (brew install ffmpeg / apt install ffmpeg)

# load env vars (or export them manually)
export $(grep -v '^#' .env | xargs)
python bot.py
```

## Run with Docker

```bash
cd telegram-bot
docker build -t fetchwave-bot .
docker run --env-file .env fetchwave-bot
```

## Deploy on Render (as a Background Worker)

The bot has **no web port**, so deploy it as a *Background Worker*, not a Web
Service:

1. Render → **New + → Background Worker** → pick this repo.
2. **Root Directory:** `telegram-bot`  ·  **Runtime:** `Docker`.
3. Add environment variables: `API_ID`, `API_HASH`, `BOT_TOKEN`, `ADMIN_ID`
   (and optionally `AUTO_DELETE_SECONDS`).
4. (Optional) Add a **Secret File** named `cookies.txt` — it mounts at
   `/etc/secrets/cookies.txt` and is picked up automatically.
5. Create the worker. Check the logs for `Bot is online.`

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `API_ID` / `API_HASH` | — | Telegram app credentials (my.telegram.org) |
| `BOT_TOKEN` | — | Bot token from @BotFather |
| `ADMIN_ID` | — | Telegram user id that receives request logs |
| `AUTO_DELETE_SECONDS` | `300` | Delay before messages/video are deleted |
| `COOKIES_FILE` | `/etc/secrets/cookies.txt` | Optional cookies file path |

## Responsible use

Only download content you own or have permission to download. Respect YouTube's
and Instagram's Terms of Service and copyright.
