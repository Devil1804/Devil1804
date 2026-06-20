"""
FetchWave Telegram Bot
======================

A Telethon bot (logs in with a BOT TOKEN) that:
  - accepts a YouTube or Instagram link
  - auto-verifies the link
  - lets the user pick a quality via inline buttons
  - downloads with yt-dlp showing a LIVE progress bar (download + upload)
  - sends the file back and reminds the user to forward it to Saved Messages
  - auto-deletes the link message, status messages and the video after N minutes
  - logs every request to an admin (name, user id, username, phone if shared)

Requires: telethon, yt-dlp  (and ffmpeg on the system for merging/MP3).
Env vars: API_ID, API_HASH, BOT_TOKEN, ADMIN_ID, AUTO_DELETE_SECONDS, COOKIES_FILE
"""

import asyncio
import html
import os
import re
import secrets
import shutil
import tempfile
import time
from urllib.parse import urlparse

from telethon import Button, TelegramClient, events

import yt_dlp

# --------------------------------------------------------------------------- #
# Configuration
# --------------------------------------------------------------------------- #

API_ID = int(os.environ.get("API_ID", "0") or 0)
API_HASH = os.environ.get("API_HASH", "")
BOT_TOKEN = os.environ.get("BOT_TOKEN", "")
ADMIN_ID = int(os.environ.get("ADMIN_ID", "0") or 0)
AUTO_DELETE = int(os.environ.get("AUTO_DELETE_SECONDS", "300"))  # 5 minutes
COOKIES_FILE = os.environ.get("COOKIES_FILE", "/etc/secrets/cookies.txt")

if not (API_ID and API_HASH and BOT_TOKEN):
    raise SystemExit(
        "Missing config. Set API_ID, API_HASH and BOT_TOKEN environment variables.\n"
        "Get API_ID/API_HASH from https://my.telegram.org and BOT_TOKEN from @BotFather."
    )

ALLOWED_HOSTS = (
    "youtube.com",
    "youtu.be",
    "m.youtube.com",
    "music.youtube.com",
    "instagram.com",
    "instagr.am",
)

URL_RE = re.compile(r"https?://[^\s]+", re.IGNORECASE)

# Format selectors offered via inline buttons.
FORMATS = {
    "best": "bestvideo[height<=1080]+bestaudio/best[height<=1080]/best",
    "1080": "bestvideo[height<=1080]+bestaudio/best[height<=1080]/best",
    "720": "bestvideo[height<=720]+bestaudio/best[height<=720]/best",
}

WELCOME = (
    "<b>👋 Welcome to FetchWave</b>\n\n"
    "Send me a <b>YouTube</b> or <b>Instagram</b> link and I'll download it for you "
    "with a live progress bar.\n\n"
    "⚠️ The file <b>auto-deletes in {mins} minutes</b>, so forward it to your "
    "<b>Saved Messages</b> right away.\n\n"
    "You can optionally share your number below (used only for support)."
).format(mins=AUTO_DELETE // 60)

# In-memory stores
PENDING = {}      # token -> {url, chat, msg, user}
PHONES = {}       # user_id -> phone number (only if user shared it)

client = TelegramClient("fetchwave_bot", API_ID, API_HASH)
client.parse_mode = "html"


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #

def valid_link(url: str) -> bool:
    try:
        host = (urlparse(url).hostname or "").lower()
        if host.startswith("www."):
            host = host[4:]
        return any(host == h or host.endswith("." + h) for h in ALLOWED_HOSTS)
    except Exception:
        return False


def detect_platform(url: str):
    u = url.lower()
    if "youtu" in u:
        return "YouTube"
    if "instagr" in u:
        return "Instagram"
    return None


def human(n) -> str:
    if not n:
        return "0 B"
    n = float(n)
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024:
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} TB"


