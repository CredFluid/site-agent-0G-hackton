import type { DashboardRunDetail, DashboardRunSummary } from "./contracts.js";

type AppState = {
  detail: DashboardRunDetail | null;
  error: string | null;
  loadingDetail: boolean;
  loadingRuns: boolean;
  runs: DashboardRunSummary[];
  selectedRunId: string | null;
};

const appRoot = document.getElementById("app");

if (!appRoot) {
  throw new Error("Dashboard root element was not found.");
}

const dashboardRoot: HTMLElement = appRoot;

const state: AppState = {
  detail: null,
  error: null,
  loadingDetail: false,
  loadingRuns: true,
  runs: [],
  selectedRunId: null
};

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

function currentRunIdFromUrl(): string | null {
  const requestedRunId = new URLSearchParams(window.location.search).get("run");
  return requestedRunId && requestedRunId.trim().length > 0 ? requestedRunId : null;
}

function updateUrl(runId: string, pushHistory: boolean): void {
  const nextUrl = new URL(window.location.href);
  nextUrl.searchParams.set("run", runId);

  if (pushHistory) {
    window.history.pushState({ runId }, "", nextUrl);
    return;
  }

  window.history.replaceState({ runId }, "", nextUrl);
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `${response.status} ${response.statusText}`);
  }

  return (await response.json()) as T;
}

async function loadRuns(): Promise<void> {
  state.loadingRuns = true;
  state.error = null;
  render();

  try {
    state.runs = await fetchJson<DashboardRunSummary[]>("/api/runs");
    const requestedRunId = currentRunIdFromUrl();
    const selectedRun =
      state.runs.find((run) => run.id === requestedRunId) ??
      state.runs[0] ??
      null;

    state.loadingRuns = false;
    render();

    if (selectedRun) {
      await loadRunDetail(selectedRun.id, false);
      return;
    }

    state.selectedRunId = null;
  } catch (error) {
    state.loadingRuns = false;
    state.error = error instanceof Error ? error.message : "Failed to load dashboard runs.";
    render();
  }
}

async function loadRunDetail(runId: string, pushHistory: boolean): Promise<void> {
  state.selectedRunId = runId;
  state.loadingDetail = true;
  state.error = null;
  render();

  try {
    state.detail = await fetchJson<DashboardRunDetail>(`/api/runs/${encodeURIComponent(runId)}`);
    state.loadingDetail = false;
    updateUrl(runId, pushHistory);
  } catch (error) {
    state.loadingDetail = false;
    state.error = error instanceof Error ? error.message : "Failed to load the selected run.";
  }

  render();
}

function renderRunList(): string {
  if (state.loadingRuns && state.runs.length === 0) {
    return `<div class="empty-stack"><div><h3>Loading runs</h3><p class="muted">Scanning the <code>runs/</code> directory.</p></div></div>`;
  }

  if (state.runs.length === 0) {
    return `<div class="empty-stack"><div><h3>No runs yet</h3><p class="muted">Generate a report from the CLI and it will show up here automatically.</p></div></div>`;
  }

  return state.runs
    .map((run) => {
      const isActive = run.id === state.selectedRunId;
      const summary = run.summary ?? "No report summary has been generated for this run yet.";
      const scoreLabel = run.overallScore === null ? "n/a" : `${run.overallScore}`;
      const modes = [run.mobile ? "Mobile" : "Desktop", run.headed ? "Headed" : "Headless"];

      return `
        <button type="button" class="run-button ${isActive ? "run-button--active" : ""}" data-run-id="${escapeHtml(run.id)}">
          <div class="run-topline">
            <div>
              <div class="run-host">${escapeHtml(run.host)}</div>
              <div class="muted">${escapeHtml(formatDate(run.startedAt))}</div>
            </div>
            <span class="pill pill--score-${scoreTone(run.overallScore)}">${escapeHtml(scoreLabel)}</span>
          </div>
          <p class="run-summary">${escapeHtml(summary)}</p>
          <div class="mini-meta">
            ${modes.map((mode) => `<span>${escapeHtml(mode)}</span>`).join("")}
            <span>${escapeHtml(`${run.taskCount} tasks`)}</span>
          </div>
        </button>
      `;
    })
    .join("");
}

