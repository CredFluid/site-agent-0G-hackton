# Site Agent Pro

> AI-powered browser agent that executes real user tasks on any website, captures step-by-step evidence, and produces scored, actionable reports.

**Playwright** · **OpenAI / Ollama** · **axe-core** · **TypeScript** · **Zod**

---

## How It Works

```
User submits URL + tasks
        │
        ▼
┌─────────────────────────────┐
│  Chromium launches           │
│  (desktop 1440×900           │
│   or mobile 390×844)         │
└──────────┬──────────────────┘
           ▼
┌─────────────────────────────┐
│  For each task:              │
│   1. Capture page state      │
│   2. LLM plans next action   │
│   3. Playwright executes it  │
│   4. Repeat until done       │
└──────────┬──────────────────┘
           ▼
┌─────────────────────────────┐
│  Site checks:                │
│  SEO · Performance ·         │
│  Security · Accessibility ·  │
│  Mobile · Content · CRO      │
└──────────┬──────────────────┘
           ▼
┌─────────────────────────────┐
│  LLM evaluates the run       │
│  → Scored report (1-10)      │
│  → HTML / Markdown / JSON    │
│  → Click replay animation    │
└─────────────────────────────┘
```

---

## Features

- **Task-driven execution** — the agent follows only the tasks you provide, nothing more
- **Step-by-step evidence** — every click, page state, console error, and network failure is logged
- **Independent evaluation** — the LLM scores from captured evidence, not from the agent's own impressions
- **Multi-agent perspectives** — run 1–5 agents with different personas on the same site, merged into one report
- **Auth-aware** — detects login walls mid-run, fills signup forms, polls IMAP for OTP/verification emails
- **Supplemental audits** — SEO crawl, security headers, performance timings, accessibility (axe-core), CRO signals, content readability, mobile layout
- **Click replay** — animated WebP of before/after screenshots for every click
- **Dual LLM support** — OpenAI (GPT-5) for production, Ollama for local/private development
- **Three deployment modes** — CLI, web dashboard, or Netlify serverless

---

## Quick Start

### 1. Install

```bash
npm install
npm run browser:install
```

### 2. Configure

```bash
cp .env.example .env
```

Set your LLM provider in `.env`:

```bash
# Option A: OpenAI (recommended for production)
LLM_PROVIDER=openai
OPENAI_API_KEY=your_key_here

# Option B: Ollama (for local/private development)
LLM_PROVIDER=ollama
OLLAMA_MODEL=llama3.1:8b
```

### 3. Run

```bash
# Run the agent against a site
npm run dev -- --url https://example.com \
  --task "Open pricing and compare the visible plans before signup"

# Start the web dashboard
npm run dashboard
# → http://localhost:4173
```

### 4. View Results

Artifacts are saved to `runs/<run-id>/`:

| File | Contents |
|---|---|
| `report.html` | Standalone shareable report |
| `report.json` | Machine-readable scored report |
| `report.md` | Markdown report |
| `task-results.json` | Per-task step history and outcomes |
| `raw-events.json` | Every browser event, console log, and network request |
| `accessibility.json` | axe-core violation list |
| `site-checks.json` | SEO, performance, security, CRO, content, mobile checks |
| `click-replay.webp` | Animated before/after click screenshots |
| `inputs.json` | Run configuration and timing metadata |

---

## CLI Reference

```bash
# Basic single-task run
npm run dev -- --url https://example.com --task "Click the pricing tab"

# Multiple tasks
npm run dev -- --url https://example.com \
  --task "Read the visible how-to-play section" \
  --task "Play the game five times and record each win or loss"

# Mobile viewport (iPhone 13, 390×844)
npm run dev -- --url https://example.com --task "Check the mobile nav" --mobile

# Headed mode (visible browser)
npm run dev -- --url https://example.com --task "Open pricing" --headed

# Ollama for local sites
npm run dev -- --url http://127.0.0.1:3000 --task "Check the homepage CTA" \
  --llm-provider ollama --model llama3.1:8b

# Allow self-signed HTTPS certificates
npm run dev -- --url https://localhost:3000 --task "Check the homepage" --ignore-https-errors
```

> **Note:** Every CLI run requires at least one `--task` flag. Runs with no tasks are rejected.

### All CLI Options

| Flag | Description |
|---|---|
| `--url <url>` | **(Required)** Website URL to test |
| `--task <task>` | **(Required)** Task for the agent. Repeat for multiple tasks |
| `--headed` | Run browser in headed (visible) mode |
| `--mobile` | Use iPhone 13 mobile viewport |
| `--ignore-https-errors` | Allow invalid or self-signed HTTPS certificates |
| `--llm-provider <name>` | LLM provider: `openai` or `ollama` |
| `--model <name>` | Override the model name |
| `--ollama-base-url <url>` | Override the Ollama endpoint |
| `--storage-state <path>` | Load Playwright storage state JSON before the run |
| `--save-storage-state <path>` | Save Playwright storage state JSON after the run |
| `--auth-flow` | Bootstrap a test account (signup/login/OTP), then run tasks |
| `--auth-only` | Bootstrap a test account and save session — skip task run |
| `--signup-url <url>` | Signup page URL (absolute or relative) |
| `--login-url <url>` | Login page URL (absolute or relative) |
| `--access-url <url>` | Protected page URL to verify after login |

