"""
FetchWave Telegram Bot
======================

A bot-token-only bot (HTTP Bot API via python-telegram-bot — NO api_id /
api_hash) that:
  - accepts a YouTube or Instagram link and auto-verifies it
  - lets the user pick a quality via inline buttons
  - downloads with yt-dlp showing a LIVE progress bar
  - AUTO-COMPRESSES oversized files with ffmpeg to fit Telegram's 50 MB bot
    limit when possible; otherwise asks for a lower quality
  - sends the file back and reminds the user to forward it to Saved Messages
  - auto-deletes the link, status and video messages after N minutes
  - logs every request to an admin (name, user id, username, phone if shared)

A tiny Flask server runs alongside the bot so it can be deployed as a
**web service** (binds $PORT) and kept awake by an uptime pinger.

Requires: python-telegram-bot, yt-dlp, flask  (and ffmpeg + ffprobe).
Env: BOT_TOKEN, ADMIN_ID, AUTO_DELETE_SECONDS, MAX_DOWNLOAD_MB, COOKIES_FILE, PORT
"""

import asyncio
import html
import os
import re
import secrets
import shutil
import subprocess
import tempfile
import threading
from urllib.parse import urlparse

from flask import Flask, jsonify

from telegram import (
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    KeyboardButton,
    ReplyKeyboardMarkup,
    ReplyKeyboardRemove,
    Update,
)
from telegram.constants import ParseMode
from telegram.ext import (
    Application,
    CallbackQueryHandler,
    CommandHandler,
    ContextTypes,
    MessageHandler,
    filters,
)

import yt_dlp

# --------------------------------------------------------------------------- #
# Configuration  (BOT TOKEN ONLY — no api_id / api_hash)
# --------------------------------------------------------------------------- #

BOT_TOKEN = os.environ.get("BOT_TOKEN", "")
ADMIN_ID = int(os.environ.get("ADMIN_ID", "0") or 0)
AUTO_DELETE = int(os.environ.get("AUTO_DELETE_SECONDS", "300"))  # 5 minutes
COOKIES_FILE = os.environ.get("COOKIES_FILE", "/etc/secrets/cookies.txt")
PORT = int(os.environ.get("PORT", "8080"))

# Telegram Bot API hard limit for files a bot can SEND.
MAX_BYTES = 50 * 1024 * 1024  # 50 MB
MAX_LABEL = "50 MB"
# Don't pull absurdly large sources just to compress them. Configurable cap.
MAX_DOWNLOAD_BYTES = int(os.environ.get("MAX_DOWNLOAD_MB", "500")) * 1024 * 1024
# Target a bit under the limit to leave room for container overhead.
COMPRESS_TARGET = int(MAX_BYTES * 0.92)

if not BOT_TOKEN:
    raise SystemExit(
        "Missing config. Set the BOT_TOKEN environment variable "
        "(get it from @BotFather on Telegram)."
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

FORMATS = {
    "best": "bestvideo[height<=1080]+bestaudio/best[height<=1080]/best",
    "1080": "bestvideo[height<=1080]+bestaudio/best[height<=1080]/best",
    "720": "bestvideo[height<=720]+bestaudio/best[height<=720]/best",
}

WELCOME = (
    "<b>👋 Welcome to FetchWave</b>\n\n"
    "Send me a <b>YouTube</b> or <b>Instagram</b> link and I'll download it for you "
    "with a live progress bar.\n\n"
    f"📦 <b>Max send size: {MAX_LABEL}</b> (Telegram's bot limit). Larger videos are "
    "<b>automatically compressed</b> to fit when possible — otherwise pick a lower "
    "quality or <b>🎵 MP3</b>.\n\n"
    f"⚠️ The file <b>auto-deletes in {AUTO_DELETE // 60} minutes</b> — forward it to "
    "your <b>Saved Messages</b> right away.\n\n"
    "You can optionally share your number below."
)

# In-memory stores
PENDING = {}   # token -> {url, chat, msg, user}
PHONES = {}    # user_id -> phone number (only if shared)


# --------------------------------------------------------------------------- #
# Flask keep-alive server (so the bot can run as a web service)
# --------------------------------------------------------------------------- #

flask_app = Flask(__name__)


@flask_app.route("/")
def _home():
    return "FetchWave Telegram bot is alive ✅"


@flask_app.route("/health")
def _health():
    return jsonify(ok=True, pending=len(PENDING))


def start_keep_alive():
    def run():
        flask_app.run(host="0.0.0.0", port=PORT, debug=False, use_reloader=False)

    threading.Thread(target=run, daemon=True).start()
    print(f"  Keep-alive web server on :{PORT}")


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


def quality_buttons(token: str) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        [
            [
                InlineKeyboardButton("🎬 Best", callback_data=f"dl|{token}|best"),
                InlineKeyboardButton("1080p", callback_data=f"dl|{token}|1080"),
            ],
            [
                InlineKeyboardButton("720p", callback_data=f"dl|{token}|720"),
                InlineKeyboardButton("🎵 MP3", callback_data=f"dl|{token}|mp3"),
            ],
            [InlineKeyboardButton("❌ Cancel", callback_data=f"cancel|{token}")],
        ]
    )


