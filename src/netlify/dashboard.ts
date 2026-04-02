import { z } from "zod";
import { renderHtmlReport } from "../reporting/html.js";
import { AccessibilityResultSchema, FinalReportSchema, TaskRunResultSchema } from "../schemas/types.js";
import {
  DashboardRunDetailSchema,
  DashboardRunSummarySchema,
  RunInputsSchema,
  type DashboardRunDetail,
  type DashboardRunSummary
} from "../dashboard/contracts.js";
import { listRunIds, readRunArtifactJson, readRunArtifactText } from "./storage.js";

const TaskRunResultsSchema = z.array(TaskRunResultSchema);
const RawEventsSchema = z.array(z.unknown());

const DASHBOARD_CSS = String.raw`
  :root {
    color-scheme: light;
    --bg: #f6efe3;
    --bg-deep: #eadcc7;
    --ink: #1d1b19;
    --muted: #655c53;
    --panel: rgba(255, 251, 245, 0.9);
    --panel-strong: #fffaf2;
    --line: rgba(86, 72, 52, 0.14);
    --accent: #bf5a2c;
    --accent-strong: #9e4319;
    --teal: #176f69;
    --gold: #b7811b;
    --danger: #b42318;
    --shadow: 0 22px 60px rgba(83, 60, 28, 0.14);
  }

  * { box-sizing: border-box; }
  html, body { margin: 0; min-height: 100%; }
  body {
    color: var(--ink);
    font-family: "Avenir Next", "Trebuchet MS", sans-serif;
    background:
      radial-gradient(circle at top left, rgba(191, 90, 44, 0.18), transparent 32%),
      radial-gradient(circle at top right, rgba(23, 111, 105, 0.16), transparent 28%),
      linear-gradient(180deg, #fbf6ee 0%, var(--bg) 52%, var(--bg-deep) 100%);
  }
  a { color: inherit; }
  code {
    font-family: "SFMono-Regular", "Menlo", "Monaco", monospace;
    font-size: 0.92em;
    padding: 0.12rem 0.36rem;
    border-radius: 999px;
    background: rgba(23, 111, 105, 0.08);
  }
  .app-shell {
    display: grid;
    grid-template-columns: minmax(280px, 340px) minmax(0, 1fr);
    min-height: 100vh;
  }
  .sidebar {
    position: sticky;
    top: 0;
    height: 100vh;
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
    padding: 1.5rem;
    border-right: 1px solid var(--line);
    background: rgba(255, 248, 239, 0.72);
    backdrop-filter: blur(22px);
    overflow: auto;
  }
  .brand-block, .panel, .run-link {
    border: 1px solid var(--line);
    border-radius: 24px;
    box-shadow: var(--shadow);
  }
  .brand-block {
    padding: 1.4rem;
    background: linear-gradient(160deg, rgba(255, 252, 246, 0.96), rgba(249, 238, 221, 0.92));
  }
  .eyebrow {
    margin: 0 0 0.4rem;
    color: var(--accent);
    font-size: 0.78rem;
    font-weight: 700;
    letter-spacing: 0.18em;
    text-transform: uppercase;
  }
  h1, h2, h3 {
    margin: 0;
    font-family: "Iowan Old Style", "Palatino Linotype", "Book Antiqua", Georgia, serif;
    letter-spacing: -0.03em;
  }
  h1 { font-size: clamp(2rem, 3vw, 2.8rem); line-height: 0.96; }
  h2 { font-size: clamp(2rem, 4vw, 3.3rem); line-height: 0.94; }
  h3 { font-size: 1.25rem; }
  .muted, .run-summary, .warning-note { color: var(--muted); }
  .run-list, .task-stack, .score-grid, .list-grid, .accessibility-grid, .history-grid {
    display: grid;
    gap: 1rem;
  }
  .run-link {
    display: block;
    text-decoration: none;
    padding: 1rem;
    background: rgba(255, 252, 247, 0.84);
  }
  .run-link--active {
    border-color: rgba(23, 111, 105, 0.32);
    background: linear-gradient(180deg, rgba(255, 249, 239, 0.98), rgba(240, 248, 246, 0.95));
  }
  .run-topline, .section-heading, .task-card__header, .history-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
  }
  .run-summary {
    margin: 0.65rem 0 0;
    font-size: 0.92rem;
    line-height: 1.45;
  }
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.38rem 0.7rem;
    border-radius: 999px;
    border: 1px solid transparent;
    font-size: 0.82rem;
    font-weight: 700;
    text-transform: capitalize;
    white-space: nowrap;
  }
  .pill--score-high, .pill--status-success, .pill--friction-none { color: #0f5f56; background: rgba(23, 111, 105, 0.12); }
  .pill--score-mid, .pill--status-partial_success, .pill--friction-low, .pill--friction-medium { color: #8a5f08; background: rgba(183, 129, 27, 0.14); }
  .pill--score-low, .pill--status-failed, .pill--friction-high { color: #8d1b13; background: rgba(180, 35, 24, 0.12); }
  .main {
    min-width: 0;
    padding: 1.5rem;
    display: grid;
    gap: 1.2rem;
  }
  .panel {
    padding: 1.35rem;
    background: var(--panel);
    backdrop-filter: blur(16px);
  }
  .hero-panel {
    background:
      radial-gradient(circle at right top, rgba(191, 90, 44, 0.12), transparent 34%),
      linear-gradient(180deg, rgba(255, 253, 248, 0.98), rgba(255, 247, 236, 0.94));
  }
  .hero-grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 1rem;
    align-items: end;
  }
  .hero-summary {
    max-width: 64ch;
    font-size: 1.05rem;
    line-height: 1.6;
  }
  .helper-row, .mini-meta, .task-meta, .history-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 0.55rem;
    margin-top: 0.9rem;
  }
  .helper-row span, .mini-meta span, .task-meta span, .history-meta span {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.36rem 0.6rem;
    border-radius: 999px;
    background: rgba(29, 27, 25, 0.05);
    font-size: 0.82rem;
  }
  .hero-score {
    min-width: 180px;
    padding: 1.1rem 1rem;
    border-radius: 24px;
    border: 1px solid var(--line);
    background: rgba(255, 255, 255, 0.68);
    text-align: center;
  }
  .hero-score strong {
    display: block;
    font-family: "Iowan Old Style", "Palatino Linotype", Georgia, serif;
    font-size: clamp(2.4rem, 6vw, 4rem);
    line-height: 0.9;
  }
  .hero-score span { color: var(--muted); font-size: 0.88rem; }
  .score-grid { grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); }
  .score-card, .history-card, .violation-card, .task-card {
    padding: 1rem;
    border-radius: 20px;
    border: 1px solid var(--line);
    background: rgba(255, 255, 255, 0.82);
  }
  .score-card__value { display: flex; align-items: baseline; gap: 0.25rem; margin-top: 0.35rem; }
  .score-card__value strong { font-size: 2rem; line-height: 0.9; }
  .score-bar {
    height: 10px;
    margin-top: 0.8rem;
    border-radius: 999px;
    overflow: hidden;
    background: rgba(29, 27, 25, 0.08);
  }
  .score-bar > span {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: linear-gradient(90deg, var(--accent), #da7a3f);
  }
  .list-grid, .history-grid, .accessibility-grid {
    grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  }
  .prose-list, .evidence-list {
    margin: 1rem 0 0;
    padding-left: 1.2rem;
    display: grid;
    gap: 0.75rem;
  }
  .task-card__reason, .history-card p, .violation-card p {
    margin: 0.55rem 0 0;
    line-height: 1.48;
  }
  .task-details {
    margin-top: 1rem;
    border-top: 1px solid var(--line);
    padding-top: 1rem;
  }
  .warning-note, .empty-stack {
    padding: 1rem;
    border-radius: 18px;
    border: 1px dashed rgba(191, 90, 44, 0.32);
    background: rgba(255, 248, 239, 0.76);
  }
  .empty-stack {
    display: grid;
    place-items: center;
    min-height: 240px;
    text-align: center;
  }
  .link-row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-top: 0.8rem;
  }
  .inline-link {
    color: var(--accent-strong);
    text-decoration: none;
  }
  .inline-link:hover, .inline-link:focus-visible { text-decoration: underline; }
  @media (max-width: 1080px) {
    .app-shell { grid-template-columns: 1fr; }
    .sidebar {
      position: static;
      height: auto;
      border-right: 0;
      border-bottom: 1px solid var(--line);
    }
  }
  @media (max-width: 760px) {
    .main, .sidebar { padding: 1rem; }
    .hero-grid, .score-grid, .list-grid, .accessibility-grid, .history-grid { grid-template-columns: 1fr; }
  }
`;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatDate(value: string | null | undefined, timeZone?: string | null): string {
  if (!value) {
    return "Unknown time";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
    ...(timeZone ? { timeZone } : {})
  }).format(date);
}

