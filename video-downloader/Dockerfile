# FetchWave — container image for Render / Railway / Fly.io / any Docker host.
# Bundles yt-dlp + ffmpeg so the full app (incl. realtime progress + playlist ZIP) works.
FROM node:22-slim

# System deps:
#  - ffmpeg: merges video+audio and converts to MP3
#  - curl + ca-certificates: fetch the standalone yt-dlp binary (self-contained, no Python needed)
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg curl ca-certificates \
 && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
      -o /usr/local/bin/yt-dlp \
 && chmod a+rx /usr/local/bin/yt-dlp \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# No npm dependencies to install — the app uses only Node.js built-ins.
COPY . .

ENV NODE_ENV=production
# Render/Railway inject PORT automatically; server.js reads process.env.PORT.
EXPOSE 3000

CMD ["node", "server.js"]
