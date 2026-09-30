#!/usr/bin/env bash
# Installed by bootstrap.sh as a root-owned command. The deploy user may run
# this one command via sudo; it never gets direct access to the database or .env.
set -euo pipefail

ROOT=/opt/tricount
SERVICE_USER=tricount

if [ "$(id -u)" -ne 0 ]; then
  echo "run this via sudo" >&2
  exit 1
fi

if [ ! -x "$ROOT/app/.venv/bin/alembic" ]; then
  echo "install application dependencies before releasing" >&2
  exit 1
fi

if [ -f "$ROOT/var/tricount.db" ]; then
  snapshot="$ROOT/backups/pre-deploy-$(date +%Y%m%d-%H%M%S).db"
  runuser -u "$SERVICE_USER" -- sqlite3 "$ROOT/var/tricount.db" ".backup '$snapshot'"
  find "$ROOT/backups" -maxdepth 1 -type f -name 'pre-deploy-*.db' \
    -printf '%T@ %p\n' | sort -rn | tail -n +11 | cut -d ' ' -f 2- | xargs -r rm --
fi

runuser -u "$SERVICE_USER" -- bash -c '
  set -euo pipefail
  set -a
  . /opt/tricount/.env
  set +a
  cd /opt/tricount/app
  PYTHONDONTWRITEBYTECODE=1 .venv/bin/alembic upgrade head
'

systemctl restart tricount
