# Site Agent Pro

A production-ready browser agent that tests a website like a normal user and produces a blunt, evidence-based task output.

It uses:
- **Playwright** for browser automation and resilient user-facing locators
- **OpenAI or Ollama** for agent planning and structured evaluation
- **axe-core for Playwright** for accessibility checks
- **sharp** and **node-webpmux** for animated WebP click-replay generation
- **Netlify Blobs** for serverless artifact and submission storage
- **@sparticuz/chromium** for Lambda-style serverless Chromium execution
- **Zod** for runtime schema validation throughout

## What this project does

- Opens a site in Chromium (desktop at 1440×900 or mobile at 390×844 via iPhone 13 profile)
- Executes realistic task flows from accepted tasks entered on the dashboard or passed with `--task`
- Limits itself to normal user behavior and visible-page interaction
- Requires at least one explicit `--task` for every CLI run — there are no built-in fallback task suites
- Generates an upfront site brief before tasks begin, and refreshes it after a successful auth recovery
- Detects auth walls mid-run and can attempt automatic signup/login when auth bootstrap is configured
- Can reuse a legitimate Playwright `storageState` JSON for authenticated or pre-verified test lanes
- Can bootstrap an authenticated session by filling signup forms, polling a real IMAP inbox for OTP or verification emails, logging in, and saving `storageState`
- Logs every step, friction point, console error, page error, and failed network request
- Runs an axe-core accessibility pass on the final page state
- Runs supplemental site checks (performance timings, SEO crawl, security headers, CRO signals, content readability, mobile layout) after the task loop
- Produces JSON, HTML, Markdown, and animated WebP click-replay artifacts per run
- Supports 1–5 concurrent agent perspectives per submission, with an aggregate report across all perspectives

## Why this design is not trash

Most "AI website reviewers" are fake-polite nonsense because they:
- let the model roam randomly
- do not log evidence
- confuse hidden DOM access with human behavior
- generate fluffy praise with no proof

This project avoids that by separating the system into:
- **task execution** — the agent follows only the accepted tasks you provide
- **structured evidence capture** — every step, click, and page state is logged
- **independent evaluation** — the evaluator scores from logs and evidence only, not from the agent's own impressions

## Quick start

1. Install dependencies

```bash
npm install
```

2. Install Chromium for Playwright

```bash
npm run browser:install
```

3. Create your environment file and choose an LLM provider

```bash
cp .env.example .env
# then either:
# - keep LLM_PROVIDER=openai and set OPENAI_API_KEY=your_openai_api_key_here
# - or set LLM_PROVIDER=ollama and choose an installed OLLAMA_MODEL
```

4. Run the agent against a site

```bash
npm run dev -- --url https://example.com --task "Open pricing and compare the visible plans before signup"
```

5. Start the local app

```bash
npm run dashboard
```

Then open:
- `http://localhost:4173/` for the public submission form
- `http://localhost:4173/dashboard` for the internal run dashboard

6. Check the generated artifacts in `runs/<run-id>/`

## Product flow

The local app supports the full submission loop:
- a public submission form at `/`
- accepted tasks entered directly on the landing page (required — no tasks, no run)
- 1 to 5 concurrent agent perspectives per submission
- a hosted public task output link at `/r/<token>` (valid for 30 days)
- a status page at `/submissions/<submission-id>`
- dashboard-first aggregate and per-agent output inspection and downloads at `/dashboard`
- standalone HTML output pages at `/outputs/<run-id>`

Every run is task-driven. The landing page and CLI accept the task list directly, and the agents use only those accepted tasks to decide where to go, what to click, and how the final output is scored.

For game sites, submit explicit tasks such as reading the visible how-to-play section, reaching a playable state, and playing five rounds while recording wins and losses.

## Netlify deployment