function humanize(value: string): string {
  return value.replaceAll("_", " ");
}

function scoreTone(score: number | null | undefined): "high" | "mid" | "low" {
  if ((score ?? 0) >= 8) {
    return "high";
  }

  if ((score ?? 0) >= 5) {
    return "mid";
  }

  return "low";
}

function safeHref(url: string): string | null {
  return /^https?:\/\//i.test(url) ? url : null;
}

function readHost(baseUrl: string | undefined, fallback: string): string {
  if (!baseUrl) {
    return fallback;
  }

  try {
    return new URL(baseUrl).hostname.replace(/^www\./, "") || fallback;
  } catch {
    return fallback;
  }
}

export async function buildRunSummary(runId: string): Promise<DashboardRunSummary> {
  const inputs = await readRunArtifactJson(runId, "inputs.json", RunInputsSchema);
  const report = await readRunArtifactJson(runId, "report.json", FinalReportSchema);
  const accessibility = await readRunArtifactJson(runId, "accessibility.json", AccessibilityResultSchema);

  return DashboardRunSummarySchema.parse({
    id: runId,
    baseUrl: inputs?.baseUrl ?? "",
    host: readHost(inputs?.baseUrl, runId),
    startedAt: inputs?.startedAt ?? null,
    headed: inputs?.headed ?? false,
    mobile: inputs?.mobile ?? false,
    model: inputs?.model ?? null,
    taskPath: inputs?.taskPath ?? null,
    persona: inputs?.persona ?? null,
    overallScore: report?.overall_score ?? null,
    summary: report?.summary ?? null,
    taskCount: report?.task_results.length ?? 0,
    accessibilityViolationCount: accessibility?.violations.length ?? null
  });
}

