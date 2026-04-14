import { config } from "../config.js";
import { DASHBOARD_HEAD_TAGS } from "../dashboard/theme.js";
import { isExpired } from "./model.js";
import { DEFAULT_SUBMISSION_TARGET_MODE, type SubmissionTargetMode } from "./publicUrl.js";
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
    ${DASHBOARD_HEAD_TAGS}
    <style>
      :root {
        color-scheme: dark;
        --bg: #0c0c10;
        --surface: #13131a;
        --surface2: #1a1a24;
        --ink: #e8e8f0;
        --muted: #87879b;
        --line: rgba(255, 255, 255, 0.09);
        --card: rgba(19, 19, 26, 0.96);
        --accent: #00d4aa;
        --teal: #00d4aa;
        --gold: #f5a623;
        --red: #ff5555;
        --blue: #4d9fff;
        --shadow: 0 28px 90px rgba(0, 0, 0, 0.34);
        --font-sans: "Syne", sans-serif;
        --font-mono: "IBM Plex Mono", monospace;
      }

      * { box-sizing: border-box; }
      html, body { margin: 0; min-height: 100%; }
      body {
        font-family: var(--font-sans);
        color: var(--ink);
        background:
          radial-gradient(circle at top left, rgba(0, 212, 170, 0.09), transparent 26%),
          radial-gradient(circle at top right, rgba(77, 159, 255, 0.08), transparent 30%),
          linear-gradient(180deg, #0c0c10 0%, #101018 100%);
      }

      .page {
        width: min(1040px, calc(100vw - 2rem));
        margin: 0 auto;
        padding: 1rem 0 2.5rem;
      }

      .landing-shell {
        width: min(1040px, calc(100vw - 2rem));
        margin: 0 auto;
        padding: 0.8rem 0 2.6rem;
      }

      .card {
        background: var(--card);
        border: 1px solid var(--line);
        border-radius: 24px;
        box-shadow: var(--shadow);
        padding: 1.4rem;
        margin-top: 1rem;
        backdrop-filter: blur(14px);
      }

      .landing-shell .card {
        margin-top: 0;
      }

      .eyebrow {
        margin: 0 0 0.45rem;
        color: var(--accent);
        font-size: 0.72rem;
        font-weight: 700;
        letter-spacing: 0.18em;
        text-transform: uppercase;
        font-family: var(--font-mono);
      }

      h1, h2 {
        margin: 0;
        letter-spacing: -0.03em;
      }

      h1 { font-size: clamp(2.15rem, 4vw, 3.55rem); line-height: 0.98; }
      h2 { font-size: clamp(1.45rem, 3vw, 2.1rem); line-height: 1; }

      p, li, label {
        color: var(--muted);
        line-height: 1.6;
      }

      label {
        display: grid;
        gap: 0.5rem;
      }

      form {
        display: grid;
        gap: 1rem;
      }

      input, button, select, textarea {
        width: 100%;
        border-radius: 12px;
        border: 1px solid var(--line);
        padding: 0.92rem 1rem;
        font: inherit;
      }

      input, select, textarea {
        background: var(--surface2);
        color: var(--ink);
      }

      textarea {
        min-height: 4.25rem;
        resize: vertical;
      }

      button, .button-link {
        display: inline-flex;
        justify-content: center;
        align-items: center;
        gap: 0.5rem;
        background: linear-gradient(135deg, var(--accent), #2ae0bf);
        color: #0c0c10;
        text-decoration: none;
        font-weight: 700;
        cursor: pointer;
      }

      .hero-card {
        padding: clamp(1.35rem, 2vw, 1.85rem);
        display: grid;
        gap: 1.3rem;
      }

      .hero-top {
        display: grid;
        grid-template-columns: minmax(0, 1.1fr) minmax(320px, 0.9fr);
        gap: 1.25rem;
        align-items: start;
      }

      .hero-copy {
        max-width: 34rem;
        display: grid;
        gap: 0.9rem;
      }

      .hero-card .meta,
      .hero-card .hero-grid {
        margin-top: 0;
      }

      .lead {
        margin-top: 0;
        font-size: 0.98rem;
        max-width: 34rem;
      }

      .hero-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 0.9rem;
        margin-top: 0.15rem;
      }

      .hero-stat {
        border: 1px solid var(--line);
        border-radius: 16px;
        padding: 1rem 1.05rem;
        background: rgba(255, 255, 255, 0.025);
      }

      .hero-stat strong {
        display: block;
        color: var(--ink);
        font-size: 1.15rem;
        margin-bottom: 0.28rem;
      }

      .hero-stat span {
        color: var(--muted);
        font-size: 0.9rem;
      }

      .launch-panel {
        padding: 1.25rem;
        border: 1px solid var(--line);
        border-radius: 20px;
        background:
          linear-gradient(180deg, rgba(255, 255, 255, 0.05), rgba(255, 255, 255, 0.02)),
          rgba(8, 8, 14, 0.24);
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
      }

      .card-title {
        font-family: var(--font-mono);
        font-size: 0.78rem;
        text-transform: uppercase;
        letter-spacing: 0.12em;
        color: var(--muted);
        margin-bottom: 0.85rem;
      }

      .url-row {
        display: flex;
        gap: 0.75rem;
        align-items: stretch;
      }

      .target-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 0.75rem;
      }

      .target-option {
        position: relative;
        display: block;
        cursor: pointer;
      }

      .target-option input {
        position: absolute;
        opacity: 0;
        pointer-events: none;
      }

      .target-option-body {
        height: 100%;
        display: grid;
        gap: 0.35rem;
        padding: 0.92rem 1rem;
        border: 1px solid var(--line);
        border-radius: 16px;
        background: rgba(255, 255, 255, 0.03);
        transition: transform 180ms ease, border-color 180ms ease, background 180ms ease;
      }

      .target-option:hover .target-option-body,
      .target-option:focus-within .target-option-body {
        transform: translateY(-1px);
        border-color: rgba(77, 159, 255, 0.28);
      }

      .target-option input:checked + .target-option-body {
        border-color: rgba(0, 212, 170, 0.34);
        background: rgba(0, 212, 170, 0.08);
        box-shadow: inset 0 0 0 1px rgba(0, 212, 170, 0.12);
      }

      .target-option-body strong {
        color: var(--ink);
        font-size: 0.94rem;
      }

      .target-option-body small {
        color: var(--muted);
        line-height: 1.5;
        font-size: 0.82rem;
      }

      .url-input {
        flex: 1 1 auto;
        font-family: var(--font-mono);
      }

      .url-row button {
        width: auto;
        min-width: 210px;
        white-space: nowrap;
      }

      .config-row {
        display: flex;
        flex-wrap: wrap;
        gap: 0.75rem;
        align-items: center;
      }

      .config-select {
        width: auto;
        min-width: 130px;
        font-family: var(--font-mono);
        font-size: 0.88rem;
        padding: 0.72rem 0.9rem;
      }

      .tag {
        display: inline-flex;
        align-items: center;
        border: 1px solid var(--line);
        border-radius: 999px;
        padding: 0.36rem 0.7rem;
        font-family: var(--font-mono);
        font-size: 0.72rem;
        color: var(--muted);
        background: rgba(255, 255, 255, 0.03);
      }

      .tag.on {
        color: var(--accent);
        border-color: rgba(0, 212, 170, 0.32);
        background: rgba(0, 212, 170, 0.1);
      }

      .launch-note {
        margin: 0.9rem 0 0;
        padding-top: 0.9rem;
        border-top: 1px solid var(--line);
        font-size: 0.9rem;
      }

      .task-intro {
        margin: 0;
        font-size: 0.9rem;
      }

      .scope-note {
        margin: 0;
        font-size: 0.84rem;
      }

      .instruction-box {
        display: grid;
        gap: 0.6rem;
      }

      .instruction-box strong {
        color: var(--ink);
        font-size: 0.92rem;
      }

      .instruction-box textarea {
        min-height: 220px;
      }

      .file-row {
        display: grid;
        gap: 0.5rem;
      }

      .file-row input[type="file"] {
        padding: 0.78rem 0.9rem;
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
        background: rgba(255, 255, 255, 0.05);
        border: 1px solid var(--line);
        font-size: 0.78rem;
        font-family: var(--font-mono);
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
        border-radius: 14px;
        border: 1px dashed rgba(255, 85, 85, 0.35);
        background: rgba(255, 85, 85, 0.08);
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
        border-radius: 12px;
        border: 1px solid var(--line);
        background: rgba(255, 255, 255, 0.03);
        text-decoration: none;
        color: var(--ink);
        font-weight: 700;
      }

      .button-link {
        border-radius: 12px;
      }

      .mono {
        font-family: var(--font-mono);
      }

      @media (max-width: 920px) {
        .hero-top,
        .hero-grid {
          grid-template-columns: 1fr;
        }

        .target-grid {
          grid-template-columns: 1fr;
        }
      }

      @media (max-width: 720px) {
        .page,
        .landing-shell {
          width: min(100vw - 1rem, 1120px);
          padding: 1rem 0 2rem;
        }

        .hero-card,
        .card {
          padding: 1.1rem;
        }

        .launch-panel {
          padding: 1rem;
        }

        .url-row {
          flex-direction: column;
        }

        .url-row button {
          width: 100%;
        }

        .config-row {
          align-items: stretch;
        }

        .config-select {
          width: 100%;
        }
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
  selectedAgentCount?: number;
  submittedInstructions?: string;
  allowPrivateTargets?: boolean;
  selectedTargetMode?: SubmissionTargetMode;
}): string {
  const selectedAgentCount = Math.min(5, Math.max(1, Math.round(args.selectedAgentCount ?? 1)));
  const allowPrivateTargets = Boolean(args.allowPrivateTargets);
  const selectedTargetMode =
    allowPrivateTargets && args.selectedTargetMode === "localhost"
      ? "localhost"
      : DEFAULT_SUBMISSION_TARGET_MODE;
  const lead =
    allowPrivateTargets
      ? "Start with a public URL or a localhost/private dev URL and AgentProbe will send 1 to 5 AI visitors through the site to execute the exact tasks you provide. The output focuses on what each task attempted, what visibly happened, and whether each task succeeded or failed on desktop and mobile."
      : "Start with a public URL and AgentProbe will send 1 to 5 AI visitors through the site to execute the exact tasks you provide. The output focuses on what each task attempted, what visibly happened, and whether each task succeeded or failed on desktop and mobile.";
  const urlPlaceholder =
    allowPrivateTargets && selectedTargetMode === "localhost"
      ? "http://localhost:3000"
      : allowPrivateTargets
        ? "https://example.com or http://localhost:3000"
        : "https://example.com";
  const launchNote =
    allowPrivateTargets
      ? "Use the Localhost/private dev site option when you want to probe localhost, .localhost, .local, 127.0.0.1, or private LAN URLs from this machine."
      : "Launch from the homepage, then use the dashboard to inspect accepted tasks, visible evidence, and saved run artifacts.";

  return basePage({
    title: "AgentProbe",
    body: `
      <main class="landing-shell">
        <section class="card hero-card">
          <p class="eyebrow">AgentProbe</p>
          <div class="hero-top">
            <div class="hero-copy">
              <h1>Review your website the way a real visitor experiences it.</h1>
              <p class="lead">${lead}</p>
              <div class="meta">
                <span>Task-driven sessions</span>
                <span>Desktop and mobile notes</span>
                <span>Observed clicks and states</span>
                <span>Success or failure per task</span>
                <span>Saved execution outputs</span>
                ${allowPrivateTargets ? "<span>Localhost-ready</span>" : ""}
              </div>
            </div>
            <div class="launch-panel">
              <div class="card-title">New test</div>
              ${args.error ? `<div class="error">${escapeHtml(args.error)}</div>` : ""}
              <form method="post" action="/submit" enctype="multipart/form-data">
                ${
                  allowPrivateTargets
                    ? `
                      <div class="target-grid">
                        <label class="target-option">
                          <input type="radio" name="target" value="public" ${selectedTargetMode === "public" ? "checked" : ""} />
                          <span class="target-option-body">
                            <strong>Public site</strong>
                            <small>Use a normal internet-facing URL like https://example.com.</small>
                          </span>
                        </label>
                        <label class="target-option">
                          <input type="radio" name="target" value="localhost" ${selectedTargetMode === "localhost" ? "checked" : ""} />
                          <span class="target-option-body">
                            <strong>Localhost/private dev site</strong>
                            <small>Allow http://localhost, 127.0.0.1, .localhost, .local, and private LAN URLs.</small>
                          </span>
                        </label>
                      </div>
                    `
                    : ""
                }
                <div class="url-row">
                  <input class="url-input" type="url" name="url" placeholder="${urlPlaceholder}" required value="${escapeHtml(args.submittedUrl ?? "")}" />
                  <button type="submit">▶ Start task run</button>
                </div>
                ${
                  allowPrivateTargets
                    ? `<p class="scope-note">Public mode keeps the original hosted-safe validation. Localhost/private mode unlocks local dev targets when you run this dashboard on your own machine.</p>`
                    : ""
                }
                <p class="task-intro">Paste the instructions in one box or upload a text or JSON file. The agent will first understand what the site appears to be for, then perform only the instructions you supplied.</p>
                <label class="instruction-box">
                  <strong>Instructions</strong>
                  <textarea name="instructions" placeholder="- Find the main signup path and explain whether it is clear&#10;- Check what a new user is supposed to do first&#10;- Try the pricing flow and stop before entering private details">${escapeHtml(args.submittedInstructions ?? "")}</textarea>
                </label>
                <label class="file-row">
                  <strong>Instruction file (optional)</strong>
                  <input type="file" name="instructions_file" accept=".txt,.md,.json,.csv,text/plain,application/json" />
                </label>
                <div class="config-row">
                  <select class="config-select" name="agents">
                    ${[1, 2, 3, 4, 5]
                      .map((count) => `<option value="${count}" ${selectedAgentCount === count ? "selected" : ""}>${count} agent${count === 1 ? "" : "s"}</option>`)
                      .join("")}
                  </select>
                  <span class="tag on">tabs and links</span>
                  <span class="tag on">mobile notes</span>
                  <span class="tag on">honest feedback</span>
                </div>
              </form>
              <p class="launch-note">${launchNote}</p>
              <div class="link-row">
                <a class="ghost-link" href="/dashboard">Open dashboard</a>
              </div>
            </div>
          </div>
          <div class="hero-grid">
            <div class="hero-stat">
              <strong>1-5 agents</strong>
              <span>Run one agent or a small task panel against the same accepted task list.</span>
            </div>
            <div class="hero-stat">
              <strong>Real interaction notes</strong>
              <span>Each output explains what each task tried, what happened, and where it stalled.</span>
            </div>
            <div class="hero-stat">
              <strong>Task outcome focus</strong>
              <span>Outputs stay anchored to accepted tasks instead of drifting into generic site commentary.</span>
            </div>
            <div class="hero-stat">
              <strong>Task dashboard</strong>
              <span>Use the dashboard after launch to inspect saved task runs and artifacts.</span>
            </div>
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
  const finishedAgentCount = submission.completedAgentCount + submission.failedAgentCount;

  return basePage({
    title: "AgentProbe submission",
    body: `
      <main class="page">
        <section class="card">
          <p class="eyebrow">Submission status</p>
          <h1>Your test is ${escapeHtml(submission.status)}</h1>
          <p>This page refreshes while the run is active. Once it finishes, open the saved task run in the dashboard or download the task output directly.</p>
          <div class="meta">
            <span class="status status--${escapeHtml(submission.status)}">${escapeHtml(submission.status)}</span>
            <span>${escapeHtml(submission.url)}</span>
            <span>${escapeHtml(`${submission.agentCount} agent${submission.agentCount === 1 ? "" : "s"}`)}</span>
            <span>${escapeHtml(`${submission.customTasks.length} accepted task${submission.customTasks.length === 1 ? "" : "s"}`)}</span>
            <span>${escapeHtml(`${submission.completedAgentCount} completed`)}</span>
            <span>${escapeHtml(`${submission.failedAgentCount} failed`)}</span>
            <span>${escapeHtml(`${finishedAgentCount}/${submission.agentCount} finished`)}</span>
            <span>Expires ${escapeHtml(formatDateTime(submission.expiresAt))}</span>
            <span>${escapeHtml(config.deviceTimezone)}</span>
          </div>
          <div class="card" style="margin-top: 1rem; padding: 1rem;">
            <h2>Accepted tasks</h2>
            ${
              submission.customTasks.length > 0
                ? `<ul>${submission.customTasks.map((task) => `<li>${escapeHtml(task)}</li>`).join("")}</ul>`
                : `<p>No accepted tasks were captured for this submission.</p>`
            }
            ${
              submission.instructionText
                ? `<p style="margin-top: 1rem;"><strong>Instruction source</strong></p><p style="white-space: pre-wrap;">${escapeHtml(submission.instructionText)}</p>`
                : ""
            }
            ${submission.instructionFileName ? `<p class="muted" style="margin-top: 0.7rem;">Uploaded file: ${escapeHtml(submission.instructionFileName)}</p>` : ""}
          </div>
          ${
            submission.agentRuns.length > 0
              ? `
                <div class="card" style="margin-top: 1rem; padding: 1rem;">
                  <h2>Agent panel</h2>
                  <div class="meta">
                    ${submission.agentRuns
                      .map(
                        (agentRun) => `
                          <span class="status status--${escapeHtml(agentRun.status)}">${escapeHtml(agentRun.profileLabel ? `${agentRun.label}: ${agentRun.profileLabel}` : agentRun.label)} (${escapeHtml(agentRun.status)})</span>
                        `
                      )
                      .join("")}
                  </div>
                  <div class="link-row">
                    ${submission.agentRuns
                      .map((agentRun) => {
                        if (!agentRun.runId) {
                          return "";
                        }

                        return `
                          <a class="ghost-link" href="/outputs/${escapeHtml(agentRun.runId)}">${escapeHtml(`${agentRun.label} output`)}</a>
                          <a class="ghost-link" href="/api/runs/${escapeHtml(agentRun.runId)}/artifacts/report.html">${escapeHtml(`${agentRun.label} HTML`)}</a>
                          <a class="ghost-link" href="/api/runs/${escapeHtml(agentRun.runId)}/artifacts/report.json">${escapeHtml(`${agentRun.label} JSON`)}</a>
                        `;
                      })
                      .join("")}
                  </div>
                </div>
              `
              : ""
          }
          ${
            submission.status === "completed"
              ? `
                <div class="link-row">
                  <a class="button-link" href="${escapeHtml(dashboardRunUrl)}">Open in dashboard</a>
                  <a class="ghost-link" href="/outputs/${escapeHtml(submission.runId ?? "")}">Open standalone output</a>
                  ${htmlDownloadUrl ? `<a class="ghost-link" href="${escapeHtml(htmlDownloadUrl)}">Download HTML output</a>` : ""}
                  ${jsonDownloadUrl ? `<a class="ghost-link" href="${escapeHtml(jsonDownloadUrl)}">Download JSON output</a>` : ""}
                  <a class="ghost-link" href="${escapeHtml(reportUrl)}">Open public output</a>
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
          <p class="eyebrow">AgentProbe task output</p>
          <h1>${escapeHtml(args.title)}</h1>
          <p>${escapeHtml(args.message)}</p>
        </section>
      </main>
    `
  });
}

export function renderExpiredReportPage(submission: Submission): string {
  return renderReportUnavailablePage({
    title: "This task output link has expired",
    message: `Task outputs are available for 30 days. This link for ${submission.url} expired on ${formatDateTime(submission.expiresAt)} (${config.deviceTimezone}).`
  });
}

export function canAccessPublicReport(submission: Submission): { allowed: boolean; reason?: string } {
  if (submission.status !== "completed" || !submission.runId) {
    return { allowed: false, reason: "This task output is not ready yet." };
  }

  if (isExpired(submission.expiresAt)) {
    return { allowed: false, reason: "This task output link has expired." };
  }

  return { allowed: true };
}