This repo includes a Netlify-oriented runtime:
- a synchronous Netlify Function (`src/netlify/functions/app.ts`) handling `/`, `/submit`, `/dashboard`, `/submissions/:id`, `/r/:token`, `/outputs/:runId`, `/api/runs`, `/api/runs/:runId`, and `/api/runs/:runId/artifacts/:fileName`
- a Netlify Background Function (`src/netlify/functions/process-submission-background.ts`) for the long-running audit job
- Netlify Blobs storage for submissions and run artifacts (auto-selected when `SITE_ID` or `URL` env vars are present)

Build configuration (`netlify.toml`):
- build command: `npm run build`
- publish directory: `netlify-static`
- functions directory: `dist/netlify/functions`
- Node version: 22
- `playwright` and `@sparticuz/chromium` are declared as external node modules

Required Netlify environment variables:
- `OPENAI_API_KEY`
- `APP_BASE_URL` — set to your production site URL

Recommended Netlify environment variables:
- `OPENAI_MODEL` — defaults to `gpt-5`
- `INTERNAL_JOB_SECRET` — restricts background job invocation via the `x-agentprobe-job-secret` header

Notes:
- The Netlify runtime uses `@sparticuz/chromium` instead of a build-time Playwright browser download. Serverless mode is auto-detected via `USE_SERVERLESS_CHROMIUM=true`, `NETLIFY_LOCAL=true`, `SITE_ID`, or `URL`.
- You can also set `PLAYWRIGHT_EXECUTABLE_PATH` to point to a specific Chromium binary.
- Local development still uses the normal Playwright browser flow via `npm run browser:install`.
- The run cap is 600 seconds end-to-end. The runner reserves part of that wall-clock budget for evaluation and output generation.

## CLI usage

```bash
# Basic run with one task
npm run dev -- --url https://example.com --task "Open pricing and compare the visible plans before signup"

# Local Ollama run
npm run dev -- --url http://127.0.0.1:3000 --task "Open pricing and compare the visible plans before signup" --llm-provider ollama --model llama3.1:8b

# Switch back to OpenAI for internet-facing runs
npm run dev -- --url https://example.com --task "Open pricing and compare the visible plans before signup" --llm-provider openai --model gpt-5

# Headed mode
npm run dev -- --url https://example.com --task "Open pricing and compare the visible plans before signup" --headed

# Multiple tasks
npm run dev -- --url https://example.com --task "Read the visible how-to-play section" --task "Play the game five times and record each win or loss"

# Mobile viewport (390×844, iPhone 13 profile)
npm run dev -- --url https://example.com --task "Check the mobile nav and reach the contact page" --mobile

# Allow self-signed or invalid HTTPS certificates
npm run dev -- --url https://localhost:3000 --task "Check the homepage" --ignore-https-errors

# Load a saved Playwright storage state
npm run dev -- --url https://example.com --task "Reach the dashboard home after login" --storage-state .auth/session.json

# Load and save storage state after the run
npm run dev -- --url https://example.com --task "Reach the dashboard home after login" --storage-state .auth/session.json --save-storage-state .auth/session.json

# Auth bootstrap then run tasks
npm run dev -- --url https://example.com --task "Reach the account dashboard and confirm billing is visible" --auth-flow --signup-url /register --login-url /login --access-url /app

# Auth bootstrap only — save session, skip task run
npm run dev -- --url https://example.com --auth-only --signup-url /register --login-url /login --access-url /app
```

## Auth bootstrap

When you want the agent to create or verify a test account itself, use `--auth-flow`.

What it does:
- fills visible signup fields with your configured test identity (`AUTH_TEST_EMAIL`, `AUTH_TEST_PASSWORD`, etc.)
- uses the same configured email for signup and login
- polls the configured IMAP inbox for a new OTP or verification email
- submits the OTP or opens the verification link
- logs in with the same credentials
- checks a protected page if you provide `--access-url`
- saves the authenticated Playwright session to `AUTH_SESSION_STATE_PATH`, `PLAYWRIGHT_STORAGE_STATE_PATH`, or `.auth/session.json`
- writes an `auth-flow.json` artifact to the run directory