export async function buildRunDetail(runId: string): Promise<DashboardRunDetail | null> {
  const inputs = await readRunArtifactJson(runId, "inputs.json", RunInputsSchema);
  const report = await readRunArtifactJson(runId, "report.json", FinalReportSchema);
  const accessibility = await readRunArtifactJson(runId, "accessibility.json", AccessibilityResultSchema);
  const taskRuns = (await readRunArtifactJson(runId, "task-results.json", TaskRunResultsSchema)) ?? [];
  const rawEvents = (await readRunArtifactJson(runId, "raw-events.json", RawEventsSchema)) ?? [];

  if (!inputs && !report && !accessibility && taskRuns.length === 0 && rawEvents.length === 0) {
    return null;
  }

  const warnings: string[] = [];
  if (!inputs) {
    warnings.push("inputs.json is missing or invalid for this run.");
  }
  if (!report) {
    warnings.push("report.json is missing or invalid for this run.");
  }
  if (!accessibility) {
    warnings.push("accessibility.json is missing or invalid for this run.");
  }
  if (taskRuns.length === 0) {
    warnings.push("task-results.json is missing or empty for this run.");
  }

  const reviewedTasks = new Map((report?.task_results ?? []).map((task) => [task.name, task]));
  const taskRunsByName = new Map(taskRuns.map((task) => [task.name, task]));
  const taskNames = Array.from(new Set([...taskRuns.map((task) => task.name), ...(report?.task_results.map((task) => task.name) ?? [])]));

  const tasks = taskNames.map((taskName) => {
    const taskRun = taskRunsByName.get(taskName);
    const reviewedTask = reviewedTasks.get(taskName);

    return {
      name: taskName,
      status: reviewedTask?.status ?? taskRun?.status ?? "failed",
      reason: reviewedTask?.reason ?? taskRun?.reason ?? "No task reasoning was captured for this task.",
      evidence: reviewedTask?.evidence ?? [],
      finalUrl: taskRun?.finalUrl ?? "",
      finalTitle: taskRun?.finalTitle ?? "",
      history: taskRun?.history ?? []
    };
  });

  return DashboardRunDetailSchema.parse({
    id: runId,
    host: readHost(inputs?.baseUrl, runId),
    inputs,
    report,
    accessibility,
    tasks,
    rawEventCount: rawEvents.length,
    warnings
  });
}