def render_status(state: dict) -> str:
    status = state.get("status")
    if status in (None, "starting"):
        return "⏳ <b>Preparing download…</b>"
    if status == "processing":
        return "⚙️ <b>Processing / merging…</b>\n" + bar(100)
    if status == "compressing":
        return "🗜 <b>Compressing to fit 50 MB…</b>\nThis can take a moment."

    pct = state.get("percent")
    head = f"⬇️ <b>Downloading…</b> {pct:.0f}%" if pct is not None else "⬇️ <b>Downloading…</b>"
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


async def safe_edit(bot, chat_id, msg_id, text, reply_markup=None):
    try:
        await bot.edit_message_text(
            chat_id=chat_id,
            message_id=msg_id,
            text=text,
            parse_mode=ParseMode.HTML,
            reply_markup=reply_markup,
            disable_web_page_preview=True,
        )
    except Exception:
        pass


# --------------------------- download + compress --------------------------- #

def build_ydl_opts(fmt_key: str, tmpdir: str, hook):
    opts = {
        "outtmpl": os.path.join(tmpdir, "%(title).80s.%(ext)s"),
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "progress_hooks": [hook],
        "max_filesize": MAX_DOWNLOAD_BYTES,
    }
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


def media_duration(path: str) -> float:
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=nw=1:nk=1", path],
            capture_output=True, text=True, timeout=60,
        )
        return float((out.stdout or "0").strip())
    except Exception:
        return 0.0


def compress_video_to_fit(inp: str, tmpdir: str, state: dict):
    """Re-encode (H.264/AAC, capped at 720p) targeting < 50 MB. Returns path or None."""
    state["status"] = "compressing"
    dur = media_duration(inp)
    out = os.path.join(tmpdir, "compressed.mp4")
    v_kbps = 800  # fallback if duration unknown
    if dur and dur > 0:
        v_kbps = max(120, int((COMPRESS_TARGET * 8 / 1000) / dur - 128))

    for _ in range(2):
        cmd = [
            "ffmpeg", "-y", "-i", inp,
            "-vf", "scale='min(1280,iw)':-2",
            "-c:v", "libx264", "-preset", "veryfast",
            "-b:v", f"{v_kbps}k", "-maxrate", f"{int(v_kbps * 1.45)}k",
            "-bufsize", f"{int(v_kbps * 2)}k",
            "-c:a", "aac", "-b:a", "128k",
            "-movflags", "+faststart", out,
        ]
        subprocess.run(cmd, capture_output=True, timeout=1800, check=True)
        sz = os.path.getsize(out)
        if sz <= MAX_BYTES:
            return out
        # too big — scale the bitrate down and retry once
        v_kbps = max(100, int(v_kbps * (MAX_BYTES / sz) * 0.9))

    return out if os.path.getsize(out) <= MAX_BYTES else None


def compress_audio_to_fit(inp: str, tmpdir: str, state: dict):
    state["status"] = "compressing"
    dur = media_duration(inp)
    out = os.path.join(tmpdir, "compressed.mp3")
    kbps = 128
    if dur and dur > 0:
        kbps = max(48, min(320, int((COMPRESS_TARGET * 8 / 1000) / dur)))
    subprocess.run(
        ["ffmpeg", "-y", "-i", inp, "-c:a", "libmp3lame", "-b:a", f"{kbps}k", out],
        capture_output=True, timeout=900, check=True,
    )
    return out if os.path.getsize(out) <= MAX_BYTES else None


# ------------------------------- admin log --------------------------------- #

