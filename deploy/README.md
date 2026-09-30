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
site, and adds a nightly backup. Receipt scanning starts disabled. Configure a
provider and its credentials only after checking availability for your deployment.

---

## 2. Receipt scanning and provider availability

The upload, parsing, and editable expense form are already implemented. Set
`VLM_PROVIDER=disabled` until the chosen model provider is available for your
deployment and users. Anthropic's [Supported Regions Policy](https://www.anthropic.com/supported-countries)
does not list Russia. Routing a Russian VPS through a VPN or relay does not
itself make a deployment eligible for Claude. For a service operating in
Russia, use a provider available there or add a local OCR parser behind
`src/tricount_but_better/vlm/base.py`.

For an eligible Claude deployment that needs a corporate network proxy, this
app accepts `ANTHROPIC_PROXY_URL=http://proxy-host:port`. It passes the setting
to Claude Code as `HTTPS_PROXY`/`HTTP_PROXY` and to the Messages API client.
Anthropic's [Claude Code proxy documentation](https://docs.anthropic.com/en/docs/claude-code/corporate-proxy)
supports HTTP(S) proxies, but explicitly says the CLI does **not** support
SOCKS proxies. The `socks` Python extra applies only to the Messages API
client. Leave the proxy unset when direct egress is available.
`ANTHROPIC_BASE_URL` is available for an approved Anthropic-compatible gateway.

### Check the configured provider

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
