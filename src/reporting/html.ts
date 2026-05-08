import type { AccessibilityResult, FinalReport, SiteBrief, SiteChecks, TaskHistoryEntry, TaskRunResult } from "../schemas/types.js";
import {
  buildStructuredReviewTemplate,
  labelForCoverageStatus,
  labelForMetricStatus,
  type ReportMetric,
  type ReportMetricGroup,
  type ReportMetricStatus,
  type SectionCoverage
} from "./template.js";
import { DASHBOARD_HEAD_TAGS } from "../dashboard/theme.js";

type HtmlReportArgs = {
  website: string;
  persona: string;
  acceptedTasks?: string[] | undefined;
  instructionText?: string | undefined;
  report: FinalReport;
  taskResults: TaskRunResult[];
  accessibility: AccessibilityResult | undefined;
  siteChecks: SiteChecks | undefined;
  siteBrief?: SiteBrief | null | undefined;
  rawEvents: unknown[] | undefined;
  runId: string | undefined;
  startedAt: string | undefined;
  mobile: boolean | undefined;
  timeZone: string | undefined;
  clickReplayArtifact?: string | null | undefined;
};

type SessionLogItem = {
  action: string;
  outcome: string;
  task: string;
  time: string;
  url: string;
};

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatLogTime(value: string, timeZone?: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    ...(timeZone ? { timeZone } : {})
  });
}

function describeAction(entry: TaskHistoryEntry): string {
  const target = entry.decision.target.trim();

  switch (entry.decision.action) {
    case "click":
      return target ? `Clicked "${target}"` : "Clicked a visible element";
    case "type":
      return target ? `Typed into "${target}"` : "Typed into a visible field";
    case "scroll":
      return "Scrolled the page";
    case "wait":
      return "Waited for the page to respond";
    case "back":
      return "Went back one page";
    case "extract":
      return "Captured a page snapshot";
    case "trade":
      return "Executed the wallet trade handoff";
    case "stop":
      return "Stopped the path";
    default:
      return entry.decision.action;
  }
}

function deriveSessionLog(taskResults: TaskRunResult[]): SessionLogItem[] {
  return taskResults
    .flatMap((taskResult) => taskResult.history)
    .sort((left, right) => new Date(left.time).getTime() - new Date(right.time).getTime())
    .map((entry) => ({
      action: describeAction(entry),
      outcome: entry.result.note,
      task: entry.task,
      time: entry.time,
      url: entry.url
    }));
}

function renderSimpleList(items: string[]): string {
  if (items.length === 0) {
    return `<li class="empty-item">None recorded.</li>`;
  }

  return items.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
}

function renderInstructionText(value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized) {
    return "";
  }

  return `<p class="instruction-text">${escapeHtml(normalized)}</p>`;
}

function formatTaskOutcome(status: FinalReport["task_results"][number]["status"]): string {
  switch (status) {
    case "success":
      return "Succeeded";
    case "partial_success":
      return "Partially Succeeded";
    case "failed":
    default:
      return "Failed";
  }
}

function renderToolList(items: string[]): string {
  if (items.length === 0) {
    return "";
  }

  return `<div class="tool-row">${items.map((item) => `<span class="tool-chip">${escapeHtml(item)}</span>`).join("")}</div>`;
}

function renderStatusBadge(status: ReportMetricStatus): string {
  return `<span class="status-badge status-badge--${status}">${escapeHtml(labelForMetricStatus(status))}</span>`;
}

function renderCoverageBadge(status: SectionCoverage["status"]): string {
  return `<span class="status-badge status-badge--${status === "verified" ? "good" : status === "inferred" ? "warning" : "blocked"}">${escapeHtml(labelForCoverageStatus(status))}</span>`;
}

