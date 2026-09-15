# Xacheus AI

**A private personal + business AI agent that belongs to you.**
You talk to it — *“Xacheus, handle this for me.”* — and it plans, uses your tools,
remembers your context, acts on your world, and shows you everything it did.

This repository is the complete platform:

| Piece | What it is | Path |
| --- | --- | --- |
| **Kernel** | Agents, tools, memory, knowledge, permissions, automation engine | `packages/core` |
| **Backend** | HTTP + WebSocket API, auth, device bridge, webhooks | `apps/server` |
| **Control Center (web)** | Voice + chat console, dashboards, approvals, configuration | `apps/web` |
| **Android companion** | Wake word, device actions, notifications, smart-home hand-off | `apps/android` |

It runs with **zero credentials** out of the box — on your machine, with your data
in plain files you can read, back up and delete.

```
┌──────────────────────────┐        ┌────────────────────────────────────────┐
│  Android app (bridge)    │        │  Web console (Control Center)          │
│  wake word · device ops   │        │  chat · voice · dashboards · approvals │
└────────────┬─────────────┘        └────────────────┬───────────────────────┘
             │  WebSocket (phone dials out)           │  HTTPS/WS
             ▼                                        ▼
        ┌───────────────────────────────────────────────────────────┐
        │                     Xacheus kernel                        │
        │  Master Agent → specialists → tools → memory/knowledge    │
        │  permissions · confirmations · audit log · automations    │
        └──────┬──────────────────┬───────────────────┬─────────────┘
               │                  │                   │
        ┌──────▼─────┐     ┌──────▼──────┐     ┌──────▼────────────┐
        │ Model layer│     │ Connectors  │     │ Storage           │
        │ local/API/ │     │ Meta, mail, │     │ JSON/Firestore +  │
        │ built-in   │     │ home, cloud │     │ Cloudinary        │
        └────────────┘     └─────────────┘     └───────────────────┘
```

---

## Quick start (5 minutes, no accounts needed)

```bash
git clone <your-repo> && cd Xacheusai
npm install

cp .env.example .env        # everything is optional; edit as you go
npm run build               # build core, server and the console
npm start                   # → http://localhost:8787
```

Open **http://localhost:8787** — the backend serves the built console. Type
*“what is on today?”* and it answers with a plan you can inspect.

For live-reloading development:

```bash
npm run dev                 # server on :8787, console on :5173 (proxying /api)
```

Useful scripts:

| Command | What it does |
| --- | --- |
| `npm run typecheck` | Strict TypeScript across core, server and web |
| `npm test` | Kernel tests: permissions, confirmations, memory, automation safety |
| `npm run smoke` | Boots a real server and drives 52 end-to-end checks |
| `npm run smoke:console` | Renders the built console against a live API and asserts it painted |
| `npm run dev` | Backend + console with hot reload |

### The very first things worth doing

1. **Set an owner passcode** — `XACHEUS_OWNER_PASSCODE=…` in `.env`. Until you do,
   the API is open and the startup banner warns you loudly.