---

## Web Dashboard

```bash
npm run dashboard
```

| URL | Purpose |
|---|---|
| `http://localhost:4173/` | Public submission form — enter URL + tasks |
| `http://localhost:4173/dashboard` | Internal run dashboard — inspect all results |
| `/submissions/<id>` | Submission progress tracking |
| `/r/<token>` | Public shareable report link (valid 30 days) |
| `/outputs/<run-id>` | Standalone HTML report for any run |
| `/api/runs` | REST API — list all runs |
| `/api/runs/<id>` | REST API — run detail |

The dashboard supports:
- 1–5 concurrent agent perspectives per submission
- Aggregate and per-agent report inspection
- Artifact downloads (JSON, Markdown, HTML, WebP click replay)
- Strengths, weaknesses, and top fix recommendations

---

## Authentication

The agent can bootstrap authenticated sessions for sites that require signup/login.

### Quick Example

```bash
npm run dev -- --url https://example.com \
  --task "Reach the account dashboard and confirm billing is visible" \
  --auth-flow --signup-url /register --login-url /login --access-url /app
```

### What Auth Bootstrap Does

1. Fills visible signup fields with your configured test identity
2. Polls your IMAP inbox for OTP or verification emails
3. Submits the OTP code or opens the verification link
4. Logs in with the same credentials
5. Verifies a protected page (if `--access-url` is provided)
6. Saves the authenticated session to `.auth/session.json`

Successful auth also caches the working identity in `.auth/credentials.json`, keyed by target origin, so later runs against the same site can reuse the saved username or email plus password.

Auth walls detected mid-task are handled automatically when auth credentials are configured or a working identity has already been cached for that target origin.

### Auth-Only Mode

Save an authenticated session without running tasks:

```bash
npm run dev -- --url https://example.com --auth-only \
  --signup-url /register --login-url /login --access-url /dashboard
```

### Session Reuse

For sites behind verified sessions, load a saved Playwright storage state:

```bash
# Via CLI flag
npm run dev -- --url https://example.com --task "Reach the dashboard" \
  --storage-state .auth/session.json

# Via .env (auto-loaded on every run)
PLAYWRIGHT_STORAGE_STATE_PATH=.auth/session.json
```

> **Important:** This does not bypass CAPTCHA, MFA, or anti-bot controls. It reuses legitimate sessions you've established.

### Auth Environment Variables

**Required for a fresh auth bootstrap** (not needed when the target origin already has cached credentials):

| Variable | Description |
|---|---|
| `AUTH_TEST_EMAIL` | Email address for signup/login |
| `AUTH_TEST_PASSWORD` | Password for signup/login |

**Optional login field:**

`AUTH_TEST_USERNAME`

**IMAP inbox** (for OTP/verification email polling):

| Variable | Default | Description |
|---|---|---|
| `AUTH_IMAP_HOST` | — | IMAP server hostname |
| `AUTH_IMAP_PORT` | `993` | IMAP port |
| `AUTH_IMAP_SECURE` | `true` | Use TLS |
| `AUTH_IMAP_USER` | — | IMAP username |
| `AUTH_IMAP_PASSWORD` | — | IMAP password |
| `AUTH_IMAP_MAILBOX` | `INBOX` | Mailbox to poll |

**Optional identity fields:**

`AUTH_TEST_FIRST_NAME` · `AUTH_TEST_LAST_NAME` · `AUTH_TEST_PHONE` · `AUTH_TEST_ADDRESS_LINE1` · `AUTH_TEST_ADDRESS_LINE2` · `AUTH_TEST_CITY` · `AUTH_TEST_STATE` · `AUTH_TEST_POSTAL_CODE` · `AUTH_TEST_COUNTRY` · `AUTH_TEST_COMPANY`

**Optional tuning:**

| Variable | Default | Description |
|---|---|---|
| `AUTH_EMAIL_POLL_TIMEOUT_MS` | `180000` | Max wait time for verification email |
| `AUTH_EMAIL_POLL_INTERVAL_MS` | `5000` | Poll frequency |
| `AUTH_OTP_LENGTH` | `6` | Expected OTP digit count |
| `AUTH_EMAIL_FROM_FILTER` | — | Filter emails by sender |
| `AUTH_EMAIL_SUBJECT_FILTER` | — | Filter emails by subject |
| `AUTH_SIGNUP_URL` | — | Default signup URL (instead of CLI flag) |
| `AUTH_LOGIN_URL` | — | Default login URL |
| `AUTH_ACCESS_URL` | — | Default protected page URL |
| `AUTH_SESSION_STATE_PATH` | `.auth/session.json` | Where to save the session |

