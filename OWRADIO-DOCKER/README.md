# 🐳 OWRadio Docker — Containerized Deployment Guide

This directory provides a fully isolated, production-ready containerized package for **OWRadio**. It is optimized for existing Linux servers, VPS nodes (e.g. Debian, Ubuntu, CentOS), and environments running shared reverse proxies (Nginx Proxy Manager, Traefik, Caddy).

---

## 🌟 Why Docker for OWRadio?

- **Non-Destructive:** Does not require root `apt-get` on the host, does not overwrite system Node/FFmpeg versions, and keeps existing services intact.
- **Self-Contained:** Bundles Node 22, FFmpeg, native compile tools (`better-sqlite3`, `@discordjs/opus`), and the standalone `yt-dlp` binary.
- **Isolated Storage:** Stores all database files and persistent stream state inside `./data/owradio.db`, avoiding collisions with other applications.
- **Instant Rollback:** Includes zero-downtime switch and rollback scripts (`switch-to-owradio.sh` and `rollback-to-legacy.sh`).

---

## 🚀 Quick Setup

### 1. Configure Environment
```bash
cp .env.example .env
# Edit .env with your Discord token and settings
```

### 2. Add YouTube Cookies (Crucial for Datacenter IPs)
Export your cookies from [youtube.com](https://www.youtube.com) using the browser extension **"Get cookies.txt LOCALLY"** and save them as `cookies.txt` or place them into `data/youtube-cookies.txt`.

### 3. Build & Launch with Docker Compose
```bash
docker compose up -d --build
```

### 4. Check Logs & Health
```bash
docker compose logs -f musicbot
curl -I http://localhost:8091/stream.mp3
```

---

## 🔄 Instant Swap / Rollback on Existing Bot Servers

If replacing a legacy music bot (e.g. Vexo):
- **Activate OWRadio:** `./scripts/switch-to-owradio.sh` (creates `.legacy.yml` backups and starts container)
- **Revert to Legacy Bot:** `./scripts/rollback-to-legacy.sh` (restores original compose and restarts)