export async function buildStandaloneReportHtml(runId: string): Promise<string | null> {
  const staticReport = await readRunArtifactText(runId, "report.html");
  if (staticReport) {
    return staticReport;
  }

  const inputs = await readRunArtifactJson(runId, "inputs.json", RunInputsSchema);
  const report = await readRunArtifactJson(runId, "report.json", FinalReportSchema);
  const taskRuns = (await readRunArtifactJson(runId, "task-results.json", TaskRunResultsSchema)) ?? [];

  if (!report) {
    return null;
  }

  return renderHtmlReport({
    website: inputs?.baseUrl ?? runId,
    persona: inputs?.persona ?? "first-time visitor",
    report,
    taskResults: taskRuns,
    runId,
    startedAt: inputs?.startedAt
  });
}

export async function loadDashboardData(selectedRunId: string | null): Promise<{
  runs: DashboardRunSummary[];
  detail: DashboardRunDetail | null;
  selectedRunId: string | null;
}> {
  const runIds = await listRunIds();
  const runs = await Promise.all(runIds.map((runId) => buildRunSummary(runId)));
  const resolvedRunId = runs.find((run) => run.id === selectedRunId)?.id ?? runs[0]?.id ?? null;
  const detail = resolvedRunId ? await buildRunDetail(resolvedRunId) : null;

  return {
    runs,
    detail,
    selectedRunId: resolvedRunId
  };
}

function renderList(title: string, items: string[], emptyCopy: string): string {
  if (items.length === 0) {
    return `<div class="panel"><div class="section-heading"><h3>${escapeHtml(title)}</h3></div><div class="warning-note">${escapeHtml(emptyCopy)}</div></div>`;
  }

  return `
    <div class="panel">
      <div class="section-heading"><h3>${escapeHtml(title)}</h3></div>
      <ul class="prose-list">
        ${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
      </ul>
    </div>
  `;
}

function renderTaskCard(detail: DashboardRunDetail, task: DashboardRunDetail["tasks"][number]): string {
  const finalHref = safeHref(task.finalUrl);
  const evidenceBlock =
    task.evidence.length > 0
      ? `
          <ul class="evidence-list">
            ${task.evidence.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
          </ul>
        `
      : `<div class="warning-note">The final reviewer did not add evidence bullets for this task, so use the step history below.</div>`;

  const historyGrid =
    task.history.length > 0
      ? task.history
          .map((entry) => {
            const targetLabel = entry.decision.target ? ` <code>${escapeHtml(entry.decision.target)}</code>` : "";
            const matcher = entry.result.matchedBy ? ` via ${escapeHtml(entry.result.matchedBy)}` : "";
            const stepHref = safeHref(entry.url);

            return `
              <article class="history-card">
                <div class="history-head">
                  <strong>Step ${entry.step}</strong>
                  <span class="pill pill--friction-${escapeHtml(entry.decision.friction)}">${escapeHtml(humanize(entry.decision.friction))} friction</span>
                </div>
                <p><strong>${escapeHtml(entry.decision.action)}</strong>${targetLabel}</p>
                <p>${escapeHtml(entry.decision.expectation)}</p>
                <p class="muted">${escapeHtml(entry.result.note)}${matcher}</p>
                <div class="history-meta">
                  <span>${escapeHtml(entry.title || "Untitled page")}</span>
                  <span>${escapeHtml(formatDate(entry.time, detail.inputs?.synchronizedTimezone ?? null))}</span>
                </div>
                <div class="link-row">
                  ${
                    stepHref
                      ? `<a class="inline-link" href="${escapeHtml(stepHref)}" target="_blank" rel="noreferrer">Open page</a>`
                      : `<span class="muted">No page URL recorded.</span>`
                  }
                </div>
              </article>
            `;
          })
          .join("")
      : `<div class="warning-note">No step history was recorded for this task.</div>`;

  return `
    <article class="task-card">
      <div class="task-card__header">
        <div>
          <h3>${escapeHtml(task.name)}</h3>
          <p class="task-card__reason">${escapeHtml(task.reason)}</p>
        </div>
        <span class="pill pill--status-${escapeHtml(task.status)}">${escapeHtml(humanize(task.status))}</span>
      </div>
      <div class="task-meta">
        <span>${escapeHtml(`${task.history.length} steps`)}</span>
        <span>${escapeHtml(task.finalTitle || "No final title recorded")}</span>
      </div>
      <div class="link-row">
        ${
          finalHref
            ? `<a class="inline-link" href="${escapeHtml(finalHref)}" target="_blank" rel="noreferrer">Open final URL</a>`
            : `<span class="muted">No final URL recorded.</span>`
        }
      </div>
      ${evidenceBlock}
      <details class="task-details">
        <summary>Interaction timeline</summary>
        <div class="history-grid">
          ${historyGrid}
        </div>
      </details>
    </article>
  `;
}

