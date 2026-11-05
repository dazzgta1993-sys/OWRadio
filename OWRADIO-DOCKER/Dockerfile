FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
WORKDIR /app

# Install base audio utilities (ffmpeg), build dependencies for native node addons, and standalone yt-dlp
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    python-is-python3 \
    build-essential \
    curl \
    ca-certificates \
    && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp \
    && rm -rf /var/lib/apt/lists/*

# Install node dependencies
COPY package*.json tsconfig.json drizzle.config.ts ./
RUN npm ci

# Copy application source and scripts
COPY src ./src
COPY scripts ./scripts

EXPOSE 8091

CMD ["npm", "start"]
