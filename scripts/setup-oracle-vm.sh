#!/usr/bin/env bash
# ==============================================================================
# OWRADIO - Oracle Cloud Infrastructure (OCI) Always Free VM Provisioning Script
# Target: Ubuntu 22.04 / 24.04 LTS on Ampere A1 (ARM64 aarch64)
# ==============================================================================

set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

echo "===================================================================="
echo "⚡ Starting OWRadio Automated Provisioning on Oracle Cloud Free Tier"
echo "===================================================================="

# Check if running as root or with sudo privileges
if [ "$EUID" -ne 0 ]; then
  SUDO="sudo"
else
  SUDO=""
fi

# 1. Update APT & install base system dependencies
echo "📦 [1/6] Updating APT repositories & installing base tools..."
$SUDO apt-get update -y
$SUDO apt-get install -y \
  curl \
  wget \
  git \
  build-essential \
  python3 \
  python3-pip \
  ffmpeg \
  sqlite3 \
  unzip \
  ca-certificates \
  iptables \
  iptables-persistent

# 2. Install Node.js 22 LTS (NodeSource)
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -d'.' -f1)" != "v22" ]; then
  echo "🟢 [2/6] Installing Node.js 22.x LTS..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO -E bash -
  $SUDO apt-get install -y nodejs
else
  echo "✅ Node.js $(node -v) is already installed."
fi

# 3. Install latest standalone yt-dlp
echo "🎥 [3/6] Installing latest yt-dlp binary..."
$SUDO curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
$SUDO chmod a+rx /usr/local/bin/yt-dlp

# 4. Open Host Firewall for Ports 8091, 80, 443 (OWRadio Web, Stream & Caddy HTTPS)
echo "🛡️ [5/6] Opening Host Firewall ports (22, 80, 443, 8091)..."
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  $SUDO ufw allow 8091/tcp comment "OWRadio HTTP & Stream"
  $SUDO ufw allow 80/tcp comment "HTTP (Caddy SSL challenge)"
  $SUDO ufw allow 443/tcp comment "HTTPS (Caddy SSL)"
  $SUDO ufw allow 22/tcp comment "SSH"
fi

# Ensure iptables does not reject incoming traffic on 8091, 80, 443 (Oracle Cloud default iptables block)
$SUDO iptables -I INPUT 6 -m state --state NEW -p tcp --dport 8091 -j ACCEPT || true
$SUDO iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT || true
$SUDO iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT || true
$SUDO netfilter-persistent save || true

# 6. Configure systemd unit file for OWRadio
echo "⚙️ [6/6] Configuring systemd service (/etc/systemd/system/owradio.service)..."
INSTALL_DIR="$(pwd)"
CURRENT_USER="$(whoami)"

$SUDO bash -c "cat > /etc/systemd/system/owradio.service << 'EOF'
[Unit]
Description=OWRadio - Open Web Radio & Discord Audio Engine
After=network.target

[Service]
Type=simple
User=${CURRENT_USER}
WorkingDirectory=${INSTALL_DIR}
ExecStart=/usr/bin/npx tsx src/index.ts
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF"

$SUDO systemctl daemon-reload
$SUDO systemctl enable owradio.service

echo "===================================================================="
echo "🎉 OWRadio Host Provisioning Complete!"
echo "===================================================================="
echo "Next steps:"
echo " 1. Configure .env from .env.example (cp .env.example .env)"
echo " 2. Run 'npm install'"
echo " 3. Start service: sudo systemctl start owradio.service"
echo " 4. Check status:  sudo systemctl status owradio.service"
echo " 5. View logs:     journalctl -u owradio.service -f"
echo " 6. Open Web UI:   http://<YOUR_VM_IP>:8091"
echo "===================================================================="