The auth bootstrap also runs automatically mid-task if `AUTH_TEST_EMAIL` and `AUTH_TEST_PASSWORD` are set and an auth wall is detected during a task run.

Example:

```bash
npm run dev -- --url https://example.com --auth-flow --signup-url /register --login-url /login --access-url /dashboard --headed
```

If you only want a reusable authenticated session file and not the task run:

```bash
npm run dev -- --url https://example.com --auth-only --signup-url /register --login-url /login --access-url /dashboard
```

The auth bootstrap uses IMAP mailbox access (`imapflow` + `mailparser`), not a browser-driven Gmail or Outlook tab. That makes the OTP and verification step much more reliable for test lanes.

Required auth environment variables (when `--auth-flow` or `--auth-only` is used):
- `AUTH_TEST_EMAIL`
- `AUTH_TEST_PASSWORD`

Optional auth environment variables:
- `AUTH_TEST_FIRST_NAME`, `AUTH_TEST_LAST_NAME`, `AUTH_TEST_PHONE`
- `AUTH_TEST_ADDRESS_LINE1`, `AUTH_TEST_ADDRESS_LINE2`, `AUTH_TEST_CITY`, `AUTH_TEST_STATE`, `AUTH_TEST_POSTAL_CODE`, `AUTH_TEST_COUNTRY`, `AUTH_TEST_COMPANY`
- `AUTH_IMAP_HOST`, `AUTH_IMAP_PORT` (default: 993), `AUTH_IMAP_SECURE` (default: true), `AUTH_IMAP_USER`, `AUTH_IMAP_PASSWORD`, `AUTH_IMAP_MAILBOX` (default: INBOX)
- `AUTH_EMAIL_POLL_TIMEOUT_MS` (default: 180000), `AUTH_EMAIL_POLL_INTERVAL_MS` (default: 5000)
- `AUTH_OTP_LENGTH` (default: 6), `AUTH_EMAIL_FROM_FILTER`, `AUTH_EMAIL_SUBJECT_FILTER`
- `AUTH_SIGNUP_URL`, `AUTH_LOGIN_URL`, `AUTH_ACCESS_URL` (can be set in `.env` instead of passing CLI flags)
- `AUTH_SESSION_STATE_PATH` — where to save the authenticated session JSON

## LLM provider switching

The agent supports both OpenAI and Ollama.

Environment variables:
- `LLM_PROVIDER` — `openai` or `ollama`
- `OPENAI_API_KEY` — required only when using `openai`
- `OPENAI_MODEL` — defaults to `gpt-5`
- `OLLAMA_BASE_URL` — defaults to `http://127.0.0.1:11434`
- `OLLAMA_MODEL` — defaults to `llama3.1:8b`

CLI overrides:
- `--llm-provider openai|ollama`
- `--model <name>`
- `--ollama-base-url <url>`

Examples:

```bash
# Use Ollama against a local site
npm run dev -- --url http://127.0.0.1:3000 --task "Check the homepage CTA" --llm-provider ollama --model llama3.1:8b

# Use OpenAI against a public site
npm run dev -- --url https://example.com --task "Open pricing" --llm-provider openai --model gpt-5
```

Notes:
- Ollama is most useful for local development and private staging pages where you do not want to depend on OpenAI.
- Netlify or other hosted environments will still need a reachable LLM endpoint. Ollama is only a good fit there if that runtime can actually reach your Ollama host.

## Legitimate session reuse

For sites that are only reachable after a real verified session, the runner can load a Playwright `storageState` JSON instead of trying to bypass the security layer.

Use one of these paths:
- set `PLAYWRIGHT_STORAGE_STATE_PATH=.auth/session.json` in `.env` so the CLI and local app reuse the same approved session automatically
- pass `--storage-state .auth/session.json` for a single CLI run
- pass `--save-storage-state .auth/session.json` when you want the CLI run to persist the updated session after it finishes

Example:

```bash
npm run dev -- --url https://example.com --task "Reach the account dashboard" --storage-state .auth/session.json --headed
```