function renderScoreCards(detail: DashboardRunDetail): string {
  const report = detail.report;
  if (!report) {
    return `
      <div class="score-card">
        <div class="muted">Task coverage</div>
        <div class="score-card__value"><strong>${detail.tasks.length}</strong><span>tasks</span></div>
        <div class="score-bar"><span style="width: 100%"></span></div>
      </div>
      <div class="score-card">
        <div class="muted">Accessibility findings</div>
        <div class="score-card__value"><strong>${detail.accessibility?.violations.length ?? 0}</strong><span>issues</span></div>
        <div class="score-bar"><span style="width: 100%"></span></div>
      </div>
      <div class="score-card">
        <div class="muted">Raw events</div>
        <div class="score-card__value"><strong>${detail.rawEventCount}</strong><span>events</span></div>
        <div class="score-bar"><span style="width: 100%"></span></div>
      </div>
    `;
  }

  return Object.entries(report.scores)
    .map(([label, value]) => `
      <article class="score-card">
        <div class="muted">${escapeHtml(humanize(label))}</div>
        <div class="score-card__value">
          <strong>${value}</strong>
          <span>/10</span>
        </div>
        <div class="score-bar"><span style="width: ${Math.max(10, value * 10)}%"></span></div>
      </article>
    `)
    .join("");
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

function renderTaskCard(task: DashboardRunDetail["tasks"][number]): string {
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
                  <span>${escapeHtml(formatDate(entry.time, state.detail?.inputs?.synchronizedTimezone ?? null))}</span>
                </div>
                <div class="link-row">
                  <a class="inline-link" href="${escapeHtml(safeHref(entry.url) ?? "#")}" target="_blank" rel="noreferrer">Open page</a>
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
      <div class="task-meta task-card__meta">
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

function renderMain(): string {
  if (state.loadingRuns && state.runs.length === 0) {
    return `<section class="panel empty-stack"><div><h2>Loading dashboard</h2><p class="muted">Reading saved run artifacts.</p></div></section>`;
  }

  if (state.runs.length === 0) {
    return `
      <section class="panel empty-stack">
        <div>
          <h2>No reports yet</h2>
          <p class="muted">Run the CLI first, then refresh this dashboard.</p>
          <p class="muted"><code>npm run dev -- --url https://example.com</code></p>
        </div>
      </section>
    `;
  }

  if (state.loadingDetail && !state.detail) {
    return `<section class="panel empty-stack"><div><h2>Loading run</h2><p class="muted">Pulling report details, tasks, and logs.</p></div></section>`;
  }

  if (!state.detail) {
    return `<section class="panel empty-stack"><div><h2>Select a run</h2><p class="muted">Choose a saved run from the left to inspect the report.</p></div></section>`;
  }

  const detail = state.detail;
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
          ${
            state.error
              ? `<p class="warning-note">${escapeHtml(state.error)}</p>`
              : ""
          }
        </div>
        <div class="hero-score">
          <strong>${overallScore === null ? "n/a" : overallScore}</strong>
          <span>overall score / 10</span>
        </div>
      </div>
      ${
        detail.warnings.length > 0
          ? `<p class="warning-note">${escapeHtml(detail.warnings.join(" "))}</p>`
          : ""
      }
    </section>

    <section class="score-grid">
      ${renderScoreCards(detail)}
    </section>

    <section class="list-grid">
      ${renderList("Strengths", report?.strengths ?? [], "No strengths were recorded for this run.")}
      ${renderList("Weaknesses", report?.weaknesses ?? [], "No weaknesses were recorded for this run.")}
      ${renderList("Top fixes", report?.top_fixes ?? [], "No top fixes were recorded for this run.")}
      <div class="panel">
        <div class="section-heading">
          <h3>Run details</h3>
          <span class="muted">${escapeHtml(`${detail.tasks.length} tasks`)}</span>
        </div>
        <div class="helper-row" style="margin-top: 1rem;">
          <span>${escapeHtml(inputs?.taskPath ?? "Task path unavailable")}</span>
          <span>${escapeHtml(`${detail.accessibility?.violations.length ?? 0} accessibility findings`)}</span>
          <span>${escapeHtml(currentRunIdFromUrl() ?? detail.id)}</span>
        </div>
      </div>
    </section>

    <section class="panel">
      <div class="section-heading">
        <h3>Task deep dive</h3>
        <span class="muted">Review the recorded interaction timeline</span>
      </div>
      <div class="task-stack">
        ${detail.tasks.map((task) => renderTaskCard(task)).join("")}
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

function render(): void {
  dashboardRoot.innerHTML = `
    <div class="app-shell">
      <aside class="sidebar">
        <div class="brand-block">
          <p class="eyebrow">Site Agent Pro</p>
          <h1>Run Dashboard</h1>
          <p class="sidebar-copy">Browse saved audits, inspect evidence, and review the interaction log without digging through the filesystem.</p>
          <div class="mini-meta">
            <span>${escapeHtml(`${state.runs.length} saved runs`)}</span>
            <span>${state.loadingRuns ? "Refreshing" : "Artifacts from runs/"}</span>
          </div>
        </div>
        <div class="run-list">
          ${renderRunList()}
        </div>
      </aside>
      <main class="main">
        ${renderMain()}
      </main>
    </div>
  `;
}

document.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) {
    return;
  }

  const runButton = target.closest<HTMLElement>("[data-run-id]");
  if (runButton) {
    const runId = runButton.dataset.runId;
    if (runId && runId !== state.selectedRunId) {
      void loadRunDetail(runId, true);
    }
    return;
  }
});

window.addEventListener("popstate", () => {
  const requestedRunId = currentRunIdFromUrl();
  if (!requestedRunId) {
    const newestRun = state.runs[0];
    if (newestRun) {
      void loadRunDetail(newestRun.id, false);
    }
    return;
  }

  if (requestedRunId !== state.selectedRunId) {
    void loadRunDetail(requestedRunId, false);
  }
});

render();
void loadRuns();
