#!/usr/bin/env bash
# =============================================================================
#  BizOrganiser — install / update on an Ubuntu server (22.04 or 24.04).
#  Built for Oracle Cloud "Always Free" (ARM Ampere A1 or AMD E2.1.Micro),
#  works on any Ubuntu VM.
#
#  Usage (normally run for you by deploy.ps1):
#     sudo DOMAIN=biz.example.com bash install.sh /tmp/bizorganiser.tgz
#  DOMAIN is optional: without it, <your-ip>.sslip.io is used.
#
#  Safe to run again: updates the code and keeps all data.
# =============================================================================
set -euo pipefail

PKG="${1:-/tmp/bizorganiser.tgz}"
DOMAIN="${DOMAIN:-}"
APP=/opt/bizorganiser
DATA=/var/lib/bizorganiser
BACKUPS=/var/backups/bizorganiser
PORT=8080
SVC=bizorganiser

say() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
[ "$(id -u)" = 0 ] || { echo "Please run with sudo."; exit 1; }
[ -f "$PKG" ] || { echo "Package $PKG not found."; exit 1; }

if [ -z "$DOMAIN" ]; then
  IP=$(curl -fsS --max-time 10 https://ifconfig.me || curl -fsS --max-time 10 https://api.ipify.org || true)
  [ -n "$IP" ] || { echo "Could not detect the public IP. Run again with DOMAIN=<name or IP>.sslip.io"; exit 1; }
  DOMAIN="${IP//./-}.sslip.io"
fi

say "Installing system packages"
export DEBIAN_FRONTEND=noninteractive
echo iptables-persistent iptables-persistent/autosave_v4 boolean true | debconf-set-selections
echo iptables-persistent iptables-persistent/autosave_v6 boolean true | debconf-set-selections
apt-get update -y
apt-get install -y ca-certificates curl gnupg debian-keyring debian-archive-keyring apt-transport-https \
  unattended-upgrades iptables-persistent sqlite3 tar

say "Enabling automatic security updates"
dpkg-reconfigure -f noninteractive unattended-upgrades

say "Installing Node.js 24"
if ! command -v node >/dev/null || ! node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)'; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y nodejs
fi
node -v

say "Installing Caddy (web server with automatic HTTPS)"
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' -o /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

say "Creating service account and folders"
id bizorg >/dev/null 2>&1 || useradd --system --home-dir "$DATA" --shell /usr/sbin/nologin bizorg
mkdir -p "$DATA" "$BACKUPS"
chown bizorg:bizorg "$DATA"; chmod 700 "$DATA"; chmod 700 "$BACKUPS"

say "Installing application code into $APP"
rm -rf "$APP.new"; mkdir -p "$APP.new"
tar -xzf "$PKG" -C "$APP.new"
rm -rf "$APP.new/data" "$APP.new/start.bat"
find "$APP.new" -name '*.sh' -exec sed -i 's/\r$//' {} +
[ -f "$APP.new/server/server.js" ] || { echo "The package does not contain server/server.js"; exit 1; }
say "Installing Node.js packages"
( cd "$APP.new" && npm install --omit=dev --no-audit --no-fund )
rm -rf "$APP.old"; [ -d "$APP" ] && mv "$APP" "$APP.old"
mv "$APP.new" "$APP"
chown -R root:root "$APP"; chmod -R go-w "$APP"

if [ ! -f "$DATA/config.json" ]; then
  say "Writing first configuration"
  cat > "$DATA/config.json" <<EOF
{
  "host": "127.0.0.1",
  "port": $PORT,
  "secureCookies": true,
  "trustProxy": true
}
EOF
  chown bizorg:bizorg "$DATA/config.json"; chmod 600 "$DATA/config.json"
fi

say "Configuring the system service"
cat > /etc/systemd/system/$SVC.service <<EOF
[Unit]
Description=BizOrganiser
After=network-online.target
Wants=network-online.target

[Service]
User=bizorg
Group=bizorg
WorkingDirectory=$APP
Environment=BIZ_DATA_DIR=$DATA
Environment=NODE_ENV=production
ExecStart=/usr/bin/node $APP/server/server.js
Restart=on-failure
RestartSec=3
# hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$DATA
CapabilityBoundingSet=
AmbientCapabilities=

[Install]
WantedBy=multi-user.target
EOF

say "Configuring HTTPS for $DOMAIN"
cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
	encode gzip
	request_body {
		max_size 60MB
	}
	header Strict-Transport-Security "max-age=31536000"
	reverse_proxy 127.0.0.1:$PORT
}
EOF

say "Opening ports 80 and 443 in the server firewall"
for p in 80 443; do
  if ! iptables -C INPUT -p tcp --dport $p -m state --state NEW -j ACCEPT 2>/dev/null; then
    n=$(iptables -L INPUT --line-numbers -n | awk '/REJECT/ {print $1; exit}')
    if [ -n "$n" ]; then iptables -I INPUT "$n" -p tcp --dport $p -m state --state NEW -j ACCEPT
    else iptables -A INPUT -p tcp --dport $p -m state --state NEW -j ACCEPT; fi
  fi
done
netfilter-persistent save >/dev/null

say "Setting up daily backups (02:30, kept 14 days) in $BACKUPS"
cat > /usr/local/bin/bizorganiser-backup <<EOF
#!/usr/bin/env bash
set -euo pipefail
T=\$(date +%F-%H%M)
sqlite3 "$DATA/bizorganiser.db" ".backup '$BACKUPS/db-\$T.sqlite'"
tar -czf "$BACKUPS/files-\$T.tgz" -C "$DATA" --ignore-failed-read files config.json
chmod 600 "$BACKUPS"/*
find "$BACKUPS" -type f -mtime +14 -delete
EOF
chmod 700 /usr/local/bin/bizorganiser-backup
echo "30 2 * * * root /usr/local/bin/bizorganiser-backup" > /etc/cron.d/bizorganiser
[ -f "$DATA/bizorganiser.db" ] && /usr/local/bin/bizorganiser-backup && echo "Backup taken before update."

say "Starting BizOrganiser"
systemctl daemon-reload
systemctl enable $SVC >/dev/null
systemctl restart $SVC
systemctl enable caddy >/dev/null
systemctl reload caddy 2>/dev/null || systemctl restart caddy

for i in $(seq 1 30); do curl -fsS -o /dev/null http://127.0.0.1:$PORT/ && break; sleep 1; done
if ! curl -fsS -o /dev/null http://127.0.0.1:$PORT/; then
  echo "The application did not start. Recent log:"; journalctl -u $SVC -n 40 --no-pager; exit 1
fi

say "Done"
echo "  Address:   https://$DOMAIN/          (customer portal: /b2b/   e-shop: /shop/)"
echo "  The HTTPS certificate is requested automatically on the first visit (can take ~1 minute)."
if [ -f "$DATA/FIRST-RUN-CREDENTIALS.txt" ]; then
  echo
  echo "  First sign-in: see the temporary password with"
  echo "     sudo cat $DATA/FIRST-RUN-CREDENTIALS.txt"
  echo "  and delete that file after everyone has chosen a new password."
fi
echo "  Logs:      sudo journalctl -u $SVC -f"
echo "  Backups:   $BACKUPS"
