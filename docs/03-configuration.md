# 03 - Configuration

## Environment variables

### `OPENAI_API_KEY`
Required. Your API key.

### `OPENAI_MODEL`
Default: `gpt-5`

Change this if you want a different compatible model.

### `APP_BASE_URL`
Default: `http://localhost:4173`

Used when building hosted task-output links.

### `HEADLESS`
Default: `true`

Set to `false` if you want the browser visible by default.

### `MAX_SESSION_DURATION_MS`
Default: `600000`

Caps a single audit at 10 minutes in V1.
The code enforces a hard ceiling of 600 seconds even if you set a larger value.

### `MAX_STEPS_PER_TASK`
Default: `32`

The default now leans toward a forensic investigation across multiple focused coverage lanes instead of one vague exploration pass.
The runner also preserves time for later tasks and supplemental site checks, so increasing this does not guarantee more useful coverage.
Raise this only when tasks genuinely require even longer flows. Bigger numbers can still make the agent wander if the site has poor signals.

### `ACTION_DELAY_MS`
Default: `600`

Extra delay between actions. Useful when sites animate heavily.

### `NAVIGATION_TIMEOUT_MS`
Default: `25000`

Increase this for painfully slow sites.
This timeout also affects the supplemental site probes that power performance, SEO, security, mobile, and content coverage.

### `REPORT_TTL_DAYS`
Default: `30`

Hosted public task-output links expire after this many days.

### `PLAYWRIGHT_STORAGE_STATE_PATH`
Default: unset

Optional path to a Playwright `storageState` JSON file.
Use this when your approved test lane already has a legitimate verified or authenticated session and you want the CLI or local app to reuse it automatically.

## Coverage playbook

If you want the fewest possible `blocked` metrics:

- Prefer sites or QA lanes that are reachable without CAPTCHA, Cloudflare challenges, or geo/IP throttling.
- Reuse a legitimate session with `PLAYWRIGHT_STORAGE_STATE_PATH` or `--storage-state` when important paths sit behind login or verification.
- Raise `NAVIGATION_TIMEOUT_MS` for slow sites before raising `MAX_STEPS_PER_TASK`.
- Keep `MAX_SESSION_DURATION_MS` near the 10-minute ceiling for deeper task runs.
- Use multiple agent perspectives in the submission form when you want broader behavioral coverage, not just deeper repetition from one agent.

### `DASHBOARD_PORT`
Default: `4173`

Port used by the local app server.

### `DASHBOARD_HOST`
Default: `127.0.0.1`

Host binding used by the local app server.

## Auth bootstrap variables

These are only needed when you use `--auth-flow` or `--auth-only`.

### `AUTH_TEST_EMAIL`
Required for auth bootstrap.

The base mailbox address the runner uses for signup and login.
On the first signup attempt it uses this exact address.
If the site says the account already exists, the runner now retries with fresh plus-address aliases such as `name+siteagent-...@domain.com` so it can keep registering without manual edits.

### `AUTH_TEST_PASSWORD`
Required for auth bootstrap.

The password the runner uses for both signup and login.

### `AUTH_TEST_FIRST_NAME` through `AUTH_TEST_COMPANY`
Defaults are provided in `.env.example`.

These values are used to fill visible signup fields such as name, phone, address, city, state, postal code, country, and company.
When the runner has to retry signup with a fresh identity, it also adds small numeric variations to these details so sites that enforce uniqueness beyond email are less likely to reject the retry.

### `AUTH_IMAP_HOST`, `AUTH_IMAP_PORT`, `AUTH_IMAP_SECURE`, `AUTH_IMAP_USER`, `AUTH_IMAP_PASSWORD`, `AUTH_IMAP_MAILBOX`

Configure the real inbox the runner should poll for OTP or verification emails.
The auth bootstrap uses IMAP mailbox access, not a browser-driven webmail tab.

### `AUTH_EMAIL_POLL_TIMEOUT_MS`
Default: `180000`

How long to wait for the verification email before failing the auth bootstrap.

### `AUTH_EMAIL_POLL_INTERVAL_MS`
Default: `5000`

How frequently to poll the inbox for a new message.

### `AUTH_OTP_LENGTH`
Default: `6`

Expected OTP length for numeric code extraction.

### `AUTH_EMAIL_FROM_FILTER`
Optional.

Use this when the mailbox receives lots of unrelated email and you want to constrain matching to a specific sender.

### `AUTH_EMAIL_SUBJECT_FILTER`
Optional.

Use this when the mailbox receives lots of unrelated email and you want to constrain matching to a specific subject fragment.

### `AUTH_GENERATED_IDENTITY_MAX_ATTEMPTS`
Default: `5`

How many signup identities the runner should try before giving up when the site keeps reporting that the account already exists.

### `AUTH_SIGNUP_URL`, `AUTH_LOGIN_URL`, `AUTH_ACCESS_URL`
Optional.

Default auth flow URLs used by the CLI when you do not pass `--signup-url`, `--login-url`, or `--access-url`.

If auth credentials are configured and a normal task run lands on a real login or registration wall, the runner can also attempt an automatic in-session signup/login recovery using the current blocked page as the protected destination to re-open.

### `AUTH_SESSION_STATE_PATH`
Default: `.auth/session.json`

Where the authenticated Playwright session is saved if you do not explicitly pass `--save-storage-state`.

## CLI flags

### `--url`
Required website URL.

### `--task`
Required for task runs. Repeat it for each accepted task you want the agent to perform.

Example:

```bash
npm run dev -- --url https://example.com --task "Open pricing and compare the visible plans" --task "Reach the signup page without creating an account"
```

### `--headed`
Shows the browser.

### `--mobile`
Uses a mobile browser profile.

### `--ignore-https-errors`
Allows invalid or self-signed HTTPS certificates.

Useful for local development sites such as:

```bash
npm run dev -- --url https://localhost:3000 --ignore-https-errors
```

### `--storage-state`
Loads a Playwright `storageState` JSON file for a single run.

Example:

```bash
npm run dev -- --url https://example.com --storage-state .auth/session.json
```

### `--save-storage-state`
Saves the Playwright `storageState` JSON after the run finishes.

Example:

```bash
npm run dev -- --url https://example.com --storage-state .auth/session.json --save-storage-state .auth/session.json
```

### `--auth-flow`
Runs the auth bootstrap first, then continues the accepted task run with the authenticated session.

Example:

```bash
npm run dev -- --url https://example.com --auth-flow --signup-url /register --login-url /login --access-url /app
```

### `--auth-only`
Runs only the auth bootstrap and saves the authenticated session without generating a task output.

### `--signup-url`
Optional absolute or relative signup URL for auth bootstrap.

### `--login-url`
Optional absolute or relative login URL for auth bootstrap.

### `--access-url`
Optional absolute or relative protected URL used to confirm the session can reach authenticated content after login.

## Local app routes

After running `npm run dashboard`:
- `/` is the public submission form
- `/dashboard` is the internal run dashboard
- `/submissions/<id>` is the submission status page
- `/r/<token>` is the public task-output link
- `/outputs/<run-id>` is the standalone HTML output route
