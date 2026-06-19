import http from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createZip } from "./zip.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const PORT = process.env.PORT || 3000;
const YT_DLP = process.env.YTDLP_PATH || "yt-dlp";
const JOB_TTL_MS = 15 * 60 * 1000; // auto-clean abandoned jobs after 15 min

// Optional cookies: if a Netscape-format cookies file exists, yt-dlp uses it
// (helps with YouTube bot checks / private or age-restricted content). If it's
// missing, the app works exactly as before with no cookies.
// On Render, add a Secret File named "cookies.txt" (mounted at /etc/secrets/)
// or set COOKIES_FILE to a custom path.
const COOKIES_FILE = process.env.COOKIES_FILE || "/etc/secrets/cookies.txt";

/** Returns ["--cookies", path] when a usable cookies file is present, else []. */
function cookieArgs() {
  try {
    if (COOKIES_FILE && fs.statSync(COOKIES_FILE).size > 0) {
      return ["--cookies", COOKIES_FILE];
    }
  } catch {
    /* file not present — fall through to no cookies */
  }
  return [];
}

/** True if cookies are currently available (used for startup logging). */
function cookiesPresent() {
  return cookieArgs().length > 0;
}

/* ----------------------------- helpers ----------------------------- */

const URL_RE = /^https?:\/\/[^\s]+$/i;
const ALLOWED_HOSTS = [
  "youtube.com",
  "youtu.be",
  "m.youtube.com",
  "music.youtube.com",
  "instagram.com",
  "instagr.am",
];

function isAllowedUrl(raw) {
  if (typeof raw !== "string" || !URL_RE.test(raw.trim())) return false;
  try {
    const host = new URL(raw.trim()).hostname.replace(/^www\./, "");
    return ALLOWED_HOSTS.some((h) => host === h || host.endsWith("." + h));
  } catch {
    return false;
  }
}

function runYtDlp(args, { timeout = 90_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(YT_DLP, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("yt-dlp timed out"));
    }, timeout);

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(
        err.code === "ENOENT"
          ? new Error("yt-dlp is not installed or not on PATH.")
          : err
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `yt-dlp exited with code ${code}`));
    });
  });
}

function genericFormats() {
  return [
    { id: "video-best", label: "Best quality", type: "video", ext: "mp4" },
    { id: "video-1080", label: "1080p", type: "video", ext: "mp4" },
    { id: "video-720", label: "720p", type: "video", ext: "mp4" },
    { id: "video-480", label: "480p", type: "video", ext: "mp4" },
    { id: "video-360", label: "360p", type: "video", ext: "mp4" },
    { id: "audio-mp3", label: "Audio only (MP3)", type: "audio", ext: "mp3" },
  ];
}

function shapeVideoInfo(meta) {
  const seen = new Set();
  const formats = [];
  const heights = [2160, 1440, 1080, 720, 480, 360, 240];

  for (const h of heights) {
    const has = (meta.formats || []).some(
      (f) =>
        f.vcodec &&
        f.vcodec !== "none" &&
        (f.height || 0) >= h - 30 &&
        (f.height || 0) <= h + 30
    );
    if (has && !seen.has(h)) {
      seen.add(h);
      formats.push({ id: `video-${h}`, label: `${h}p`, type: "video", ext: "mp4" });
    }
  }
  formats.unshift({ id: "video-best", label: "Best quality", type: "video", ext: "mp4" });
  formats.push({ id: "audio-mp3", label: "Audio only (MP3)", type: "audio", ext: "mp3" });

  const thumb =
    meta.thumbnail ||
    (Array.isArray(meta.thumbnails) && meta.thumbnails.length
      ? meta.thumbnails[meta.thumbnails.length - 1].url
      : null);

  return {
    isPlaylist: false,
    title: meta.title || "Untitled",
    uploader: meta.uploader || meta.channel || meta.uploader_id || "Unknown",
    duration: meta.duration || null,
    thumbnail: thumb,
    extractor: meta.extractor_key || meta.extractor || "",
    webpage_url: meta.webpage_url || meta.original_url || "",
    formats,
  };
}