function renderAccessibility(detail: DashboardRunDetail): string {
  const accessibility = detail.accessibility;

  if (!accessibility) {
    return `<div class="warning-note">No accessibility artifact was found for this run.</div>`;
  }

  if (accessibility.error) {
    return `<div class="warning-note">${escapeHtml(accessibility.error)}</div>`;
  }

  if (accessibility.violations.length === 0) {
    return `<div class="warning-note">No accessibility violations were recorded in the saved audit artifact.</div>`;
  }

  return `
    <div class="accessibility-grid">
      ${accessibility.violations
        .map((violation) => `
          <article class="violation-card">
            <div class="section-heading">
              <h3>${escapeHtml(violation.id)}</h3>
              <span class="pill pill--score-${scoreTone(violation.impact ? 3 : 6)}">${escapeHtml(violation.impact ?? "unknown impact")}</span>
            </div>
            <p>${escapeHtml(violation.description)}</p>
            <p><strong>Help:</strong> ${escapeHtml(violation.help)}</p>
            <div class="helper-row">
              <span>${escapeHtml(`${violation.nodes} affected nodes`)}</span>
            </div>
          </article>
        `)
        .join("")}
    </div>
  `;
}

function renderMain(detail: DashboardRunDetail | null, error: string | null): string {
  if (!detail) {
    return `
      <section class="panel empty-stack">
        <div>
          <h2>No reports yet</h2>
          <p class="muted">Submit a URL from the landing page and the finished report will show up here.</p>
        </div>
      </section>
    `;
  }

  const report = detail.report;
  const inputs = detail.inputs;
  const summary = report?.summary ?? "This run has saved artifacts, but no final report summary was available.";
  const overallScore = report?.overall_score ?? null;
  const metaPills = [
    inputs?.persona ?? "Unknown persona",
    inputs?.mobile ? "Mobile run" : "Desktop run",
    inputs?.headed ? "Headed browser" : "Headless browser",
    inputs?.ignoreHttpsErrors ? "Ignoring HTTPS errors" : "Strict HTTPS checks",
    inputs?.model ? `Model: ${inputs.model}` : "Model unknown",
    inputs?.synchronizedTimezone ? `Timezone: ${inputs.synchronizedTimezone}` : null,
    inputs?.maxRunDurationSeconds ? `Max total run: ${inputs.maxRunDurationSeconds}s` : null,
    inputs?.browserExecutionBudgetMs ? `Browser budget: ${Math.round(inputs.browserExecutionBudgetMs / 1000)}s` : null,
    inputs?.reportingReserveMs ? `Report reserve: ${Math.round(inputs.reportingReserveMs / 1000)}s` : null,
    `${detail.rawEventCount} raw events`
  ].filter((item): item is string => Boolean(item));

  return `
    <section class="panel hero-panel">
      <div class="hero-grid">
        <div>
          <p class="eyebrow">Saved audit run</p>
          <h2>${escapeHtml(detail.host)}</h2>
          <p class="hero-summary">${escapeHtml(summary)}</p>
          <div class="helper-row">
            <span>${escapeHtml(inputs?.baseUrl ?? "Unknown URL")}</span>
            <span>${escapeHtml(formatDate(inputs?.startedAt, inputs?.synchronizedTimezone ?? null))}</span>
            ${metaPills.map((item) => `<span>${escapeHtml(item)}</span>`).join("")}
          </div>
          <div class="link-row">
            <a class="inline-link" href="/reports/${encodeURIComponent(detail.id)}" target="_blank" rel="noreferrer">Open standalone HTML report</a>
            <a class="inline-link" href="/api/runs/${encodeURIComponent(detail.id)}/artifacts/report.html">Download HTML report</a>
            <a class="inline-link" href="/api/runs/${encodeURIComponent(detail.id)}/artifacts/report.json">Download JSON report</a>
          </div>
          ${error ? `<p class="warning-note">${escapeHtml(error)}</p>` : ""}
        </div>
        <div class="hero-score">
          <strong>${overallScore === null ? "n/a" : overallScore}</strong>
          <span>overall score / 10</span>
        </div>
      </div>
      ${detail.warnings.length > 0 ? `<p class="warning-note">${escapeHtml(detail.warnings.join(" "))}</p>` : ""}
    </section>

    <section class="score-grid">
      ${
        report
          ? Object.entries(report.scores)
              .map(([label, value]) => `
                <article class="score-card">
                  <div class="muted">${escapeHtml(humanize(label))}</div>
                  <div class="score-card__value"><strong>${value}</strong><span>/10</span></div>
                  <div class="score-bar"><span style="width: ${Math.max(10, value * 10)}%"></span></div>
                </article>
              `)
              .join("")
          : `
              <article class="score-card">
                <div class="muted">Task coverage</div>
                <div class="score-card__value"><strong>${detail.tasks.length}</strong><span>tasks</span></div>
                <div class="score-bar"><span style="width: 100%"></span></div>
              </article>
            `
      }
    </section>

    <section class="list-grid">
      ${renderList("Strengths", report?.strengths ?? [], "No strengths were recorded for this run.")}
      ${renderList("Weaknesses", report?.weaknesses ?? [], "No weaknesses were recorded for this run.")}
      ${renderList("Top fixes", report?.top_fixes ?? [], "No top fixes were recorded for this run.")}
    </section>

    <section class="panel">
      <div class="section-heading">
        <h3>Task deep dive</h3>
        <span class="muted">Review the recorded interaction timeline</span>
      </div>
      <div class="task-stack">
        ${detail.tasks.map((task) => renderTaskCard(detail, task)).join("")}
      </div>
    </section>

    <section class="panel">
      <div class="section-heading">
        <h3>Accessibility</h3>
        <span class="muted">Saved axe results</span>
      </div>
      ${renderAccessibility(detail)}
    </section>
  `;
}

