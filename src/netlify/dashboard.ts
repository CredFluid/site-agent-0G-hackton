import { z } from "zod";
import {
  buildRunDetail as buildBackendRunDetail,
  buildRunSummary as buildBackendRunSummary,
  buildStandaloneReportHtml as buildBackendStandaloneReportHtml,
  loadDashboardData as loadBackendDashboardData
} from "../backend/dashboardData.js";
import { renderHtmlReport } from "../reporting/html.js";
import { AccessibilityResultSchema, FinalReportSchema, SiteChecksSchema, TaskRunResultSchema } from "../schemas/types.js";
import {
  DashboardRunDetailSchema,
  DashboardRunSummarySchema,
  RunInputsSchema,
  type DashboardRunDetail,
  type DashboardRunSummary,
  type RunInputs
} from "../dashboard/contracts.js";
import { buildVisitRecap, buildVisitSummary, filterVisitorFacingItems } from "../dashboard/narrative.js";
import { DASHBOARD_CSS as SHARED_DASHBOARD_CSS, DASHBOARD_HEAD_TAGS } from "../dashboard/theme.js";
import { createNetlifyRunRepository, listRunIds, readRunArtifactBinary, readRunArtifactJson, readRunArtifactText } from "./storage.js";

const TaskRunResultsSchema = z.array(TaskRunResultSchema);
const RawEventsSchema = z.array(z.unknown());

type AgentCardModel = {
  idLabel: string;
  persona: string;
  summary: string;
  score: number | null;
  stateClass: string;
  pipClass: string;
  progressClass: string;
  progressWidth: number;
  runId: string | null;
  selected: boolean;
};

type FeedbackItem = {
  source: string;
  text: string;
  tagLabel: string;
  tagClass: string;
};

type IssueItem = {
  iconClass: string;
  iconLabel: string;
  text: string;
  countLabel: string;
};

type ActivityItem = {
  time: string;
  idLabel: string | null;
  text: string;
};

const SIDEBAR_COLLAPSE_STORAGE_KEY = "agentprobe:dashboard-sidebar-collapsed";
const SUMMARY_RAIL_COLLAPSE_STORAGE_KEY = "agentprobe:dashboard-summary-collapsed";
const netlifyRunRepository = createNetlifyRunRepository();

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
  .pill--score-high, .pill--status-success, .pill--status-completed, .pill--friction-none { color: #0f5f56; background: rgba(23, 111, 105, 0.12); }
  .pill--score-mid, .pill--status-partial_success, .pill--status-queued, .pill--status-running, .pill--friction-low, .pill--friction-medium { color: #8a5f08; background: rgba(183, 129, 27, 0.14); }
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
  .visit-recap {
    display: grid;
    gap: 0.9rem;
    margin-top: 1rem;
  }
  .visit-recap__line {
    margin: 0;
    max-width: 74ch;
    font-size: 1.02rem;
    line-height: 1.7;
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

function formatDashboardDate(value: string | null | undefined): string {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) {
    return value ?? "Today";
  }

  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    day: "2-digit",
    month: "short",
    year: "numeric"
  }).format(date);
}

