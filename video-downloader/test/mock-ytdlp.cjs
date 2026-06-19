#!/usr/bin/env node
/* Mock yt-dlp for offline end-to-end testing of the server. */
const fs = require("fs");
const path = require("path");
const args = process.argv.slice(2);
const url = args[args.length - 1] || "";
const has = (f) => args.includes(f);
const val = (f) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : null;
};

if (has("-J")) {
  if (/list=|\/playlist/.test(url)) {
    const entries = [];
    for (let i = 1; i <= 3; i++)
      entries.push({
        id: "vid" + i,
        title: "Mock Video " + i,
        url: "https://www.youtube.com/watch?v=vid" + i,
        duration: 100 + i,
      });
    process.stdout.write(
      JSON.stringify({
        _type: "playlist",
        title: "Mock Playlist",
        uploader: "Mock Channel",
        entries,
      })
    );
  } else {
    process.stdout.write(
      JSON.stringify({
        title: "Mock Single Video",
        uploader: "Mock Channel",
        duration: 212,
        thumbnail: "https://example.com/y.jpg",
        extractor_key: "Youtube",
        webpage_url: url,
        formats: [
          { vcodec: "avc1", height: 1080 },
          { vcodec: "avc1", height: 720 },
          { vcodec: "avc1", height: 360 },
          { vcodec: "none", acodec: "mp4a" },
        ],
      })
    );
  }
  process.exit(0);
}

// download mode
const outTmpl = val("-o");
const dir = path.dirname(outTmpl);
const audio = has("-x");
const ext = audio ? "mp3" : "mp4";
const isPlaylist = has("--yes-playlist");
const count = isPlaylist ? 3 : 1;
const total = 800000;

(async () => {
  for (let item = 1; item <= count; item++) {
    for (let p = 0; p <= 100; p += 25) {
      const dl = Math.round((total * p) / 100);
      process.stdout.write(
        [
          "PROG",
          dl,
          total,
          total,
          400000,
          Math.max(0, (100 - p) / 25),
          isPlaylist ? item : "NA",
          isPlaylist ? count : "NA",
          isPlaylist ? "Mock Video " + item : "Mock Single Video",
        ].join("\t") + "\n"
      );
      await new Promise((r) => setTimeout(r, 30));
    }
    const name = isPlaylist
      ? String(item).padStart(3, "0") + " - Mock Video " + item + "." + ext
      : "Mock Single Video." + ext;
    fs.writeFileSync(path.join(dir, name), Buffer.alloc(total, item % 256));
  }
  if (!audio && !isPlaylist)
    process.stderr.write('[Merger] Merging formats into "out.mp4"\n');
  process.exit(0);
})();
