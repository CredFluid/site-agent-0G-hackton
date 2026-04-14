# Site Agent Pro

A production-ready browser agent that tests a website like a normal user and produces a blunt, evidence-based task output.

It uses:
- **Playwright** for browser automation and resilient user-facing locators
- **OpenAI Responses API** for agent planning and structured evaluation
- **axe-core for Playwright** for accessibility checks

## What this project does

- Opens a site in Chromium
- Executes realistic task flows from accepted tasks entered on the dashboard or passed with `--task`
- Limits itself to normal user behavior and visible-page interaction
- Uses only accepted tasks from explicit input, with no built-in fallback personas or task suites
- Can reuse a legitimate Playwright session state for authenticated or pre-verified test lanes
- Can bootstrap an authenticated session by filling signup forms, polling a real IMAP inbox for OTP or verification emails, logging in, and saving `storageState`
- Logs every step, friction point, and console error
- Runs an accessibility pass
- Produces JSON, HTML, and Markdown task outputs

## Why this design is not trash

Most “AI website reviewers” are fake-polite nonsense because they:
- let the model roam randomly
- do not log evidence
- confuse hidden DOM access with human behavior
- generate fluffy praise with no proof

This project avoids that by separating the system into:
- **task execution**
- **structured evidence capture**
- **independent evaluation**

## Quick start

1. Install dependencies

```bash
npm install
```

2. Install Chromium for Playwright

```bash
npm run browser:install
```

3. Create your environment file

```bash
cp .env.example .env
```

4. Set your API key in `.env`

```bash
OPENAI_API_KEY=your_openai_api_key_here
```

5. Run the agent against a site

```bash
npm run dev -- --url https://example.com --task "Open pricing and compare the visible plans before signup"
```

6. Start the local app

```bash
npm run dashboard
```

Then open:
- `http://localhost:4173/` for the public submission form
- `http://localhost:4173/dashboard` for the internal run dashboard

7. Check the generated artifacts in `runs/...` or use the hosted output links

## Product flow

The local app now supports the minimal AgentProbe-style loop:
- a public submission form at `/`
- one queued submission batch at a time
- 1 to 5 concurrent agent perspectives per submission
- a hosted public task output link at `/r/<token>`
- a status page at `/submissions/<submission-id>`
- dashboard-first aggregate and per-agent output inspection and downloads

Every run is task-driven now. The landing page and CLI accept the task list directly, and the agents use only those accepted tasks to decide where to go, what to click, and how the final output is scored.

For game sites, submit explicit tasks such as reading the visible how-to-play section, reaching a playable state, and playing five rounds while recording wins and losses.

## Netlify deployment

This repo now includes a Netlify-oriented runtime shape:
- a synchronous Netlify Function for `/`, `/submit`, `/dashboard`, `/submissions/<id>`, `/r/<token>`, `/outputs/<run-id>`, and `/api/runs/...`
- a Netlify Background Function for the long-running audit job
- Netlify Blobs storage for submissions and task output artifacts

Files added for that flow:
- `netlify.toml`
- `src/netlify/functions/app.ts`
- `src/netlify/functions/process-submission-background.ts`

Required Netlify environment variables:
- `OPENAI_API_KEY`
- `APP_BASE_URL` set to your production site URL

Recommended Netlify environment variables:
- `OPENAI_MODEL`
- `INTERNAL_JOB_SECRET` to restrict background job invocation

Notes:
- The Netlify runtime now uses `@sparticuz/chromium`, which is designed for Lambda-style serverless environments, instead of relying on a build-time Playwright browser download.
- Local development still uses the normal Playwright browser flow via `npm run browser:install`.
- The current run cap is 10 minutes, which fits within Netlify Background Functions' 15-minute execution window.

## CLI usage

```bash
npm run dev -- --url https://example.com --task "Open pricing and compare the visible plans before signup"
npm run dev -- --url https://example.com --task "Open pricing and compare the visible plans before signup" --headed
npm run dev -- --url https://example.com --task "Read the visible how-to-play section" --task "Play the game five times and record each win or loss"
npm run dev -- --url https://example.com --task "Check the mobile nav and reach the contact page" --mobile
npm run dev -- --url https://localhost:3000 --ignore-https-errors
npm run dev -- --url https://example.com --task "Reach the dashboard home after login" --storage-state .auth/session.json
npm run dev -- --url https://example.com --task "Reach the dashboard home after login" --storage-state .auth/session.json --save-storage-state .auth/session.json
npm run dev -- --url https://example.com --task "Reach the account dashboard and confirm billing is visible" --auth-flow --signup-url /register --login-url /login --access-url /app
npm run dev -- --url https://example.com --auth-only --signup-url /register --login-url /login --access-url /app
```

## Auth bootstrap

When you want the repo to create or verify a test account itself, use `--auth-flow`.

What it does:
- fills visible signup fields with your configured test identity
- uses the same configured email for signup and login
- polls the configured IMAP inbox for a new OTP or verification email
- submits the OTP or opens the verification link
- logs in with the same credentials
- checks a protected page if you provide `--access-url`
- saves the authenticated Playwright session to `AUTH_SESSION_STATE_PATH`, `PLAYWRIGHT_STORAGE_STATE_PATH`, or `.auth/session.json`

