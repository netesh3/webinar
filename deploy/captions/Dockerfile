# Server-side live captions: a LiveKit agent + faster-whisper (CPU, int8). See README.md.
#
#   docker build -t webinarliv-captions deploy/captions
#
# Runs at nice 10 inside a container that compose also gives a low cpu_shares and a hard
# `cpus` cap: video always wins.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_HOME=/models/hf \
    CAPTIONS_MODEL_DIR=/models \
    CAPTIONS_SPOOL_DIR=/var/lib/captions/spool

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY webcaptions ./webcaptions

# Weights and spooled audio live on volumes (see the compose service), owned by this user.
RUN useradd --system --uid 10001 --home-dir /app captions \
    && mkdir -p /models /var/lib/captions/spool \
    && chown -R captions:captions /models /var/lib/captions
USER captions

# Fetch any missing weights into the volume (instant after the first start), then the
# worker. exec so docker's SIGTERM reaches the worker and it drains its rooms.
CMD ["sh", "-c", "nice -n 10 python -m webcaptions.download && exec nice -n 10 python -m webcaptions.agent start"]