export function renderDashboardPage(args: {
  runs: DashboardRunSummary[];
  detail: DashboardRunDetail | null;
  selectedRunId: string | null;
  error?: string | null;
}): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Site Agent Dashboard</title>
    <style>${DASHBOARD_CSS}</style>
  </head>
  <body>
    <div class="app-shell">
      <aside class="sidebar">
        <div class="brand-block">
          <p class="eyebrow">Site Agent Pro</p>
          <h1>Run Dashboard</h1>
          <p class="muted">Browse saved audits, inspect evidence, and download reports without touching the filesystem.</p>
          <div class="mini-meta">
            <span>${escapeHtml(`${args.runs.length} saved runs`)}</span>
            <span>Netlify-hosted dashboard</span>
          </div>
        </div>
        <div class="run-list">
          ${
            args.runs.length === 0
              ? `<div class="empty-stack"><div><h3>No runs yet</h3><p class="muted">Submit a URL from the home page to generate your first report.</p></div></div>`
              : args.runs
                  .map((run) => {
                    const isActive = run.id === args.selectedRunId;
                    const summary = run.summary ?? "No report summary has been generated for this run yet.";
                    const scoreLabel = run.overallScore === null ? "n/a" : `${run.overallScore}`;
                    const modes = [run.mobile ? "Mobile" : "Desktop", run.headed ? "Headed" : "Headless"];

                    return `
                      <a href="/dashboard?run=${encodeURIComponent(run.id)}" class="run-link ${isActive ? "run-link--active" : ""}">
                        <div class="run-topline">
                          <div>
                            <div><strong>${escapeHtml(run.host)}</strong></div>
                            <div class="muted">${escapeHtml(formatDate(run.startedAt))}</div>
                          </div>
                          <span class="pill pill--score-${scoreTone(run.overallScore)}">${escapeHtml(scoreLabel)}</span>
                        </div>
                        <p class="run-summary">${escapeHtml(summary)}</p>
                        <div class="mini-meta">
                          ${modes.map((mode) => `<span>${escapeHtml(mode)}</span>`).join("")}
                          <span>${escapeHtml(`${run.taskCount} tasks`)}</span>
                        </div>
                      </a>
                    `;
                  })
                  .join("")
          }
        </div>
      </aside>
      <main class="main">
        ${renderMain(args.detail, args.error ?? null)}
      </main>
    </div>
  </body>
</html>`;
}
