const $ = (sel) => document.querySelector(sel);

const form = $("#form");
const urlInput = $("#url");
const fetchBtn = $("#fetchBtn");
const pasteBtn = $("#pasteBtn");
const hint = $("#hint");
const toast = $("#toast");
const tabs = document.querySelectorAll(".tab");

// single video els
const resultEl = $("#result");
const thumb = $("#thumb");
const vidTitle = $("#vidTitle");
const uploader = $("#uploader");
const durationEl = $("#duration");
const platformBadge = $("#platformBadge");
const quality = $("#quality");
const downloadBtn = $("#downloadBtn");
const dlNote = $("#dlNote");
const progressEl = $("#progress");
const progressStatus = $("#progressStatus");
const progressPct = $("#progressPct");
const barFill = $("#barFill");
const progressMeta = $("#progressMeta");

// playlist els
const playlistResult = $("#playlistResult");
const plTitle = $("#plTitle");
const plMeta = $("#plMeta");
const plQuality = $("#plQuality");
const plDownloadAll = $("#plDownloadAll");
const plList = $("#plList");
const plProgress = $("#plProgress");
const plProgressStatus = $("#plProgressStatus");
const plProgressPct = $("#plProgressPct");
const plBarFill = $("#plBarFill");
const plProgressMeta = $("#plProgressMeta");

let currentInfo = null;
let activePlatform = "youtube";

/* ---------------- helpers ---------------- */

function showToast(msg, type = "") {
  toast.textContent = msg;
  toast.className = "toast show " + type;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => {
    toast.className = "toast " + type;
  }, 4200);
}

function fmtDuration(secs) {
  if (!secs && secs !== 0) return "";
  secs = Math.round(secs);
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function fmtBytes(n) {
  if (!n && n !== 0) return "";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

function fmtEta(s) {
  if (s == null) return "";
  s = Math.round(s);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
}

function setLoading(btn, on) {
  btn.classList.toggle("loading", on);
  btn.disabled = on;
}

function triggerBrowserDownload(url) {
  const iframe = document.createElement("iframe");
  iframe.style.display = "none";
  iframe.src = url;
  document.body.appendChild(iframe);
  setTimeout(() => iframe.remove(), 1000 * 60 * 10);
}

/* ---------------- platform tabs ---------------- */

tabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    tabs.forEach((t) => {
      t.classList.remove("active");
      t.setAttribute("aria-selected", "false");
    });
    tab.classList.add("active");
    tab.setAttribute("aria-selected", "true");
    activePlatform = tab.dataset.platform;
    urlInput.placeholder =
      activePlatform === "instagram"
        ? "Paste an Instagram Reel or post link…"
        : "Paste a YouTube video, Shorts or playlist link…";
    urlInput.focus();
  });
});

/* ---------------- paste ---------------- */

pasteBtn.addEventListener("click", async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (text) {
      urlInput.value = text.trim();
      urlInput.focus();
    }
  } catch {
    showToast("Clipboard access blocked — paste manually with Ctrl/Cmd+V.", "error");
  }
});

/* ---------------- fetch info ---------------- */

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const url = urlInput.value.trim();
  if (!url) {
    showToast("Please paste a link first.", "error");
    urlInput.focus();
    return;
  }
  if (!/^https?:\/\//i.test(url)) {
    showToast("That doesn't look like a valid link.", "error");
    return;
  }

  setLoading(fetchBtn, true);
  hint.textContent = "Fetching details…";

  try {
    const res = await fetch("/api/info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to fetch info.");

    currentInfo = { ...data, sourceUrl: url };
    if (data.isPlaylist) {
      renderPlaylist(currentInfo);
      hint.textContent = `Playlist with ${data.count} item(s) found.`;
      showToast(`Playlist found — ${data.count} items ✓`, "success");
    } else {
      renderVideo(currentInfo);
      hint.textContent = "Done! Pick a quality below.";
      showToast("Video found ✓", "success");
    }
  } catch (err) {
    showToast(err.message || "Something went wrong.", "error");
    hint.textContent = "Tip: works with Reels, Shorts, videos and playlists.";
  } finally {
    setLoading(fetchBtn, false);
  }
});

