# Site Agent Pro

A production-ready browser agent that tests a website like a normal user and produces a blunt, evidence-based review.

It uses:
- **Playwright** for browser automation and resilient user-facing locators
- **OpenAI Responses API** for agent planning and structured evaluation
- **axe-core for Playwright** for accessibility checks

## What this project does

- Opens a site in Chromium
- Executes realistic task flows from a persona file
- Limits itself to normal user behavior and visible-page interaction
- Logs every step, friction point, and console error
- Runs an accessibility pass
- Produces JSON and Markdown reports

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
npm run dev -- --url https://example.com
```

6. Start the local app

```bash
npm run dashboard
```

Then open:
- `http://localhost:4173/` for the public submission form
- `http://localhost:4173/dashboard` for the internal run dashboard

7. Check the generated artifacts in `runs/...` or use the hosted report links

## Product flow

The local app now supports the minimal AgentProbe-style loop:
- a public submission form at `/`
- one queued submission batch at a time
- 1 to 5 concurrent agent perspectives per submission
- a hosted public report link at `/r/<token>`
- a status page at `/submissions/<submission-id>`
- dashboard-first aggregate and per-agent report review and downloads

## Netlify deployment

This repo now includes a Netlify-oriented runtime shape:
- a synchronous Netlify Function for `/`, `/submit`, `/dashboard`, `/submissions/<id>`, `/r/<token>`, `/reports/<run-id>`, and `/api/runs/...`
- a Netlify Background Function for the long-running audit job
- Netlify Blobs storage for submissions and report artifacts

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
npm run dev -- --url https://example.com
npm run dev -- --url https://example.com --task src/tasks/first_time_buyer.json
npm run dev -- --url https://example.com --generic
npm run dev -- --url https://example.com --headed
npm run dev -- --url https://example.com --mobile
npm run dev -- --url https://localhost:3000 --ignore-https-errors
```

## Dashboard usage

```bash
npm run dashboard
```

The dashboard:
- lists saved single runs and aggregate multi-agent runs from `runs/`
- shows overall scores and report summaries
- surfaces the per-agent breakdown for aggregate runs
- displays strengths, weaknesses, and top fixes
- lets you inspect task evidence and per-step interaction logs
- surfaces saved accessibility findings
- links to a standalone HTML report page for each run at `/reports/<run-id>`

The public app:
- accepts a URL submission at `/`
- defaults to a generic walkthrough run mode, with a structured checklist option
- lets you choose between 1 and 5 concurrent agent perspectives
- validates public URLs only in V1
- serves unique public report links for 30 days at `/r/<token>`
- shows submission progress at `/submissions/<submission-id>`
- lets you download both aggregate and per-agent reports directly from the dashboard

## Output files

Each run produces a timestamped directory inside `runs/` with:
- `inputs.json`
- `raw-events.json`
- `task-results.json`
- `accessibility.json`
- `report.json`
- `report.html`
- `report.md`

The dashboard reads these same artifacts directly, so you can inspect old runs without rerunning the agent.

Submissions are also stored in `submissions/` so the local server can track queue state, report tokens, and expiry.

Each audit is capped at 600 seconds end-to-end in V1. The runner reserves part of that wall-clock budget for evaluation and report generation so the agent does not burn the full ten minutes wandering the site and then fail to finish the review.

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
7. **Reporter** writes machine-readable and human-readable reports.

## Important constraints

- This project does **not** bypass CAPTCHA, MFA, or anti-bot controls.
- This project does **not** pretend hidden elements are visible to users.
- This project does **not** claim certainty when it lacks evidence.

## Recommended rollout path

Start here:
- run it manually on desktop
- review logs and reports
- tune tasks for your product category
- add mobile runs
- add CI later

Do **not** dump it straight into CI and assume the scores mean truth. That would be lazy and dumb.