async def notify_admin(context, user, url: str):
    if not ADMIN_ID:
        return
    phone = PHONES.get(user.id) or "N/A"
    uname = f"@{user.username}" if user.username else "N/A"
    name = " ".join(filter(None, [user.first_name, user.last_name])) or "N/A"
    text = (
        "📥 <b>New download request</b>\n\n"
        f"👤 <b>Name:</b> {html.escape(name)}\n"
        f"🆔 <b>User ID:</b> <code>{user.id}</code>\n"
        f"🔗 <b>Username:</b> {html.escape(uname)}\n"
        f"📱 <b>Phone:</b> {html.escape(str(phone))}\n\n"
        f"🌐 <b>Link:</b> {html.escape(url)}"
    )
    try:
        await context.bot.send_message(
            ADMIN_ID, text, parse_mode=ParseMode.HTML,
            reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("🔗 Open link", url=url)]]),
            disable_web_page_preview=True,
        )
    except Exception:
        pass


async def autodelete(context, chat_id, message_ids, token):
    await asyncio.sleep(AUTO_DELETE)
    for mid in message_ids:
        if not mid:
            continue
        try:
            await context.bot.delete_message(chat_id, mid)
        except Exception:
            pass
    PENDING.pop(token, None)


# --------------------------------------------------------------------------- #
# Handlers
# --------------------------------------------------------------------------- #

async def cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    kb = ReplyKeyboardMarkup(
        [[KeyboardButton("📱 Share my number (optional)", request_contact=True)]],
        resize_keyboard=True, one_time_keyboard=True,
    )
    await update.message.reply_text(WELCOME, parse_mode=ParseMode.HTML, reply_markup=kb)


async def on_contact(update: Update, context: ContextTypes.DEFAULT_TYPE):
    PHONES[update.effective_user.id] = update.message.contact.phone_number
    await update.message.reply_text(
        "📱 Thanks, your number is saved. Now send me a link!",
        reply_markup=ReplyKeyboardRemove(),
    )


async def on_message(update: Update, context: ContextTypes.DEFAULT_TYPE):
    text = (update.message.text or "").strip()
    match = URL_RE.search(text)
    if not match:
        await update.message.reply_text(
            "🔗 Send me a <b>YouTube</b> or <b>Instagram</b> link.", parse_mode=ParseMode.HTML
        )
        return

    url = match.group(0)
    if not valid_link(url):
        await update.message.reply_text(
            "❌ Only <b>YouTube</b> and <b>Instagram</b> links are supported.",
            parse_mode=ParseMode.HTML,
        )
        return

    platform = detect_platform(url)
    await notify_admin(context, update.effective_user, url)

    token = secrets.token_urlsafe(8)
    PENDING[token] = {
        "url": url,
        "chat": update.effective_chat.id,
        "msg": update.message.message_id,
        "user": update.effective_user.id,
    }
    await update.message.reply_text(
        f"✅ <b>{platform}</b> link verified!\nChoose a format below 👇",
        parse_mode=ParseMode.HTML, reply_markup=quality_buttons(token),
    )