function fillFormats(selectEl, formats) {
  selectEl.innerHTML = "";
  formats.forEach((f) => {
    const opt = document.createElement("option");
    opt.value = f.id;
    opt.textContent = f.type === "audio" ? f.label : `${f.label} · MP4`;
    selectEl.appendChild(opt);
  });
}

function reveal(section) {
  section.hidden = false;
  section.classList.remove("show");
  void section.offsetWidth;
  section.classList.add("show");
  section.scrollIntoView({ behavior: "smooth", block: "center" });
}

/* ---------------- single video ---------------- */

function renderVideo(info) {
  playlistResult.hidden = true;
  resetProgress(progressEl, barFill, progressPct, progressStatus, progressMeta);
  dlNote.textContent = "";

  vidTitle.textContent = info.title;
  uploader.textContent = info.uploader ? "by " + info.uploader : "";
  durationEl.textContent = fmtDuration(info.duration);
  durationEl.style.display = info.duration ? "" : "none";

  const isInsta = (info.extractor || "").toLowerCase().includes("instagram");
  platformBadge.textContent = isInsta ? "Instagram" : "YouTube";

  if (info.thumbnail) {
    thumb.src = info.thumbnail;
    thumb.style.display = "";
  } else {
    thumb.style.display = "none";
  }

  fillFormats(quality, info.formats);
  reveal(resultEl);
}

downloadBtn.addEventListener("click", () => {
  if (!currentInfo) return;
  startJob({
    url: currentInfo.sourceUrl,
    format: quality.value,
    mode: "single",
    title: currentInfo.title,
    btn: downloadBtn,
    ui: {
      wrap: progressEl,
      fill: barFill,
      pct: progressPct,
      status: progressStatus,
      meta: progressMeta,
    },
  });
});

/* ---------------- playlist ---------------- */

function renderPlaylist(info) {
  resultEl.hidden = true;
  resetProgress(plProgress, plBarFill, plProgressPct, plProgressStatus, plProgressMeta);

  plTitle.textContent = info.title;
  plMeta.textContent = `${info.count} videos${info.uploader ? " · " + info.uploader : ""}`;
  fillFormats(plQuality, info.formats);

  plList.innerHTML = "";
  info.entries.forEach((entry) => {
    const li = document.createElement("li");
    li.className = "pl-item";
    li.innerHTML = `
      <span class="pl-idx">${entry.index}</span>
      <div class="pl-item-info">
        <span class="pl-item-title">${escapeHtml(entry.title)}</span>
        <span class="pl-item-sub">${entry.duration ? fmtDuration(entry.duration) : ""}</span>
      </div>
      <button class="pl-item-dl" title="Download this video" aria-label="Download this video">
        <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M12 16l-5-5 1.4-1.4L11 12.2V4h2v8.2l2.6-2.6L17 11zM5 20v-2h14v2z"/></svg>
        <span class="spinner small" aria-hidden="true"></span>
      </button>`;
    const btn = li.querySelector(".pl-item-dl");
    btn.addEventListener("click", () => {
      if (!entry.url) {
        showToast("This item has no direct link.", "error");
        return;
      }
      startJob({
        url: entry.url,
        format: plQuality.value,
        mode: "single",
        title: entry.title,
        btn,
        ui: {
          wrap: plProgress,
          fill: plBarFill,
          pct: plProgressPct,
          status: plProgressStatus,
          meta: plProgressMeta,
        },
      });
    });
    plList.appendChild(li);
  });

  reveal(playlistResult);
}

