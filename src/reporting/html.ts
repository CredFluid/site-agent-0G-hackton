import type { FinalReport, TaskHistoryEntry, TaskRunResult } from "../schemas/types.js";

type HtmlReportArgs = {
  website: string;
  persona: string;
  report: FinalReport;
  taskResults: TaskRunResult[];
  runId?: string | undefined;
  startedAt?: string | undefined;
  timeZone?: string | undefined;
};

type FrictionPoint = {
  title: string;
  severity: "low" | "medium" | "high";
  context: string;
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

function formatDate(value: string | undefined, timeZone?: string): string {
  if (!value) {
    return "Unknown time";
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
    ...(timeZone ? { timeZone } : {})
  });
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

function classifySeverity(text: string): "low" | "medium" | "high" {
  const normalized = text.toLowerCase();

  if (/(blocked|never|critical|broken|crash|failed|stuck|trap|401|403|error|unreachable|captcha|verification)/.test(normalized)) {
    return "high";
  }

  if (/(confusing|unclear|misleading|slow|friction|hidden|delay|hard to use|difficult|ambiguous)/.test(normalized)) {
    return "medium";
  }

  return "low";
}

function keywordMatches(left: string, right: string): boolean {
  const keywords = left.toLowerCase().match(/[a-z0-9]{4,}/g) ?? [];
  const haystack = right.toLowerCase();
  return keywords.some((keyword) => haystack.includes(keyword));
}

function deriveFrictionPoints(report: FinalReport): FrictionPoint[] {
  const issues = report.weaknesses.length > 0 ? report.weaknesses : report.top_fixes;

  return issues.slice(0, 6).map((issue, index) => {
    const relatedTask = report.task_results.find(
      (task) =>
        keywordMatches(issue, task.reason) ||
        task.evidence.some((evidence) => keywordMatches(issue, evidence))
    );

    const context =
      relatedTask?.evidence.find((evidence) => keywordMatches(issue, evidence)) ??
      relatedTask?.reason ??
      `Observed during the agent session and ranked #${index + 1} in the final review.`;

    return {
      title: issue,
      severity: classifySeverity(issue),
      context
    };
  });
}

function describeAction(entry: TaskHistoryEntry): string {
  const target = entry.decision.target.trim();

  switch (entry.decision.action) {
    case "click":
      return target ? `Clicked ${target}` : "Clicked a visible element";
    case "type":
      return target ? `Typed into ${target}` : "Typed into a visible field";
    case "scroll":
      return "Scrolled the page";
    case "wait":
      return "Waited for the page to respond";
    case "back":
      return "Went back one page";
    case "extract":
      return "Captured the page state";
    case "stop":
      return "Stopped the session";
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

export function renderHtmlReport(args: HtmlReportArgs): string {
  const frictionPoints = deriveFrictionPoints(args.report);
  const sessionLog = deriveSessionLog(args.taskResults);
  const overallScore = args.report.overall_score;
  const positiveItems = args.report.strengths.slice(0, 8);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>AgentProbe Report</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f5eddf;
        --paper: rgba(255, 251, 244, 0.94);
        --paper-strong: #fffaf2;
        --ink: #1d1915;
        --muted: #6b625a;
        --line: rgba(74, 57, 34, 0.14);
        --accent: #b85e33;
        --teal: #176f69;
        --teal-soft: rgba(23, 111, 105, 0.12);
        --gold: #a96f14;
        --gold-soft: rgba(169, 111, 20, 0.12);
        --red: #b42318;
        --red-soft: rgba(180, 35, 24, 0.12);
        --shadow: 0 26px 70px rgba(72, 47, 14, 0.14);
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
          radial-gradient(circle at top left, rgba(184, 94, 51, 0.18), transparent 30%),
          radial-gradient(circle at top right, rgba(23, 111, 105, 0.16), transparent 32%),
          linear-gradient(180deg, #fbf7f0 0%, var(--bg) 48%, #e9dbc2 100%);
      }

      body::before {
        position: fixed;
        inset: 0;
        pointer-events: none;
        content: "";
        background-image:
          linear-gradient(rgba(29, 25, 21, 0.018) 1px, transparent 1px),
          linear-gradient(90deg, rgba(29, 25, 21, 0.018) 1px, transparent 1px);
        background-size: 26px 26px;
        mask-image: linear-gradient(180deg, rgba(0, 0, 0, 0.35), transparent 92%);
      }

      .page {
        width: min(1120px, calc(100vw - 2rem));
        margin: 0 auto;
        padding: 1rem 0 2.5rem;
      }

      .hero,
      .section-card {
        border: 1px solid var(--line);
        border-radius: 28px;
        box-shadow: var(--shadow);
        backdrop-filter: blur(18px);
      }

      .hero {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 1rem;
        padding: 1.5rem;
        background:
          radial-gradient(circle at right top, rgba(184, 94, 51, 0.12), transparent 32%),
          linear-gradient(180deg, rgba(255, 252, 246, 0.98), rgba(249, 240, 227, 0.94));
      }

      .hero h1,
      .section-card h2 {
        margin: 0;
        font-family: "Iowan Old Style", "Palatino Linotype", Georgia, serif;
        letter-spacing: -0.04em;
      }

      .hero h1 {
        font-size: clamp(2.2rem, 5vw, 4rem);
        line-height: 0.94;
      }

      .eyebrow {
        margin: 0 0 0.45rem;
        color: var(--accent);
        font-size: 0.78rem;
        font-weight: 700;
        letter-spacing: 0.18em;
        text-transform: uppercase;
      }

      .hero-copy p {
        max-width: 66ch;
        margin: 1rem 0 0;
        color: var(--muted);
        font-size: 1.02rem;
        line-height: 1.6;
      }

      .hero-score {
        min-width: 200px;
        padding: 1.2rem;
        border-radius: 24px;
        border: 1px solid var(--line);
        background: rgba(255, 255, 255, 0.74);
        text-align: center;
        align-self: start;
      }

      .hero-score strong {
        display: block;
        font-family: "Iowan Old Style", "Palatino Linotype", Georgia, serif;
        font-size: clamp(3rem, 9vw, 5rem);
        line-height: 0.86;
      }

      .hero-score span {
        color: var(--muted);
        font-size: 0.92rem;
      }

      .meta-row {
        display: flex;
        flex-wrap: wrap;
        gap: 0.55rem;
        margin-top: 1rem;
      }

      .meta-row span {
        display: inline-flex;
        align-items: center;
        padding: 0.38rem 0.72rem;
        border-radius: 999px;
        background: rgba(29, 25, 21, 0.05);
        font-size: 0.84rem;
      }

      .grid {
        display: grid;
        gap: 1rem;
        margin-top: 1rem;
      }

      .grid--dual {
        grid-template-columns: 1.1fr 0.9fr;
      }

      .section-card {
        padding: 1.35rem;
        background: var(--paper);
      }

      .section-card h2 {
        font-size: clamp(1.7rem, 4vw, 2.7rem);
        line-height: 0.96;
      }

      .summary-copy {
        margin: 0.85rem 0 0;
        color: var(--muted);
        font-size: 1.02rem;
        line-height: 1.7;
      }

      .issue-list,
      .positive-list,
      .log-list {
        margin: 1rem 0 0;
        padding: 0;
        list-style: none;
        display: grid;
        gap: 0.85rem;
      }

      .issue-item,
      .positive-item,
      .log-item {
        padding: 1rem;
        border-radius: 20px;
        border: 1px solid var(--line);
        background: var(--paper-strong);
      }

      .issue-head,
      .log-head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 1rem;
      }

      .issue-item p,
      .log-item p {
        margin: 0.55rem 0 0;
        color: var(--muted);
        line-height: 1.55;
      }

      .severity {
        display: inline-flex;
        align-items: center;
        padding: 0.36rem 0.68rem;
        border-radius: 999px;
        font-size: 0.8rem;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.06em;
      }

      .severity--high {
        color: var(--red);
        background: var(--red-soft);
      }

      .severity--medium {
        color: var(--gold);
        background: var(--gold-soft);
      }

      .severity--low {
        color: var(--teal);
        background: var(--teal-soft);
      }

      .section-card--full {
        margin-top: 1rem;
      }

      .log-item time {
        display: inline-flex;
        padding: 0.32rem 0.62rem;
        border-radius: 999px;
        background: rgba(29, 25, 21, 0.05);
        font-size: 0.82rem;
        color: var(--muted);
      }

      .log-meta {
        display: flex;
        flex-wrap: wrap;
        gap: 0.5rem;
        margin-top: 0.7rem;
      }

      .log-meta span {
        padding: 0.32rem 0.62rem;
        border-radius: 999px;
        background: rgba(23, 111, 105, 0.08);
        font-size: 0.8rem;
      }

      .empty {
        margin-top: 1rem;
        padding: 1rem;
        border-radius: 18px;
        border: 1px dashed rgba(184, 94, 51, 0.32);
        color: var(--muted);
        background: rgba(255, 248, 239, 0.82);
      }

      @media (max-width: 900px) {
        .hero,
        .grid--dual {
          grid-template-columns: 1fr;
        }

        .hero-score {
          min-width: 0;
        }
      }
    </style>
  </head>
  <body>
    <main class="page">
      <section class="hero">
        <div class="hero-copy">
          <p class="eyebrow">AgentProbe report</p>
          <h1>One AI user session on ${escapeHtml(args.website)}</h1>
          <p>${escapeHtml(args.report.summary)}</p>
          <div class="meta-row">
            <span>${escapeHtml(args.website)}</span>
            <span>${escapeHtml(args.persona)}</span>
            <span>${escapeHtml(formatDate(args.startedAt, args.timeZone))}</span>
            ${args.timeZone ? `<span>${escapeHtml(args.timeZone)}</span>` : ""}
            ${args.runId ? `<span>${escapeHtml(args.runId)}</span>` : ""}
          </div>
        </div>
        <div class="hero-score">
          <strong>${overallScore}</strong>
          <span>overall experience score / 10</span>
        </div>
      </section>

      <div class="grid grid--dual">
        <section class="section-card">
          <p class="eyebrow">1. Summary</p>
          <h2>What the agent found</h2>
          <p class="summary-copy">${escapeHtml(args.report.summary)}</p>
        </section>

        <section class="section-card">
          <p class="eyebrow">2. Positives</p>
          <h2>What worked well</h2>
          ${
            positiveItems.length > 0
              ? `
                <ul class="positive-list">
                  ${positiveItems.map((item) => `<li class="positive-item">${escapeHtml(item)}</li>`).join("")}
                </ul>
              `
              : `<div class="empty">The agent did not record any strong positives during this session.</div>`
          }
        </section>
      </div>

      <section class="section-card section-card--full">
        <p class="eyebrow">3. Friction points</p>
        <h2>Where the experience broke down</h2>
        ${
          frictionPoints.length > 0
            ? `
              <ol class="issue-list">
                ${frictionPoints
                  .map(
                    (issue) => `
                      <li class="issue-item">
                        <div class="issue-head">
                          <strong>${escapeHtml(issue.title)}</strong>
                          <span class="severity severity--${issue.severity}">${escapeHtml(issue.severity)}</span>
                        </div>
                        <p>${escapeHtml(issue.context)}</p>
                      </li>
                    `
                  )
                  .join("")}
              </ol>
            `
            : `<div class="empty">No friction points were recorded in the final report.</div>`
        }
      </section>

      <section class="section-card section-card--full">
        <p class="eyebrow">4. Session log</p>
        <h2>Every action the agent took</h2>
        ${
          sessionLog.length > 0
            ? `
              <ol class="log-list">
                ${sessionLog
                  .map(
                    (item) => `
                      <li class="log-item">
                        <div class="log-head">
                          <div>
                            <strong>${escapeHtml(item.action)}</strong>
                            <p>${escapeHtml(item.outcome)}</p>
                          </div>
                          <time datetime="${escapeHtml(item.time)}">${escapeHtml(formatLogTime(item.time, args.timeZone))}</time>
                        </div>
                        <div class="log-meta">
                          <span>${escapeHtml(item.task)}</span>
                          <span>${escapeHtml(item.url)}</span>
                        </div>
                      </li>
                    `
                  )
                  .join("")}
              </ol>
            `
            : `<div class="empty">No session log entries were available for this run.</div>`
        }
      </section>
    </main>
  </body>
</html>`;
}
