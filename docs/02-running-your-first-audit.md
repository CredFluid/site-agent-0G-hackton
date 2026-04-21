# 02 - Running Your First Task Run

## 1. Start with a simple public site

```bash
npm run dev -- --url https://example.com --task "Open pricing and compare the visible plans before signup"
```

This creates a new run directory in `runs/`.
If you want the full local product flow, start the app with `npm run dashboard` and submit the URL through `http://localhost:4173/`.

## 2. Inspect the output

You should see:
- `inputs.json`
- `raw-events.json`
- `task-results.json`
- `accessibility.json`
- `report.json`
- `report.html`
- `report.md`

## 3. Run in a visible browser

Use this while debugging interaction issues:

```bash
npm run dev -- --url https://example.com --headed
```

## 4. Run as a mobile user

```bash
npm run dev -- --url https://example.com --mobile
```

## 5. Bootstrap an authenticated session

When the site requires signup, email verification, OTP, or login before the important content is visible, use the auth bootstrap first:

```bash
npm run dev -- --url https://example.com --auth-flow --signup-url /register --login-url /login --access-url /dashboard --headed
```

If you only want the authenticated Playwright session file and not the task run:

```bash
npm run dev -- --url https://example.com --auth-only --signup-url /register --login-url /login --access-url /dashboard
```

This writes `auth-flow.json` into the run directory and saves the authenticated `storageState` so future runs can reuse it directly.
It also caches the working username or email plus password in `.auth/credentials.json` for that target origin, so later runs can reuse the same login details automatically.

If auth credentials are configured, or the site already has a cached working identity for that origin, a normal task run can also recover mid-session now: when the agent hits a real login or registration wall, it can attempt signup/login in the same browser session and retry with fresh dummy details if the site says the account already exists.

## 6. Read the task output correctly

Do not treat the overall score as objective truth.
Use the output to answer:
- what users could do
- where they got stuck
- what broke trust
- what to fix first

## 7. Use the hosted output flow

When you run the local app server:
- submit a public URL from `/`
- check status at `/submissions/<submission-id>`
- open the unique public task-output link at `/r/<token>`
- download the finished output from `/dashboard`