---

## Web3 Wallet Integration

The agent has built-in support for interacting with Web3 dApps. It uses a dual-mode architecture:

1. **Programmatic Provider (Default):** Injects a secure, headless-compatible `window.ethereum` provider. Transaction signing requests are intercepted and sent to a local HTTP relay running securely inside the Node.js process. The private key never enters the browser.
2. **MetaMask Extension Mode (Optional):** Runs a full headed browser with the MetaMask extension loaded, and automatically clicks "Connect", "Confirm", or "Sign" in MetaMask popups.

### Quick Setup

Configure your wallet in `.env`:

```bash
# Required
WALLET_PRIVATE_KEY=your_private_key_here
WALLET_RPC_URL=https://eth-sepolia.g.alchemy.com/v2/...
WALLET_CHAIN_ID=11155111

# Optional: Mnemonic instead of private key
# WALLET_MNEMONIC="word1 word2 ..."
```

Once configured, the agent will automatically inject the wallet into every page it visits. The LLM planner is also aware of its wallet address and can interact with "Connect Wallet" flows.

### Using MetaMask Extension Mode

If you specifically need to test how a dApp interacts with the MetaMask UI, you can run the agent with the extension loaded. This requires extracting the MetaMask extension folder (not a `.crx` file).

**How to get the Extension Path (Mac):**
1. Ensure MetaMask is installed in your normal Google Chrome browser.
2. The extracted path is typically located at:
   `/Users/<YourUsername>/Library/Application Support/Google/Chrome/Default/Extensions/nkbihfbeogaeaoehlefnkodbefgpgknn/<version_number>`
3. Set the environment variable in `.env`:
   ```bash
   WALLET_METAMASK_EXTENSION_PATH=/Users/YourUsername/Library/.../11.14.2_0
   WALLET_METAMASK_USER_DATA_DIR=/Users/YourUsername/.site-agent-metamask-profile
   ```
*Note: Using this mode forces the agent to run in headed (visible) mode. For real MetaMask signing/confirm popups, point `WALLET_METAMASK_USER_DATA_DIR` at a persistent Chromium profile where MetaMask is already set up and unlocked.*

---

## Configuration

All settings are read from environment variables (`.env` file).

### Core Settings

| Variable | Default | Description |
|---|---|---|
| `LLM_PROVIDER` | `openai` | LLM backend: `openai` or `ollama` |
| `OPENAI_API_KEY` | — | **(Required for OpenAI)** API key |
| `OPENAI_MODEL` | `gpt-5` | Model for planning and evaluation |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | Ollama server URL |
| `OLLAMA_MODEL` | `llama3.1:8b` | Ollama model name |

### Execution Limits

| Variable | Default | Description |
|---|---|---|
| `MAX_SESSION_DURATION_MS` | `600000` | Total run time cap (clamped 60s–600s) |
| `MAX_STEPS_PER_TASK` | `32` | Max actions per task |
| `ACTION_DELAY_MS` | `600` | Delay between actions (human-like pacing) |
| `NAVIGATION_TIMEOUT_MS` | `25000` | Page load timeout |

### Browser

| Variable | Default | Description |
|---|---|---|
| `HEADLESS` | `true` | Set `false` for headed mode |
| `PLAYWRIGHT_STORAGE_STATE_PATH` | — | Auto-load session state JSON |
| `PLAYWRIGHT_EXECUTABLE_PATH` | — | Custom Chromium binary path |
| `USE_SERVERLESS_CHROMIUM` | — | Force `@sparticuz/chromium` |
| `SPARTICUZ_CHROMIUM_LOCATION` | — | Chromium binary location hint |

### Dashboard & Deployment

| Variable | Default | Description |
|---|---|---|
| `APP_BASE_URL` | — | Production URL for public report links |
| `DASHBOARD_PORT` | `4173` | Dashboard server port |
| `DASHBOARD_HOST` | `127.0.0.1` | Dashboard server host |
| `REPORT_TTL_DAYS` | `30` | Public report link expiry |
| `INTERNAL_JOB_SECRET` | — | Restrict background job invocation |

---

## Writing Effective Tasks

Since the agent follows only your tasks, structure them as focused coverage lanes:

```bash
# Map the main journey
--task "Navigate to pricing and compare the monthly vs yearly plans"

# Inspect discovery paths
--task "Use the site search to find 'refund policy' and read the visible result"

# Follow the conversion path
--task "Click the Sign Up Free tab, fill every visible detail, and submit"

# Probe edge cases
--task "Enter an invalid email in the signup form and check the error message"
```