function formatClock(value: string | null | undefined, timeZone?: string | null): string {
  if (!value) {
    return "--:--";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
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

function formatScore(score: number | null | undefined): string {
  if (score === null || score === undefined) {
    return "n/a";
  }

  return Number.isInteger(score) ? `${score}` : score.toFixed(1);
}

function computeAverageScore(runs: DashboardRunSummary[]): number | null {
  const scores = runs
    .map((run) => run.overallScore)
    .filter((score): score is number => score !== null);

  if (scores.length === 0) {
    return null;
  }

  const average = scores.reduce((sum, score) => sum + score, 0) / scores.length;
  return Math.round(average * 10) / 10;
}

function safeHref(url: string): string | null {
  return /^https?:\/\//i.test(url) ? url : null;
}

function buildArtifactHref(runId: string, fileName: string | null | undefined): string | null {
  const normalized = fileName?.trim();
  if (!normalized) {
    return null;
  }

  return `/api/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(normalized)}`;
}

function displayAgentPersona(profileLabel: string | null | undefined, fallback: string): string {
  const trimmed = profileLabel?.trim();
  return trimmed ? trimmed : fallback;
}

function describeClickReplay(inputs: RunInputs | null): string {
  if (!inputs?.clickReplayArtifact) {
    return "";
  }

  const frameLabel =
    inputs.clickReplayFrameCount && inputs.clickReplayFrameCount > 0
      ? `${inputs.clickReplayFrameCount} frame${inputs.clickReplayFrameCount === 1 ? "" : "s"}`
      : "saved click frames";
  const durationLabel =
    inputs.clickReplayDurationMs && inputs.clickReplayDurationMs > 0
      ? ` over ${(Math.round((inputs.clickReplayDurationMs / 1000) * 10) / 10).toFixed(1)}s`
      : "";

  return `Compact animated WebP with highlighted click targets, built from ${frameLabel}${durationLabel}.`;
}

function renderClickReplayStatus(detail: DashboardRunDetail): string {
  const inputs = detail.inputs;
  const clickReplayHref = buildArtifactHref(detail.id, inputs?.clickReplayArtifact);

  if (clickReplayHref) {
    return `
      <div class="warning-note" style="margin-top: 12px;"><strong>Click replay.</strong> ${escapeHtml(describeClickReplay(inputs))}</div>
      <div class="step-proof" style="margin-top: 12px;">
        <figure class="proof-shot">
          <a href="${escapeHtml(clickReplayHref)}" target="_blank" rel="noreferrer">
            <img src="${escapeHtml(clickReplayHref)}" alt="Animated click replay for this run" loading="lazy" />
          </a>
          <figcaption>Animated WebP replay</figcaption>
        </figure>
      </div>
    `;
  }

  if (inputs?.batchRole === "aggregate" && (inputs.agentRuns?.length ?? 0) > 0) {
    const agentReplayLinks = inputs.agentRuns
      .filter((agentRun) => Boolean(agentRun.runId))
      .sort((left, right) => left.index - right.index)
      .map((agentRun) => {
        const childRunId = agentRun.runId as string;
        const runHref = `/dashboard?run=${encodeURIComponent(childRunId)}`;
        const replayHref =
          agentRun.clickReplayAvailable || agentRun.clickReplayArtifact
            ? buildArtifactHref(childRunId, agentRun.clickReplayArtifact ?? "click-replay.webp")
            : null;

        return `
          <div class="link-row" style="margin-top: 8px;">
            <strong>${escapeHtml(displayAgentPersona(agentRun.profileLabel, agentRun.label))}</strong>
            <a class="inline-link" href="${escapeHtml(runHref)}">Open run</a>
            ${replayHref ? `<a class="inline-link" href="${escapeHtml(replayHref)}" target="_blank" rel="noreferrer">Open replay</a>` : `<span class="muted">Replay unavailable</span>`}
          </div>
        `;
      })
      .join("");

    return `
      <div class="warning-note" style="margin-top: 12px;"><strong>Click replay.</strong> This is the aggregate summary run. Use the links below to open each agent run directly, or jump straight into an available replay.</div>
      ${agentReplayLinks}
    `;
  }

  return `<div class="warning-note" style="margin-top: 12px;"><strong>Click replay.</strong> No click actions were recorded in this run, so there was nothing to turn into a replay.</div>`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function classifyFinding(text: string, positive = false): Pick<FeedbackItem, "tagClass" | "tagLabel"> {
  if (positive) {
    return { tagClass: "tag-pos", tagLabel: "GOOD" };
  }

  if (/(slow|lag|latency|performance|preload|asset|websocket|load)/i.test(text)) {
    return { tagClass: "tag-perf", tagLabel: "PERF" };
  }

  if (/(bug|error|broken|fail|failed|missing|hidden|did not|didn't|could not|can't|cannot|not respond|unclear)/i.test(text)) {
    return { tagClass: "tag-bug", tagLabel: "BUG" };
  }

  return { tagClass: "tag-ux", tagLabel: "UX" };
}

function classifyIssue(text: string): Pick<IssueItem, "iconClass" | "iconLabel"> {
  if (/(slow|lag|latency|performance|preload|asset|websocket|load)/i.test(text)) {
    return { iconClass: "i-info", iconLabel: "i" };
  }

  if (/(bug|error|broken|fail|failed|missing|hidden|did not|didn't|could not|can't|cannot|not respond)/i.test(text)) {
    return { iconClass: "i-bug", iconLabel: "!" };
  }

  return { iconClass: "i-ux", iconLabel: "~" };
}

function formatAgentId(index: number): string {
  return `AGT-${String(index).padStart(2, "0")}`;
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

function formatAgentCount(agentCount: number): string {
  return `${agentCount} agent${agentCount === 1 ? "" : "s"}`;
}

function describeBatchRole(batchRole: RunInputs["batchRole"], agentCount: number): string {
  if (batchRole === "aggregate") {
    return `${formatAgentCount(agentCount)} task panel`;
  }

  if (batchRole === "child") {
    return "Individual agent run";
  }

  return "Single-agent run";
}

function isVisibleDashboardRun(run: DashboardRunSummary): boolean {
  return run.batchRole !== "child";
}

export async function buildRunSummary(runId: string): Promise<DashboardRunSummary> {
  return buildBackendRunSummary(netlifyRunRepository, runId);
}

async function enrichAgentRunsWithReplay(agentRuns: RunInputs["agentRuns"]): Promise<RunInputs["agentRuns"]> {
  return Promise.all(
    agentRuns.map(async (agentRun) => {
      const childRunId = agentRun.runId?.trim();
      if (!childRunId) {
        return agentRun;
      }

      const clickReplayAvailable = (await readRunArtifactBinary(childRunId, "click-replay.webp")) !== null;
      return {
        ...agentRun,
        clickReplayAvailable,
        clickReplayArtifact: clickReplayAvailable ? "click-replay.webp" : null
      };
    })
  );
}

export async function buildRunDetail(runId: string): Promise<DashboardRunDetail | null> {
  return buildBackendRunDetail(netlifyRunRepository, runId);
}

export async function buildStandaloneReportHtml(runId: string): Promise<string | null> {
  return buildBackendStandaloneReportHtml(netlifyRunRepository, runId);
}

export async function loadDashboardData(selectedRunId: string | null): Promise<{
  runs: DashboardRunSummary[];
  detail: DashboardRunDetail | null;
  selectedRunId: string | null;
}> {
  return loadBackendDashboardData(netlifyRunRepository, selectedRunId);
}

function renderRunList(runs: DashboardRunSummary[], selectedRunId: string | null): string {
  if (runs.length === 0) {
    return `<div class="empty-stack"><div><h3>No runs yet</h3><p class="muted">Your first finished task run will appear here automatically.</p></div></div>`;
  }

  return runs
    .map((run) => {
      const isActive = run.id === selectedRunId;
      const summary = run.summary ?? "This run does not have a saved summary yet.";
      const scoreLabel = formatScore(run.overallScore);
      const modes = [
        describeBatchRole(run.batchRole, run.agentCount),
        run.mobile ? "Mobile" : "Desktop",
        run.headed ? "Headed" : "Headless",
        run.batchRole === "aggregate"
          ? `${run.completedAgentCount}/${run.agentCount} complete${run.failedAgentCount > 0 ? ` · ${run.failedAgentCount} failed` : ""}`
          : null
      ];

      return `
        <a href="/dashboard?run=${encodeURIComponent(run.id)}" class="run-link ${isActive ? "run-link--active" : ""}">
          <div class="run-topline">
            <div>
              <div class="run-host">${escapeHtml(run.host)}</div>
              <div class="muted">${escapeHtml(formatDate(run.startedAt))}</div>
            </div>
            <span class="pill pill--score-${scoreTone(run.overallScore)}">${escapeHtml(scoreLabel)}</span>
          </div>
          <p class="run-summary">${escapeHtml(summary)}</p>
          <div class="mini-meta">
            ${modes.filter((mode): mode is string => Boolean(mode)).map((mode) => `<span>${escapeHtml(mode)}</span>`).join("")}
          </div>
        </a>
      `;
    })
    .join("");
}

function renderMetricsGrid(runs: DashboardRunSummary[], detail: DashboardRunDetail | null): string {
  const totalRuns = runs.length;
  const totalAgents = runs.reduce((sum, run) => sum + run.agentCount, 0);
  const selectedInputs = detail?.inputs;
  const findingsCount = detail
    ? filterVisitorFacingItems(detail.report?.weaknesses ?? []).length +
      filterVisitorFacingItems(detail.report?.top_fixes ?? []).length +
      (detail.accessibility?.violations.length ?? 0)
    : 0;
  const latestRun = runs[0] ?? null;
  const averageScore = computeAverageScore(runs);

  return `
    <section class="metrics-grid">
      <article class="metric-card">
        <div class="metric-label">Total runs</div>
        <div class="metric-val">${totalRuns}</div>
        <div class="metric-delta ${totalRuns > 0 ? "delta-up" : ""}">${escapeHtml(latestRun ? `Latest ${formatDate(latestRun.startedAt)}` : "Waiting for the first task run")}</div>
      </article>
      <article class="metric-card">
        <div class="metric-label">Agents deployed</div>
        <div class="metric-val">${totalAgents}</div>
        <div class="metric-delta">${escapeHtml(detail ? `${selectedInputs?.agentCount ?? 1} in this run` : "Across saved runs")}</div>
      </article>
      <article class="metric-card">
        <div class="metric-label">Issues found</div>
        <div class="metric-val" style="color: var(--red);">${detail ? findingsCount : 0}</div>
        <div class="metric-delta ${findingsCount > 0 ? "delta-down" : ""}">${escapeHtml(detail ? "From the selected run" : "Open a run to inspect findings")}</div>
      </article>
      <article class="metric-card">
        <div class="metric-label">Avg UX score</div>
        <div class="metric-val" style="color: var(--accent);">${escapeHtml(formatScore(averageScore))}</div>
        <div class="metric-delta ${averageScore !== null && averageScore >= 7 ? "delta-up" : averageScore !== null ? "delta-down" : ""}">${escapeHtml(detail?.report ? `Selected run ${formatScore(detail.report.overall_score)}/10` : "Across scored runs")}</div>
      </article>
    </section>
  `;
}

function renderNewTestCard(detail: DashboardRunDetail | null): string {
  const urlValue = detail?.inputs?.baseUrl ?? "";
  const selectedAgents = String(detail?.inputs?.agentCount ?? 1);
  const submittedInstructions = detail?.inputs?.instructionText ?? detail?.inputs?.customTasks?.join("\n") ?? "";

  return `
    <form class="new-test-card" id="new-test" method="POST" action="/submit" enctype="multipart/form-data">
      <div class="card-title">New test</div>
      <div class="url-row">
        <input class="url-input" name="url" type="url" value="${escapeHtml(urlValue)}" placeholder="https://app.yourproduct.com" required />
        <button class="btn btn-primary" type="submit">▶ Start task run</button>
      </div>
      <p class="task-intro">Paste the instructions in one box or upload a text or JSON file. The agents will first understand what the site appears to be for, then perform only the instructions you supplied.</p>
      <div class="instruction-panel">
        <label>
          <span class="instruction-label">Instructions</span>
          <textarea class="instruction-input" name="instructions" placeholder="- Check what a new user is meant to do first&#10;- Try the pricing path and explain whether it is clear&#10;- Stop before entering private details">${escapeHtml(submittedInstructions)}</textarea>
        </label>
      </div>
      <div class="file-input-row">
        <label>
          <span class="instruction-label">Instruction file (optional)</span>
          <input class="file-input" type="file" name="instructions_file" accept=".txt,.md,.json,.csv,text/plain,application/json" />
        </label>
      </div>
      <div class="config-row">
        <select class="config-select" name="agents">
          ${[1, 2, 3, 4, 5]
            .map((count) => `<option value="${count}" ${selectedAgents === `${count}` ? "selected" : ""}>${count} ${count === 1 ? "agent" : "agents"}</option>`)
            .join("")}
        </select>
        <span class="tag on">task-driven</span>
        <span class="tag on">dashboard input only</span>
        <span class="tag on">no fallback personas</span>
      </div>
    </form>
  `;
}

function buildAgentCards(detail: DashboardRunDetail, selectedRunId: string | null): AgentCardModel[] {
  const inputs = detail.inputs;

  const displayAgentPersona = (profileLabel: string | null | undefined, fallback: string): string => {
    const trimmed = profileLabel?.trim();
    return trimmed ? trimmed : fallback;
  };

  if (inputs?.batchRole === "aggregate" && inputs.agentRuns.length > 0) {
    return inputs.agentRuns
      .slice()
      .sort((left, right) => left.index - right.index)
      .map((agentRun) => {
        const status = agentRun.status;
        const summary =
          agentRun.reportSummary ??
          agentRun.error ??
          (status === "completed"
            ? "Finished the accepted tasks and submitted final outcomes."
            : status === "failed"
              ? "The run ended with an error before the accepted tasks could finish."
              : status === "running"
                ? "Still working through the accepted tasks."
                : "Queued and waiting to start.");

        return {
          idLabel: formatAgentId(agentRun.index),
          persona: displayAgentPersona(agentRun.profileLabel, agentRun.label),
          summary,
          score: agentRun.overallScore,
          stateClass:
            status === "completed" ? "st-done" : status === "running" ? "st-active" : status === "failed" ? "st-error" : "st-idle",
          pipClass:
            status === "completed" ? "pip-green" : status === "running" ? "pip-blue" : status === "failed" ? "pip-amber" : "pip-gray",
          progressClass: status === "completed" ? "prog-green" : status === "running" ? "prog-blue" : "prog-amber",
          progressWidth: status === "completed" ? 100 : status === "running" ? 62 : status === "failed" ? 100 : 18,
          runId: agentRun.runId,
          selected: agentRun.runId === selectedRunId
        };
      });
  }

  const batchRole = inputs?.batchRole ?? "single";
  const persona =
    batchRole === "child"
      ? inputs?.agentProfileLabel ?? inputs?.agentLabel ?? "Focused task runner"
      : inputs?.persona ?? "Human visitor";

  return [
    {
      idLabel: batchRole === "child" ? formatAgentId(inputs?.agentIndex ?? 1) : "AGT-01",
      persona,
      summary: buildVisitSummary(detail),
      score: detail.report?.overall_score ?? null,
      stateClass: detail.report ? "st-done" : "st-idle",
      pipClass: detail.report ? "pip-green" : "pip-gray",
      progressClass: detail.report ? "prog-green" : "prog-amber",
      progressWidth: detail.report ? 100 : 24,
      runId: detail.id,
      selected: true
    }
  ];
}

function buildFeedbackItems(detail: DashboardRunDetail): FeedbackItem[] {
  const report = detail.report;
  const inputs = detail.inputs;
  const items: FeedbackItem[] = [];

  if (inputs?.batchRole === "aggregate") {
    for (const agentRun of inputs.agentRuns.slice().sort((left, right) => left.index - right.index)) {
      const summary = agentRun.reportSummary ?? agentRun.error;
      if (!summary) {
        continue;
      }

      const classification =
        agentRun.status === "completed" && (agentRun.overallScore ?? 0) >= 8
          ? { tagClass: "tag-pos", tagLabel: "GOOD" }
          : agentRun.status === "failed"
            ? { tagClass: "tag-bug", tagLabel: "BUG" }
            : classifyFinding(summary);

      items.push({
        source: formatAgentId(agentRun.index),
        text: summary,
        tagClass: classification.tagClass,
        tagLabel: classification.tagLabel
      });
    }
  }

  for (const strength of filterVisitorFacingItems(report?.strengths ?? []).slice(0, 2)) {
    const classification = classifyFinding(strength, true);
    items.push({
      source: "VISIT",
      text: strength,
      tagClass: classification.tagClass,
      tagLabel: classification.tagLabel
    });
  }

  for (const weakness of filterVisitorFacingItems(report?.weaknesses ?? []).slice(0, 4)) {
    const classification = classifyFinding(weakness);
    items.push({
      source: "VISIT",
      text: weakness,
      tagClass: classification.tagClass,
      tagLabel: classification.tagLabel
    });
  }

  for (const fix of filterVisitorFacingItems(report?.top_fixes ?? []).slice(0, 2)) {
    items.push({
      source: "FIX",
      text: fix,
      tagClass: "tag-ux",
      tagLabel: "FIX"
    });
  }

  for (const violation of detail.accessibility?.violations.slice(0, 2) ?? []) {
    items.push({
      source: "AXE",
      text: `${violation.help} (${violation.nodes} affected ${violation.nodes === 1 ? "node" : "nodes"})`,
      tagClass: "tag-bug",
      tagLabel: "A11Y"
    });
  }

  return items.slice(0, 8);
}

function buildIssueItems(detail: DashboardRunDetail): IssueItem[] {
  const issues: IssueItem[] = [];

  for (const weakness of filterVisitorFacingItems(detail.report?.weaknesses ?? []).slice(0, 3)) {
    const classification = classifyIssue(weakness);
    issues.push({
      iconClass: classification.iconClass,
      iconLabel: classification.iconLabel,
      text: weakness,
      countLabel: "Observed"
    });
  }

  for (const violation of detail.accessibility?.violations.slice(0, 1) ?? []) {
    issues.push({
      iconClass: "i-bug",
      iconLabel: "!",
      text: violation.help,
      countLabel: `${violation.nodes} ${violation.nodes === 1 ? "node" : "nodes"}`
    });
  }

  for (const fix of filterVisitorFacingItems(detail.report?.top_fixes ?? []).slice(0, 1)) {
    issues.push({
      iconClass: "i-info",
      iconLabel: "i",
      text: fix,
      countLabel: "Fix first"
    });
  }

  if (issues.length === 0) {
    issues.push({
      iconClass: "i-info",
      iconLabel: "i",
      text: "No major issues were recorded for this visit.",
      countLabel: "Clear"
    });
  }

  return issues.slice(0, 4);
}

function buildPersonaChips(detail: DashboardRunDetail): string[] {
  const inputs = detail.inputs;

  if (inputs?.batchRole === "aggregate" && inputs.agentRuns.length > 0) {
    const profileLabels = Array.from(
      new Set(
        inputs.agentRuns
          .map((agentRun) => agentRun.profileLabel.trim())
          .filter(Boolean)
      )
    );

    if (profileLabels.length > 0) {
      return profileLabels;
    }
  }

  if (inputs?.agentProfileLabel) {
    return [inputs.agentProfileLabel];
  }

  if (inputs?.persona) {
    return [inputs.persona];
  }

  return ["Human visitor"];
}

function getActionDescription(action: string, target: string): string {
  const trimmedTarget = target.trim();

  switch (action) {
    case "click":
      return trimmedTarget ? `I clicked "${trimmedTarget}"` : "I clicked an element";
    case "type":
      return trimmedTarget ? `I typed into "${trimmedTarget}"` : "I typed into a field";
    case "scroll":
      return "I scrolled the page";
    case "wait":
      return "I waited for the page to respond";
    case "back":
      return "I went back";
    case "extract":
      return "I captured the page state";
    case "stop":
      return "I stopped";
    default:
      return `I performed "${action}"`;
  }
}

function buildActivityItems(detail: DashboardRunDetail): ActivityItem[] {
  const inputs = detail.inputs;
  const timezone = inputs?.synchronizedTimezone ?? null;

  if (inputs?.batchRole === "aggregate" && inputs.agentRuns.length > 0) {
    return inputs.agentRuns
      .slice()
      .sort((left, right) => {
        const rightTime = new Date(right.completedAt ?? right.startedAt ?? 0).getTime();
        const leftTime = new Date(left.completedAt ?? left.startedAt ?? 0).getTime();
        return rightTime - leftTime;
      })
      .map((agentRun) => ({
        time: formatClock(agentRun.completedAt ?? agentRun.startedAt, timezone),
        idLabel: formatAgentId(agentRun.index),
        text:
          agentRun.status === "completed"
            ? `completed the visit · ${formatScore(agentRun.overallScore)}/10`
            : agentRun.status === "failed"
              ? `stopped with an error${agentRun.error ? ` · ${agentRun.error}` : ""}`
              : agentRun.status === "running"
                ? "is still moving through the site"
                : "is queued for launch"
      }))
      .slice(0, 5);
  }

  const history = detail.tasks
    .flatMap((task) => task.history)
    .slice()
    .sort((left, right) => new Date(right.time).getTime() - new Date(left.time).getTime());

  return history.slice(0, 5).map((entry) => ({
    time: formatClock(entry.time, timezone),
    idLabel: null,
    text: `${getActionDescription(entry.decision.action, entry.decision.target)} · ${entry.result.note}`
  }));
}

function renderAgentGrid(detail: DashboardRunDetail, selectedRunId: string | null): string {
  const inputs = detail.inputs;
  const report = detail.report;
  const batchRole = inputs?.batchRole ?? "single";
  const badgeClass =
    batchRole === "aggregate" && (inputs?.completedAgentCount ?? 0) < (inputs?.agentCount ?? 1)
      ? "live-badge"
      : detail.warnings.length > 0
        ? "live-badge warning"
        : "live-badge";
  const badgeLabel =
    batchRole === "aggregate" && (inputs?.completedAgentCount ?? 0) < (inputs?.agentCount ?? 1)
      ? "LIVE"
      : detail.warnings.length > 0
        ? "CHECK"
        : "SAVED";
  const cards = buildAgentCards(detail, selectedRunId);
  const feedbackItems = buildFeedbackItems(detail);
  const subtitle =
    batchRole === "aggregate"
      ? `${inputs?.completedAgentCount ?? 0} of ${inputs?.agentCount ?? 1} complete${(inputs?.failedAgentCount ?? 0) > 0 ? ` · ${inputs?.failedAgentCount ?? 0} failed` : ""}`
      : `${detail.tasks.length} accepted ${detail.tasks.length === 1 ? "task" : "tasks"} · ${report ? `${formatScore(report.overall_score)}/10 overall` : "output pending"}`;

  return `
    <section class="panel" id="live-run">
      <div class="panel-head">
        <div class="${badgeClass}"><div class="live-dot${detail.warnings.length > 0 ? " warning" : ""}"></div>${escapeHtml(badgeLabel)}</div>
        <div>
          <div class="panel-title">${escapeHtml(`${detail.host} · ${describeBatchRole(batchRole, inputs?.agentCount ?? 1)}`)}</div>
          <div class="panel-sub">${escapeHtml(subtitle)}</div>
        </div>
        <div class="panel-actions">
          <a class="icon-btn" href="/outputs/${encodeURIComponent(detail.id)}" target="_blank" rel="noreferrer">↗ Full output</a>
          <a class="icon-btn" href="/api/runs/${encodeURIComponent(detail.id)}/artifacts/report.json">↓ JSON output</a>
        </div>
      </div>
      <div class="agents-grid">
        ${cards
          .map((card) => {
            const inner = `
              <div class="agent-num">
                <span>${escapeHtml(card.idLabel)}</span>
                <span class="status-pip ${card.pipClass}"></span>
              </div>
              <div class="agent-persona">${escapeHtml(card.persona)}</div>
              <div class="agent-doing">${escapeHtml(card.summary)}</div>
              <div class="agent-score ${card.score === null ? "score-muted" : card.score >= 8 ? "score-green" : card.score >= 5 ? "score-amber" : "score-red"}">${escapeHtml(card.score === null ? "..." : `${formatScore(card.score)}/10`)}</div>
              <div class="prog-track"><div class="prog-fill ${card.progressClass}" style="width:${card.progressWidth}%"></div></div>
            `;

            return card.runId
              ? `<a href="/dashboard?run=${encodeURIComponent(card.runId)}" class="agent-card ${card.stateClass} ${card.selected ? "selected" : ""}">${inner}</a>`
              : `<article class="agent-card ${card.stateClass} ${card.selected ? "selected" : ""}">${inner}</article>`;
          })
          .join("")}
      </div>
      <div style="padding: 0 16px 6px;">
        <div class="card-title">Live feedback stream</div>
      </div>
      <div class="feedback-list">
        ${
          feedbackItems.length > 0
            ? feedbackItems
                .map(
                  (item) => `
                    <article class="fb-item">
                      <div class="fb-top">
                        <span class="fb-agent">${escapeHtml(item.source)}</span>
                        <span class="fb-tag ${item.tagClass}">${escapeHtml(item.tagLabel)}</span>
                      </div>
                      <div class="fb-text">${escapeHtml(item.text)}</div>
                    </article>
                  `
                )
                .join("")
            : `<div class="warning-note">Feedback will appear here once the run records strengths, issues, or accessibility findings.</div>`
        }
      </div>
    </section>
  `;
}

function renderListPanel(title: string, items: string[], emptyCopy: string): string {
  return `
    <section class="panel">
      <div class="panel-head">
        <div class="panel-title">${escapeHtml(title)}</div>
      </div>
      <div class="panel-body">
        ${
          items.length > 0
            ? `<ul class="prose-list">${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
            : `<div class="warning-note">${escapeHtml(emptyCopy)}</div>`
        }
      </div>
    </section>
  `;
}

function renderTaskCard(detail: DashboardRunDetail, task: DashboardRunDetail["tasks"][number]): string {
  const finalHref = safeHref(task.finalUrl);
  const timeZone = detail.inputs?.synchronizedTimezone ?? null;
  const historyHtml =
    task.history.length > 0
      ? task.history
          .map((entry) => {
            const stepHref = safeHref(entry.url);
            const actionText = getActionDescription(entry.decision.action, entry.decision.target);

            return `
              <article class="history-card">
                <div class="history-head">
                  <strong>Step ${entry.step}</strong>
                  <span class="pill pill--friction-${escapeHtml(entry.decision.friction)}">${escapeHtml(humanize(entry.decision.friction))} friction</span>
                </div>
                ${
                  entry.decision.instructionQuote
                    ? `<p><strong>Page Step${entry.decision.stepNumber ? ` ${escapeHtml(String(entry.decision.stepNumber))}` : ""}:</strong> ${escapeHtml(entry.decision.instructionQuote)}</p>`
                    : ""
                }
                <p><strong>${escapeHtml(actionText)}</strong></p>
                <p>${escapeHtml(entry.decision.expectation)}</p>
                <p>${escapeHtml(entry.result.note)}</p>
                <div class="history-meta">
                  <span>${escapeHtml(entry.title || "Untitled page")}</span>
                  <span>${escapeHtml(formatDate(entry.time, timeZone))}</span>
                </div>
                <div class="link-row">
                  ${
                    stepHref
                      ? `<a class="inline-link" href="${escapeHtml(stepHref)}" target="_blank" rel="noreferrer">Open page</a>`
                      : `<span class="muted">No page URL was recorded.</span>`
                  }
                </div>
              </article>
            `;
          })
          .join("")
      : `<div class="warning-note">No step-by-step history was recorded for this part of the visit.</div>`;

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
        <span>${escapeHtml(`${task.history.length} steps recorded`)}</span>
        <span>${escapeHtml(task.finalTitle || "No final page title recorded")}</span>
      </div>
      <div class="link-row">
        ${
          finalHref
            ? `<a class="inline-link" href="${escapeHtml(finalHref)}" target="_blank" rel="noreferrer">Open final URL</a>`
            : `<span class="muted">No final URL was recorded.</span>`
        }
      </div>
      ${
        task.evidence.length > 0
          ? `<ul class="evidence-list">${task.evidence.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
          : `<div class="warning-note" style="margin-top: 12px;">No extra evidence bullets were saved for this section.</div>`
      }
      <details class="task-details">
        <summary>Interaction timeline</summary>
        <div class="history-grid">
          ${historyHtml}
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
    return `<div class="warning-note">No accessibility violations were recorded for this run.</div>`;
  }

  return `
    <div class="accessibility-grid">
      ${accessibility.violations
        .map(
          (violation) => `
            <article class="violation-card">
              <div class="section-heading">
                <h3>${escapeHtml(violation.id)}</h3>
                <span class="pill pill--score-${scoreTone(violation.impact ? 3 : 6)}">${escapeHtml(violation.impact ?? "unknown impact")}</span>
              </div>
              <p>${escapeHtml(violation.description)}</p>
              <p><strong>Help:</strong> ${escapeHtml(violation.help)}</p>
              <div class="helper-row">
                <span>${escapeHtml(`${violation.nodes} affected ${violation.nodes === 1 ? "node" : "nodes"}`)}</span>
              </div>
            </article>
          `
        )
        .join("")}
    </div>
  `;
}

function renderSummaryRail(detail: DashboardRunDetail): string {
  const report = detail.report;
  const issues = buildIssueItems(detail);
  const personas = buildPersonaChips(detail);
  const activityItems = buildActivityItems(detail);
  const overallScore = report?.overall_score ?? null;

  return `
    <aside class="panel summary-rail" data-summary-rail>
      <div class="panel-head">
        <div class="panel-title">Run summary</div>
        <div class="panel-actions">
          <a class="icon-btn" data-summary-share href="/outputs/${encodeURIComponent(detail.id)}" target="_blank" rel="noreferrer">⎘ Share output</a>
          <button class="icon-btn summary-toggle" type="button" data-summary-toggle aria-expanded="true" aria-label="Collapse run summary">
            <span aria-hidden="true">◂</span>
            <span class="summary-toggle-label">Hide</span>
          </button>
        </div>
      </div>

      <div class="summary-rail-body">
        <div class="summary-section">
          <div class="ss-label">Overall score</div>
          <div class="big-score">${escapeHtml(formatScore(overallScore))}<span class="score-dim">/10</span></div>
          ${
            report
              ? `
                <div class="score-bars">
                  ${Object.entries(report.scores)
                    .map(([label, value]) => `
                      <div class="sb-row">
                        <span class="sb-name">${escapeHtml(humanize(label))}</span>
                        <div class="sb-track"><div class="sb-fill ${value >= 8 ? "prog-green" : value >= 5 ? "prog-blue" : "prog-amber"}" style="width:${clamp(value * 10, 10, 100)}%"></div></div>
                        <span class="sb-val" style="color:${value >= 8 ? "var(--accent)" : value >= 5 ? "var(--blue)" : "var(--amber)"}">${value}</span>
                      </div>
                    `)
                    .join("")}
                </div>
              `
              : `<div class="warning-note" style="margin-top: 12px;">This run does not have a saved score breakdown yet.</div>`
          }
        </div>

        <div class="summary-section">
          <div class="ss-label">Top issues</div>
          <div class="issue-list">
            ${issues
              .map(
                (issue) => `
                  <div class="issue-row">
                    <div class="issue-icon ${issue.iconClass}">${escapeHtml(issue.iconLabel)}</div>
                    <span class="issue-text">${escapeHtml(issue.text)}</span>
                    <span class="issue-cnt">${escapeHtml(issue.countLabel)}</span>
                  </div>
                `
              )
              .join("")}
          </div>
        </div>

        <div class="summary-section">
          <div class="ss-label">Personas</div>
          <div class="persona-chips">
            ${personas.map((persona) => `<span class="p-chip">${escapeHtml(persona)}</span>`).join("")}
          </div>
        </div>

        <div class="summary-section">
          <div class="ss-label">Activity</div>
          <div class="activity-log">
            ${activityItems
              .map(
                (item) => `
                  <div class="al-row">
                    <span class="al-time">${escapeHtml(item.time)}</span>
                    <span class="al-text">${item.idLabel ? `<span class="al-id">${escapeHtml(item.idLabel)}</span> ` : ""}${escapeHtml(item.text)}</span>
                  </div>
                `
              )
              .join("")}
          </div>
        </div>
      </div>
    </aside>
  `;
}

function renderRunMetaPanel(detail: DashboardRunDetail): string {
  const inputs = detail.inputs;
  const clickReplayHref = buildArtifactHref(detail.id, inputs?.clickReplayArtifact);
  const metaItems = [
    describeBatchRole(inputs?.batchRole ?? "single", inputs?.agentCount ?? 1),
    inputs?.mobile ? "Mobile-sized run" : "Desktop-sized run",
    inputs?.headed ? "Headed browser" : "Headless browser",
    inputs?.llmProvider && inputs?.model
      ? `${inputs.llmProvider === "ollama" ? "Ollama" : "OpenAI"} ${inputs.model}`
      : inputs?.model
        ? `Model ${inputs.model}`
        : null,
    inputs?.synchronizedTimezone ? `Timezone ${inputs.synchronizedTimezone}` : null,
    `${detail.rawEventCount} raw events`
  ].filter((item): item is string => Boolean(item));

  return `
    <section class="panel">
      <div class="panel-head">
        <div>
          <div class="panel-title">Run details</div>
          <div class="panel-sub">The context behind this saved visit</div>
        </div>
      </div>
      <div class="panel-body">
        <div class="helper-row" style="margin-top: 0;">
          ${metaItems.map((item) => `<span>${escapeHtml(item)}</span>`).join("")}
        </div>
        ${
          inputs?.siteBrief?.summary
            ? `<div class="warning-note" style="margin-top: 12px;"><strong>Site brief.</strong> ${escapeHtml(inputs.siteBrief.summary)}</div>`
            : ""
        }
        ${
          inputs?.instructionText
            ? `<div class="warning-note" style="margin-top: 12px; white-space: pre-wrap;"><strong>Instruction source.</strong>\n${escapeHtml(inputs.instructionText)}</div>`
            : ""
        }
        ${renderClickReplayStatus(detail)}
        <div class="link-row">
          <a class="inline-link" href="/outputs/${encodeURIComponent(detail.id)}" target="_blank" rel="noreferrer">Open standalone HTML output</a>
          <a class="inline-link" href="/api/runs/${encodeURIComponent(detail.id)}/artifacts/report.html">Download HTML output</a>
          <a class="inline-link" href="/api/runs/${encodeURIComponent(detail.id)}/artifacts/report.json">Download JSON output</a>
          ${clickReplayHref ? `<a class="inline-link" href="${escapeHtml(clickReplayHref)}" target="_blank" rel="noreferrer">Open click replay</a>` : ""}
        </div>
      </div>
    </section>
  `;
}

function renderDetailContent(detail: DashboardRunDetail, selectedRunId: string | null): string {
  const recapParagraphs = buildVisitRecap(detail);
  const strengths = filterVisitorFacingItems(detail.report?.strengths ?? []);
  const weaknesses = filterVisitorFacingItems(detail.report?.weaknesses ?? []);
  const topFixes = filterVisitorFacingItems(detail.report?.top_fixes ?? []);

  return `
    <div class="two-col" data-summary-layout>
      <div class="stack">
        ${renderAgentGrid(detail, selectedRunId)}

        <section class="panel">
          <div class="panel-head">
            <div>
              <div class="panel-title">How I’d Describe This Visit To A Friend</div>
              <div class="panel-sub">Built from recorded clicks, pages, and accepted-task outcomes</div>
            </div>
          </div>
          <div class="panel-body">
            <div class="visit-recap">
              ${recapParagraphs.map((paragraph) => `<p class="visit-recap__line">${escapeHtml(paragraph)}</p>`).join("")}
            </div>
          </div>
        </section>

        <div class="list-grid">
          ${renderListPanel("What felt solid", strengths, "I did not record any standout positives in this run.")}
          ${renderListPanel("Where the visit broke down", weaknesses, "This visit was smoother than expected.")}
          ${renderListPanel("What I would fix first", topFixes, "No top-priority fixes were recorded for this run.")}
        </div>

        ${renderRunMetaPanel(detail)}

        <section class="panel" id="output-details">
          <div class="panel-head">
            <div>
              <div class="panel-title">Interaction breakdown</div>
              <div class="panel-sub">Each part of the visit, with the recorded step history underneath</div>
            </div>
          </div>
          <div class="panel-body">
            <div class="task-stack">
              ${
                detail.tasks.length > 0
                  ? detail.tasks.map((task) => renderTaskCard(detail, task)).join("")
                  : `<div class="warning-note">No task breakdown was recorded for this run.</div>`
              }
            </div>
          </div>
        </section>

        <section class="panel">
          <div class="panel-head">
            <div>
              <div class="panel-title">Accessibility findings</div>
              <div class="panel-sub">Saved axe results from the same run</div>
            </div>
          </div>
          <div class="panel-body">
            ${renderAccessibility(detail)}
          </div>
        </section>
      </div>

      ${renderSummaryRail(detail)}
    </div>
  `;
}

function renderEmptyState(): string {
  return `
    <div class="two-col">
      <div class="stack">
        <section class="panel empty-stack">
          <div>
            <h2>No outputs yet</h2>
            <p class="muted">Start a new task run from the home page and the finished run will appear here automatically.</p>
          </div>
        </section>
      </div>
      <aside class="panel">
        <div class="summary-section">
          <div class="ss-label">Run summary</div>
          <div class="warning-note">Pick or create a run to see the score, issues, personas, and activity rail.</div>
        </div>
      </aside>
    </div>
  `;
}

function renderMain(runs: DashboardRunSummary[], detail: DashboardRunDetail | null, selectedRunId: string | null, error: string | null): string {
  const topbarDate = detail?.inputs?.startedAt ?? runs[0]?.startedAt ?? null;
  const exportHref = detail ? `/api/runs/${encodeURIComponent(detail.id)}/artifacts/report.html` : null;

  return `
    <div class="topbar">
      <div class="topbar-left">
        <button class="btn btn-ghost sidebar-toggle" type="button" data-sidebar-toggle aria-expanded="true" aria-label="Hide nav">
          <span aria-hidden="true">◂</span>
          <span class="sidebar-toggle-label">Hide nav</span>
        </button>
        <div>
          <span class="page-title">Dashboard</span>
          <span class="page-sub">— ${escapeHtml(formatDashboardDate(topbarDate))}</span>
        </div>
      </div>
      <div class="topbar-right">
        ${
          exportHref
            ? `<a class="btn btn-ghost" href="${escapeHtml(exportHref)}">↓ Export</a>`
            : `<span class="btn btn-ghost">↓ Export</span>`
        }
        <a class="btn btn-primary" href="/">▶ New test run</a>
      </div>
    </div>

    <div class="content">
      ${renderMetricsGrid(runs, detail)}
      ${error ? `<div class="warning-note">${escapeHtml(error)}</div>` : ""}
      ${detail ? renderDetailContent(detail, selectedRunId) : renderEmptyState()}
    </div>
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
    ${DASHBOARD_HEAD_TAGS}
    <style>${SHARED_DASHBOARD_CSS}</style>
  </head>
  <body>
    <div class="app">
      <nav class="sidebar">
        <div class="logo">
          <div class="logo-mark"></div>
          <div>
            <div class="logo-name">agentprobe</div>
          </div>
          <span class="logo-beta">β</span>
        </div>

        <div class="nav-section">
          <div class="nav-label">Main</div>
          <a class="nav-item active" href="/dashboard">
            <span class="nav-icon">◈</span> Dashboard
          </a>
          <a class="nav-item" href="/">
            <span class="nav-icon">⊡</span> New test
            <span class="nav-badge">${escapeHtml(`${args.runs.length}`)}</span>
          </a>
          <a class="nav-item" href="#output-details">
            <span class="nav-icon">◫</span> Outputs
          </a>
        </div>

        <div class="nav-section">
          <div class="nav-label">Config</div>
          <a class="nav-item" href="#live-run">
            <span class="nav-icon">◉</span> Live run
          </a>
          <a class="nav-item" href="#saved-runs">
            <span class="nav-icon">◎</span> Saved runs
          </a>
        </div>

        <div class="nav-section run-list-shell" id="saved-runs">
          <div class="nav-label">Saved runs</div>
          <div class="run-list">
            ${renderRunList(args.runs, args.selectedRunId)}
          </div>
        </div>

        <div class="sidebar-footer">
          <div class="workspace">
            <div class="ws-avatar">AP</div>
            <div>
              <div class="ws-name">AgentProbe Workspace</div>
              <div class="ws-plan">${escapeHtml(`${args.runs.length} saved ${args.runs.length === 1 ? "run" : "runs"}`)}</div>
            </div>
          </div>
        </div>
      </nav>

      <main class="main">
        ${renderMain(args.runs, args.detail, args.selectedRunId, args.error ?? null)}
      </main>
    </div>
    <script>
      (() => {
        const navStorageKey = ${JSON.stringify(SIDEBAR_COLLAPSE_STORAGE_KEY)};
        const summaryStorageKey = ${JSON.stringify(SUMMARY_RAIL_COLLAPSE_STORAGE_KEY)};
        const app = document.querySelector(".app");
        const navToggle = document.querySelector("[data-sidebar-toggle]");
        const summaryLayout = document.querySelector("[data-summary-layout]");
        const summaryRail = document.querySelector("[data-summary-rail]");
        const summaryToggle = document.querySelector("[data-summary-toggle]");
        if (!app || !navToggle) {
          return;
        }

        const updateNavToggle = (collapsed) => {
          app.classList.toggle("sidebar-collapsed", collapsed);
          navToggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
          navToggle.setAttribute("aria-label", collapsed ? "Show nav" : "Hide nav");
          navToggle.innerHTML = collapsed
            ? '<span aria-hidden="true">▸</span><span class="sidebar-toggle-label">Show nav</span>'
            : '<span aria-hidden="true">◂</span><span class="sidebar-toggle-label">Hide nav</span>';
        };

        const updateSummaryToggle = (collapsed) => {
          if (!summaryLayout || !summaryRail || !summaryToggle) {
            return;
          }

          summaryLayout.classList.toggle("summary-rail-collapsed", collapsed);
          summaryRail.classList.toggle("summary-rail--collapsed", collapsed);
          summaryToggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
          summaryToggle.setAttribute("aria-label", collapsed ? "Expand run summary" : "Collapse run summary");
          summaryToggle.innerHTML = collapsed
            ? '<span aria-hidden="true">▸</span><span class="summary-toggle-label">Open</span>'
            : '<span aria-hidden="true">◂</span><span class="summary-toggle-label">Hide</span>';

          const summaryTitle = summaryRail.querySelector(".panel-title");
          if (summaryTitle) {
            summaryTitle.textContent = collapsed ? "Summary" : "Run summary";
          }
        };

        let navCollapsed = false;
        try {
          navCollapsed = window.localStorage.getItem(navStorageKey) === "true";
        } catch {}
        updateNavToggle(navCollapsed);

        navToggle.addEventListener("click", () => {
          navCollapsed = !app.classList.contains("sidebar-collapsed");
          try {
            window.localStorage.setItem(navStorageKey, String(navCollapsed));
          } catch {}
          updateNavToggle(navCollapsed);
        });

        let summaryCollapsed = false;
        try {
          summaryCollapsed = window.localStorage.getItem(summaryStorageKey) === "true";
        } catch {}
        updateSummaryToggle(summaryCollapsed);

        summaryToggle?.addEventListener("click", () => {
          summaryCollapsed = !summaryLayout?.classList.contains("summary-rail-collapsed");
          try {
            window.localStorage.setItem(summaryStorageKey, String(summaryCollapsed));
          } catch {}
          updateSummaryToggle(summaryCollapsed);
        });
      })();
    </script>
  </body>
</html>`;
}
