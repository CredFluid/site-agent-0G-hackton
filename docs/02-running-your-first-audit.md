# 02 - Running Your First Audit

## 1. Start with a simple public site

```bash
npm run dev -- --url https://example.com
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

## 5. Read the report correctly

Do not treat the overall score as objective truth.
Use the report to answer:
- what users could do
- where they got stuck
- what broke trust
- what to fix first

## 6. Use the hosted report flow

When you run the local app server:
- submit a public URL from `/`
- check status at `/submissions/<submission-id>`
- open the unique public report link at `/r/<token>`
- download the finished report from `/dashboard`
