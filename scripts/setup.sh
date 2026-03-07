#!/bin/bash
set -euo pipefail

APP_DIR="/opt/reel-bot"
DATA_DIR="$APP_DIR/data"

echo "=== Instagram Reel Bot - Server Setup ==="

# 1. System dependencies
echo "[1/7] Installing system dependencies..."
sudo apt update && sudo apt install -y nginx ffmpeg python3-pip curl

# 2. yt-dlp
echo "[2/7] Installing yt-dlp..."
pip3 install --user --break-system-packages yt-dlp 2>/dev/null || pip3 install --user yt-dlp
# Ensure yt-dlp is in PATH
export PATH="$HOME/.local/bin:$PATH"
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc

# 3. Node.js 20 (via NodeSource)
echo "[3/7] Installing Node.js 20..."
if ! command -v node &> /dev/null || [[ $(node -v | cut -d. -f1 | tr -d 'v') -lt 20 ]]; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt install -y nodejs
fi

# 4. PM2
echo "[4/7] Installing PM2..."
sudo npm install -g pm2

# 5. Application setup
echo "[5/7] Setting up application directory..."
sudo mkdir -p "$DATA_DIR"/{raw,processed,watermarks}
sudo mkdir -p "$APP_DIR/logs"

# If running from repo, copy files
if [ -f "package.json" ]; then
    sudo cp -r . "$APP_DIR/"
    cd "$APP_DIR"
    sudo chown -R "$USER:$USER" "$APP_DIR"
fi

cd "$APP_DIR"
npm install --production

# 6. Nginx config
echo "[6/7] Configuring Nginx..."
sudo cp "$APP_DIR/nginx/reel-bot.conf" /etc/nginx/sites-available/reel-bot
sudo ln -sf /etc/nginx/sites-available/reel-bot /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# 7. PM2 startup
echo "[7/7] Starting with PM2..."
pm2 start ecosystem.config.js
pm2 save
echo "Run 'pm2 startup' and follow instructions to enable auto-start on boot"

# Firewall
if command -v ufw &> /dev/null; then
    sudo ufw allow 8888/tcp
    echo "Firewall: port 8888 opened"
fi

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Next steps:"
echo "  1. cp .env.example .env"
echo "  2. nano .env  (fill in your API keys and tokens)"
echo "  3. node scripts/seed-accounts.js  (add YouTube channels)"
echo "  4. pm2 restart reel-bot"
echo ""
echo "Useful commands:"
echo "  pm2 logs reel-bot      - View logs"
echo "  pm2 status             - Check process status"
echo "  pm2 restart reel-bot   - Restart bot"