async def on_cancel(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    token = query.data.split("|", 1)[1]
    PENDING.pop(token, None)
    await query.answer()
    await safe_edit(context.bot, query.message.chat_id, query.message.message_id, "❌ Cancelled.")


async def on_download(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    _, token, fmt_key = query.data.split("|")
    item = PENDING.get(token)
    if not item:
        await query.answer("This request expired — please send the link again.", show_alert=True)
        return

    await query.answer("Starting…")
    url = item["url"]
    chat_id = query.message.chat_id
    status_id = query.message.message_id

    await safe_edit(context.bot, chat_id, status_id, "⏳ <b>Preparing download…</b>")

    state = {"status": "starting"}
    done = asyncio.Event()

    async def updater():
        last = ""
        while not done.is_set():
            txt = render_status(state)
            if txt != last:
                await safe_edit(context.bot, chat_id, status_id, txt)
                last = txt
            await asyncio.sleep(3)

    upd_task = asyncio.create_task(updater())
    tmpdir = tempfile.mkdtemp(prefix="tgdl-")
    loop = asyncio.get_running_loop()

    # ---- download ----
    try:
        await loop.run_in_executor(None, do_download, url, fmt_key, tmpdir, state)
    except Exception as exc:
        done.set()
        upd_task.cancel()
        await safe_edit(
            context.bot, chat_id, status_id,
            f"❌ <b>Download failed.</b>\n<code>{html.escape(str(exc))[:300]}</code>",
        )
        shutil.rmtree(tmpdir, ignore_errors=True)
        return

    files = [f for f in os.listdir(tmpdir) if not f.endswith((".part", ".ytdl"))]
    if not files:
        done.set()
        upd_task.cancel()
        await safe_edit(
            context.bot, chat_id, status_id,
            f"❌ <b>Source is too large to process</b> (over {human(MAX_DOWNLOAD_BYTES)}).\n"
            "Try a lower quality or <b>🎵 MP3</b>.",
        )
        shutil.rmtree(tmpdir, ignore_errors=True)
        return

    filepath = os.path.join(tmpdir, files[0])
    size = os.path.getsize(filepath)
    compressed = False

    # ---- compress if over the 50 MB limit ----
    if size > MAX_BYTES:
        await safe_edit(
            context.bot, chat_id, status_id,
            f"🗜 <b>{human(size)} is over {MAX_LABEL}.</b> Compressing to fit…",
        )
        try:
            if fmt_key == "mp3":
                newpath = await loop.run_in_executor(None, compress_audio_to_fit, filepath, tmpdir, state)
            else:
                newpath = await loop.run_in_executor(None, compress_video_to_fit, filepath, tmpdir, state)
        except Exception:
            newpath = None

        if newpath and os.path.getsize(newpath) <= MAX_BYTES:
            filepath = newpath
            size = os.path.getsize(newpath)
            compressed = True
        else:
            done.set()
            upd_task.cancel()
            await safe_edit(
                context.bot, chat_id, status_id,
                f"❌ <b>Couldn't get it under {MAX_LABEL}</b> even after compression.\n"
                "Try <b>720p</b> or <b>🎵 MP3</b> instead.",
            )
            shutil.rmtree(tmpdir, ignore_errors=True)
            return

    done.set()
    try:
        await upd_task
    except Exception:
        pass

    # ---- upload ----
    note = "🗜 Compressed to fit Telegram's 50 MB limit.\n\n" if compressed else ""
    await safe_edit(context.bot, chat_id, status_id, f"📤 <b>Uploading… ({human(size)})</b>")
    caption = (
        "✅ <b>Here's your file!</b>\n\n"
        f"{note}"
        f"⚠️ <b>Forward it to your Saved Messages now</b> — it will be "
        f"auto-deleted in <b>{AUTO_DELETE // 60} min</b>."
    )
    src_btn = InlineKeyboardMarkup([[InlineKeyboardButton("🔗 Source", url=url)]])

    try:
        with open(filepath, "rb") as fh:
            if fmt_key == "mp3":
                sent = await context.bot.send_audio(
                    chat_id, fh, caption=caption, parse_mode=ParseMode.HTML, reply_markup=src_btn
                )
            else:
                sent = await context.bot.send_video(
                    chat_id, fh, caption=caption, parse_mode=ParseMode.HTML,
                    supports_streaming=True, reply_markup=src_btn,
                )
    except Exception as exc:
        await safe_edit(
            context.bot, chat_id, status_id,
            f"❌ <b>Upload failed.</b>\n<code>{html.escape(str(exc))[:300]}</code>",
        )
        shutil.rmtree(tmpdir, ignore_errors=True)
        return

    shutil.rmtree(tmpdir, ignore_errors=True)
    await safe_edit(
        context.bot, chat_id, status_id,
        f"✅ <b>Sent!</b> Forward it to <b>Saved Messages</b> — everything here "
        f"auto-deletes in {AUTO_DELETE // 60} min. 🗑",
    )

    ids = [item.get("msg"), status_id, sent.message_id]
    asyncio.create_task(autodelete(context, chat_id, ids, token))


# --------------------------------------------------------------------------- #
# Entrypoint
# --------------------------------------------------------------------------- #

def main():
    print("Starting FetchWave Telegram bot (bot-token only)…")
    print(f"  Max send size: {MAX_LABEL}  |  download cap: {human(MAX_DOWNLOAD_BYTES)}")
    print(f"  Auto-delete after: {AUTO_DELETE}s")
    try:
        if COOKIES_FILE and os.path.getsize(COOKIES_FILE) > 0:
            print(f"  Cookies: enabled ({COOKIES_FILE})")
    except OSError:
        print("  Cookies: none found — running without cookies")

    start_keep_alive()

    app = Application.builder().token(BOT_TOKEN).build()
    app.add_handler(CommandHandler(["start", "help"], cmd_start))
    app.add_handler(MessageHandler(filters.CONTACT, on_contact))
    app.add_handler(CallbackQueryHandler(on_cancel, pattern=r"^cancel\|"))
    app.add_handler(CallbackQueryHandler(on_download, pattern=r"^dl\|"))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, on_message))

    print("  Bot is online. Press Ctrl+C to stop.")
    app.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    main()
