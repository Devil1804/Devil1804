# FetchWave Telegram Bot

A **bot-token-only** Telegram bot (built on
[python-telegram-bot](https://docs.python-telegram-bot.org) — **no api_id /
api_hash required**) that downloads **YouTube** and **Instagram** links and
sends them back inside Telegram, with a live progress bar and automatic
clean-up.

## Features

- 🔗 Send any YouTube or Instagram link — the bot **auto-verifies** it
- 🎛 **Interactive inline buttons** to pick quality: Best / 1080p / 720p / MP3
- 📊 **Real-time progress** bar (the status message updates live while downloading)
- 🗜 **Auto-compression**: videos over 50 MB are re-encoded with ffmpeg
  (H.264/AAC, capped at 720p, bitrate sized to the duration) to fit the limit
  when possible; if it still can't fit, you're asked to pick a lower quality
- 🌐 **Runs as a web service**: a small Flask server binds `$PORT` and answers
  `/health`, so the bot stays alive on Render/Railway (and works with uptime pingers)
- 📤 Sends the finished file straight to you
- ⏳ Reminds you to **forward it to Saved Messages**, then **auto-deletes**
  the link, status messages and the video after 5 minutes (configurable)
- 🛡 **Admin log**: every request is reported to the admin with the user's
  name, user id, username and phone number (if shared)
- 🍪 Reuses an optional **cookies.txt** automatically if present

> **Why 50 MB?** Bots that use only a bot token send files through the HTTP
> Bot API, which caps uploads at **50 MB**. This build compresses larger videos
> to try to fit; truly long/high-bitrate videos may still exceed it.

> **Privacy notes (Telegram limitations):**
> - A bot can only see a user's **phone number if they tap "Share my number"**.
>   Until then the admin log shows `N/A`.
> - A bot **cannot** forward to your Saved Messages for you — it can only remind
>   you and delete messages in the chat afterwards.

## Setup

1. **Create the bot:** message [@BotFather](https://t.me/BotFather) → `/newbot`
   → copy the **bot token**. That's the only credential you need.
2. **Find your admin id:** message [@userinfobot](https://t.me/userinfobot).
3. Copy `.env.example` to `.env` and fill in `BOT_TOKEN` and `ADMIN_ID`.

## Run locally

```bash
cd telegram-bot
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
# requires ffmpeg installed (brew install ffmpeg / apt install ffmpeg)

export $(grep -v '^#' .env | xargs)   # load env vars
python bot.py
```

## Run with Docker

```bash
cd telegram-bot
docker build -t fetchwave-bot .
docker run --env-file .env fetchwave-bot
```

## Deploy on Render (as a Web Service)

Because the bot now runs a **Flask keep-alive server**, deploy it as a normal
*Web Service* (it binds `$PORT` and answers `/health`):

1. Render → **New + → Web Service** → pick this repo.
2. **Root Directory:** `telegram-bot`  ·  **Runtime:** `Docker`.
3. Add environment variables: `BOT_TOKEN`, `ADMIN_ID`
   (and optionally `AUTO_DELETE_SECONDS`, `MAX_DOWNLOAD_MB`).
4. (Optional) Add a **Secret File** named `cookies.txt` — it mounts at
   `/etc/secrets/cookies.txt` and is picked up automatically.
5. Create the service. Check the logs for `Bot is online.`

> **Keep it awake (free plan):** Render free web services sleep after ~15 min
> idle. Point a free uptime pinger (e.g. UptimeRobot) at your service's
> `/health` URL every few minutes to keep it warm.

> Tip: the repo's top-level `render.yaml` Blueprint can deploy **both** the web
> app and this bot at once — just fill in `BOT_TOKEN`/`ADMIN_ID` when prompted.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `BOT_TOKEN` | — | Bot token from @BotFather (only credential needed) |
| `ADMIN_ID` | — | Telegram user id that receives request logs |
| `AUTO_DELETE_SECONDS` | `300` | Delay before messages/video are deleted |
| `MAX_DOWNLOAD_MB` | `500` | Largest source the bot downloads before compressing |
| `PORT` | `8080` | Port for the Flask keep-alive server |
| `COOKIES_FILE` | `/etc/secrets/cookies.txt` | Optional cookies file path |

## Responsible use

Only download content you own or have permission to download. Respect YouTube's
and Instagram's Terms of Service and copyright.