2. **Pair your phone** (optional) — see [Android companion](#android-companion).
3. **Add a model** (optional) — Xacheus already works without one; a model makes it
   conversational. Totally local: install [Ollama](https://ollama.com), then
   `ollama pull llama3.1:8b` and set `XACHEUS_MODEL=ollama`.
4. **Grant permissions as you need them** — by design, Xacheus cannot post, send,
   call or control anything until you say so in *Connect → Permissions*.

---

## How Xacheus thinks

When you ask for something, the kernel runs a fixed, inspectable pipeline:

```
REQUEST → AUTHENTICATION → PERMISSION CHECK → TOOL VALIDATION → ACTION
        → AUDIT LOG → RESULT → (NOTIFICATION)
```

1. **Routing** — the built-in planner (or your LLM) picks the owning agent.
2. **Planning** — a plan is built from tools that *exist*. A model can never
   invent an action: only registered tool ids execute.
3. **Permission check** — scopes, per-tool policies and agent policies are
   evaluated. Missing scope → the step is *blocked* and Xacheus tells you exactly
   which scope to grant.
4. **Confirmation** — anything high-impact (publishing, sending, calling, running
   commands, changing device settings) waits for you. Decline → nothing runs.
5. **Execution** — every result carries a mode: `live`, `sandbox`, `dry-run` or
   `blocked`.
6. **Audit** — each stage is written to an append-only log with actor, tool, mode
   and outcome.

### The one promise that matters

**Xacheus never pretends.** If a connector has no credentials, results say
`simulated`; if a phone is not connected, the command reports that nothing was
executed; if a permission is missing, the answer names the scope to grant. There
is no code path that reports a simulated action as a real one, and the test suite
guards it (`npm test`, `npm run smoke`).

### Execution modes

| Mode | Meaning |
| --- | --- |
| `live` | A real service, device or file was touched |
| `sandbox` | Simulated: credentials or hardware are missing. Nothing left the machine |
| `dry-run` | Prepared and shown to you, deliberately not executed |
| `blocked` | Denied by permission policy, with the reason and the fix |

---

## The agents

| Agent | Handles |
| --- | --- |
| **Master** | Coordinates every specialist; fans out across personal/business |
| **Personal** | Reminders, schedules, tasks, calendar, notes, recurring routines |
| **Business** | Products, customers, leads, sales, expenses, documents, projects, marketing |
| **Research** | Web search, page reading, monitoring, summaries, comparisons, reports |
| **Knowledge** | PDFs, DOCX, images and business files ingested, indexed and searchable |
| **Code** | Read, explain, find bugs, generate, modify, review, tests, logs, deploy help |
| **Social** | Facebook + Instagram via authorized APIs: read, classify, draft, publish approved content |
| **Messaging** | WhatsApp Business: inbound inquiries, drafted replies, escalation, approved sends |
| **Mail** | Organize, summarize, draft, prioritize, follow-ups, classification |
| **Home** | Lights, switches, plugs, fans, thermostats, cameras, sensors, TVs, speakers, locks |
| **Automation** | Triggers → conditions → plan → tools → action → result → notification |
| **Phone** | Permitted Android actions through the companion app |

Try these in the console or by voice:

> “What is on today?”
> “Remember that the workshop closes at 4pm on Fridays.”
> “Search my documents for the supplier agreement.”
> “Draft a reply to the WhatsApp asking about delivery.”
> “Turn off everything downstairs.”
> “Find bugs in src/payments and explain them.”
> “Every morning at 7, brief me and remind me to check the website.”

---

## Memory and knowledge

Five memory types, all reviewable, correctable and deletable:

| Kind | Holds |
| --- | --- |
| `conversation` | The running thread (per session) |
| `long-term` | Durable facts about you and your preferences |
| `company` | Brand tone, opening hours, policies, facts Xacheus may quote |
| `task` | Open loops it is tracking for you |
| `knowledge` | Facts distilled from your documents |

Knowledge ingestion: upload a PDF/DOCX/TXT/CSV/JSON/HTML/image in the console
(or POST to `/api/documents`), and Xacheus extracts the text, chunks it, indexes
it for retrieval, files the original in **Cloudinary** when configured (otherwise
locally under `.data/uploads`, served at `/api/files/:id`), and *learns* durable
facts into company memory.

Everything lives in `.data/collections/*.json` by default — human-readable,
greppable, portable. Point `XACHEUS_STORAGE=firestore` (with a service account)
to use Firestore instead.

---

## Xacheus Connect

Every integration is a **connector**: a manifest (what it needs, what it can do)
plus typed operations that become tools. Connectors report their own health, so
the console can always answer *“what is not connected, and why?”*

| Connector | Goes live with |
| --- | --- |
| Facebook Page | `FACEBOOK_PAGE_ID`, `FACEBOOK_PAGE_ACCESS_TOKEN` |
| Instagram Business | `INSTAGRAM_BUSINESS_ACCOUNT_ID` (+ Facebook credentials) |
| WhatsApp Cloud API | `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET` |
| Mail (IMAP/SMTP) | `MAIL_IMAP_HOST`, `MAIL_SMTP_HOST`, `MAIL_USER`, `MAIL_PASSWORD` (`npm i imapflow nodemailer -w @xacheus/core`) |
| Smart home | `HOME_ASSISTANT_URL`, `HOME_ASSISTANT_TOKEN`, `HOME_AREAS` |
| Cloudinary | `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` |
| Firebase | `FIREBASE_*` web config + optional service account |
| Web research | `BRAVE_API_KEY` (optional — reports sandbox without it) |
| Custom API | Any HTTP endpoint you describe; private network addresses are refused unless you opt in |
| Android device | `XACHEUS_DEVICE_BRIDGE_TOKEN` + the companion app |

Enter credentials in **Connect → Connectors** (they are stored server-side and
never sent back to the browser — reads are masked), or in `.env`.

### WhatsApp webhook (inbound messages)

Meta POSTs inbound messages to `/api/webhooks/whatsapp`. That route cannot ask for
your passcode, so it authenticates the *caller* instead:

- `GET` verifies the subscription against `WHATSAPP_VERIFY_TOKEN`.
- `POST` requires a valid `X-Hub-Signature-256` HMAC over the raw body using
  `WHATSAPP_APP_SECRET`. **Unsigned webhooks are refused** (503 until the secret is
  set, 401 on a bad signature) — an endpoint that writes to your business database
  must not be open.

Inbound messages become a lead, a notification, an audit entry and a dashboard
event. Xacheus drafts the reply; you approve the send.

---

## Android companion

`apps/android` is a Kotlin/Compose app that makes your phone a first-class part of
Xacheus: wake word (`“Xacheus…”`), voice chat, notifications, and permitted device
actions — open apps, reminders, calendar, media, calls, SMS, camera, clipboard,
location, torch, TTS.

Design rules, enforced in code:

- The phone **dials out** to your backend over a WebSocket (`/api/devices/socket`).
  No inbound ports on your handset, no listening server.
- The wake word runs in a **foreground service with a permanent visible
  notification**. Android shows the microphone indicator the whole time. There is
  no covert listening mode, and the service stops the moment you stop it.
- Every device action is **permission-checked at the moment of use**. If Android
  says no, Xacheus reports the denial instead of faking success.
- An action that needs a system grant Android does not give third-party apps
  (airplane mode, silent settings writes) is reported as unsupported rather than
  worked around.

See [`apps/android/README.md`](apps/android/README.md) for building, pairing,
permissions and how to swap the wake-word engine for Porcupine or Vosk.

---

## Model layer (pluggable, no rebuilds)

Xacheus is model-agnostic by design. Switch at any time in **Settings → Model
layer**, or with `XACHEUS_MODEL`:

| Provider | Setting | Notes |
| --- | --- | --- |
| Built-in planner | `heuristic` (default) | No network, no cost, deterministic. Routing, tools, memory and knowledge all work |
| Ollama | `ollama` | Local and private: `OLLAMA_BASE_URL`, `OLLAMA_MODEL` |
| OpenAI-compatible | `openai` | OpenAI, Groq, Together, vLLM, LM Studio, OpenRouter |
| Anthropic | `anthropic` | `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` |

Your own model later plugs in the same way: implement the provider interface and
nothing else in the platform changes.

---

## Security model

- **Auth**: owner passcode, Android device token, or Firebase ID tokens verified
  against Google's public keys (`FIREBASE_PROJECT_ID`, optional
  `XACHEUS_OWNER_EMAIL` restriction). Timing-safe comparisons; tokens accepted via
  `Authorization: Bearer`, `?token=` or `x-xacheus-token` (the last two exist for
  WebSockets, which cannot set headers in browsers).
- **Permissions, not promises**: scopes are deny-by-default for anything that
  reaches other people or changes your world; per-tool policies can disable a tool
  or change when it asks.
- **Confirmations**: high/critical risk tools always ask; declining is final for
  that step and audited as such.
- **Automation safety**: the Automation Engine cannot perform a confirmation-gated
  action unattended. It fails closed and tells you — and it cannot even hold
  permission to publish, by agent policy.
- **Code Agent jail**: every path is resolved against `XACHEUS_WORKSPACE_ROOT`;
  escaping the workspace is refused. Shell commands are matched against an
  allow-list (`npm test`, `npm run <script>`, `npx tsc`, `pytest`, `go test`,
  `cargo test`, `git status|diff|log`, …) with a time limit, and always require
  your approval.
- **Custom API connector**: private/link-local addresses are refused unless you
  explicitly opt in (`XACHEUS_ALLOW_PRIVATE_API=true`), so a URL from a model
  cannot be used to probe your internal network.
- **Secrets** live server-side; the console only ever receives masked values.

Audit log: `.data/audit.json`, exposed in the console under *Automations → Activity*
and via `GET /api/audit`.

---

## API overview

All routes are guarded except the three marked *public*.

```
# Chat & runs
POST   /api/chat                     ask Xacheus anything
POST   /api/voice                    same, plus a speakable string for TTS
POST   /api/runs/:id/confirm         approve/decline a gated step
GET    /api/runs · /api/runs/pending · /api/runs/:id
GET    /api/sessions · /api/sessions/:id · DELETE /api/sessions/:id
GET    /api/agents                   agent roster + their tools

# Memory & knowledge
GET|POST /api/memory · PATCH|DELETE /api/memory/:id
GET    /api/knowledge · /api/knowledge/search?q=… · DELETE /api/knowledge/:id
POST   /api/knowledge/text
POST   /api/documents                multipart upload (PDF/DOCX/image/…)
GET    /api/files/:id                locally stored originals

# Business & personal
GET    /api/business · /api/business/brief · /api/business/leads
GET    /api/business/tasks · /api/business/products · /api/business/expenses
PATCH  /api/business/company · POST /api/business/tasks · /api/business/leads
POST   /api/business/inquiry         forms/landing pages post here
GET|POST|DELETE /api/calendar · /api/calendar/:id
GET    /api/notifications · POST /api/notifications/read

# Automations
GET|POST /api/automations · GET /api/automations/starters
POST   /api/automations/starters     install a starter template
PATCH|DELETE /api/automations/:id · POST /api/automations/:id/run
GET    /api/automations/:id/history  recent runs for one automation

# Xacheus Connect & Control Center
GET    /api/connectors · POST /api/connectors/config · POST /api/connectors/:id/verify
GET    /api/tools                    tool catalogue with risk + policy
GET    /api/permissions · POST /api/permissions/scopes
POST   /api/permissions/tools/:id · /api/permissions/agents/:id
GET    /api/audit
GET    /api/devices · POST /api/devices/pair · DELETE /api/devices/:id
POST   /api/devices/:id/command      fire-and-test the bridge
GET    /api/models · GET /api/models/probe · POST /api/models/select
GET    /api/stats · /api/status

# Webhooks / realtime
GET|POST /api/webhooks/whatsapp      public: verify token + HMAC signature
GET    /api/health                   public
GET    /api/config                   public: console bootstrap (no secrets)
WS     /api/events                   live console feed
WS     /api/devices/socket           Android bridge (device token)
```

---

## Repository layout

```
packages/core/                 the brain
  src/agents/                  router, planners, orchestrator, agent descriptors
  src/tools/                   79 tools: memory, business, personal, content, research, code, system, automation
  src/connectors/              meta, mail, home, cloudinary, firebase, web, custom, device
  src/memory/ knowledge/       the five memory kinds + document index
  src/security/                permission engine, audit log
  src/models/                  pluggable providers (built-in, Ollama, OpenAI-compatible, Anthropic)
  src/automation/              trigger → condition → tools → action → notification
  src/devices/                 device bridge protocol
  src/kernel/                  creates and wires everything
  test/                        kernel tests (node:test)

apps/server/                   Fastify API: routes, guard, realtime, webhooks
apps/web/                      React console: chat, dashboard, library, business, automations, connect, settings
apps/android/                  Kotlin companion app (wake word, device actions)
scripts/smoke.mjs              end-to-end verification against a real server
```

---

## Environment reference

Everything is optional. See `.env.example` for the annotated list.

| Area | Variables |
| --- | --- |
| Server | `PORT`, `HOST`, `XACHEUS_DATA_DIR`, `XACHEUS_CORS_ORIGINS`, `XACHEUS_WORKSPACE_ROOT` |
| Auth | `XACHEUS_OWNER_PASSCODE`, `XACHEUS_OWNER_EMAIL`, `XACHEUS_DEVICE_BRIDGE_TOKEN`, `FIREBASE_*` |
| Model | `XACHEUS_MODEL`, `OLLAMA_*`, `OPENAI_*`, `ANTHROPIC_*` |
| Storage | `XACHEUS_STORAGE`, `GOOGLE_APPLICATION_CREDENTIALS`, `FIREBASE_SERVICE_ACCOUNT_JSON` |
| Media | `CLOUDINARY_*` |
| Social | `FACEBOOK_*`, `INSTAGRAM_*`, `WHATSAPP_*`, `META_GRAPH_VERSION` |
| Mail | `MAIL_IMAP_*`, `MAIL_SMTP_*`, `MAIL_USER`, `MAIL_PASSWORD`, `MAIL_FROM` |
| Home | `HOME_ASSISTANT_URL`, `HOME_ASSISTANT_TOKEN`, `HOME_AREAS` |
| Research | `BRAVE_API_KEY` |

---

## Honest limitations

Things Xacheus deliberately does **not** do, and why:

- **It cannot bypass Android permissions.** No app can; anything claiming to is
  either rooted trickery or a lie. Where Android withholds a capability, Xacheus
  says so.
- **It cannot bypass a platform's rules.** Facebook/Instagram/WhatsApp actions go
  through the official APIs with credentials you own. It does not scrape behind a
  login.
- **It cannot control devices with no authorized interface.** Smart-home control
  goes through Home Assistant (or another API you configure). A device that only
  speaks an app's private protocol is out of reach — deliberately.
- **The browser wake word is best-effort.** Browsers cannot run a persistent
  listener in the background; the console's continuous mode only works while the
  tab is open and only reacts to utterances that begin with “Xacheus”. True
  always-available wake word lives in the Android app's foreground service.
- **The built-in planner is not a chatbot.** Without a model, answers are
  structured reports assembled from your real data. Ask better questions
  (“what is on today?”, “show stale leads”) and it is genuinely useful; connect a
  model for prose.
- **Mail requires two extra packages** (`imapflow`, `nodemailer`) because they are
  heavy and only needed if you use that connector.

---

## Verifying it yourself

```bash
npm test              # 12 kernel tests: permissions, confirmations, memory, automation safety, code jail
npm run smoke         # 52 end-to-end checks against a booted server, including the webhook HMAC
npm run smoke:console # mounts the built console in a DOM against a live API and checks it renders
```

The smoke run is the honest one: it asserts that unconfigured integrations report
sandbox mode, that publishing without permission is blocked with instructions,
that declining executes nothing, that an unpaired phone is never claimed to have
acted, and that unsigned webhooks are rejected.

---

## License

Private project. Add a license file before distributing.
