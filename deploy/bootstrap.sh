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

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

if [ "$(id -u)" -ne 0 ]; then
  echo "run this as root (sudo bash deploy/bootstrap.sh)" >&2
  exit 1
fi

say "Installing packages"
apt-get update -qq
apt-get install -y --no-install-recommends \
  ca-certificates curl git rsync nginx sqlite3 python3 sudo

say "Installing Node (for the Claude Code CLI)"
if ! command -v node >/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

say "Creating users and directories"
id -u "$SERVICE_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin "$SERVICE_USER"
id -u "$DEPLOY_USER"  >/dev/null 2>&1 || useradd --create-home --shell /bin/bash "$DEPLOY_USER"

mkdir -p "$ROOT"/{app,web,var/uploads,home,backups}
chown -R "$DEPLOY_USER":"$SERVICE_USER" "$ROOT"
# The deploy user writes code; the service user writes data.
chown -R "$SERVICE_USER":"$SERVICE_USER" "$ROOT"/{var,home,backups}
chmod 2775 "$ROOT"/app "$ROOT"/web
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
CORS_ORIGINS=https://split.example.com
DEFAULT_CURRENCY=RUB
UPLOAD_DIR=$ROOT/var/uploads

VLM_PROVIDER=agent_sdk
VLM_MODEL=claude-sonnet-5
CLAUDE_CODE_OAUTH_TOKEN=
CLAUDE_CLI_PATH=$CLAUDE_BIN

# Pick ONE egress route if this host cannot reach api.anthropic.com directly.
# See deploy/README.md.
# ANTHROPIC_PROXY_URL=socks5://user:pass@vpn-host:1080
# ANTHROPIC_BASE_URL=https://relay.example.com
ENVEOF
  chown root:"$SERVICE_USER" "$ROOT/.env"
  chmod 640 "$ROOT/.env"
  echo "    generated a JWT secret; now fill in CLAUDE_CODE_OAUTH_TOKEN and CORS_ORIGINS"
else
  echo "    kept the existing .env"
fi

say "Installing the systemd unit"
install -m 644 "$(dirname "$0")/systemd/tricount.service" /etc/systemd/system/tricount.service
systemctl daemon-reload
systemctl enable tricount

say "Letting the deploy user restart the service"
cat > /etc/sudoers.d/tricount-deploy <<SUDOEOF
$DEPLOY_USER ALL=(root) NOPASSWD: /bin/systemctl restart tricount, /bin/systemctl status tricount, /usr/bin/journalctl -u tricount *
SUDOEOF
chmod 440 /etc/sudoers.d/tricount-deploy
visudo -cf /etc/sudoers.d/tricount-deploy

say "Installing the nginx site"
install -m 644 "$(dirname "$0")/nginx.conf" /etc/nginx/sites-available/tricount
ln -sf /etc/nginx/sites-available/tricount /etc/nginx/sites-enabled/tricount
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

say "Nightly database backup"
cat > /etc/cron.daily/tricount-backup <<CRONEOF
#!/bin/sh
# SQLite .backup is consistent against a live database, unlike cp.
[ -f "$ROOT/var/tricount.db" ] || exit 0
sqlite3 "$ROOT/var/tricount.db" ".backup '$ROOT/backups/daily-\$(date +\%Y\%m\%d).db'"
find "$ROOT/backups" -name 'daily-*.db' -mtime +30 -delete
CRONEOF
chmod 755 /etc/cron.daily/tricount-backup

cat <<DONE

Done. Remaining manual steps:

  1. Edit $ROOT/.env
       - CLAUDE_CODE_OAUTH_TOKEN=<your token>
       - CORS_ORIGINS=https://your-domain
       - an egress route, if this host cannot reach api.anthropic.com

  2. Point your domain at this server, edit server_name in
     /etc/nginx/sites-available/tricount, then:
       certbot --nginx -d your-domain

  3. Add the deploy key to $DEPLOY_USER:
       sudo -u $DEPLOY_USER mkdir -p ~$DEPLOY_USER/.ssh
       sudo -u $DEPLOY_USER tee -a ~$DEPLOY_USER/.ssh/authorized_keys

  4. Push to main. The Deploy workflow does the rest.

DONE
