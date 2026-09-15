# Deploying Xacheus

Two shapes, and the choice matters more than any setting:

| | **Always-on host** (recommended) | **Vercel** (serverless) |
| --- | --- | --- |
| Live run streaming to the console | ✅ WebSocket | ❌ console polls instead |
| Android phone bridge | ✅ persistent socket | ⚠️ HTTP polling transport |
| Interval/schedule automations | ✅ built-in scheduler | ⚠️ needs a Vercel Cron |
| Durable data | ✅ local files on a volume | ⚠️ **requires Firestore** |
| Long research/code runs | ✅ no limit | ⚠️ 60 s function ceiling |
| Cost | a small VPS / Railway / Fly | free tier often fits |
| Setup effort | `docker run` | ~10 minutes |

Vercel is genuinely good for this app's **console + API + webhooks** (WhatsApp inbound, forms, integrations calling in). It is the wrong home for a *long-lived autonomous agent* — Xacheus is honest about that rather than pretending, and every gap is reported at runtime and in the UI.

Both deployments run the identical kernel: same tools, same permission engine, same confirmation flow, same audit log.

---

## Option A — Vercel

### What is already done for you

- `api/index.js` — one catch-all serverless function serving the whole API, with the kernel cached on `globalThis` so warm instances do not rebuild it per request.
- `vercel.json` — build command, SPA output, `/api/*` rewrites, cron entry, security headers (the console is served from the same origin, so no CORS setup is needed).
- `apps/server/src/storage-guard.ts` — refuses to boot with throwaway storage instead of losing your data quietly.
- `apps/server/src/routes/cron.ts` — `GET|POST /api/tasks/tick`, guarded by `CRON_SECRET` (Vercel Cron sends it automatically as a bearer token).
- Polling device transport (`/api/devices/heartbeat`, `/api/devices/result`) so the Android app works without a socket.
- Console + runtime honesty: the dashboard shows a **polling** badge instead of a fake "streaming" one, and warns when storage is temporary.

### One-click from the repository

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/prayerdome0/Xacheusai&project-name=xacheus-ai&repository-name=xacheus-ai&env=XACHEUS_STORAGE,XACHEUS_OWNER_PASSCODE,XACHEUS_DEVICE_BRIDGE_TOKEN,CRON_SECRET,FIREBASE_SERVICE_ACCOUNT_JSON,FIREBASE_PROJECT_ID&envDescription=See%20DEPLOY.md%20for%20what%20each%20value%20is&envLink=https%3A%2F%2Fgithub.com%2Fprayerdome0%2FXacheusai%2Fblob%2Fmain%2FDEPLOY.md)

That link clones the repo into your own GitHub account, creates the Vercel
project, and prompts for the environment variables it cannot guess. It will **not**
boot until durable storage is configured — by design, and the error message says
exactly which value is missing.

### Automatic deploys from GitHub

Vercel's Git integration already redeploys on every push once the project is
connected — that is usually all you need. (The workflow is documented here rather
than committed because the GitHub App used to push this branch is not permitted to
create workflow files; pasting it into the GitHub editor takes a moment.) If you would rather deploy from Actions
(for example to run the test suite before shipping), create
`.github/workflows/deploy-vercel.yml` in the GitHub web editor with the workflow
below, and add `VERCEL_TOKEN`, `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID` as
repository secrets (the IDs come from `vercel link`, the token from
vercel.com/account/tokens).

The workflow verifies before it ships — typecheck, tests, and the full end-to-end
smoke suite — and skips itself with a notice instead of failing when the secrets
are absent.

