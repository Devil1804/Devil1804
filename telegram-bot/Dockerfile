FROM python:3.12-slim

# ffmpeg (and ffprobe) are required by yt-dlp for merging and by the bot for
# compressing oversized files to fit Telegram's 50 MB limit.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# The bot runs a Flask keep-alive server on $PORT (Render/Railway inject it).
ENV PORT=8080
EXPOSE 8080

CMD ["python", "bot.py"]