plDownloadAll.addEventListener("click", () => {
  if (!currentInfo) return;
  startJob({
    url: currentInfo.sourceUrl,
    format: plQuality.value,
    mode: "playlist",
    title: currentInfo.title,
    btn: plDownloadAll,
    ui: {
      wrap: plProgress,
      fill: plBarFill,
      pct: plProgressPct,
      status: plProgressStatus,
      meta: plProgressMeta,
    },
  });
});

/* ---------------- shared job + SSE progress ---------------- */

function resetProgress(wrap, fill, pct, status, meta) {
  wrap.hidden = true;
  fill.style.width = "0%";
  fill.classList.remove("indeterminate");
  pct.textContent = "0%";
  status.textContent = "Preparing…";
  meta.textContent = "";
}

async function startJob({ url, format, mode, title, btn, ui }) {
  setLoading(btn, true);
  ui.wrap.hidden = false;
  ui.fill.style.width = "0%";
  ui.fill.classList.add("indeterminate");
  ui.status.textContent = mode === "playlist" ? "Starting playlist download…" : "Starting…";
  ui.pct.textContent = "";
  ui.meta.textContent = "";

  let jobId;
  try {
    const res = await fetch("/api/job", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, format, mode, title }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Could not start download.");
    jobId = data.jobId;
  } catch (err) {
    setLoading(btn, false);
    ui.fill.classList.remove("indeterminate");
    ui.status.textContent = "Failed to start";
    showToast(err.message, "error");
    return;
  }

  const es = new EventSource(`/api/progress/${jobId}`);

  es.onmessage = (ev) => {
    let d;
    try {
      d = JSON.parse(ev.data);
    } catch {
      return;
    }

    if (d.phase === "downloading") {
      const pct = mode === "playlist" ? d.overall : d.percent;
      ui.fill.classList.toggle("indeterminate", pct == null);
      if (pct != null) {
        ui.fill.style.width = pct + "%";
        ui.pct.textContent = pct + "%";
      }
      let status =
        mode === "playlist" && d.itemCount
          ? `Downloading ${d.item}/${d.itemCount}`
          : "Downloading";
      if (d.title) status += ` · ${truncate(d.title, 40)}`;
      ui.status.textContent = status;
      const bits = [];
      if (d.total) bits.push(`${fmtBytes(d.downloaded)} / ${fmtBytes(d.total)}`);
      if (d.speed) bits.push(`${fmtBytes(d.speed)}/s`);
      if (d.eta != null) bits.push(`ETA ${fmtEta(d.eta)}`);
      ui.meta.textContent = bits.join("  ·  ");
    } else if (d.phase === "processing") {
      ui.fill.classList.add("indeterminate");
      ui.status.textContent = d.note || "Processing…";
      ui.pct.textContent = "";
    } else if (d.phase === "done") {
      es.close();
      ui.fill.classList.remove("indeterminate");
      ui.fill.style.width = "100%";
      ui.pct.textContent = "100%";
      ui.status.textContent = "Ready!";
      const parts = [];
      if (d.fileCount > 1) parts.push(`${d.fileCount} files`);
      if (d.size) parts.push(fmtBytes(d.size));
      ui.meta.textContent = parts.join("  ·  ") + "  ·  starting download…";
      triggerBrowserDownload(d.downloadUrl);
      showToast("Download ready — saving to your device ✓", "success");
      setLoading(btn, false);
    } else if (d.phase === "error") {
      es.close();
      ui.fill.classList.remove("indeterminate");
      ui.status.textContent = "Failed";
      ui.meta.textContent = d.message || "Something went wrong.";
      showToast(d.message || "Download failed.", "error");
      setLoading(btn, false);
    }
  };

  es.onerror = () => {
    // EventSource auto-retries; only surface if the job never completed.
    if (btn.classList.contains("loading")) {
      ui.status.textContent = "Connection interrupted — retrying…";
    }
  };
}

/* ---------------- utils ---------------- */

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function truncate(s, n) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

window.addEventListener("load", () => urlInput.focus());