Example:

```bash
npm run dev -- --url https://example.com --auth-flow --signup-url /register --login-url /login --access-url /dashboard --headed
```

If you only want a reusable authenticated session file and not the task run, run:

```bash
npm run dev -- --url https://example.com --auth-only --signup-url /register --login-url /login --access-url /dashboard
```

The auth bootstrap uses IMAP mailbox access, not a browser-driven Gmail or Outlook tab. That makes the OTP and verification step much more reliable for test lanes.

## Legitimate session reuse

For sites that are only reachable after a real verified session, the runner can load a Playwright `storageState` JSON instead of trying to bypass the security layer.

Use one of these paths:
- set `PLAYWRIGHT_STORAGE_STATE_PATH=.auth/session.json` in `.env` so the CLI and local app reuse the same approved session automatically
- pass `--storage-state .auth/session.json` for a single CLI run
- pass one or more `--task "..."` flags for the exact accepted tasks on that run
- pass `--save-storage-state .auth/session.json` when you want the CLI run to persist the updated session after it finishes

Example:

```bash
npm run dev -- --url https://example.com --storage-state .auth/session.json --headed
```

This is for legitimate authenticated or pre-cleared test lanes. It does not solve CAPTCHA, MFA, or other anti-bot checks on its own.

## Dashboard usage

```bash
npm run dashboard
```

The dashboard:
- lists saved single runs and aggregate multi-agent runs from `runs/`
- shows overall scores and task-output summaries
- surfaces the per-agent breakdown for aggregate runs
- displays strengths, weaknesses, and top fixes
- lets you inspect task evidence and per-step interaction logs
- surfaces saved accessibility findings
- links to a standalone HTML output page for each run at `/outputs/<run-id>`

The public app:
- accepts a URL submission plus accepted tasks at `/`
- launches only the accepted dashboard tasks for each run
- lets you choose between 1 and 5 concurrent agent perspectives
- validates public URLs only in V1
- serves unique public task output links for 30 days at `/r/<token>`
- shows submission progress at `/submissions/<submission-id>`
- lets you download both aggregate and per-agent outputs directly from the dashboard

## Coverage tuning

Because the run now follows only accepted tasks, write the task list as focused coverage lanes instead of one giant “explore everything” instruction:
- map the main journey
- inspect discovery paths
- follow the conversion and trust path
- probe suspicious and recovery states

That improves section quality without letting early clicks consume the whole run budget.

If you want to minimize `blocked` metrics in the task outputs:
- keep `MAX_SESSION_DURATION_MS` near the 10-minute cap
- raise `NAVIGATION_TIMEOUT_MS` for slow sites before raising step counts
- reuse a legitimate `storageState` for authenticated or challenge-gated paths
- prefer QA lanes that do not trigger CAPTCHA, Cloudflare, or geo/IP blocks
- use more than one agent perspective when you want broader coverage, not just deeper repetition

## Output files

Each run produces a timestamped directory inside `runs/` with:
- `inputs.json`
- `raw-events.json`
- `task-results.json`
- `accessibility.json`
- `report.json`
- `report.html`
- `report.md`

When auth bootstrap is enabled, the same run directory also includes:
- `auth-flow.json`

The dashboard reads these same artifacts directly, so you can inspect old runs without rerunning the agent.

Submissions are also stored in `submissions/` so the local server can track queue state, public output tokens, and expiry.

Each audit is capped at 600 seconds end-to-end in V1. The runner reserves part of that wall-clock budget for evaluation and output generation so the agent does not burn the full ten minutes wandering the site and then fail to finish the accepted tasks cleanly.

## Step-by-step documentation

Read these in order:
- `docs/01-installation.md`
- `docs/02-running-your-first-audit.md`
- `docs/03-configuration.md`
- `docs/04-how-the-agent-thinks.md`
- `docs/05-extending-personas-and-tasks.md`
- `docs/06-hardening-for-production.md`

## High-level architecture

1. **Runner** launches Playwright and visits the site.
2. **Summarizer** captures visible text, actionable elements, page signals, and browser events.
3. **Planner** asks the model for the next realistic user action.
4. **Executor** performs that action with guarded locator strategies.
5. **Audit** runs axe-core checks.
6. **Evaluator** scores the site from logs and evidence only.
7. **Output writer** writes machine-readable and human-readable task outputs.

## Important constraints

- This project does **not** bypass CAPTCHA, MFA, or anti-bot controls.
- This project can reuse a real Playwright session state when you provide one through approved means.
- This project can read OTP or verification emails only when you provide legitimate IMAP inbox credentials for the same mailbox.
- This project does **not** pretend hidden elements are visible to users.
- This project does **not** claim certainty when it lacks evidence.

## Recommended rollout path

Start here:
- run it manually on desktop
- inspect logs and task outputs
- tune tasks for your product category
- add mobile runs
- add CI later

Do **not** dump it straight into CI and assume the scores mean truth. That would be lazy and dumb.