```yaml
name: Deploy to Vercel
on:
  push:
    branches: [main]
  workflow_dispatch:

concurrency:
  group: vercel-${{ github.ref }}
  cancel-in-progress: true

jobs:
  deploy:
    runs-on: ubuntu-latest
    env:
      VERCEL_ORG_ID: ${{ secrets.VERCEL_ORG_ID }}
      VERCEL_PROJECT_ID: ${{ secrets.VERCEL_PROJECT_ID }}
      VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}
    steps:
      - uses: actions/checkout@v4
      - id: config
        run: |
          if [ -z "$VERCEL_TOKEN" ] || [ -z "$VERCEL_ORG_ID" ] || [ -z "$VERCEL_PROJECT_ID" ]; then
            echo "ready=false" >> "$GITHUB_OUTPUT"
            echo "::notice title=Vercel deploy skipped::Add VERCEL_TOKEN, VERCEL_ORG_ID and VERCEL_PROJECT_ID."
          else
            echo "ready=true" >> "$GITHUB_OUTPUT"
          fi
      - uses: actions/setup-node@v4
        if: steps.config.outputs.ready == 'true'
        with:
          node-version: 22
          cache: npm
      - if: steps.config.outputs.ready == 'true'
        run: npm ci
      - if: steps.config.outputs.ready == 'true'
        run: |
          npm run typecheck
          npm test
          npm run smoke
      - if: steps.config.outputs.ready == 'true'
        run: npx vercel@latest pull --yes --environment=production --token="$VERCEL_TOKEN"
      - if: steps.config.outputs.ready == 'true'
        run: npx vercel@latest build --prod --token="$VERCEL_TOKEN"
      - id: deploy
        if: steps.config.outputs.ready == 'true'
        run: |
          url="$(npx vercel@latest deploy --prebuilt --prod --token="$VERCEL_TOKEN")"
          echo "url=$url" >> "$GITHUB_OUTPUT"
          echo "### Deployed to $url" >> "$GITHUB_STEP_SUMMARY"
```

### Steps

**1. Get a Firebase service account (required — this is the durability part)**

Firebase console → project **xacheus-ai** → ⚙️ Project settings → **Service accounts** → *Generate new private key*. You get a JSON file.

Then enable Firestore: Build → **Firestore Database** → Create database (production mode is fine).

> Why this is mandatory: Vercel gives every invocation a fresh, temporary filesystem. Local JSON files there mean your memory, business records and audit log vanish between requests — sometimes even mid-conversation. Xacheus will refuse to start rather than let you believe otherwise.

**2. Set environment variables** (Vercel → Project → Settings → Environment Variables, for Production *and* Preview)

| Variable | Value | Why |
| --- | --- | --- |
| `XACHEUS_STORAGE` | `firestore` | durable, shared across instances |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | the whole JSON file, on one line | Firestore REST auth |
| `FIREBASE_PROJECT_ID` | `xacheus-ai` | Firestore project + ID-token auth |
| `XACHEUS_OWNER_PASSCODE` | a long random string | **required** — never expose an open agent |
| `XACHEUS_DEVICE_BRIDGE_TOKEN` | another long random string | pairs the Android app |
| `CRON_SECRET` | another long random string | authenticates the cron tick |
| `FIREBASE_API_KEY` | `AIzaSyCXKhOJYmmYz2Aqyv1powJuUaJHAySI87o` | web console Firebase sign-in |
| `FIREBASE_AUTH_DOMAIN` | `xacheus-ai.firebaseapp.com` | ditto |
| `FIREBASE_APP_ID` | `1:381741784268:web:3d9e4f5b70a794c0bd3669` | ditto |
| `FIREBASE_STORAGE_BUCKET` | `xacheus-ai.firebasestorage.app` | optional |
| `FIREBASE_MESSAGING_SENDER_ID` | `381741784268` | optional |

Optional but useful: `OPENAI_API_KEY` + `XACHEUS_MODEL=openai` (or `ANTHROPIC_API_KEY`, or point `OLLAMA_BASE_URL` at a reachable local model), `CLOUDINARY_*`, `FACEBOOK_*`, `WHATSAPP_*`, `HOME_ASSISTANT_*`, `BRAVE_API_KEY`.

> Firebase web keys are public by design — they ship in every browser bundle. The real protection is Firebase Auth plus your Firestore rules; the server-side protection is the owner passcode and the service account.

**3. Deploy**

Dashboard: **Add New → Project → Import Git Repository** → pick your repo → it reads `vercel.json` (build `npm run build`, output `apps/web/dist`) → Deploy.

> **Root Directory must be the repository root (leave it blank).** This is a
> workspace monorepo: the root `package.json` lists `packages/*`, `apps/server`
> and `apps/web`, and `vercel.json`'s paths (`apps/web/dist`, `api/index.js`)
> are written relative to that root. If Root Directory points at a single
> workspace, Vercel installs only that workspace's tree (≈109 packages instead
> of ≈309) and runs that workspace's `build` alone, so the console in
> `apps/web/dist` — the configured `outputDirectory` — is never produced.
> Each workspace declares its own `typescript` devDependency and
> `@xacheus/server` builds `@xacheus/core` first, so the API compiles under any
> install scope; only a root-level build produces the complete artifact.