def bar(pct) -> str:
    pct = max(0, min(100, pct or 0))
    filled = int(pct // 10)
    return "▰" * filled + "▱" * (10 - filled)


def quality_buttons(token: str):
    return [
        [
            Button.inline("🎬 Best", f"dl|{token}|best".encode()),
            Button.inline("1080p", f"dl|{token}|1080".encode()),
        ],
        [
            Button.inline("720p", f"dl|{token}|720".encode()),
            Button.inline("🎵 MP3", f"dl|{token}|mp3".encode()),
        ],
        [Button.inline("❌ Cancel", f"cancel|{token}".encode())],
    ]


def render_status(state: dict, fmt: str) -> str:
    status = state.get("status")
    if status in (None, "starting"):
        return "⏳ <b>Preparing download…</b>"
    if status == "processing":
        return "⚙️ <b>Processing / merging…</b>\n" + bar(100)

    pct = state.get("percent")
    head = (
        f"⬇️ <b>Downloading…</b> {pct:.0f}%" if pct is not None else "⬇️ <b>Downloading…</b>"
    )
    lines = [head, bar(pct if pct is not None else 0)]
    extra = []
    if state.get("total"):
        extra.append(f"{human(state.get('downloaded'))} / {human(state.get('total'))}")
    if state.get("speed"):
        extra.append(f"{human(state.get('speed'))}/s")
    if state.get("eta") is not None:
        extra.append(f"ETA {int(state['eta'])}s")
    if extra:
        lines.append("  ·  ".join(extra))
    return "\n".join(lines)


async def safe_edit(msg, text, buttons=None):
    try:
        await msg.edit(text, buttons=buttons)
    except Exception:
        pass  # ignore "message not modified" / flood etc.


def build_ydl_opts(fmt_key: str, tmpdir: str, hook):
    opts = {
        "outtmpl": os.path.join(tmpdir, "%(title).80s.%(ext)s"),
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "progress_hooks": [hook],
        "restrictfilenames": False,
    }
    # Optional cookies — only if the file actually exists and is non-empty.
    try:
        if COOKIES_FILE and os.path.getsize(COOKIES_FILE) > 0:
            opts["cookiefile"] = COOKIES_FILE
    except OSError:
        pass

    if fmt_key == "mp3":
        opts["format"] = "bestaudio/best"
        opts["postprocessors"] = [
            {"key": "FFmpegExtractAudio", "preferredcodec": "mp3", "preferredquality": "0"}
        ]
    else:
        opts["format"] = FORMATS.get(fmt_key, FORMATS["best"])
        opts["merge_output_format"] = "mp4"
    return opts


def do_download(url: str, fmt_key: str, tmpdir: str, state: dict):
    """Blocking yt-dlp download — runs in a thread executor."""

    def hook(d):
        if d.get("status") == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            done = d.get("downloaded_bytes", 0)
            state["status"] = "downloading"
            state["downloaded"] = done
            state["total"] = total
            state["percent"] = (done / total * 100) if total else None
            state["speed"] = d.get("speed")
            state["eta"] = d.get("eta")
        elif d.get("status") == "finished":
            state["status"] = "processing"

    with yt_dlp.YoutubeDL(build_ydl_opts(fmt_key, tmpdir, hook)) as ydl:
        ydl.extract_info(url, download=True)


async def notify_admin(sender, url: str):
    if not ADMIN_ID:
        return
    phone = PHONES.get(sender.id) or getattr(sender, "phone", None) or "N/A"
    uname = f"@{sender.username}" if getattr(sender, "username", None) else "N/A"
    name = " ".join(
        filter(None, [getattr(sender, "first_name", ""), getattr(sender, "last_name", "")])
    ) or "N/A"
    text = (
        "📥 <b>New download request</b>\n\n"
        f"👤 <b>Name:</b> {html.escape(name)}\n"
        f"🆔 <b>User ID:</b> <code>{sender.id}</code>\n"
        f"🔗 <b>Username:</b> {html.escape(uname)}\n"
        f"📱 <b>Phone:</b> {html.escape(str(phone))}\n\n"
        f"🌐 <b>Link:</b> {html.escape(url)}"
    )
    try:
        await client.send_message(
            ADMIN_ID, text, buttons=[[Button.url("🔗 Open link", url)]], link_preview=False
        )
    except Exception:
        pass


async def autodelete(chat_id, message_ids, token):
    """Delete the link msg, status msg and the video after AUTO_DELETE seconds."""
    await asyncio.sleep(AUTO_DELETE)
    try:
        await client.delete_messages(chat_id, [m for m in message_ids if m])
    except Exception:
        pass
    PENDING.pop(token, None)


# --------------------------------------------------------------------------- #
# Handlers
# --------------------------------------------------------------------------- #

@client.on(events.NewMessage(incoming=True))
async def on_message(event):
    msg = event.message

    # 1) user shared their contact (phone)
    if msg.contact:
        PHONES[event.sender_id] = msg.contact.phone_number
        await event.reply(
            "📱 Thanks, your number is saved. Now send me a link!",
            buttons=Button.clear(),
        )
        return

    text = (event.raw_text or "").strip()

    # 2) commands
    if text.startswith("/start") or text.startswith("/help"):
        await event.reply(
            WELCOME,
            buttons=[[Button.request_phone("📱 Share my number (optional)")]],
            link_preview=False,
        )
        return

    # 3) find & verify a link
    match = URL_RE.search(text)
    if not match:
        await event.reply("🔗 Send me a <b>YouTube</b> or <b>Instagram</b> link.")
        return

    url = match.group(0)
    if not valid_link(url):
        await event.reply("❌ Only <b>YouTube</b> and <b>Instagram</b> links are supported.")
        return

    platform = detect_platform(url)
    sender = await event.get_sender()
    await notify_admin(sender, url)

    token = secrets.token_urlsafe(8)
    PENDING[token] = {
        "url": url,
        "chat": event.chat_id,
        "msg": event.id,
        "user": event.sender_id,
    }
    await event.reply(
        f"✅ <b>{platform}</b> link verified!\nChoose a format below 👇",
        buttons=quality_buttons(token),
        link_preview=False,
    )


@client.on(events.CallbackQuery(pattern=rb"cancel\|"))
async def on_cancel(event):
    token = event.data.decode().split("|", 1)[1]
    PENDING.pop(token, None)
    await event.edit("❌ Cancelled.")


@client.on(events.CallbackQuery(pattern=rb"dl\|"))
async def on_download(event):
    _, token, fmt_key = event.data.decode().split("|")
    item = PENDING.get(token)
    if not item:
        await event.answer("This request expired — please send the link again.", alert=True)
        return

    await event.answer("Starting…")
    url = item["url"]

    # The message that held the buttons becomes our live status message.
    status = await event.edit("⏳ <b>Preparing download…</b>")

    state = {"status": "starting"}
    done = asyncio.Event()

    async def updater():
        last = ""
        while not done.is_set():
            txt = render_status(state, fmt_key)
            if txt != last:
                await safe_edit(status, txt)
                last = txt
            await asyncio.sleep(3)

    upd_task = asyncio.create_task(updater())
    tmpdir = tempfile.mkdtemp(prefix="tgdl-")
    loop = asyncio.get_event_loop()

    # ---- download ----
    try:
        await loop.run_in_executor(None, do_download, url, fmt_key, tmpdir, state)
    except Exception as exc:
        done.set()
        upd_task.cancel()
        await safe_edit(status, f"❌ <b>Download failed.</b>\n<code>{html.escape(str(exc))[:300]}</code>")
        shutil.rmtree(tmpdir, ignore_errors=True)
        return

    done.set()
    try:
        await upd_task
    except Exception:
        pass

    files = [
        f for f in os.listdir(tmpdir) if not f.endswith((".part", ".ytdl"))
    ]
    if not files:
        await safe_edit(status, "❌ No output file was produced.")
        shutil.rmtree(tmpdir, ignore_errors=True)
        return
    filepath = os.path.join(tmpdir, files[0])

    # ---- upload with progress ----
    await safe_edit(status, "📤 <b>Uploading to Telegram…</b>")
    last_up = [0.0]

    def up_cb(current, total):
        now = time.time()
        if now - last_up[0] >= 3:
            last_up[0] = now
            pct = (current / total * 100) if total else 0
            try:
                asyncio.create_task(
                    safe_edit(status, f"📤 <b>Uploading…</b> {pct:.0f}%\n{bar(pct)}")
                )
            except RuntimeError:
                pass

    caption = (
        "✅ <b>Here's your file!</b>\n\n"
        f"⚠️ <b>Forward it to your Saved Messages now</b> — it will be "
        f"auto-deleted in <b>{AUTO_DELETE // 60} min</b>."
    )
    try:
        sent = await client.send_file(
            item["chat"],
            filepath,
            caption=caption,
            supports_streaming=True,
            progress_callback=up_cb,
            buttons=[[Button.url("🔗 Source", url)]],
        )
    except Exception as exc:
        await safe_edit(status, f"❌ <b>Upload failed.</b>\n<code>{html.escape(str(exc))[:300]}</code>")
        shutil.rmtree(tmpdir, ignore_errors=True)
        return

    # delete the local temp file immediately
    shutil.rmtree(tmpdir, ignore_errors=True)

    await safe_edit(
        status,
        f"✅ <b>Sent!</b> Forward it to <b>Saved Messages</b> — everything here "
        f"auto-deletes in {AUTO_DELETE // 60} min. 🗑",
    )

    # schedule deletion of: original link msg, status msg, the video
    ids = [item.get("msg"), status.id, sent.id]
    asyncio.create_task(autodelete(item["chat"], ids, token))


# --------------------------------------------------------------------------- #
# Entrypoint
# --------------------------------------------------------------------------- #

def main():
    print("Starting FetchWave Telegram bot…")
    print(f"  Auto-delete after: {AUTO_DELETE}s")
    try:
        if COOKIES_FILE and os.path.getsize(COOKIES_FILE) > 0:
            print(f"  Cookies: enabled ({COOKIES_FILE})")
    except OSError:
        print("  Cookies: none found — running without cookies")
    client.start(bot_token=BOT_TOKEN)
    print("  Bot is online. Press Ctrl+C to stop.")
    client.run_until_disconnected()


if __name__ == "__main__":
    main()