**Tips for better results:**
- Write **specific, concrete actions** — not "explore the site"
- Split large journeys into **separate tasks** so early clicks don't consume the entire budget
- For slow sites, increase `NAVIGATION_TIMEOUT_MS` before increasing step counts
- Use `--storage-state` for pages behind authentication
- Run **multiple agent perspectives** (2-5) when you want broader coverage
- For game sites, be explicit: "Play 5 rounds and record each win or loss"

---

## Netlify Deployment

This repo includes a Netlify-ready runtime:

- **Synchronous Function** (`src/netlify/functions/app.ts`) — handles all dashboard routes
- **Background Function** (`src/netlify/functions/process-submission-background.ts`) — long-running audit jobs
- **Netlify Blobs** — storage for submissions and run artifacts (auto-detected via `SITE_ID` or `URL` env vars)
- **@sparticuz/chromium** — serverless Chromium (replaces Playwright's browser download)

### Build Configuration (`netlify.toml`)

| Setting | Value |
|---|---|
| Build command | `npm run build` |
| Publish directory | `netlify-static` |
| Functions directory | `dist/netlify/functions` |
| Node version | 22 |
| External modules | `playwright`, `@sparticuz/chromium` |

### Required Environment Variables

| Variable | Description |
|---|---|
| `OPENAI_API_KEY` | OpenAI API key |
| `APP_BASE_URL` | Your production site URL |

### Optional Environment Variables

| Variable | Description |
|---|---|
| `OPENAI_MODEL` | Defaults to `gpt-5` |
| `INTERNAL_JOB_SECRET` | Restricts background job invocation via `x-agentprobe-job-secret` header |

> **Note:** Serverless mode is auto-detected via `USE_SERVERLESS_CHROMIUM=true`, `NETLIFY_LOCAL=true`, `SITE_ID`, or `URL`. The total run cap is 600 seconds, with part reserved for evaluation and report generation.

---

## Architecture

For a detailed technical breakdown of every module, see [**ARCHITECTURE.md**](ARCHITECTURE.md).

High-level summary:

| Layer | Key Files | Purpose |
|---|---|---|
| **Entry points** | `cli/run.ts`, `dashboard/server.ts`, `netlify/` | CLI, web UI, serverless |
| **Orchestration** | `runAuditJob.ts`, `processSubmissionBatch.ts` | Single-run and multi-agent execution |
| **Agent loop** | `runner.ts` → `planner.ts` → `executor.ts` | Capture state → LLM plans → Playwright acts |
| **Page understanding** | `pageState.ts`, `siteBrief.ts`, `taskDirectives.ts` | DOM snapshots, site comprehension, instruction parsing |
| **Authentication** | `auth/profile.ts`, `auth/inbox.ts`, `auth/runner.ts` | Identity management, IMAP OTP polling, login flows |
| **Evaluation** | `evaluator.ts`, `aggregateReport.ts` | LLM scoring, multi-agent result merging |
| **Site checks** | `siteChecks.ts`, `audit.ts` | SEO, performance, security, accessibility |
| **Reporting** | `reporting/html.ts`, `reporting/markdown.ts`, `clickReplay.ts` | HTML/MD/JSON reports, click replay animation |
| **LLM** | `llm/client.ts`, `prompts/browserAgent.ts`, `prompts/reviewer.ts` | OpenAI + Ollama client, system prompts |

---

## Important Constraints

- **No CAPTCHA/MFA bypass** — the agent does not solve CAPTCHAs, MFA challenges, or anti-bot controls
- **No hidden DOM access** — the agent interacts only with visible elements, like a real user
- **No unsupported claims** — the evaluator scores from evidence only, not from the agent's impressions
- **Task-required** — every run must have at least one explicit task
- **Legitimate sessions only** — storage state reuse is for approved, pre-established sessions

---

## Step-by-Step Guides

| Guide | Topic |
|---|---|
| `docs/01-installation.md` | Installation and setup |
| `docs/02-running-your-first-audit.md` | Your first run |
| `docs/03-configuration.md` | Configuration deep-dive |
| `docs/04-how-the-agent-thinks.md` | Agent planning internals |
| `docs/05-extending-personas-and-tasks.md` | Custom personas and tasks |
| `docs/06-hardening-for-production.md` | Production deployment |

---

## Recommended Rollout

1. **Start local** — run manually on desktop, inspect logs and reports
2. **Tune tasks** — write focused coverage lanes for your product
3. **Add mobile** — include `--mobile` runs
4. **Multi-agent** — use 2-5 perspectives for broader coverage
5. **CI integration** — only after you've validated the scores match your expectations

> Treat the scores as **signals, not ground truth** until you've calibrated them against your own quality bar.
