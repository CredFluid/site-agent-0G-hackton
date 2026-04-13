import fs from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import dotenv from "dotenv";
import ts from "typescript";
import { z } from "zod";
import { config } from "../config.js";
import { AccessibilityResultSchema, FinalReportSchema, TaskRunResultSchema } from "../schemas/types.js";
import { renderHtmlReport } from "../reporting/html.js";
import { readUtf8 } from "../utils/files.js";
import { info, warn } from "../utils/log.js";
import { canAccessPublicReport, renderExpiredReportPage, renderLandingPage, renderReportUnavailablePage, renderSubmissionStatusPage } from "../submissions/html.js";
import { findSubmissionByReportToken } from "../submissions/store.js";
import { validatePublicUrl } from "../submissions/publicUrl.js";
import { SubmissionService } from "../submissions/service.js";
import {
  DashboardRunDetailSchema,
  DashboardRunSummarySchema,
  RunInputsSchema,
  type DashboardRunDetail,
  type DashboardRunSummary
} from "./contracts.js";

dotenv.config();

const RUNS_DIR = path.join(process.cwd(), "runs");
const CLIENT_ENTRY = path.join(process.cwd(), "src", "dashboard", "client.ts");
const DEFAULT_PORT = 4173;
const DEFAULT_HOST = "127.0.0.1";
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

  * {
    box-sizing: border-box;
  }

  html,
  body {
    margin: 0;
    min-height: 100%;
  }

  body {
    color: var(--ink);
    font-family: "Avenir Next", "Trebuchet MS", sans-serif;
    background:
      radial-gradient(circle at top left, rgba(191, 90, 44, 0.18), transparent 32%),
      radial-gradient(circle at top right, rgba(23, 111, 105, 0.16), transparent 28%),
      linear-gradient(180deg, #fbf6ee 0%, var(--bg) 52%, var(--bg-deep) 100%);
  }

  body::before {
    position: fixed;
    inset: 0;
    pointer-events: none;
    content: "";
    background-image:
      linear-gradient(rgba(29, 27, 25, 0.02) 1px, transparent 1px),
      linear-gradient(90deg, rgba(29, 27, 25, 0.02) 1px, transparent 1px);
    background-size: 22px 22px;
    mask-image: linear-gradient(180deg, rgba(0, 0, 0, 0.4), transparent 90%);
  }

  button,
  input,
  select,
  textarea {
    font: inherit;
  }

  a {
    color: inherit;
  }

  code {
    font-family: "SFMono-Regular", "Menlo", "Monaco", monospace;
    font-size: 0.92em;
    padding: 0.12rem 0.36rem;
    border-radius: 999px;
    background: rgba(23, 111, 105, 0.08);
  }

  img {
    max-width: 100%;
    display: block;
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
  }

  .brand-block,
  .panel,
  .run-button {
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

  h1,
  h2,
  h3 {
    margin: 0;
    font-family: "Iowan Old Style", "Palatino Linotype", "Book Antiqua", Georgia, serif;
    letter-spacing: -0.03em;
  }

  h1 {
    font-size: clamp(2rem, 3vw, 2.8rem);
    line-height: 0.96;
  }

  h2 {
    font-size: clamp(2rem, 4vw, 3.3rem);
    line-height: 0.94;
  }

  h3 {
    font-size: 1.25rem;
  }

  .sidebar-copy,
  .muted,
  .run-summary,
  .task-subcopy,
  .warning-note {
    color: var(--muted);
  }

  .mini-meta,
  .helper-row,
  .task-meta,
  .history-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 0.55rem;
  }

  .mini-meta span,
  .helper-row span,
  .task-meta span,
  .history-meta span {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.36rem 0.6rem;
    border-radius: 999px;
    background: rgba(29, 27, 25, 0.05);
    font-size: 0.82rem;
  }

  .run-list {
    display: grid;
    gap: 0.9rem;
    overflow: auto;
    padding-right: 0.25rem;
  }

  .run-button {
    width: 100%;
    padding: 1rem;
    text-align: left;
    border-color: transparent;
    background: rgba(255, 252, 247, 0.84);
    cursor: pointer;
    transition: transform 180ms ease, border-color 180ms ease, background 180ms ease;
  }

  .run-button:hover,
  .run-button:focus-visible {
    transform: translateY(-1px);
    border-color: rgba(191, 90, 44, 0.28);
    outline: none;
  }

  .run-button--active {
    border-color: rgba(23, 111, 105, 0.32);
    background: linear-gradient(180deg, rgba(255, 249, 239, 0.98), rgba(240, 248, 246, 0.95));
  }

  .run-topline,
  .section-heading,
  .task-card__header,
  .history-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
  }

  .run-host {
    font-weight: 700;
    font-size: 1rem;
  }

  .run-summary {
    margin: 0.65rem 0 0;
    font-size: 0.92rem;
    line-height: 1.45;
    display: -webkit-box;
    overflow: hidden;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
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

  .pill--score-high,
  .pill--status-success,
  .pill--status-completed,
  .pill--friction-none {
    color: #0f5f56;
    background: rgba(23, 111, 105, 0.12);
  }

  .pill--score-mid,
  .pill--status-partial_success,
  .pill--status-queued,
  .pill--status-running,
  .pill--friction-low,
  .pill--friction-medium {
    color: #8a5f08;
    background: rgba(183, 129, 27, 0.14);
  }

  .pill--score-low,
  .pill--status-failed,
  .pill--friction-high {
    color: #8d1b13;
    background: rgba(180, 35, 24, 0.12);
  }

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

  .hero-score span {
    color: var(--muted);
    font-size: 0.88rem;
  }

  .score-grid,
  .list-grid,
  .accessibility-grid,
  .history-grid {
    display: grid;
    gap: 1rem;
  }

  .score-grid {
    grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  }

  .score-card {
    padding: 1rem;
    border-radius: 20px;
    border: 1px solid var(--line);
    background: var(--panel-strong);
  }

  .score-card__value {
    display: flex;
    align-items: baseline;
    gap: 0.25rem;
    margin-top: 0.35rem;
  }

  .score-card__value strong {
    font-size: 2rem;
    line-height: 0.9;
  }

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

  .list-grid {
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  }

  .prose-list {
    margin: 1rem 0 0;
    padding-left: 1.2rem;
    display: grid;
    gap: 0.75rem;
  }

  .task-stack {
    display: grid;
    gap: 1rem;
    margin-top: 1rem;
  }

  .task-card {
    padding: 1rem;
    border-radius: 22px;
    border: 1px solid var(--line);
    background: rgba(255, 255, 255, 0.76);
  }

  .task-card__reason {
    margin: 0.4rem 0 0;
    line-height: 1.5;
  }

  .task-card__meta {
    margin-top: 0.9rem;
  }

  .task-details {
    margin-top: 1rem;
    border-top: 1px solid var(--line);
    padding-top: 1rem;
  }

  .task-details > summary {
    cursor: pointer;
    font-weight: 700;
    list-style: none;
  }

  .task-details > summary::-webkit-details-marker {
    display: none;
  }

  .evidence-list {
    margin: 0.9rem 0 0;
    padding-left: 1.2rem;
    display: grid;
    gap: 0.55rem;
  }

  .history-grid {
    grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
    margin-top: 1rem;
  }

  .history-card,
  .violation-card {
    padding: 1rem;
    border-radius: 18px;
    border: 1px solid var(--line);
    background: rgba(255, 251, 247, 0.92);
  }

  .history-card p,
  .violation-card p {
    margin: 0.55rem 0 0;
    line-height: 1.48;
  }

  .accessibility-grid {
    grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
    margin-top: 1rem;
  }

  .warning-note,
  .empty-stack {
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

  .inline-link:hover,
  .inline-link:focus-visible {
    text-decoration: underline;
  }

  .button-reset {
    border: 0;
    background: transparent;
    cursor: pointer;
  }

  .kbd {
    display: inline-flex;
    align-items: center;
    padding: 0.2rem 0.42rem;
    border-radius: 8px;
    border: 1px solid var(--line);
    background: rgba(255, 255, 255, 0.9);
    font-family: "SFMono-Regular", "Menlo", monospace;
    font-size: 0.8rem;
  }

  @media (max-width: 1080px) {
    .app-shell {
      grid-template-columns: 1fr;
    }

    .sidebar {
      position: static;
      height: auto;
      border-right: 0;
      border-bottom: 1px solid var(--line);
    }

    .run-list {
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    }
  }

  @media (max-width: 760px) {
    .main,
    .sidebar {
      padding: 1rem;
    }

    .hero-grid {
      grid-template-columns: 1fr;
    }

    .history-grid,
    .score-grid,
    .list-grid,
    .accessibility-grid {
      grid-template-columns: 1fr;
    }
  }
`;

function parsePort(value: string | undefined): number {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }

  return DEFAULT_PORT;
}

function readJsonFile<T>(filePath: string, schema: z.ZodType<T>, label: string): T | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    return schema.parse(JSON.parse(readUtf8(filePath)));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown parse error";
    warn(`Failed to parse ${label}: ${message}`);
    return null;
  }
}

function resolveRunDir(runId: string): string | null {
  if (!/^[A-Za-z0-9-]+$/.test(runId)) {
    return null;
  }

  const runDir = path.resolve(RUNS_DIR, runId);
  const baseDir = path.resolve(RUNS_DIR);

  if (!runDir.startsWith(`${baseDir}${path.sep}`)) {
    return null;
  }

  if (!fs.existsSync(runDir) || !fs.statSync(runDir).isDirectory()) {
    return null;
  }

  return runDir;
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

function getClientScript(): string {
  const source = readUtf8(CLIENT_ENTRY);
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
      importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
      isolatedModules: true
    },
    fileName: CLIENT_ENTRY
  });

  return transpiled.outputText;
}

function listRunIds(): string[] {
  if (!fs.existsSync(RUNS_DIR)) {
    return [];
  }

  return fs
    .readdirSync(RUNS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left));
}

function buildRunSummary(runId: string): DashboardRunSummary {
  const runDir = path.join(RUNS_DIR, runId);
  const inputs = readJsonFile(path.join(runDir, "inputs.json"), RunInputsSchema, `${runId}/inputs.json`);
  const report = readJsonFile(path.join(runDir, "report.json"), FinalReportSchema, `${runId}/report.json`);
  const accessibility = readJsonFile(path.join(runDir, "accessibility.json"), AccessibilityResultSchema, `${runId}/accessibility.json`);

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
    accessibilityViolationCount: accessibility?.violations.length ?? null,
    batchRole: inputs?.batchRole ?? "single",
    agentCount: inputs?.agentCount ?? 1,
    completedAgentCount: inputs?.completedAgentCount ?? 0,
    failedAgentCount: inputs?.failedAgentCount ?? 0,
    agentLabel: inputs?.agentLabel ?? null,
    agentProfileLabel: inputs?.agentProfileLabel ?? null
  });
}

function isVisibleDashboardRun(run: DashboardRunSummary): boolean {
  return run.batchRole !== "child";
}

function buildRunDetail(runId: string): DashboardRunDetail | null {
  const runDir = resolveRunDir(runId);

  if (!runDir) {
    return null;
  }

  const warnings: string[] = [];
  const inputs = readJsonFile(path.join(runDir, "inputs.json"), RunInputsSchema, `${runId}/inputs.json`);
  const report = readJsonFile(path.join(runDir, "report.json"), FinalReportSchema, `${runId}/report.json`);
  const accessibility = readJsonFile(path.join(runDir, "accessibility.json"), AccessibilityResultSchema, `${runId}/accessibility.json`);
  const taskRuns = readJsonFile(path.join(runDir, "task-results.json"), TaskRunResultsSchema, `${runId}/task-results.json`) ?? [];
  const rawEvents = readJsonFile(path.join(runDir, "raw-events.json"), RawEventsSchema, `${runId}/raw-events.json`) ?? [];

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

function buildStandaloneReportHtml(runId: string): string | null {
  const runDir = resolveRunDir(runId);

  if (!runDir) {
    return null;
  }

  const staticReportPath = path.join(runDir, "report.html");
  if (fs.existsSync(staticReportPath) && fs.statSync(staticReportPath).isFile()) {
    return readUtf8(staticReportPath);
  }

  const inputs = readJsonFile(path.join(runDir, "inputs.json"), RunInputsSchema, `${runId}/inputs.json`);
  const report = readJsonFile(path.join(runDir, "report.json"), FinalReportSchema, `${runId}/report.json`);
  const taskRuns = readJsonFile(path.join(runDir, "task-results.json"), TaskRunResultsSchema, `${runId}/task-results.json`) ?? [];

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

function sendText(res: ServerResponse, statusCode: number, body: string, contentType: string): void {
  res.writeHead(statusCode, {
    "Content-Type": `${contentType}; charset=utf-8`,
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function sendJson(res: ServerResponse, data: unknown, statusCode = 200): void {
  sendText(res, statusCode, JSON.stringify(data, null, 2), "application/json");
}

function sendRedirect(res: ServerResponse, location: string, statusCode = 303): void {
  res.writeHead(statusCode, { Location: location });
  res.end();
}

function renderDashboardHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Site Agent Dashboard</title>
    <style>${DASHBOARD_CSS}</style>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/app.js"></script>
  </body>
</html>`;
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }

  return Buffer.concat(chunks).toString("utf8");
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, submissionService: SubmissionService): Promise<void> {
  const requestUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const pathParts = requestUrl.pathname.split("/").filter(Boolean);

  if (requestUrl.pathname === "/favicon.ico") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/submit") {
    const body = await readRequestBody(req);
    const form = new URLSearchParams(body);
    const urlInput = form.get("url") ?? "";
    const requestedMode = form.get("mode") === "structured" ? "structured" : "generic";
    const requestedAgentCount = Number(form.get("agents") ?? "1");
    const normalizedAgentCount = Number.isFinite(requestedAgentCount)
      ? Math.min(5, Math.max(1, Math.round(requestedAgentCount)))
      : 1;
    const taskPath = requestedMode === "structured" ? "src/tasks/first_time_buyer.json" : "src/tasks/generic_interaction.json";

    const urlValidation = validatePublicUrl(urlInput);

    if (!urlValidation.valid) {
      sendText(
        res,
        400,
        renderLandingPage({
          error: urlValidation.reason ?? "Enter a valid public URL.",
          submittedUrl: urlInput,
          selectedMode: requestedMode,
          selectedAgentCount: normalizedAgentCount
        }),
        "text/html"
      );
      return;
    }

    const submission = await submissionService.createSubmission({
      url: urlValidation.normalizedUrl ?? urlInput.trim(),
      taskPath,
      agentCount: normalizedAgentCount
    });

    sendRedirect(res, `/submissions/${encodeURIComponent(submission.id)}`);
    return;
  }

  if (req.method !== "GET") {
    sendText(res, 405, "Method not allowed", "text/plain");
    return;
  }

  if (requestUrl.pathname === "/") {
      sendText(res, 200, renderLandingPage({}), "text/html");
    return;
  }

  if (requestUrl.pathname === "/dashboard") {
    sendText(res, 200, renderDashboardHtml(), "text/html");
    return;
  }

  if (requestUrl.pathname === "/app.js") {
    sendText(res, 200, getClientScript(), "application/javascript");
    return;
  }

  if (pathParts[0] === "submissions" && pathParts[1] && pathParts.length === 2) {
    const submission = await submissionService.getSubmission(decodeURIComponent(pathParts[1]));
    if (!submission) {
      sendText(res, 404, renderReportUnavailablePage({ title: "Submission not found", message: "We could not find that submission." }), "text/html");
      return;
    }

    sendText(res, 200, renderSubmissionStatusPage({ appBaseUrl, submission }), "text/html");
    return;
  }

  if (pathParts[0] === "r" && pathParts[1] && pathParts.length === 2) {
    const submission = findSubmissionByReportToken(decodeURIComponent(pathParts[1]));
    if (!submission) {
      sendText(res, 404, renderReportUnavailablePage({ title: "Report not found", message: "This report link does not exist." }), "text/html");
      return;
    }

    const access = canAccessPublicReport(submission);
    if (!access.allowed) {
      const html = access.reason === "This report link has expired."
        ? renderExpiredReportPage(submission)
        : renderReportUnavailablePage({ title: "Report not ready", message: access.reason ?? "This report is not ready yet." });
      const statusCode = access.reason === "This report link has expired." ? 410 : 202;
      sendText(res, statusCode, html, "text/html");
      return;
    }

    const htmlReport = buildStandaloneReportHtml(submission.runId ?? "");
    if (!htmlReport) {
      sendText(res, 404, renderReportUnavailablePage({ title: "Report not found", message: "The report artifact could not be loaded." }), "text/html");
      return;
    }

    sendText(res, 200, htmlReport, "text/html");
    return;
  }

  if (pathParts[0] === "reports" && pathParts[1] && pathParts.length === 2) {
    const runId = decodeURIComponent(pathParts[1]);
    const htmlReport = buildStandaloneReportHtml(runId);

    if (!htmlReport) {
      sendText(res, 404, "Report not found", "text/plain");
      return;
    }

    sendText(res, 200, htmlReport, "text/html");
    return;
  }

  if (requestUrl.pathname === "/api/runs") {
    const runs = listRunIds().map(buildRunSummary).filter(isVisibleDashboardRun);
    sendJson(res, runs);
    return;
  }

  if (pathParts[0] === "api" && pathParts[1] === "runs" && pathParts[2]) {
    const runId = decodeURIComponent(pathParts[2]);

    if (pathParts.length === 3) {
      const runDetail = buildRunDetail(runId);
      if (!runDetail) {
        sendJson(res, { error: `Run '${runId}' not found.` }, 404);
        return;
      }

      sendJson(res, runDetail);
      return;
    }

    if (pathParts.length === 5 && pathParts[3] === "artifacts" && pathParts[4]) {
      const allowedArtifacts = new Set(["report.html", "report.json", "report.md"]);
      const fileName = decodeURIComponent(pathParts[4]);
      if (!allowedArtifacts.has(fileName)) {
        sendJson(res, { error: "Artifact not available for download." }, 400);
        return;
      }

      const runDir = resolveRunDir(runId);
      if (!runDir) {
        sendJson(res, { error: `Run '${runId}' not found.` }, 404);
        return;
      }

      const artifactPath = path.join(runDir, fileName);
      if (fileName === "report.html" && (!fs.existsSync(artifactPath) || !fs.statSync(artifactPath).isFile())) {
        const htmlReport = buildStandaloneReportHtml(runId);
        if (!htmlReport) {
          sendJson(res, { error: `Artifact '${fileName}' not found.` }, 404);
          return;
        }

        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Disposition": `attachment; filename="${runId}-${fileName}"`,
          "Cache-Control": "no-store"
        });
        res.end(htmlReport);
        return;
      }

      if (!fs.existsSync(artifactPath) || !fs.statSync(artifactPath).isFile()) {
        sendJson(res, { error: `Artifact '${fileName}' not found.` }, 404);
        return;
      }

      res.writeHead(200, {
        "Content-Type":
          fileName.endsWith(".html")
            ? "text/html; charset=utf-8"
            : fileName.endsWith(".json")
              ? "application/json; charset=utf-8"
              : "text/markdown; charset=utf-8",
        "Content-Disposition": `attachment; filename="${runId}-${fileName}"`,
        "Cache-Control": "no-store"
      });
      fs.createReadStream(artifactPath).pipe(res);
      return;
    }
  }

  sendText(res, 404, "Not found", "text/plain");
}

const port = parsePort(process.env.DASHBOARD_PORT);
const host = process.env.DASHBOARD_HOST || DEFAULT_HOST;
const appBaseUrl = config.appBaseUrl || `http://${host === DEFAULT_HOST ? "localhost" : host}:${port}`;
const submissionService = new SubmissionService();

const server = http.createServer((req, res) => {
  handleRequest(req, res, submissionService).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unknown dashboard error";
    warn(`Dashboard request failed: ${message}`);
    sendJson(res, { error: message }, 500);
  });
});

server.listen(port, host, () => {
  info(`Dashboard ready at http://${host === DEFAULT_HOST ? "localhost" : host}:${port}`);
  submissionService.resumePendingSubmissions();
});