Or from the CLI:

```bash
npm i -g vercel
vercel link          # connect to your project
vercel env pull      # or add the variables in the dashboard
vercel --prod
```

**4. Point the cron at the tick**

`vercel.json` ships with a schedule Vercel accepts on **every** plan:

```json
{ "path": "/api/tasks/tick", "schedule": "0 6 * * *" }
```

That is a daily sweep, which is the most a Hobby account is allowed — Vercel
rejects more frequent schedules at deploy time on Hobby, so the default here is
the safe one. On Pro, tighten it to `"* * * * *"` to match what a self-hosted
server does (a tick every minute). Any other scheduler works on any plan:

- **cron-job.org / UptimeRobot / GitHub Actions** hitting `https://<your-app>.vercel.app/api/tasks/tick` with header `Authorization: Bearer <CRON_SECRET>`.
- A GitHub Action on a schedule:

```yaml
- run: curl -fsS -X POST -H "Authorization: Bearer ${{ secrets.CRON_SECRET }}" https://<your-app>.vercel.app/api/tasks/tick
```

If automations never tick, the console will tell you: `/api/runtime` reports `schedulerInProcess: false`, and the dashboard says scheduled automations need a cron.

**5. Check it is honest about itself**

```bash
curl https://<your-app>.vercel.app/api/health
curl -H "Authorization: Bearer $XACHEUS_OWNER_PASSCODE" https://<your-app>.vercel.app/api/runtime
```

`/api/runtime` should report `runtime: "serverless"`, `storage.driver: "firestore"`, `storage.durable: true`, and list the two caveats (no WebSockets here, cron-driven automations). Open the console, and the Dashboard will show a **polling** badge on the activity feed — that is the truth, not a failure.

**6. Pair the Android app**

In the app: Server URL = `https://<your-app>.vercel.app`, Device bridge token = `XACHEUS_DEVICE_BRIDGE_TOKEN`, then set **Connection → Poll** (or leave **Auto**, which falls back on its own after the socket upgrade is refused).

### If you want to look around first

Zero-config deploy — accept that nothing is saved:

```
XACHEUS_STORAGE=json
XACHEUS_ALLOW_EPHEMERAL_STORAGE=true
XACHEUS_OWNER_PASSCODE=<something>
```

The console then shows a permanent warning banner and `/api/runtime` reports `durable: false`. That is the only mode where Vercel will start without Firestore, and it is deliberately noisy.

### Function limits you should know about

| Limit | Value | What it means here |
| --- | --- | --- |
| Max duration | 60 s (see `vercel.json`; Hobby may clamp lower) | A long research sweep, a big document ingest or a slow model call can be cut off mid-run. The run is left `pending` in the audit log rather than reported as done |
| Memory | 1024 MB | comfortable for the kernel; large uploads are streamed to Cloudinary rather than held |
| Payload | Fastify allows 25 MB JSON, 40 MB multipart | Vercel's own limits may be lower — use Cloudinary for big files |
| Cold starts | ~1 s | The kernel is cached per instance, so only the first request after a cold start pays for it |

Anything that needs more should run on an always-on host (Option B) — the same
kernel, the same data if both point at the same Firestore project.

### Verifying a Vercel deployment locally, before you deploy

```bash
npm run build
npm run smoke:serverless     # 40 checks: simulates the function, including the two refusal paths
```

It boots the real `api/index.js` behind a Node HTTP server with `VERCEL=1`, then asserts the guardrails hold: it refuses throwaway storage, refuses a broken Firestore credential (instead of silently downgrading to disk), reports its limits, accepts a `CRON_SECRET` tick, round-trips a queued phone command, and still blocks/confirms the same way the full server does.

---

## Option B — Always-on host (full platform)

Use this when you want the whole thing: live streaming, a persistent phone socket, a scheduler, and no function timeouts.

### Docker

```bash
docker build -t xacheus .
docker run -d --name xacheus -p 8787:8787 \
  --env-file .env \
  -v xacheus-data:/data \
  --restart unless-stopped \
  xacheus
```

