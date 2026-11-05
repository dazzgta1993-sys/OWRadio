#!/usr/bin/env bash
# ==============================================================================
# deploy_oci.sh
# Automated deployment and systemd daemonization script for OWRadio on Oracle Cloud
# ==============================================================================

set -euo pipefail

TARGET_HOST="oracle"
REMOTE_DIR="/home/ubuntu/owradio"

echo "🚀 Deploying OWRadio to Oracle Cloud Infrastructure (${TARGET_HOST})..."

# 1. Ensure remote directory exists
ssh "${TARGET_HOST}" "mkdir -p ${REMOTE_DIR}"

# 2. Sync codebase to remote VM (excluding cache, legacy, node_modules)
echo "📦 Syncing codebase..."
rsync -avz --delete \
  --exclude="node_modules" \
  --exclude=".git" \
  --exclude=".venv" \
  --exclude="data" \
  --exclude="dist" \
  ./ "${TARGET_HOST}:${REMOTE_DIR}/"

# 3. Copy production .env if not exists
ssh "${TARGET_HOST}" "if [ ! -f ${REMOTE_DIR}/.env ]; then cp ${REMOTE_DIR}/.env.example ${REMOTE_DIR}/.env; fi"
scp .env "${TARGET_HOST}:${REMOTE_DIR}/.env"

# 4. Install production dependencies on ARM64 host
echo "📥 Installing npm packages on target..."
ssh "${TARGET_HOST}" "cd ${REMOTE_DIR} && npm install --omit=dev"

# 5. Configure systemd unit
echo "⚙️ Configuring systemd service (/etc/systemd/system/owradio.service)..."
ssh "${TARGET_HOST}" "sudo bash -c 'cat > /etc/systemd/system/owradio.service << \"EOF\"
[Unit]
Description=OWRadio - Open Web Radio & Discord Audio Engine
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=${REMOTE_DIR}
ExecStart=/usr/bin/npx tsx src/index.ts
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable owradio.service
systemctl restart owradio.service
'"

echo "✅ OWRadio successfully deployed and running under systemd on ${TARGET_HOST}!"
echo "📡 Check status with: ssh ${TARGET_HOST} 'systemctl status owradio'"
echo "📜 View logs with: ssh ${TARGET_HOST} 'journalctl -u owradio -f'"
