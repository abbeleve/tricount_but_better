# Deploying

Target: one Debian/Ubuntu box you control, running nginx + systemd, with the
database as a single SQLite file.

```
/opt/tricount/
├── app/          code (rsynced by CI, read-only to the service)
│   └── .venv/    built on the server by `uv sync`
├── web/          the built frontend (rsynced by CI)
├── var/
│   ├── tricount.db     the database
│   └── uploads/        receipt photos
├── backups/      nightly + pre-deploy snapshots
├── home/         HOME for the Claude Code CLI
└── .env          secrets — never in git, never touched by a deploy
```

`app/` and `web/` are the only rsync targets, and they are siblings of the
data. That is what makes `rsync --delete` safe.

---

## 1. Bootstrap the server (once)

```bash
sudo bash deploy/bootstrap.sh
```

It installs nginx, Node, the Claude Code CLI, `uv`, creates the `tricount`
service user and a `deploy` user, writes a `.env` with a freshly generated JWT
secret, installs the systemd unit and nginx site, and adds a nightly backup.

Then finish the three manual steps it prints: fill in `CLAUDE_CODE_OAUTH_TOKEN`,
set your domain, and run `certbot --nginx -d your-domain`.

---

## 2. Getting model traffic out of Russia

`api.anthropic.com` is not reachable from a Russian IP, so the receipt parser
needs an egress route. Pick **one**. All three are supported by the same code;
they differ only in where the tunnel lives.

### (a) A SOCKS5 or HTTP proxy — simplest

If your VPN gives you a proxy endpoint, or you can run one on the far side:

```bash
# /opt/tricount/.env
ANTHROPIC_PROXY_URL=socks5://user:pass@vpn-host:1080
```

The backend passes this to the Claude Code CLI as `HTTPS_PROXY`/`HTTP_PROXY`,
and to the Anthropic SDK as an httpx proxy. Nothing else on the box is
affected — your own SSH, apt and git stay on the direct route.

`socks5://` needs the extra that the deploy workflow already installs
(`uv sync --extra socks`). An `http://` proxy needs nothing extra.

### (b) A relay on a VPS you own abroad — most robust

Run a thin reverse proxy on a host outside the blocked region and point the app
at it. Nothing tunnels; it is an ordinary HTTPS request to your own domain.

On the foreign VPS, with Caddy:

```
relay.example.com {
    reverse_proxy https://api.anthropic.com {
        header_up Host api.anthropic.com
    }
}
```

Then:

```bash
# /opt/tricount/.env
ANTHROPIC_BASE_URL=https://relay.example.com
```

Restrict the relay to your server's IP — anyone who finds it can spend your
tokens:

```
@notmine not remote_ip <your.server.ip>
respond @notmine 403
```

### (c) A WireGuard tunnel, routed by user — no proxy needed

Route only the `tricount` user's traffic through the tunnel, leaving the rest of
the machine alone. Leave both `ANTHROPIC_PROXY_URL` and `ANTHROPIC_BASE_URL`
empty; egress is handled below the application.

```bash
sudo apt install wireguard
sudo install -m 600 your-vpn.conf /etc/wireguard/wg0.conf
```

Edit `/etc/wireguard/wg0.conf` so it installs its routes in a side table
instead of hijacking the default route, and steer one UID into it:

```ini
[Interface]
# ... Address / PrivateKey / DNS as your provider gave them ...
Table = 200
PostUp   = ip rule add uidrange %i-%i table 200 priority 1000
PostDown = ip rule del uidrange %i-%i table 200 priority 1000
```

Replace `%i` with the numeric uid of the service user
(`id -u tricount`), then:

```bash
sudo systemctl enable --now wg-quick@wg0
# verify: the service user goes through the tunnel, root does not
sudo -u tricount curl -s https://ifconfig.me; echo
curl -s https://ifconfig.me; echo
```

### Checking whichever you chose

```bash
sudo -u tricount env HOME=/opt/tricount/home \
  /opt/tricount/app/.venv/bin/python /opt/tricount/app/scripts/check_vlm.py
```

It prints the resolved provider, model, proxy and credential, then parses a
synthetic receipt. If that prints line items, the whole path works.

---

## 3. GitHub Actions

`ci.yml` runs on every push and pull request: ruff, pytest, an
`alembic check` that fails if a model changed without a migration, plus
typecheck, eslint and a production build of the frontend.

`deploy.yml` runs on pushes to `main`. It calls `ci.yml` first and stops if
anything fails, then rsyncs, backs up the database, migrates, restarts the
service and polls `/api/health` until it answers — failing the run with the
last 40 journal lines if it does not.

### Secrets to create

**Settings → Secrets and variables → Actions → New repository secret.**
`deploy.yml` also uses a `production` environment, so you can add a required
reviewer under **Settings → Environments → production** if you want a manual gate.

| Secret | What it is |
|---|---|
| `SSH_HOST` | server hostname or IP |
| `SSH_USER` | `deploy` |
| `SSH_KEY` | the **private** half of the deploy key (full PEM, including header and footer lines) |
| `SSH_KNOWN_HOSTS` | output of `ssh-keyscan -H your-server` |
| `SSH_PORT` | optional, defaults to `22` |
| `DEPLOY_PATH` | optional, defaults to `/opt/tricount` |

Generate a key that exists only for deploys:

```bash
ssh-keygen -t ed25519 -N '' -C 'github-actions' -f ~/.ssh/tricount_deploy

# public half onto the server
ssh-copy-id -i ~/.ssh/tricount_deploy.pub deploy@your-server

# private half into GitHub (paste the whole file)
cat ~/.ssh/tricount_deploy

# host fingerprint, so Actions cannot be MITM'd on first connect
ssh-keyscan -H your-server
```

With `gh` installed you can skip the web UI:

```bash
gh secret set SSH_KEY        < ~/.ssh/tricount_deploy
gh secret set SSH_KNOWN_HOSTS <<< "$(ssh-keyscan -H your-server)"
gh secret set SSH_HOST       <<< "your-server"
gh secret set SSH_USER       <<< "deploy"
```

The `CLAUDE_CODE_OAUTH_TOKEN` is deliberately **not** a GitHub secret. It lives
only in `/opt/tricount/.env` on the server, so a compromised CI run cannot read
it and deploys never rewrite it.

---

## 4. Day to day

```bash
sudo systemctl status tricount
sudo journalctl -u tricount -f

# restore a backup
sudo systemctl stop tricount
sudo -u tricount cp /opt/tricount/backups/daily-20260918.db /opt/tricount/var/tricount.db
sudo systemctl start tricount

# take a copy off the box (consistent even while running)
sudo -u tricount sqlite3 /opt/tricount/var/tricount.db ".backup '/tmp/snap.db'"
scp your-server:/tmp/snap.db .
```

Turning receipt scanning off entirely — the button disappears from the UI and
the endpoint returns 503:

```bash
# /opt/tricount/.env
VLM_PROVIDER=disabled
```

### Outgrowing SQLite

Unlikely for a flat share, but if you ever need Postgres: nothing in the code is
SQLite-specific.

```bash
uv sync --extra postgres
# DATABASE_URL=postgresql+psycopg://user:pass@localhost/tricount
uv run alembic upgrade head
```