function shapePlaylistInfo(meta) {
  const entries = (meta.entries || [])
    .filter(Boolean)
    .map((e, i) => ({
      index: i + 1,
      id: e.id || "",
      title: e.title || `Item ${i + 1}`,
      url: e.url || e.webpage_url || "",
      duration: e.duration || null,
      uploader: e.uploader || e.channel || "",
      thumbnail:
        e.thumbnail ||
        (Array.isArray(e.thumbnails) && e.thumbnails.length
          ? e.thumbnails[e.thumbnails.length - 1].url
          : null),
    }))
    .filter((e) => e.url);

  return {
    isPlaylist: true,
    title: meta.title || "Playlist",
    uploader: meta.uploader || meta.channel || meta.uploader_id || "Unknown",
    count: entries.length,
    extractor: meta.extractor_key || meta.extractor || "",
    webpage_url: meta.webpage_url || meta.original_url || "",
    entries,
    formats: genericFormats(),
  };
}

function formatSelector(id) {
  if (id === "video-best") return "bestvideo*+bestaudio/best";
  const m = /^video-(\d+)$/.exec(id);
  if (m) {
    const h = m[1];
    return `bestvideo[height<=${h}]+bestaudio/best[height<=${h}]/best`;
  }
  return "bestvideo*+bestaudio/best";
}

function safeFilename(name) {
  return (name || "download")
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || "download";
}

function cleanup(dir) {
  if (dir) fs.rm(dir, { recursive: true, force: true }, () => {});
}

/* --------------------------- http helpers --------------------------- */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".jpg": "image/jpeg",
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendText(res, status, text) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split("?")[0]);
  if (urlPath === "/") urlPath = "/index.html";
  const safePath = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(PUBLIC_DIR, safePath);
  if (!filePath.startsWith(PUBLIC_DIR)) return sendText(res, 403, "Forbidden");

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) return sendText(res, 404, "Not found");
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Content-Length": stat.size,
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let data = "";
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("Body too large"));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

/* ----------------------------- jobs --------------------------------- */

/** @type {Map<string, any>} */
const jobs = new Map();

function emit(job, event) {
  job.lastEvent = event;
  if (event.phase === "done" || event.phase === "error") job.finished = true;
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of job.subscribers) res.write(payload);
}