This is for legitimate authenticated or pre-cleared test lanes. It does not solve CAPTCHA, MFA, or other anti-bot checks on its own.

## Dashboard usage

```bash
npm run dashboard
```

The dashboard server runs on `http://localhost:4173` by default. Override with `DASHBOARD_PORT` and `DASHBOARD_HOST` environment variables.

The dashboard:
- lists saved single runs and aggregate multi-agent runs from `runs/`
- shows overall scores and task-output summaries
- surfaces the per-agent breakdown for aggregate runs
- displays strengths, weaknesses, and top fixes
- lets you inspect task evidence and per-step interaction logs
- surfaces saved accessibility findings
- links to a standalone HTML output page for each run at `/outputs/<run-id>`
- serves artifact downloads (JSON, Markdown, HTML, WebP click replay) at `/api/runs/:runId/artifacts/:fileName`

The public app:
- accepts a URL submission plus accepted tasks at `/`
- requires at least one task — submissions with no tasks are rejected
- lets you choose between 1 and 5 concurrent agent perspectives
- serves unique public task output links for 30 days at `/r/<token>`
- shows submission progress at `/submissions/<submission-id>`
- lets you download both aggregate and per-agent outputs directly from the dashboard

## Configuration reference

All configuration is read from environment variables (via `.env`).

| Variable | Default | Description |
|---|---|---|
| `OPENAI_API_KEY` | required | OpenAI API key |
| `OPENAI_MODEL` | `gpt-5` | Model used for planning and evaluation |
| `APP_BASE_URL` | — | Base URL for the deployed app (used in public report links) |
| `HEADLESS` | `true` | Set to `false` to run the browser in headed mode by default |
| `MAX_SESSION_DURATION_MS` | `600000` | Total run wall-clock cap in milliseconds (clamped to 60s–600s) |
| `MAX_STEPS_PER_TASK` | `32` | Maximum steps the agent takes per task |
| `ACTION_DELAY_MS` | `600` | Delay between actions in milliseconds |
| `NAVIGATION_TIMEOUT_MS` | `25000` | Playwright navigation and action timeout |
| `REPORT_TTL_DAYS` | `30` | How long public report links remain valid |
| `PLAYWRIGHT_STORAGE_STATE_PATH` | — | Path to a Playwright storage state JSON to load automatically |
| `PLAYWRIGHT_EXECUTABLE_PATH` | — | Path to a specific Chromium binary |
| `USE_SERVERLESS_CHROMIUM` | — | Set to `true` to force `@sparticuz/chromium` |
| `SPARTICUZ_CHROMIUM_LOCATION` | — | Optional location hint for `@sparticuz/chromium` |
| `DASHBOARD_PORT` | `4173` | Port for the local dashboard server |
| `DASHBOARD_HOST` | `127.0.0.1` | Host for the local dashboard server |
| `INTERNAL_JOB_SECRET` | — | Secret for restricting background job invocation |

## Coverage tuning

Because the run follows only accepted tasks, write the task list as focused coverage lanes instead of one giant "explore everything" instruction:
- map the main journey
- inspect discovery paths
- follow the conversion and trust path
- probe suspicious and recovery states

That improves section quality without letting early clicks consume the whole run budget.

If you want to minimize `blocked` metrics in the task outputs:
- keep `MAX_SESSION_DURATION_MS` near the 600-second cap
- raise `NAVIGATION_TIMEOUT_MS` for slow sites before raising step counts
- reuse a legitimate `storageState` for authenticated or challenge-gated paths
- prefer QA lanes that do not trigger CAPTCHA, Cloudflare, or geo/IP blocks
- use more than one agent perspective when you want broader coverage, not just deeper repetition

## Output files