function renderMetricTable(metrics: ReportMetric[]): string {
  return `
    <div class="table-wrap">
      <table class="metric-table">
        <thead>
          <tr>
            <th>Metric</th>
            <th>Value</th>
            <th>Status</th>
            <th>Coverage</th>
          </tr>
        </thead>
        <tbody>
          ${metrics
            .map(
              (metric) => `
                <tr>
                  <td>${escapeHtml(metric.label)}</td>
                  <td>${escapeHtml(metric.value)}</td>
                  <td>${renderStatusBadge(metric.status)}</td>
                  <td>${renderCoverageBadge(metric.verification)}</td>
                </tr>
              `
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderMetricGroups(groups: ReportMetricGroup[]): string {
  return groups
    .map(
      (group) => `
        <div class="subsection">
          <h3>${escapeHtml(group.title)}</h3>
          ${renderMetricTable(group.metrics)}
        </div>
      `
    )
    .join("");
}

function renderCoverageBlock(coverage: SectionCoverage): string {
  return `
    <div class="summary-card" style="margin-bottom: 0.95rem;">
      <div class="task-head">
        <h3>Coverage</h3>
        ${renderCoverageBadge(coverage.status)}
      </div>
      <p>${escapeHtml(coverage.summary)}</p>
      ${coverage.evidence.length > 0 ? `<ul class="bullet-list" style="margin-top: 0.8rem;">${renderSimpleList(coverage.evidence)}</ul>` : ""}
      ${coverage.blockers.length > 0 ? `<p style="margin-top: 0.8rem; color: var(--red);">${escapeHtml(`Blockers: ${coverage.blockers.join(" ")}`)}</p>` : ""}
    </div>
  `;
}

function renderZGProofSection(report: FinalReport): string {
  const proof = report.zgProof;
  if (!proof) {
    return "";
  }

  const storageRoot = proof.storageRootHash ?? "Recorded in storage pointer";
  const storageTx = proof.storageUploadTxHash ?? "Storage upload transaction not returned by indexer";
  const proofStatus = proof.status === "registered" ? "Registered on-chain" : "Submitted to chain";

  return `
      <section class="section">
        <h2>0G Proof</h2>
        <div class="card-grid">
          <div class="summary-card">
            <h3>On-chain registry</h3>
            <p>${escapeHtml(proofStatus)}</p>
            <p class="mono">${escapeHtml(proof.registryContractAddress)}</p>
            <p style="margin-top: 0.65rem;"><a class="inline-link" href="${escapeHtml(proof.explorerUrl)}" target="_blank" rel="noreferrer">Open 0G Explorer transaction</a></p>
          </div>
          <div class="summary-card">
            <h3>Evidence bundle</h3>
            <p class="mono">${escapeHtml(proof.artifactHash)}</p>
            <p style="margin-top: 0.65rem;">${escapeHtml(proof.storagePointer)}</p>
          </div>
        </div>
        <div class="summary-card" style="margin-top: 0.9rem;">
          <h3>Verification details</h3>
          <ul class="bullet-list">
            <li>Run ID: <span class="mono">${escapeHtml(proof.runId)}</span></li>
            <li>Target URL hash: <span class="mono">${escapeHtml(proof.targetUrlHash)}</span></li>
            <li>Task set hash: <span class="mono">${escapeHtml(proof.taskSetHash)}</span></li>
            <li>0G storage root: <span class="mono">${escapeHtml(storageRoot)}</span></li>
            <li>0G storage upload tx: <span class="mono">${escapeHtml(storageTx)}</span></li>
          </ul>
        </div>
      </section>
  `;
}

export function renderHtmlReport(args: HtmlReportArgs): string {
  const template = buildStructuredReviewTemplate({
    website: args.website,
    report: args.report,
    taskResults: args.taskResults,
    accessibility: args.accessibility,
    siteChecks: args.siteChecks,
    rawEvents: args.rawEvents,
    startedAt: args.startedAt,
    mobile: args.mobile,
    timeZone: args.timeZone
  });
  const sessionLog = deriveSessionLog(args.taskResults);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Task Execution Output</title>
    ${DASHBOARD_HEAD_TAGS}
    <style>
      :root {
        color-scheme: dark;
        --bg: #0c0c10;
        --surface: #13131a;
        --surface2: #1a1a24;
        --surface3: #22222d;
        --border: rgba(255,255,255,0.07);
        --border2: rgba(255,255,255,0.12);
        --text: #e8e8f0;
        --muted: #6b6b80;
        --accent: #00d4aa;
        --accent-dim: rgba(0,212,170,0.12);
        --accent-glow: rgba(0,212,170,0.25);
        --blue: #4d9fff;
        --blue-dim: rgba(77,159,255,0.12);
        --amber: #f5a623;
        --amber-dim: rgba(245,166,35,0.12);
        --red: #ff5555;
        --red-dim: rgba(255,85,85,0.12);
        --font-sans: "Syne", sans-serif;
        --font-mono: "IBM Plex Mono", monospace;
      }

      * { box-sizing: border-box; }
      html, body { margin: 0; min-height: 100%; }

      body {
        color: var(--text);
        font-family: var(--font-sans);
        background:
          radial-gradient(circle at top left, rgba(0,212,170,0.07), transparent 22%),
          radial-gradient(circle at bottom right, rgba(77,159,255,0.08), transparent 24%),
          var(--bg);
      }

      .report-topbar {
        position: sticky;
        top: 0;
        z-index: 20;
        background: rgba(12,12,16,0.85);
        backdrop-filter: blur(12px);
        border-bottom: 1px solid var(--border);
      }

      .report-topbar__inner {
        width: min(1180px, calc(100vw - 2rem));
        margin: 0 auto;
        padding: 12px 0;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
      }

      .report-brand {
        display: flex;
        align-items: center;
        gap: 10px;
        min-width: 0;
      }

      .logo-mark {
        width: 30px;
        height: 30px;
        border-radius: 8px;
        background: var(--accent);
        position: relative;
        flex-shrink: 0;
      }

      .logo-mark::after {
        content: "";
        position: absolute;
        inset: 10px;
        border-radius: 50%;
        background: var(--bg);
      }

      .brand-name {
        color: var(--text);
        font-size: 15px;
        font-weight: 700;
        letter-spacing: -0.02em;
      }

      .brand-sub {
        color: var(--muted);
        font-family: var(--font-mono);
        font-size: 11px;
      }

      .topbar-chip {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 6px 10px;
        border-radius: 999px;
        border: 1px solid var(--border);
        color: var(--muted);
        background: var(--surface2);
        font-family: var(--font-mono);
        font-size: 11px;
      }

      .topbar-actions {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
      }

      .page {
        width: min(1180px, calc(100vw - 2rem));
        margin: 0 auto;
        padding: 1rem 0 2.5rem;
        display: grid;
        gap: 1.15rem;
      }

      .section {
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 12px;
        padding: 1.4rem;
      }

      .hero {
        display: grid;
        grid-template-columns: minmax(0, 1.45fr) minmax(260px, 0.55fr);
        gap: 1.15rem;
        align-items: start;
      }

      .eyebrow {
        margin: 0 0 0.5rem;
        color: var(--accent);
        font-size: 0.78rem;
        font-weight: 700;
        letter-spacing: 0.16em;
        text-transform: uppercase;
        font-family: var(--font-mono);
      }

      h1, h2, h3 {
        margin: 0;
        font-family: var(--font-sans);
        color: var(--text);
        letter-spacing: -0.02em;
      }

      h1 {
        font-size: clamp(2rem, 4vw, 3rem);
        line-height: 0.98;
      }

      h2 {
        font-size: clamp(1.35rem, 3vw, 2rem);
        margin-bottom: 0.95rem;
      }

      h3 {
        font-size: 1.02rem;
      }

      p {
        margin: 0;
        line-height: 1.65;
        color: rgba(232, 232, 240, 0.82);
      }

      .lead {
        margin-top: 0.95rem;
        color: var(--text);
        font-size: 1rem;
      }

      .meta-grid,
      .card-grid,
      .split-grid,
      .priority-grid,
      .log-grid,
      .task-grid {
        display: grid;
        gap: 0.9rem;
      }

      .meta-grid {
        margin-top: 1rem;
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }

      .card-grid,
      .split-grid,
      .priority-grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }

      .task-grid,
      .log-grid {
        grid-template-columns: 1fr;
      }

      .summary-card,
      .priority-card,
      .task-card,
      .log-card {
        border: 1px solid var(--border);
        border-radius: 10px;
        background: var(--surface2);
        padding: 1rem;
      }

      .score-card {
        border: 1px solid var(--border2);
        border-radius: 12px;
        background: linear-gradient(160deg, rgba(0,212,170,0.16), rgba(77,159,255,0.10));
        padding: 1.2rem;
      }

      .score-number {
        font-size: clamp(2.3rem, 4vw, 3.1rem);
        line-height: 1;
        color: var(--accent);
        font-family: var(--font-sans);
      }

      .score-label {
        margin-top: 0.4rem;
        font-size: 0.94rem;
      }

      .meta-label {
        color: var(--muted);
        font-size: 0.72rem;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        font-family: var(--font-mono);
      }

      .meta-value {
        margin-top: 0.3rem;
        color: var(--text);
        font-size: 1rem;
      }

      .tool-row {
        display: flex;
        flex-wrap: wrap;
        gap: 0.55rem;
        margin-bottom: 0.95rem;
      }

      .tool-chip {
        display: inline-flex;
        align-items: center;
        border-radius: 999px;
        padding: 0.35rem 0.7rem;
        border: 1px solid rgba(0,212,170,0.24);
        background: var(--accent-dim);
        color: var(--accent);
        font-size: 0.76rem;
        font-weight: 500;
        font-family: var(--font-mono);
      }

      .table-wrap {
        overflow-x: auto;
      }

      .metric-table {
        width: 100%;
        border-collapse: collapse;
      }

      .metric-table th,
      .metric-table td {
        padding: 0.8rem 0.75rem;
        text-align: left;
        border-top: 1px solid var(--border);
        vertical-align: top;
      }

      .metric-table thead th {
        border-top: none;
        color: var(--muted);
        font-size: 0.74rem;
        font-weight: 500;
        letter-spacing: 0.05em;
        text-transform: uppercase;
        font-family: var(--font-mono);
      }

      .metric-table tbody td:first-child {
        color: var(--text);
        font-weight: 700;
      }

      .metric-table tbody td {
        color: rgba(232, 232, 240, 0.86);
      }

      .status-badge {
        display: inline-flex;
        align-items: center;
        padding: 0.32rem 0.68rem;
        border-radius: 999px;
        font-size: 0.78rem;
        font-weight: 700;
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }

      .status-badge--good {
        color: var(--accent);
        background: var(--accent-dim);
      }

      .status-badge--warning {
        color: var(--amber);
        background: var(--amber-dim);
      }

      .status-badge--poor {
        color: var(--red);
        background: var(--red-dim);
      }

      .status-badge--blocked {
        color: var(--red);
        background: var(--red-dim);
      }

      .status-badge--neutral,
      .status-badge--not_measured {
        color: var(--muted);
        background: rgba(255,255,255,0.06);
      }

      .bullet-list {
        margin: 0;
        padding-left: 1.2rem;
        display: grid;
        gap: 0.6rem;
      }

      .bullet-list li {
        line-height: 1.6;
      }

      .bullet-list li,
      .task-body,
      .log-card p {
        color: var(--text);
      }

      .empty-item {
        color: var(--muted) !important;
      }

      .section-copy {
        display: grid;
        gap: 0.9rem;
      }

      .subsection {
        display: grid;
        gap: 0.75rem;
      }

      .priority-card h3,
      .summary-card h3 {
        margin-bottom: 0.7rem;
      }

      .task-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 1rem;
        margin-bottom: 0.7rem;
      }

      .task-status {
        display: inline-flex;
        align-items: center;
        padding: 0.3rem 0.65rem;
        border-radius: 999px;
        background: var(--accent-dim);
        color: var(--accent);
        font-size: 0.8rem;
        font-weight: 500;
        text-transform: uppercase;
        font-family: var(--font-mono);
      }

      .task-body {
        margin-bottom: 0.75rem;
      }

      .instruction-text {
        white-space: pre-wrap;
        color: var(--text);
      }

      .task-evidence {
        margin: 0;
        padding-left: 1.15rem;
        display: grid;
        gap: 0.45rem;
      }

      .log-card {
        display: grid;
        gap: 0.35rem;
      }

      .log-action {
        color: var(--text);
        font-weight: 700;
      }

      .log-meta {
        display: flex;
        flex-wrap: wrap;
        gap: 0.55rem;
        color: var(--muted);
        font-size: 0.84rem;
      }

      .mono {
        font-family: var(--font-mono);
        font-size: 0.86rem;
        overflow-wrap: anywhere;
      }

      .inline-link {
        color: var(--accent);
        font-weight: 700;
        text-decoration: none;
      }

      .inline-link:hover {
        text-decoration: underline;
      }

      @media (max-width: 980px) {
        .hero,
        .meta-grid,
        .card-grid,
        .split-grid,
        .priority-grid {
          grid-template-columns: 1fr;
        }
      }

      @media (max-width: 720px) {
        .page {
          width: min(100vw, calc(100vw - 1rem));
        }

        .report-topbar__inner {
          width: min(100vw, calc(100vw - 1rem));
          align-items: flex-start;
          flex-direction: column;
        }

        .section {
          padding: 1.1rem;
          border-radius: 12px;
        }
      }
    </style>
  </head>
  <body>
    <header class="report-topbar">
      <div class="report-topbar__inner">
        <div class="report-brand">
          <div class="logo-mark"></div>
          <div>
            <div class="brand-name">agentprobe</div>
            <div class="brand-sub">Task execution output</div>
          </div>
        </div>
        <div class="topbar-actions">
          <div class="topbar-chip">${escapeHtml(args.runId ? `Run ${args.runId}` : "Generated task output")}</div>
        </div>
      </div>
    </header>
    <main class="page">
      <section class="section hero">
        <div>
          <p class="eyebrow">Task Execution Output</p>
          <h1>${escapeHtml(args.website)}</h1>
          <p class="lead">${escapeHtml(template.executiveSummary.summary)}</p>
          <div class="meta-grid">
            <div class="summary-card">
              <div class="meta-label">Run Date</div>
              <div class="meta-value">${escapeHtml(template.executiveSummary.auditDate)}</div>
            </div>
            <div class="summary-card">
              <div class="meta-label">Visitor Lens</div>
              <div class="meta-value">${escapeHtml(args.persona)}</div>
            </div>
            <div class="summary-card">
              <div class="meta-label">Run Mode</div>
              <div class="meta-value">${escapeHtml(args.mobile ? "Mobile-sized browser run" : "Desktop-sized browser run")}</div>
            </div>
            <div class="summary-card">
              <div class="meta-label">Run ID</div>
              <div class="meta-value mono">${escapeHtml(args.runId ?? "Not provided")}</div>
            </div>
          </div>
        </div>
        <div class="score-card">
          <div class="meta-label">Overall Score</div>
          <div class="score-number">${escapeHtml(template.executiveSummary.overallScore)}</div>
          <div class="score-label">Accepted-task execution plus supporting diagnostics.</div>
        </div>
      </section>

      ${
        args.clickReplayArtifact
          ? `
            <section class="section">
              <h2>Activity Replay</h2>
              <div class="summary-card" style="padding: 0; overflow: hidden; background: #000; display: flex; justify-content: center; align-items: center; min-height: 400px; border: 1px solid var(--border2);">
                <img src="${args.clickReplayArtifact}" alt="Activity replay" style="max-width: 100%; max-height: 720px; display: block;" />
              </div>
              <p class="meta-label" style="margin-top: 0.8rem; text-align: center;">Animated replay of actions captured during this run.</p>
            </section>
          `
          : ""
      }

      <section class="section">
        <h2>1. Task Summary</h2>
        <div class="card-grid">
          <div class="summary-card">
            <h3>Key Strengths</h3>
            <ul class="bullet-list">${renderSimpleList(template.executiveSummary.keyStrengths)}</ul>
          </div>
          <div class="summary-card">
            <h3>Critical Issues</h3>
            <ul class="bullet-list">${renderSimpleList(template.executiveSummary.criticalIssues)}</ul>
          </div>
        </div>
        <div class="summary-card" style="margin-top: 0.9rem;">
          <h3>Business Impact</h3>
          <p>${escapeHtml(template.executiveSummary.businessImpact)}</p>
        </div>
        ${
          args.siteBrief
            ? `
              <div class="summary-card" style="margin-top: 0.9rem;">
                <h3>What This Site Appears To Do</h3>
                <p>${escapeHtml(args.siteBrief.summary)}</p>
                ${args.siteBrief.intendedUserActions.length > 0 ? `<ul class="bullet-list" style="margin-top: 0.8rem;">${renderSimpleList(args.siteBrief.intendedUserActions)}</ul>` : ""}
              </div>
            `
            : ""
        }
        ${
          (args.acceptedTasks?.length ?? 0) > 0 || args.instructionText?.trim()
            ? `
              <div class="summary-card" style="margin-top: 0.9rem;">
                <h3>Instructions I Followed</h3>
                ${(args.acceptedTasks?.length ?? 0) > 0 ? `<ul class="bullet-list">${renderSimpleList(args.acceptedTasks ?? [])}</ul>` : renderInstructionText(args.instructionText)}
              </div>
            `
            : ""
        }
        <div class="summary-card" style="margin-top: 0.9rem;">
          <h3>Accepted Task Outcomes</h3>
          <ul class="bullet-list">
            ${renderSimpleList(
              args.report.task_results.map(
                (task) => `${task.name}: ${formatTaskOutcome(task.status)}. ${task.reason}`
              )
            )}
          </ul>
        </div>
        ${
          args.report.gameplay_summary
            ? `
              <div class="summary-card" style="margin-top: 0.9rem;">
                <h3>Gameplay Results</h3>
                <p>${escapeHtml(args.report.gameplay_summary.summary)}</p>
                <ul class="bullet-list">
                  ${renderSimpleList([
                    `Rounds requested: ${args.report.gameplay_summary.roundsRequested}`,
                    `Rounds recorded: ${args.report.gameplay_summary.roundsRecorded}`,
                    `Wins: ${args.report.gameplay_summary.wins}`,
                    `Losses: ${args.report.gameplay_summary.losses}`,
                    `Draws: ${args.report.gameplay_summary.draws}`,
                    `Inconclusive rounds: ${args.report.gameplay_summary.inconclusiveRounds}`,
                    args.report.gameplay_summary.howToPlayConfirmed ? "How-to-play guidance was visibly confirmed." : "How-to-play guidance was not clearly confirmed.",
                    args.report.gameplay_summary.replayConfirmed ? "Replay or restart controls were visibly confirmed." : "Replay or restart controls were not clearly confirmed."
                  ])}
                </ul>
              </div>
            `
            : ""
        }
      </section>

      <section class="section">
        <h2>2. Performance Analysis</h2>
        ${renderToolList(template.performance.tools)}
        ${renderCoverageBlock(template.performance.coverage)}
        ${renderMetricTable(template.performance.metrics)}
        <div class="split-grid" style="margin-top: 0.95rem;">
          <div class="summary-card">
            <h3>Insights</h3>
            <ul class="bullet-list">${renderSimpleList(template.performance.insights)}</ul>
          </div>
          <div class="summary-card">
            <h3>Recommendations</h3>
            <ul class="bullet-list">${renderSimpleList(template.performance.recommendations)}</ul>
          </div>
        </div>
      </section>

      <section class="section">
        <h2>3. SEO Audit</h2>
        ${renderToolList(template.seo.tools)}
        ${renderCoverageBlock(template.seo.coverage)}
        <div class="section-copy">
          ${renderMetricGroups(template.seo.groups)}
        </div>
        <div class="summary-card" style="margin-top: 0.95rem;">
          <h3>Recommendations</h3>
          <ul class="bullet-list">${renderSimpleList(template.seo.recommendations)}</ul>
        </div>
      </section>

      <section class="section">
        <h2>4. UI/UX Evaluation</h2>
        ${renderCoverageBlock(template.uiux.coverage)}
        ${renderMetricTable(template.uiux.metrics)}
        <div class="split-grid" style="margin-top: 0.95rem;">
          <div class="summary-card">
            <h3>Key Issues</h3>
            <ul class="bullet-list">${renderSimpleList(template.uiux.issues)}</ul>
          </div>
          <div class="summary-card">
            <h3>Recommendations</h3>
            <ul class="bullet-list">${renderSimpleList(template.uiux.recommendations)}</ul>
          </div>
        </div>
      </section>

      <section class="section">
        <h2>5. Security Analysis</h2>
        ${renderToolList(template.security.tools)}
        ${renderCoverageBlock(template.security.coverage)}
        ${renderMetricTable(template.security.metrics)}
        <div class="summary-card" style="margin-top: 0.95rem;">
          <h3>Recommendations</h3>
          <ul class="bullet-list">${renderSimpleList(template.security.recommendations)}</ul>
        </div>
      </section>

      <section class="section">
        <h2>6. Technical Health</h2>
        ${renderCoverageBlock(template.technicalHealth.coverage)}
        ${renderMetricTable(template.technicalHealth.metrics)}
        <div class="summary-card" style="margin-top: 0.95rem;">
          <h3>Recommendations</h3>
          <ul class="bullet-list">${renderSimpleList(template.technicalHealth.recommendations)}</ul>
        </div>
      </section>

      <section class="section">
        <h2>7. Mobile Optimization</h2>
        ${renderCoverageBlock(template.mobileOptimization.coverage)}
        ${renderMetricTable(template.mobileOptimization.metrics)}
        <div class="summary-card" style="margin-top: 0.95rem;">
          <h3>Recommendations</h3>
          <ul class="bullet-list">${renderSimpleList(template.mobileOptimization.recommendations)}</ul>
        </div>
      </section>

      <section class="section">
        <h2>8. Content Quality</h2>
        ${renderCoverageBlock(template.contentQuality.coverage)}
        ${renderMetricTable(template.contentQuality.metrics)}
        <div class="summary-card" style="margin-top: 0.95rem;">
          <h3>Recommendations</h3>
          <ul class="bullet-list">${renderSimpleList(template.contentQuality.recommendations)}</ul>
        </div>
      </section>

      <section class="section">
        <h2>9. Conversion Optimization (CRO)</h2>
        ${renderCoverageBlock(template.cro.coverage)}
        ${renderMetricTable(template.cro.metrics)}
        <div class="summary-card" style="margin-top: 0.95rem;">
          <h3>Recommendations</h3>
          <ul class="bullet-list">${renderSimpleList(template.cro.recommendations)}</ul>
        </div>
      </section>

      <section class="section">
        <h2>10. Action Plan (Prioritized)</h2>
        <div class="priority-grid">
          <div class="priority-card">
            <h3>High Priority</h3>
            <ul class="bullet-list">${renderSimpleList(template.actionPlan.high)}</ul>
          </div>
          <div class="priority-card">
            <h3>Medium Priority</h3>
            <ul class="bullet-list">${renderSimpleList(template.actionPlan.medium)}</ul>
          </div>
        </div>
        <div class="priority-card" style="margin-top: 0.9rem;">
          <h3>Low Priority</h3>
          <ul class="bullet-list">${renderSimpleList(template.actionPlan.low)}</ul>
        </div>
      </section>

      <section class="section">
        <h2>11. Final Score Breakdown</h2>
        ${renderMetricTable(
          template.scoreBreakdown.map((item) => ({
            label: item.category,
            value: item.score,
            status: item.category === "Overall"
              ? (args.report.overall_score >= 8 ? "good" : args.report.overall_score >= 6 ? "warning" : "poor")
              : "warning",
            verification: item.category === "Overall" ? "verified" : "inferred"
          }))
        )}
      </section>

      <section class="section">
        <h2>12. Agent Notes</h2>
        <div class="card-grid">
          <div class="summary-card">
            <h3>Confidence Level</h3>
            <p>${escapeHtml(template.agentNotes.confidence)}</p>
          </div>
          <div class="summary-card">
            <h3>Data Sources Used</h3>
            <ul class="bullet-list">${renderSimpleList(template.agentNotes.dataSources)}</ul>
          </div>
        </div>
        <div class="summary-card" style="margin-top: 0.9rem;">
          <h3>Limitations of Analysis</h3>
          <ul class="bullet-list">${renderSimpleList(template.agentNotes.limitations)}</ul>
        </div>
      </section>

      ${renderZGProofSection(args.report)}

      <section class="section">
        <h2>Appendix: Task Evidence</h2>
        <div class="task-grid">
          ${args.report.task_results
            .map(
              (task) => `
                <article class="task-card">
                  <div class="task-head">
                    <h3>${escapeHtml(task.name)}</h3>
                    <span class="task-status">${escapeHtml(task.status)}</span>
                  </div>
                  <p class="task-body">${escapeHtml(task.reason)}</p>
                  <ul class="task-evidence">
                    ${renderSimpleList(task.evidence)}
                  </ul>
                </article>
              `
            )
            .join("")}
        </div>
      </section>

      ${
        sessionLog.length > 0
          ? `
            <section class="section">
              <h2>Appendix: Interaction Log</h2>
              <div class="log-grid">
                ${sessionLog
                  .slice(0, 18)
                  .map(
                    (item) => `
                      <article class="log-card">
                        <div class="log-action">${escapeHtml(item.action)}</div>
                        <div class="log-meta">
                          <span>${escapeHtml(item.task)}</span>
                          <span>${escapeHtml(formatLogTime(item.time, args.timeZone))}</span>
                          <span class="mono">${escapeHtml(item.url)}</span>
                        </div>
                        <p>${escapeHtml(item.outcome)}</p>
                      </article>
                    `
                  )
                  .join("")}
              </div>
            </section>
          `
          : ""
      }
    </main>
  </body>
</html>`;
}