function parseNum(v) {
  if (v == null || v === "NA" || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function startDownloadJob({ url, formatId, mode, titleHint }) {
  const id = randomUUID();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vdl-"));
  const isPlaylist = mode === "playlist";

  const outTmpl = isPlaylist
    ? path.join(tmpDir, "%(playlist_index)03d - %(title).80s.%(ext)s")
    : path.join(tmpDir, "%(title).100s.%(ext)s");

  // Tab-delimited progress template we can parse line by line.
  const progressTmpl =
    "download:PROG\t%(progress.downloaded_bytes)s\t%(progress.total_bytes)s\t" +
    "%(progress.total_bytes_estimate)s\t%(progress.speed)s\t%(progress.eta)s\t" +
    "%(info.playlist_index)s\t%(info.playlist_count)s\t%(info.title)s";

  const args = [
    ...cookieArgs(),
    "--no-warnings",
    "--newline",
    "--progress-template",
    progressTmpl,
    "-o",
    outTmpl,
  ];
  if (!isPlaylist) args.push("--no-playlist");
  else args.push("--yes-playlist");

  if (formatId === "audio-mp3") {
    args.push("-x", "--audio-format", "mp3", "--audio-quality", "0");
  } else {
    args.push("-f", formatSelector(formatId), "--merge-output-format", "mp4");
  }
  args.push(url.trim());

  const job = {
    id,
    tmpDir,
    mode,
    titleHint,
    subscribers: new Set(),
    lastEvent: { phase: "starting" },
    finished: false,
    filePath: null,
    fileName: null,
    createdAt: Date.now(),
  };
  jobs.set(id, job);

  const child = spawn(YT_DLP, args, { windowsHide: true });
  let stderr = "";

  child.stdout.on("data", (chunk) => {
    const lines = chunk.toString().split(/\r?\n/);
    for (const line of lines) {
      if (!line.startsWith("PROG\t")) continue;
      const [, dl, total, est, speed, eta, idx, count, title] = line.split("\t");
      const downloaded = parseNum(dl);
      const totalBytes = parseNum(total) ?? parseNum(est);
      const itemIdx = parseNum(idx);
      const itemCount = parseNum(count);

      let percent = null;
      if (downloaded != null && totalBytes) {
        percent = Math.min(100, (downloaded / totalBytes) * 100);
      }
      // Overall percent across a playlist.
      let overall = percent;
      if (itemIdx && itemCount && percent != null) {
        overall = ((itemIdx - 1 + percent / 100) / itemCount) * 100;
      }

      emit(job, {
        phase: "downloading",
        percent: percent != null ? Math.round(percent) : null,
        overall: overall != null ? Math.round(overall) : null,
        downloaded,
        total: totalBytes,
        speed: parseNum(speed),
        eta: parseNum(eta),
        item: itemIdx,
        itemCount,
        title: title && title !== "NA" ? title : titleHint,
      });
    }
  });

  child.stderr.on("data", (d) => {
    const s = d.toString();
    stderr += s;
    if (/\[Merger\]|Merging formats/i.test(s)) {
      emit(job, { phase: "processing", note: "Merging video + audio…" });
    } else if (/\[ExtractAudio\]|Extracting audio/i.test(s)) {
      emit(job, { phase: "processing", note: "Extracting audio…" });
    }
  });

  child.on("error", (err) => {
    emit(job, {
      phase: "error",
      message:
        err.code === "ENOENT"
          ? "yt-dlp is not installed on the server."
          : "Download failed to start.",
    });
    scheduleCleanup(job, 30_000);
  });

  child.on("close", async (code) => {
    if (code !== 0) {
      emit(job, { phase: "error", message: "Download failed: " + (stderr.trim().split("\n").pop() || code) });
      scheduleCleanup(job, 30_000);
      return;
    }

    let files = [];
    try {
      files = fs
        .readdirSync(tmpDir)
        .filter((f) => !f.endsWith(".part") && !f.endsWith(".ytdl"))
        .sort();
    } catch {
      /* ignore */
    }

    if (!files.length) {
      emit(job, { phase: "error", message: "No output file produced." });
      scheduleCleanup(job, 30_000);
      return;
    }

    if (isPlaylist && files.length > 1) {
      emit(job, { phase: "processing", note: "Packaging " + files.length + " files into a ZIP…" });
      const zipName = safeFilename(titleHint || "playlist") + ".zip";
      const zipPath = path.join(tmpDir, "__bundle.zip");
      try {
        const out = fs.createWriteStream(zipPath);
        await createZip(
          files.map((f) => ({ name: f, path: path.join(tmpDir, f) })),
          out
        );
        job.filePath = zipPath;
        job.fileName = zipName;
      } catch (e) {
        emit(job, { phase: "error", message: "Failed to package files." });
        scheduleCleanup(job, 30_000);
        return;
      }
    } else {
      const f = files[0];
      const ext = path.extname(f) || (formatId === "audio-mp3" ? ".mp3" : ".mp4");
      job.filePath = path.join(tmpDir, f);
      job.fileName = safeFilename(titleHint || path.basename(f, ext)) + ext;
    }

    let size = null;
    try {
      size = fs.statSync(job.filePath).size;
    } catch {
      /* ignore */
    }

    emit(job, {
      phase: "done",
      downloadUrl: `/api/file/${id}`,
      fileName: job.fileName,
      size,
      fileCount: isPlaylist ? files.length : 1,
    });
    scheduleCleanup(job, JOB_TTL_MS);
  });

  return id;
}

function scheduleCleanup(job, ms) {
  clearTimeout(job._cleanup);
  job._cleanup = setTimeout(() => {
    cleanup(job.tmpDir);
    jobs.delete(job.id);
  }, ms);
}

/* ------------------------------ routes ------------------------------ */

async function handleInfo(req, res) {
  let body;
  try {
    body = JSON.parse((await readBody(req)) || "{}");
  } catch {
    return sendJson(res, 400, { error: "Invalid request body." });
  }

  const { url } = body;
  if (!isAllowedUrl(url)) {
    return sendJson(res, 400, { error: "Please enter a valid YouTube or Instagram URL." });
  }

  try {
    // --flat-playlist makes playlist probing fast; for single videos it's a no-op.
    const out = await runYtDlp([
      ...cookieArgs(),
      "-J",
      "--flat-playlist",
      "--no-warnings",
      url.trim(),
    ]);
    const meta = JSON.parse(out);
    if (meta._type === "playlist" && Array.isArray(meta.entries)) {
      sendJson(res, 200, shapePlaylistInfo(meta));
    } else {
      sendJson(res, 200, shapeVideoInfo(meta));
    }
  } catch (err) {
    sendJson(res, 502, {
      error:
        "Could not fetch info. " +
        (err.message || "The link may be private, removed, or unsupported."),
    });
  }
}

async function handleJob(req, res) {
  let body;
  try {
    body = JSON.parse((await readBody(req)) || "{}");
  } catch {
    return sendJson(res, 400, { error: "Invalid request body." });
  }
  const { url, format = "video-best", mode = "single", title } = body;
  if (!isAllowedUrl(url)) {
    return sendJson(res, 400, { error: "Invalid URL." });
  }
  if (mode !== "single" && mode !== "playlist") {
    return sendJson(res, 400, { error: "Invalid mode." });
  }
  try {
    const id = startDownloadJob({ url, formatId: format, mode, titleHint: title });
    sendJson(res, 200, { jobId: id });
  } catch (e) {
    sendJson(res, 500, { error: "Could not start the download." });
  }
}

function handleProgress(req, res, jobId) {
  const job = jobs.get(jobId);
  if (!job) return sendText(res, 404, "Unknown job.");

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write("retry: 3000\n\n");
  job.subscribers.add(res);

  // send current state immediately (covers races where job already finished)
  res.write(`data: ${JSON.stringify(job.lastEvent)}\n\n`);

  const heartbeat = setInterval(() => res.write(": ping\n\n"), 15000);

  req.on("close", () => {
    clearInterval(heartbeat);
    job.subscribers.delete(res);
  });
}

function handleFile(req, res, jobId) {
  const job = jobs.get(jobId);
  if (!job || !job.filePath) return sendText(res, 404, "File not ready or expired.");

  let stat;
  try {
    stat = fs.statSync(job.filePath);
  } catch {
    return sendText(res, 404, "File missing.");
  }

  const ext = path.extname(job.fileName).toLowerCase();
  res.writeHead(200, {
    "Content-Type": MIME[ext] || "application/octet-stream",
    "Content-Length": stat.size,
    "Content-Disposition": `attachment; filename="${job.fileName.replace(/"/g, "")}"`,
  });

  const stream = fs.createReadStream(job.filePath);
  stream.pipe(res);
  stream.on("close", () => scheduleCleanup(job, 5000));
}

/* ------------------------------ server ------------------------------ */

const server = http.createServer((req, res) => {
  const pathname = req.url.split("?")[0];

  if (req.method === "POST" && pathname === "/api/info") return handleInfo(req, res);
  if (req.method === "POST" && pathname === "/api/job") return handleJob(req, res);

  const prog = /^\/api\/progress\/([\w-]+)$/.exec(pathname);
  if (req.method === "GET" && prog) return handleProgress(req, res, prog[1]);

  const file = /^\/api\/file\/([\w-]+)$/.exec(pathname);
  if (req.method === "GET" && file) return handleFile(req, res, file[1]);

  if (req.method === "GET" && pathname === "/api/health") {
    return sendJson(res, 200, { ok: true, jobs: jobs.size, cookies: cookiesPresent() });
  }
  if (req.method === "GET") return serveStatic(req, res);

  sendText(res, 405, "Method not allowed");
});

server.listen(PORT, () => {
  console.log(`\n  FetchWave running at http://localhost:${PORT}`);
  console.log(
    cookiesPresent()
      ? `  Cookies: enabled (${COOKIES_FILE})\n`
      : `  Cookies: none found — running without cookies\n`
  );
});