Each run produces a timestamped directory inside `runs/` with:
- `inputs.json` — run configuration, persona, accepted tasks, and timing metadata
- `raw-events.json` — every browser event, console log, page error, and failed request
- `task-results.json` — per-task step history and outcome
- `accessibility.json` — axe-core violation list
- `site-checks.json` — supplemental checks: performance timings, SEO crawl, security headers, CRO signals, content readability, mobile layout
- `report.json` — final scored report with strengths, weaknesses, and top fixes
- `report.html` — standalone HTML report
- `report.md` — Markdown report
- `click-replay.webp` — animated WebP of before/after screenshots for each click step (when screenshots are available)

When auth bootstrap is enabled, the same run directory also includes:
- `auth-flow.json`

Submissions are stored in `submissions/` so the local server can track queue state, public output tokens, and expiry.

The dashboard reads these same artifacts directly, so you can inspect old runs without rerunning the agent.

## High-level architecture

1. **CLI** (`src/cli/run.ts`) — parses flags, validates tasks, and calls `runAuditJob` or `runAuthFlow`.
2. **Auth runner** (`src/auth/runner.ts`) — handles signup, IMAP polling, OTP submission, login, and session save.
3. **Audit job** (`src/core/runAuditJob.ts`) — orchestrates the full run: calls `runTaskSuite`, generates the click replay, calls `evaluateRun`, and writes all artifacts.
4. **Runner** (`src/core/runner.ts`) — launches Playwright, navigates to the site, derives a site brief, loops over tasks, and calls the planner and executor for each step.
5. **Planner** (`src/core/planner.ts`) — asks the model for the next realistic user action given the current page state and task history.
6. **Executor** (`src/core/executor.ts`) — performs the decided action with guarded locator strategies and captures before/after screenshots.
7. **Page state** (`src/core/pageState.ts`) — captures visible text, actionable elements, and page signals.
8. **Site checks** (`src/core/siteChecks.ts`) — runs supplemental probes for performance, SEO, security headers, CRO, content readability, and mobile layout after the task loop.
9. **Audit** (`src/core/audit.ts`) — runs axe-core accessibility checks.
10. **Evaluator** (`src/core/evaluator.ts`) — scores the site from task results, raw events, and accessibility findings using the OpenAI structured output API.
11. **Click replay** (`src/reporting/clickReplay.ts`) — assembles before/after screenshots into an annotated animated WebP using `sharp` and `node-webpmux`.
12. **Output writers** (`src/reporting/html.ts`, `src/reporting/markdown.ts`) — render machine-readable and human-readable task outputs.
13. **Aggregate report** (`src/core/aggregateReport.ts`) — merges results from multiple agent perspectives into a single scored report.
14. **Submission batch** (`src/core/processSubmissionBatch.ts`) — runs 1–5 agent variants in parallel and produces the aggregate.
15. **Dashboard server** (`src/dashboard/server.ts`) — local HTTP server serving the submission form, status pages, dashboard UI, and artifact downloads.
16. **Netlify app** (`src/netlify/app.ts`) — Netlify Function handler for the same routes.
17. **Storage** (`src/netlify/storage.ts`) — dual-mode storage layer: local filesystem for development, Netlify Blobs for production.

## Important constraints

- This project does **not** bypass CAPTCHA, MFA, or anti-bot controls.
- This project can reuse a real Playwright session state when you provide one through approved means.
- This project can read OTP or verification emails only when you provide legitimate IMAP inbox credentials for the same mailbox.
- This project does **not** pretend hidden elements are visible to users.
- This project does **not** claim certainty when it lacks evidence.
- Every CLI run requires at least one `--task` flag. Runs with no tasks are rejected.

## Step-by-step documentation

Read these in order:
- `docs/01-installation.md`
- `docs/02-running-your-first-audit.md`
- `docs/03-configuration.md`
- `docs/04-how-the-agent-thinks.md`
- `docs/05-extending-personas-and-tasks.md`
- `docs/06-hardening-for-production.md`

## Recommended rollout path

Start here:
- run it manually on desktop
- inspect logs and task outputs
- tune tasks for your product category
- add mobile runs
- add CI later

Do **not** dump it straight into CI and assume the scores mean truth. That would be lazy and dumb.