The image builds the kernel, server and console; runs as the non-root `node` user; keeps `/data` on a volume; and has a `HEALTHCHECK` on `/api/health`.

### Plain Node (VPS, Pi, home server)

```bash
npm ci && npm run build
cp .env.example .env        # set XACHEUS_OWNER_PASSCODE at minimum
NODE_ENV=production node apps/server/dist/index.js
```

Put it behind HTTPS (Caddy, nginx, Cloudflare Tunnel, Tailscale Funnel) before pointing a phone at it from outside your LAN.

### Managed platforms

Railway, Render, Fly.io and similar run the same Dockerfile. Persist `/data` (a volume or disk) *or* set `XACHEUS_STORAGE=firestore`, and keep `HOST=0.0.0.0`. WebSockets work on all of them, so both transports are available.

### systemd unit

```ini
[Unit]
Description=Xacheus AI
After=network-online.target

[Service]
WorkingDirectory=/opt/xacheus
EnvironmentFile=/opt/xacheus/.env
ExecStart=/usr/bin/node apps/server/dist/index.js
Restart=always
User=xacheus

[Install]
WantedBy=multi-user.target
```

---

## Storage: pick it deliberately

| Driver | Set | Durable | Use when |
| --- | --- | --- | --- |
| `json` | default | on a box: yes | your own machine or a VPS with a volume |
| `firestore` | `XACHEUS_STORAGE=firestore` + service account | yes, and shared | serverless, or several instances |
| `memory` | `XACHEUS_STORAGE=memory` | no, by design | tests and demos |

Cloudinary is separate and optional — it stores uploaded files and media, while the database stores the records about them. Without it, uploads land in `XACHEUS_DATA_DIR/uploads` and are served at `/api/files/:id`; on Vercel that means uploads are temporary, so configure `CLOUDINARY_*` if you upload on a serverless deployment.

---

## WhatsApp webhook on a deployment

Meta needs a public HTTPS URL:

```
Callback URL:  https://<your-app>/api/webhooks/whatsapp
Verify token:  <WHATSAPP_VERIFY_TOKEN>
```

Inbound `POST`s are accepted only with a valid `X-Hub-Signature-256` HMAC — set `WHATSAPP_APP_SECRET` (the Meta app secret) or they are refused with `503`. `GET /api/webhooks` reports whether both secrets are configured.

---

## Security checklist before you go live

- [ ] `XACHEUS_OWNER_PASSCODE` is a long random string, not a word.
- [ ] `XACHEUS_DEVICE_BRIDGE_TOKEN` and `CRON_SECRET` are different secrets again.
- [ ] `XACHEUS_STORAGE=firestore` with a **real** service account (the smoke test proves a broken one is refused, not ignored).
- [ ] Firestore rules deny client access to the `xacheus` root — only your server, holding the service account, may read or write it.
- [ ] `XACHEUS_OWNER_EMAIL` set if you use Firebase sign-in, so only your account counts as owner.
- [ ] Social/mail/home credentials granted the narrowest scope the provider offers.
- [ ] Nothing important left on `XACHEUS_ALLOW_EPHEMERAL_STORAGE=true`.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Deployment failed: cron schedule not allowed` | sub-daily cron on a Hobby plan | use the shipped `0 6 * * *`, or upgrade |
| `503 xacheus_not_configured` | ephemeral storage without opt-in, or unusable Firestore | set the service account, or `XACHEUS_ALLOW_EPHEMERAL_STORAGE=true` to look around |
| Console says "polling" | this host cannot hold WebSockets | expected on Vercel; deploy the Docker image if you want live streaming |
| Data disappears between requests | local files on serverless | `XACHEUS_STORAGE=firestore` |
| Automations never run | no scheduler in a function | cron → `/api/tasks/tick` with `CRON_SECRET` |
| Phone shows "Backend unreachable" | wrong URL, or token mismatch | recheck the server URL and `XACHEUS_DEVICE_BRIDGE_TOKEN`; set Connection → **Poll** |
| Every request re-reads the database | cold instance, not an error | warm instances cache the kernel; occasional cold starts are normal |
| `401` from the cron | missing/incorrect secret | send `Authorization: Bearer $CRON_SECRET` |
