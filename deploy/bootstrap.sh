#!/usr/bin/env bash
#
# One-time server setup. Run as root on a fresh Debian/Ubuntu box:
#
#     curl -fsSL https://raw.githubusercontent.com/<you>/tricount-but-better/main/deploy/bootstrap.sh | bash
#
# or copy the repo across and run  sudo bash deploy/bootstrap.sh
#
# Idempotent: safe to re-run after a change.

set -euo pipefail

ROOT=${ROOT:-/opt/tricount}
SERVICE_USER=${SERVICE_USER:-tricount}
DEPLOY_USER=${DEPLOY_USER:-deploy}

if [ "$ROOT" != /opt/tricount ] || [ "$SERVICE_USER" != tricount ] || [ "$DEPLOY_USER" != deploy ]; then
  echo "this deployment currently supports ROOT=/opt/tricount, SERVICE_USER=tricount, DEPLOY_USER=deploy" >&2
  exit 1
fi

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

if [ "$(id -u)" -ne 0 ]; then
  echo "run this as root (sudo bash deploy/bootstrap.sh)" >&2
  exit 1
fi

say "Installing packages"
apt-get update -qq
apt-get install -y --no-install-recommends \
  ca-certificates curl git rsync nginx sqlite3 python3 sudo certbot python3-certbot-nginx

say "Installing Node (for the Claude Code CLI)"
if ! command -v node >/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

say "Creating users and directories"
id -u "$SERVICE_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin "$SERVICE_USER"
id -u "$DEPLOY_USER"  >/dev/null 2>&1 || useradd --create-home --shell /bin/bash "$DEPLOY_USER"

mkdir -p "$ROOT"/{app,web,var/uploads,home,backups}
chown root:root "$ROOT"
chmod 755 "$ROOT"
# The deploy user writes code; the service user writes data.
chown -R "$DEPLOY_USER":"$SERVICE_USER" "$ROOT"/app "$ROOT"/web
chown -R "$SERVICE_USER":"$SERVICE_USER" "$ROOT"/{var,home,backups}
chmod 2755 "$ROOT"/app "$ROOT"/web
chmod 2770 "$ROOT"/var "$ROOT"/backups

say "Installing uv for the deploy user"
sudo -u "$DEPLOY_USER" -H bash -c '
  command -v ~/.local/bin/uv >/dev/null || curl -LsSf https://astral.sh/uv/install.sh | sh
'

say "Installing the Claude Code CLI"
npm install -g @anthropic-ai/claude-code >/dev/null
CLAUDE_BIN=$(command -v claude || echo /usr/bin/claude)
echo "    claude -> $CLAUDE_BIN"

say "Writing $ROOT/.env (only if absent)"
if [ ! -f "$ROOT/.env" ]; then
  SECRET=$(python3 -c 'import secrets; print(secrets.token_urlsafe(48))')
  cat > "$ROOT/.env" <<ENVEOF
ENVIRONMENT=prod
DATABASE_URL=sqlite:///$ROOT/var/tricount.db
JWT_SECRET=$SECRET
CORS_ORIGINS=https://tricount-194-87-111-40.sslip.io
DEFAULT_CURRENCY=RUB
UPLOAD_DIR=$ROOT/var/uploads

VLM_PROVIDER=disabled
VLM_MODEL=claude-sonnet-5
CLAUDE_CODE_OAUTH_TOKEN=
CLAUDE_CLI_PATH=$CLAUDE_BIN

# Pick ONE egress route if this host cannot reach api.anthropic.com directly.
# See deploy/README.md.
# ANTHROPIC_PROXY_URL=socks5://user:pass@vpn-host:1080
# ANTHROPIC_BASE_URL=https://relay.example.com
ENVEOF
  echo "    generated a JWT secret; receipt scanning is disabled until configured"
else
  echo "    kept the existing .env"
fi
chown root:"$SERVICE_USER" "$ROOT/.env"
chmod 640 "$ROOT/.env"

say "Installing the systemd unit"
install -m 644 "$(dirname "$0")/systemd/tricount.service" /etc/systemd/system/tricount.service
systemctl daemon-reload
systemctl enable tricount

say "Letting the deploy user restart the service"
install -o root -g root -m 750 "$(dirname "$0")/release.sh" /usr/local/sbin/tricount-release
cat > /etc/sudoers.d/tricount-deploy <<SUDOEOF
$DEPLOY_USER ALL=(root) NOPASSWD: /usr/local/sbin/tricount-release, /usr/bin/journalctl -u tricount -n 40 --no-pager
SUDOEOF
chmod 440 /etc/sudoers.d/tricount-deploy
visudo -cf /etc/sudoers.d/tricount-deploy

say "Installing the nginx site"
if [ ! -f /etc/nginx/sites-available/tricount ]; then
  install -m 644 "$(dirname "$0")/nginx.conf" /etc/nginx/sites-available/tricount
else
  echo "    kept the existing nginx site, including any TLS settings"
fi
ln -sf /etc/nginx/sites-available/tricount /etc/nginx/sites-enabled/tricount
nginx -t && systemctl reload nginx

say "Nightly database backup"
cat > /etc/cron.daily/tricount-backup <<CRONEOF
#!/bin/sh
# SQLite .backup is consistent against a live database, unlike cp.
[ -f "$ROOT/var/tricount.db" ] || exit 0
runuser -u "$SERVICE_USER" -- sqlite3 "$ROOT/var/tricount.db" ".backup '$ROOT/backups/daily-\$(date +%Y%m%d).db'"
find "$ROOT/backups" -name 'daily-*.db' -mtime +30 -delete
CRONEOF
chmod 755 /etc/cron.daily/tricount-backup

cat <<DONE

Done. Remaining manual steps:

  1. Optional: configure receipt scanning in $ROOT/.env
       - VLM_PROVIDER=agent_sdk
       - CLAUDE_CODE_OAUTH_TOKEN=<your token>
       - an egress route, if this host cannot reach api.anthropic.com

  2. Check that tricount-194-87-111-40.sslip.io resolves to this server,
     then run:
       certbot --nginx -d tricount-194-87-111-40.sslip.io

  3. Add the deploy public key to /home/$DEPLOY_USER/.ssh/authorized_keys
     (owner $DEPLOY_USER, directory mode 700, file mode 600).

  4. Push to main. The Deploy workflow does the rest.

DONE
