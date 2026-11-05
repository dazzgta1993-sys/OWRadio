#!/usr/bin/env bash
# ==============================================================================
# switch-to-owradio.sh
# Non-destructive switch from legacy Python musicbot to OWRadio Docker on vexo
# ==============================================================================
set -euo pipefail

cd /opt/vexo

echo "⚡ [1/4] Preserving legacy bot compose configurations..."
if [ ! -f docker-compose.legacy.yml ]; then
  cp docker-compose.yml docker-compose.legacy.yml
  echo "  ✅ Backed up docker-compose.yml -> docker-compose.legacy.yml"
fi

if [ ! -f docker-compose.vps.legacy.yml ]; then
  cp docker-compose.vps.yml docker-compose.vps.legacy.yml
  echo "  ✅ Backed up docker-compose.vps.yml -> docker-compose.vps.legacy.yml"
fi

# Backup legacy youtube cookies if present
if [ -f data/youtube-cookies.txt ] && [ ! -f data/youtube-cookies.legacy.txt ]; then
  cp data/youtube-cookies.txt data/youtube-cookies.legacy.txt
  echo "  ✅ Backed up data/youtube-cookies.txt -> data/youtube-cookies.legacy.txt"
fi

# Update cookies if newer cookies exist in owradio-docker
if [ -f owradio-docker/cookies.txt ]; then
  cp owradio-docker/cookies.txt data/youtube-cookies.txt
  chmod 660 data/youtube-cookies.txt
  echo "  ✅ Synced fresh YouTube cookies to data/youtube-cookies.txt"
fi

echo "🔄 [2/4] Switching Docker Compose configurations to OWRadio..."
cp owradio-docker/docker-compose.yml docker-compose.yml
cp owradio-docker/docker-compose.vps.yml docker-compose.vps.yml

echo "🏗️ [3/4] Building and launching OWRadio container..."
sudo /usr/local/sbin/musicbot-control rebuild

echo "🔍 [4/4] Probing container status..."
sudo /usr/local/sbin/musicbot-control status

echo "===================================================================="
echo "🎉 OWRadio is now active!"
echo "🌐 Dashboard: http://localhost:8091"
echo "📻 Stream:    http://localhost:8091/stream.mp3"
echo "To revert to legacy Python bot at any time: ./rollback-to-legacy.sh"
echo "===================================================================="
