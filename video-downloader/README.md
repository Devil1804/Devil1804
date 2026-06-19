# FetchWave — Modern Instagram & YouTube Video Downloader

A clean, fast, fully-functional video downloader with a modern animated UI.
The frontend is a polished single-page app; the backend is a small Express
server that uses [**yt-dlp**](https://github.com/yt-dlp/yt-dlp) to extract and
download videos from YouTube and Instagram.

![stack](https://img.shields.io/badge/stack-Node.js%20%2B%20Express%20%2B%20yt--dlp-7c5cff)

---

## Features

- Modern glassmorphism UI with animated gradient background and smooth motion
- YouTube **and** Instagram (Reels, Shorts, posts, standard videos)
- **Playlist support** — fetch a whole playlist, download every item, or grab
  individual videos. "Download all" bundles them into a single **ZIP**.
- **Real-time download progress** via Server-Sent Events: live percentage,
  speed, ETA, and per-item progress for playlists
- Live video preview: thumbnail, title, uploader, duration
- Quality picker — `Best`, `1080p`, `720p`, `480p`, `360p`, … plus **audio-only MP3**
- One-click download, paste-from-clipboard, toasts, loading states
- Fully responsive + reduced-motion support
- **Zero npm dependencies** — pure Node.js built-ins (incl. a tiny custom ZIP writer)

---

## Prerequisites

You need **three** things installed on the machine that runs the server:

| Tool | Why | Install |
|------|-----|---------|
| **Node.js 18+** | runs the server | https://nodejs.org |
| **yt-dlp** | does the actual extraction/download | see below |
| **ffmpeg** | merges video+audio & converts MP3 | see below |

### Install yt-dlp + ffmpeg

**macOS (Homebrew):**
```bash
brew install yt-dlp ffmpeg
```

**Windows (winget):**
```bash
winget install yt-dlp.yt-dlp
winget install Gyan.FFmpeg
```

**Linux (Debian/Ubuntu):**
```bash
sudo apt install ffmpeg
python3 -m pip install -U yt-dlp     # or: sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && sudo chmod a+rx /usr/local/bin/yt-dlp
```

Verify they're on your PATH:
```bash
yt-dlp --version
ffmpeg -version
```

> If `yt-dlp` isn't on your PATH, set its full path via the `YTDLP_PATH`
> environment variable when starting the server.

---

## Run it

No `npm install` needed — the server uses only Node.js built-in modules.

```bash
npm start          # or simply: node server.js
```

Then open **http://localhost:3000**

Custom port / yt-dlp path:
```bash
PORT=8080 YTDLP_PATH="/usr/local/bin/yt-dlp" npm start
```

---

## How it works

```
Browser  ──POST /api/info───────▶  Server ──spawn──▶ yt-dlp -J --flat-playlist   (metadata)
Browser  ──POST /api/job────────▶  Server starts a download job, returns { jobId }
Browser  ──GET  /api/progress/:id▶ Server ──SSE──▶  live progress events (%, speed, ETA)
Browser  ──GET  /api/file/:id────▶ Server streams the finished file (or ZIP), then cleans up
```

### Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/info` | Returns video metadata, or playlist info + entries |
| `POST` | `/api/job` | Starts a download job (`{ url, format, mode, title }`) → `{ jobId }` |
| `GET`  | `/api/progress/:jobId` | Server-Sent Events stream of live progress |
| `GET`  | `/api/file/:jobId` | Streams the finished file (single) or ZIP (playlist) |
| `GET`  | `/api/health` | Health check |

- `mode` is `single` or `playlist`. For playlists with multiple files, the
  results are bundled into a ZIP on the fly (streaming, store-only).
- Jobs that are never downloaded auto-clean after 15 minutes.

---

## Testing

An offline mock of `yt-dlp` lives in `test/mock-ytdlp.cjs` so the full flow
(info → job → SSE progress → file/ZIP) can be exercised without internet:

```bash
YTDLP_PATH="$(pwd)/test/mock-ytdlp.cjs" node server.js
```

---

## Project structure

```
video-downloader/
├── server.js          # HTTP server: info, job, SSE progress, file endpoints
├── zip.js             # tiny zero-dep streaming ZIP writer (for playlists)
├── package.json
├── README.md
├── test/
│   └── mock-ytdlp.cjs # offline yt-dlp stand-in for testing
└── public/
    ├── index.html     # markup
    ├── style.css      # modern animated styling + progress bar
    └── script.js      # UI logic, SSE progress, playlist handling
```

---

## Legal & responsible use

This tool is for downloading content **you own or have permission to download**.
Downloading copyrighted material without authorization may violate YouTube's and
Instagram's Terms of Service and applicable copyright law. You are responsible
for how you use it. Respect creators and platform rules.

---

## License

MIT
