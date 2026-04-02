import { config } from "../config.js";
import { isExpired } from "./model.js";
import type { Submission } from "./types.js";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatDateTime(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: config.deviceTimezone
  }).format(parsed);
}

function basePage(args: { body: string; title: string }): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(args.title)}</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f5eddf;
        --ink: #1d1915;
        --muted: #6b625a;
        --line: rgba(74, 57, 34, 0.14);
        --card: rgba(255, 251, 244, 0.94);
        --accent: #b85e33;
        --teal: #176f69;
        --gold: #a96f14;
        --red: #b42318;
        --shadow: 0 24px 70px rgba(72, 47, 14, 0.14);
      }

      * { box-sizing: border-box; }
      html, body { margin: 0; min-height: 100%; }
      body {
        font-family: "Avenir Next", "Trebuchet MS", sans-serif;
        color: var(--ink);
        background:
          radial-gradient(circle at top left, rgba(184, 94, 51, 0.18), transparent 28%),
          radial-gradient(circle at top right, rgba(23, 111, 105, 0.15), transparent 30%),
          linear-gradient(180deg, #fbf7f0 0%, var(--bg) 52%, #eadfc9 100%);
      }

      .page {
        width: min(920px, calc(100vw - 2rem));
        margin: 0 auto;
        padding: 1rem 0 2.5rem;
      }

      .card {
        background: var(--card);
        border: 1px solid var(--line);
        border-radius: 28px;
        box-shadow: var(--shadow);
        padding: 1.4rem;
        margin-top: 1rem;
      }

      .eyebrow {
        margin: 0 0 0.45rem;
        color: var(--accent);
        font-size: 0.78rem;
        font-weight: 700;
        letter-spacing: 0.18em;
        text-transform: uppercase;
      }

      h1, h2 {
        margin: 0;
        font-family: "Iowan Old Style", "Palatino Linotype", Georgia, serif;
        letter-spacing: -0.04em;
      }

      h1 { font-size: clamp(2.2rem, 5vw, 4rem); line-height: 0.95; }
      h2 { font-size: clamp(1.6rem, 4vw, 2.5rem); line-height: 0.98; }

      p, li, label {
        color: var(--muted);
        line-height: 1.6;
      }

      form {
        display: grid;
        gap: 1rem;
        margin-top: 1rem;
      }

      input, button {
        width: 100%;
        border-radius: 18px;
        border: 1px solid var(--line);
        padding: 0.92rem 1rem;
        font: inherit;
      }

      input {
        background: rgba(255, 255, 255, 0.9);
      }

      button, .button-link {
        display: inline-flex;
        justify-content: center;
        align-items: center;
        gap: 0.5rem;
        background: linear-gradient(135deg, var(--accent), #d8773f);
        color: white;
        text-decoration: none;
        font-weight: 700;
        cursor: pointer;
      }

      .meta {
        display: flex;
        flex-wrap: wrap;
        gap: 0.55rem;
        margin-top: 1rem;
      }

      .meta span {
        display: inline-flex;
        align-items: center;
        padding: 0.38rem 0.72rem;
        border-radius: 999px;
        background: rgba(29, 25, 21, 0.05);
        font-size: 0.84rem;
      }

      .status {
        display: inline-flex;
        align-items: center;
        padding: 0.4rem 0.78rem;
        border-radius: 999px;
        font-size: 0.82rem;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.06em;
      }

      .status--queued, .status--running { color: var(--gold); background: rgba(169, 111, 20, 0.12); }
      .status--completed { color: var(--teal); background: rgba(23, 111, 105, 0.12); }
      .status--failed { color: var(--red); background: rgba(180, 35, 24, 0.12); }

      .error {
        margin-top: 1rem;
        padding: 1rem;
        border-radius: 18px;
        border: 1px dashed rgba(180, 35, 24, 0.35);
        background: rgba(180, 35, 24, 0.08);
        color: var(--red);
      }

      .link-row {
        display: flex;
        flex-wrap: wrap;
        gap: 0.75rem;
        margin-top: 1rem;
      }

      .ghost-link {
        display: inline-flex;
        align-items: center;
        padding: 0.82rem 1rem;
        border-radius: 18px;
        border: 1px solid var(--line);
        background: rgba(255, 255, 255, 0.72);
        text-decoration: none;
        color: var(--ink);
        font-weight: 700;
      }
    </style>
  </head>
  <body>
    ${args.body}
  </body>
</html>`;
}

export function renderLandingPage(args: {
  error?: string | null;
  submittedUrl?: string;
  selectedMode?: "generic" | "structured";
}): string {
  const selectedMode = args.selectedMode ?? "generic";

  return basePage({
    title: "AgentProbe",
    body: `
      <main class="page">
        <section class="card">
          <p class="eyebrow">AgentProbe V1</p>
          <h1>Synthetic user testing for public web apps</h1>
          <p>Submit a public URL. A single AI agent visits the site like a first-time user, explores it for up to 10 minutes, and saves a report you can review and download from the dashboard.</p>
          <div class="meta">
            <span>One agent</span>
            <span>One session</span>
            <span>One report</span>
            <span>Public URLs only</span>
            <span>Dashboard downloads</span>
          </div>
          ${args.error ? `<div class="error">${escapeHtml(args.error)}</div>` : ""}
          <form method="post" action="/submit">
            <label>
              Public URL
              <input type="url" name="url" placeholder="https://example.com" required value="${escapeHtml(args.submittedUrl ?? "")}" />
            </label>
            <label>
              Run mode
              <select name="mode">
                <option value="generic" ${selectedMode === "generic" ? "selected" : ""}>Generic walkthrough</option>
                <option value="structured" ${selectedMode === "structured" ? "selected" : ""}>Structured navigation checklist</option>
              </select>
            </label>
            <button type="submit">Run test</button>
          </form>
          <div class="link-row">
            <a class="ghost-link" href="/dashboard">Open dashboard</a>
          </div>
        </section>
      </main>
    `
  });
}

export function renderSubmissionStatusPage(args: { appBaseUrl: string; submission: Submission }): string {
  const { submission } = args;
  const reportUrl = `${args.appBaseUrl}${submission.publicReportPath}`;
  const dashboardRunUrl = submission.runId ? `/dashboard?run=${encodeURIComponent(submission.runId)}` : "/dashboard";
  const htmlDownloadUrl = submission.runId ? `/api/runs/${encodeURIComponent(submission.runId)}/artifacts/report.html` : null;
  const jsonDownloadUrl = submission.runId ? `/api/runs/${encodeURIComponent(submission.runId)}/artifacts/report.json` : null;
  const shouldRefresh = submission.status === "queued" || submission.status === "running";

  return basePage({
    title: "AgentProbe submission",
    body: `
      <main class="page">
        <section class="card">
          <p class="eyebrow">Submission status</p>
          <h1>Your test is ${escapeHtml(submission.status)}</h1>
          <p>This page refreshes while the run is active. Once it finishes, open the saved run in the dashboard or download the report directly.</p>
          <div class="meta">
            <span class="status status--${escapeHtml(submission.status)}">${escapeHtml(submission.status)}</span>
            <span>${escapeHtml(submission.url)}</span>
            <span>Expires ${escapeHtml(formatDateTime(submission.expiresAt))}</span>
            <span>${escapeHtml(config.deviceTimezone)}</span>
          </div>
          ${
            submission.status === "completed"
              ? `
                <div class="link-row">
                  <a class="button-link" href="${escapeHtml(dashboardRunUrl)}">Open in dashboard</a>
                  <a class="ghost-link" href="/reports/${escapeHtml(submission.runId ?? "")}">Open standalone report</a>
                  ${htmlDownloadUrl ? `<a class="ghost-link" href="${escapeHtml(htmlDownloadUrl)}">Download HTML report</a>` : ""}
                  ${jsonDownloadUrl ? `<a class="ghost-link" href="${escapeHtml(jsonDownloadUrl)}">Download JSON report</a>` : ""}
                  <a class="ghost-link" href="${escapeHtml(reportUrl)}">Open public report</a>
                </div>
              `
              : ""
          }
          ${
            submission.status === "failed" && submission.error
              ? `<div class="error">${escapeHtml(submission.error)}</div>`
              : ""
          }
        </section>
      </main>
      ${
        shouldRefresh
          ? `<script>setTimeout(() => window.location.reload(), 7000);</script>`
          : ""
      }
    `
  });
}

export function renderReportUnavailablePage(args: { title: string; message: string }): string {
  return basePage({
    title: args.title,
    body: `
      <main class="page">
        <section class="card">
          <p class="eyebrow">AgentProbe report</p>
          <h1>${escapeHtml(args.title)}</h1>
          <p>${escapeHtml(args.message)}</p>
        </section>
      </main>
    `
  });
}

export function renderExpiredReportPage(submission: Submission): string {
  return renderReportUnavailablePage({
    title: "This report link has expired",
    message: `Reports are available for 30 days. This link for ${submission.url} expired on ${formatDateTime(submission.expiresAt)} (${config.deviceTimezone}).`
  });
}

export function canAccessPublicReport(submission: Submission): { allowed: boolean; reason?: string } {
  if (submission.status !== "completed" || !submission.runId) {
    return { allowed: false, reason: "This report is not ready yet." };
  }

  if (isExpired(submission.expiresAt)) {
    return { allowed: false, reason: "This report link has expired." };
  }

  return { allowed: true };
}
