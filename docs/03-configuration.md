# 03 - Configuration

## Environment variables

### `OPENAI_API_KEY`
Required. Your API key.

### `OPENAI_MODEL`
Default: `gpt-5`

Change this if you want a different compatible model.

### `APP_BASE_URL`
Default: `http://localhost:4173`

Used when building hosted report links.

### `HEADLESS`
Default: `true`

Set to `false` if you want the browser visible by default.

### `MAX_SESSION_DURATION_MS`
Default: `600000`

Caps a single audit at 10 minutes in V1.
The code enforces a hard ceiling of 600 seconds even if you set a larger value.

### `MAX_STEPS_PER_TASK`
Default: `10`

Raise this only when tasks genuinely require longer flows. Bigger numbers can make the agent wander.

### `ACTION_DELAY_MS`
Default: `600`

Extra delay between actions. Useful when sites animate heavily.

### `NAVIGATION_TIMEOUT_MS`
Default: `25000`

Increase this for painfully slow sites.

### `REPORT_TTL_DAYS`
Default: `30`

Hosted public report links expire after this many days.

### `DASHBOARD_PORT`
Default: `4173`

Port used by the local app server.

### `DASHBOARD_HOST`
Default: `127.0.0.1`

Host binding used by the local app server.

## CLI flags

### `--url`
Required website URL.

### `--task`
Path to a task file.

Example:

```bash
npm run dev -- --url https://example.com --task src/tasks/first_time_buyer.json
```

### `--generic`
Runs a generic first-time walkthrough instead of the structured task suite.

Example:

```bash
npm run dev -- --url https://example.com --generic
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

## Local app routes

After running `npm run dashboard`:
- `/` is the public submission form
- `/dashboard` is the internal run dashboard
- `/submissions/<id>` is the submission status page
- `/r/<token>` is the public report link
