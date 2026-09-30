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

The backend listens only on `127.0.0.1:8010`; nginx is the public entry point.
This deliberately avoids port `8000`, which is commonly used by other local
FastAPI services. Existing nginx sites are kept intact, so this application can
share a server with them under a separate domain or subdomain.

---

## 1. Bootstrap the server (once)

From your laptop, copy the deployment files and run the bootstrap through the
SSH account that already has sudo access on the server:

```bash
scp -r deploy deploy@194.87.111.40:/tmp/tricount-bootstrap
ssh deploy@194.87.111.40 'sudo bash /tmp/tricount-bootstrap/bootstrap.sh'
```

The script uses `/opt/tricount`, the existing `deploy` account, and a new
`tricount` service user. It adds one nginx
site without replacing your other sites; the app listens on local port `8010`.

For the first deployment, `tricount-194-87-111-40.sslip.io` resolves to
`194.87.111.40`. Replace this temporary hostname with a domain you control
when one is available. The existing application remains the default HTTP site
for requests to the IP. On the server, run:

```bash
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d tricount-194-87-111-40.sslip.io
```

Open ports 80 and 443 in the server firewall. Keep port 8010 private.
The script installs nginx, Certbot, Node, the Claude Code CLI, and `uv`,
creates the users, generates a JWT secret, installs the systemd unit and nginx
site, and adds a nightly backup. To deploy before configuring receipt scanning,
set `VLM_PROVIDER=disabled` in `/opt/tricount/.env`. Otherwise supply
`CLAUDE_CODE_OAUTH_TOKEN` and an egress route if required.

---

## 2. Receipt-scanning egress (only if needed)

If the server cannot reach `api.anthropic.com`, the receipt parser needs an
egress route. Pick **one**. Otherwise leave both egress settings unset.
All three routes are supported by the same code; they differ only in where
the tunnel lives.

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

`deploy.yml` runs on pushes to `main` or when started manually. It calls
`ci.yml` first and stops if anything fails, then rsyncs, installs locked
Python dependencies, invokes the root-owned release helper to back up and
migrate the database, restarts the service, and polls `/api/health`. A failed
health check prints the last 40 journal lines.

### Secrets to create

**Settings → Secrets and variables → Actions → New repository secret.**
`deploy.yml` also uses a `production` environment, so you can add a required
reviewer under **Settings → Environments → production** if you want a manual gate.

| Secret | What it is |
|---|---|
| `SSH_HOST` | server hostname or IP |
| `SSH_USER` | `deploy` |
| `SSH_KEY` | the **private** half of a dedicated deploy key, including its header and footer |
| `SSH_KNOWN_HOSTS` | the verified SSH host key line for `194.87.111.40` |
| `SSH_PORT` | optional, defaults to `22` |

Your existing personal SSH key is enough for the bootstrap. Generate a
separate unencrypted key for GitHub Actions:

```bash
ssh-keygen -t ed25519 -N '' -C 'github-actions' -f ~/.ssh/tricount_deploy

# The new deploy account has no password, so use your existing sudo-capable login.
ssh deploy@194.87.111.40 'sudo install -d -o deploy -g deploy -m 700 /home/deploy/.ssh'
cat ~/.ssh/tricount_deploy.pub | ssh deploy@194.87.111.40 \
  'sudo tee -a /home/deploy/.ssh/authorized_keys >/dev/null &&
   sudo chown deploy:deploy /home/deploy/.ssh/authorized_keys &&
   sudo chmod 600 /home/deploy/.ssh/authorized_keys'
ssh -i ~/.ssh/tricount_deploy deploy@194.87.111.40 'whoami'
```

Pin the server host key. Compare the scanned fingerprint with the host's
fingerprint through your already trusted admin SSH session; they must match:

```bash
ssh-keyscan -t ed25519 194.87.111.40 > /tmp/tricount_known_hosts
ssh-keygen -lf /tmp/tricount_known_hosts -E sha256
ssh deploy@194.87.111.40 \
  'sudo ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256'
```

Put the complete contents of `~/.ssh/tricount_deploy` in `SSH_KEY`,
`194.87.111.40` in `SSH_HOST`, `deploy` in `SSH_USER`, and the
scanned line in `SSH_KNOWN_HOSTS`. Repository secrets work; storing them
on the `production` environment also works. You may require a reviewer for
that environment. Push to `main` to trigger the first deployment.
When the Deploy workflow succeeds, check
`curl -fsS https://tricount-194-87-111-40.sslip.io/api/health`; it should return
`{"status":"ok"}`.

The GitHub runner checks the server's host key on every connection. The
private key stays in GitHub Actions secrets; never commit it.

The `CLAUDE_CODE_OAUTH_TOKEN` is kept in `/opt/tricount/.env` on the server,
and deploys never rewrite it.

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
