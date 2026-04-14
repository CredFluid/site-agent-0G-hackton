import path from "node:path";
import { config } from "../config.js";
import { renderHtmlReport } from "../reporting/html.js";
import { renderMarkdownReport } from "../reporting/markdown.js";
import type { AccessibilityResult, FinalReport, SiteChecks, TaskRunResult } from "../schemas/types.js";
import type { Submission, SubmissionAgentRun } from "../submissions/types.js";
import { resolveRunDir, writeJson, writeText } from "../utils/files.js";

export type CompletedAgentAudit = {
  agentRun: SubmissionAgentRun;
  report: FinalReport;
  taskResults: TaskRunResult[];
  accessibility: AccessibilityResult;
  siteChecks: SiteChecks;
  runId: string;
};

type AggregateArtifacts = {
  runDir: string;
  runId: string;
  report: FinalReport;
  taskResults: TaskRunResult[];
  accessibility: AccessibilityResult;
  siteChecks: SiteChecks;
};

const IMPACT_ORDER = ["minor", "moderate", "serious", "critical"];
const COVERAGE_ORDER = ["blocked", "inferred", "verified"];

function clampScore(value: number): number {
  return Math.min(10, Math.max(1, Math.round(value)));
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 1;
  }

  return clampScore(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function ensureSentence(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function overallFeeling(score: number): string {
  if (score >= 8) {
    return "smooth";
  }

  if (score >= 6) {
    return "mostly okay";
  }

  if (score >= 4) {
    return "mixed";
  }

  return "frustrating";
}

function isInternalWeakness(value: string): boolean {
  return /model evaluator did not finish|request timed out|current quota|429\b|run budget/i.test(value);
}

function formatAgentRunSource(agentRun: SubmissionAgentRun): string {
  return agentRun.profileLabel ? `${agentRun.label} (${agentRun.profileLabel})` : agentRun.label;
}

function formatTaskStatus(status: FinalReport["task_results"][number]["status"]): string {
  switch (status) {
    case "success":
      return "succeeded";
    case "partial_success":
      return "partially succeeded";
    case "failed":
    default:
      return "failed";
  }
}

function buildTaskOutcomeSummary(taskResults: FinalReport["task_results"]): string {
  if (taskResults.length === 0) {
    return "";
  }

  const successCount = taskResults.filter((task) => task.status === "success").length;
  const partialCount = taskResults.filter((task) => task.status === "partial_success").length;
  const failedCount = taskResults.filter((task) => task.status === "failed").length;
  const perTask = taskResults
    .slice(0, 5)
    .map((task) => `${task.name} ${formatTaskStatus(task.status)}`)
    .join("; ");

  return ensureSentence(
    `Accepted task outcomes across the panel: ${successCount} succeeded, ${partialCount} partially succeeded, and ${failedCount} failed.${perTask ? ` Per task: ${perTask}.` : ""}`
  );
}

function summarizeRankedItems(items: string[], limit: number): string[] {
  const counts = new Map<string, { count: number; sample: string; firstSeen: number }>();

  items.forEach((item, index) => {
    const key = normalizeKey(item);
    if (!key) {
      return;
    }

    const existing = counts.get(key);
    if (existing) {
      existing.count += 1;
      return;
    }

    counts.set(key, { count: 1, sample: item, firstSeen: index });
  });

  return Array.from(counts.values())
    .sort((left, right) => right.count - left.count || left.firstSeen - right.firstSeen)
    .slice(0, limit)
    .map((entry) => entry.sample);
}

function chooseImpact(left: string | null | undefined, right: string | null | undefined): string | null | undefined {
  const leftIndex = left ? IMPACT_ORDER.indexOf(left) : -1;
  const rightIndex = right ? IMPACT_ORDER.indexOf(right) : -1;
  return rightIndex > leftIndex ? right : left;
}

function coverageScore(siteChecks: SiteChecks): number {
  return Object.values(siteChecks.coverage).reduce((sum, coverage) => sum + COVERAGE_ORDER.indexOf(coverage.status), 0);
}

function pickBestSiteChecks(results: CompletedAgentAudit[]): SiteChecks {
  const best = [...results].sort((left, right) => coverageScore(right.siteChecks) - coverageScore(left.siteChecks))[0];
  return best?.siteChecks ?? {
    generatedAt: new Date().toISOString(),
    baseUrl: results[0]?.siteChecks.baseUrl ?? "",
    finalResolvedUrl: null,
    coverage: {
      performance: { status: "blocked", summary: "Performance checks were unavailable in the aggregate run.", evidence: [], blockers: [] },
      seo: { status: "blocked", summary: "SEO checks were unavailable in the aggregate run.", evidence: [], blockers: [] },
      uiux: { status: "inferred", summary: "UI and UX findings rely on the aggregate interaction evidence.", evidence: [], blockers: [] },
      security: { status: "blocked", summary: "Security checks were unavailable in the aggregate run.", evidence: [], blockers: [] },
      technicalHealth: { status: "inferred", summary: "Technical health relies on the aggregate runtime evidence.", evidence: [], blockers: [] },
      mobileOptimization: { status: "blocked", summary: "Mobile checks were unavailable in the aggregate run.", evidence: [], blockers: [] },
      contentQuality: { status: "blocked", summary: "Content checks were unavailable in the aggregate run.", evidence: [], blockers: [] },
      cro: { status: "inferred", summary: "CRO findings rely on the aggregate interaction evidence.", evidence: [], blockers: [] }
    },
    performance: { desktop: null, mobile: null, failedRequestCount: 0, imageFailureCount: 0, apiFailureCount: 0, navigationErrorCount: 0, stalledInteractionCount: 0, evidence: [] },
    seo: {
      robotsTxt: { url: "", ok: false, statusCode: null, note: "Unavailable." },
      sitemap: { url: "", ok: false, statusCode: null, note: "Unavailable." },
      brokenLinkCount: 0,
      checkedLinkCount: 0,
      brokenLinks: [],
      evidence: []
    },
    security: { https: false, secureTransportVerified: false, initialStatusCode: null, securityHeaders: [], missingHeaders: [], evidence: [] },
    technicalHealth: { framework: null, consoleErrorCount: 0, consoleWarningCount: 0, pageErrorCount: 0, apiFailureCount: 0, evidence: [] },
    mobileOptimization: { desktop: null, mobile: null, responsiveVerdict: "blocked", evidence: [] },
    contentQuality: { readabilityScore: null, readabilityLabel: "Blocked", wordCount: 0, longParagraphCount: 0, mediaCount: 0, evidence: [] },
    cro: { ctaCount: 0, primaryCtas: [], formCount: 0, submitControlCount: 0, trustSignalCount: 0, evidence: [] }
  };
}

function mergeAccessibility(results: CompletedAgentAudit[]): AccessibilityResult {
  const grouped = new Map<string, AccessibilityResult["violations"][number]>();
  let errorCount = 0;

  for (const result of results) {
    if (result.accessibility.error) {
      errorCount += 1;
    }

    for (const violation of result.accessibility.violations) {
      const existing = grouped.get(violation.id);
      if (existing) {
        existing.nodes += violation.nodes;
        existing.impact = chooseImpact(existing.impact ?? null, violation.impact ?? null) ?? undefined;
        continue;
      }

      grouped.set(violation.id, { ...violation });
    }
  }

  return {
    violations: Array.from(grouped.values()).sort((left, right) => right.nodes - left.nodes || left.id.localeCompare(right.id)),
    ...(errorCount > 0 ? { error: `Accessibility auditing reported issues in ${errorCount} of ${results.length} completed agent runs.` } : {})
  };
}

function aggregateTaskResults(results: CompletedAgentAudit[]): {
  taskResults: FinalReport["task_results"];
  syntheticRuns: TaskRunResult[];
} {
  const taskNames = Array.from(new Set(results.flatMap((result) => result.report.task_results.map((task) => task.name))));

  const aggregatedTasks = taskNames.map((taskName) => {
    const taskReports = results
      .map((result) => ({
        agentRun: result.agentRun,
        reportTask: result.report.task_results.find((task) => task.name === taskName) ?? null,
        rawTask: result.taskResults.find((task) => task.name === taskName) ?? null
      }))
      .filter((entry) => entry.reportTask || entry.rawTask);

    const statusCounts = {
      success: taskReports.filter((entry) => (entry.reportTask?.status ?? entry.rawTask?.status) === "success").length,
      partial_success: taskReports.filter((entry) => (entry.reportTask?.status ?? entry.rawTask?.status) === "partial_success").length,
      failed: taskReports.filter((entry) => (entry.reportTask?.status ?? entry.rawTask?.status) === "failed").length
    };

    const status: FinalReport["task_results"][number]["status"] =
      statusCounts.success > 0 && statusCounts.failed === 0 && statusCounts.partial_success === 0
        ? "success"
        : statusCounts.failed === taskReports.length
          ? "failed"
          : "partial_success";

    const evidence = taskReports
      .flatMap((entry) => {
        const reportEvidence = entry.reportTask?.evidence ?? [];
        if (reportEvidence.length > 0) {
          return reportEvidence.map((item) => `${formatAgentRunSource(entry.agentRun)}: ${item}`);
        }

        const fallbackReason = entry.reportTask?.reason ?? entry.rawTask?.reason;
        return fallbackReason ? [`${formatAgentRunSource(entry.agentRun)}: ${fallbackReason}`] : [];
      })
      .slice(0, 8);

    const finalUrl = taskReports.find((entry) => entry.rawTask?.finalUrl)?.rawTask?.finalUrl ?? "";
    const finalTitle = taskReports.find((entry) => entry.rawTask?.finalTitle)?.rawTask?.finalTitle ?? "";

    return {
      reportTask: {
        name: taskName,
        status,
        reason: `${statusCounts.success} success, ${statusCounts.partial_success} partial, and ${statusCounts.failed} failed across ${taskReports.length} agent perspectives.`,
        evidence
      },
      syntheticRun: {
        name: taskName,
        status,
        finalUrl,
        finalTitle,
        history: [],
        reason: `${statusCounts.success} success, ${statusCounts.partial_success} partial, and ${statusCounts.failed} failed across ${taskReports.length} agent perspectives.`
      }
    };
  });

  return {
    taskResults: aggregatedTasks.map((task) => task.reportTask),
    syntheticRuns: aggregatedTasks.map((task) => task.syntheticRun)
  };
}

function aggregateGameplaySummary(results: CompletedAgentAudit[]): FinalReport["gameplay_summary"] | undefined {
  const gameplaySummaries = results
    .map((result) => result.report.gameplay_summary)
    .filter((summary): summary is NonNullable<FinalReport["gameplay_summary"]> => Boolean(summary));
  if (gameplaySummaries.length === 0) {
    return undefined;
  }

  const roundsRequested = gameplaySummaries.reduce((sum, summary) => sum + summary.roundsRequested, 0);
  const roundsRecorded = gameplaySummaries.reduce((sum, summary) => sum + summary.roundsRecorded, 0);
  const wins = gameplaySummaries.reduce((sum, summary) => sum + summary.wins, 0);
  const losses = gameplaySummaries.reduce((sum, summary) => sum + summary.losses, 0);
  const draws = gameplaySummaries.reduce((sum, summary) => sum + summary.draws, 0);
  const inconclusiveRounds = gameplaySummaries.reduce((sum, summary) => sum + summary.inconclusiveRounds, 0);
  const howToPlayConfirmed = gameplaySummaries.some((summary) => summary.howToPlayConfirmed);
  const replayConfirmed = gameplaySummaries.some((summary) => summary.replayConfirmed);
  const evidence = gameplaySummaries.flatMap((summary) => summary.evidence).slice(0, 8);

  return {
    roundsRequested,
    roundsRecorded,
    wins,
    losses,
    draws,
    inconclusiveRounds,
    howToPlayConfirmed,
    replayConfirmed,
    summary: `Across ${gameplaySummaries.length} gameplay perspective(s), the run recorded ${roundsRecorded}/${roundsRequested} requested rounds: ${wins} wins, ${losses} losses, ${draws} draws, and ${inconclusiveRounds} inconclusive round(s).`,
    evidence
  };
}

function buildAggregateReport(submission: Submission, results: CompletedAgentAudit[]): {
  report: FinalReport;
  taskRuns: TaskRunResult[];
  accessibility: AccessibilityResult;
  siteChecks: SiteChecks;
  rawEvents: unknown[];
} {
  const completedAgentCount = results.length;
  const failedAgentCount = submission.failedAgentCount;
  const firstStrength = summarizeRankedItems(results.flatMap((result) => result.report.strengths), 6);
  const firstWeakness = summarizeRankedItems(results.flatMap((result) => result.report.weaknesses), 6);
  const firstFixes = summarizeRankedItems(results.flatMap((result) => result.report.top_fixes), 6);
  const accessibility = mergeAccessibility(results);
  const siteChecks = pickBestSiteChecks(results);
  const { taskResults, syntheticRuns } = aggregateTaskResults(results);
  const gameplaySummary = aggregateGameplaySummary(results);
  const overallScore = average(results.map((result) => result.report.overall_score));
  const visitorFacingWeaknesses = firstWeakness.filter((item) => !isInternalWeakness(item));
  const primaryWeakness = visitorFacingWeaknesses[0];
  const taskOutcomeSummary = buildTaskOutcomeSummary(taskResults);

  const report: FinalReport = {
    overall_score: overallScore,
    summary: [
      `I checked ${submission.url} from ${completedAgentCount} visitor perspective${completedAgentCount === 1 ? "" : "s"}, and overall the experience felt ${overallFeeling(overallScore)} at ${overallScore}/10.`,
      taskOutcomeSummary,
      gameplaySummary ? ensureSentence(gameplaySummary.summary) : "",
      primaryWeakness ? ensureSentence(primaryWeakness) : "",
      failedAgentCount > 0 ? `${failedAgentCount} perspective${failedAgentCount === 1 ? "" : "s"} failed before the visit could fully finish.` : ""
    ]
      .filter(Boolean)
      .join(" "),
    scores: {
      clarity: average(results.map((result) => result.report.scores.clarity)),
      navigation: average(results.map((result) => result.report.scores.navigation)),
      trust: average(results.map((result) => result.report.scores.trust)),
      friction: average(results.map((result) => result.report.scores.friction)),
      conversion_readiness: average(results.map((result) => result.report.scores.conversion_readiness)),
      accessibility_basics: average(results.map((result) => result.report.scores.accessibility_basics))
    },
    strengths: firstStrength,
    weaknesses: firstWeakness,
    task_results: taskResults,
    top_fixes: firstFixes,
    ...(gameplaySummary ? { gameplay_summary: gameplaySummary } : {})
  };

  const rawEvents = [
    {
      type: "batch_summary",
      time: new Date().toISOString(),
      completedAgentCount,
      failedAgentCount,
      note: `Batch task panel finished with ${completedAgentCount} completed agent runs and ${failedAgentCount} failed agent runs.`
    },
    ...results.map((result) => ({
      type: "agent_batch_result",
      time: result.agentRun.completedAt ?? new Date().toISOString(),
      agentId: result.agentRun.id,
      agentLabel: result.agentRun.label,
      profileLabel: result.agentRun.profileLabel,
      personaName: result.agentRun.personaName,
      runId: result.runId,
      overallScore: result.report.overall_score,
      note: result.report.summary
    }))
  ];

  return {
    report,
    taskRuns: syntheticRuns,
    accessibility,
    siteChecks,
    rawEvents
  };
}

export function createAggregateRun(submission: Submission, results: CompletedAgentAudit[]): AggregateArtifacts {
  const aggregateStartedAt = submission.startedAt ?? new Date().toISOString();
  const runDir = resolveRunDir(submission.url);
  const runId = path.basename(runDir);
  const aggregatePersona =
    submission.customTasks.length > 0
      ? `Task panel: ${submission.customTasks[0]}${submission.customTasks.length > 1 ? ` + ${submission.customTasks.length - 1} more` : ""}`
      : `${submission.agentCount}-agent task panel`;
  const { report, taskRuns, accessibility, siteChecks, rawEvents } = buildAggregateReport(submission, results);
  const timeZone = config.deviceTimezone;
  const inputs = {
    baseUrl: submission.url,
    persona: aggregatePersona,
    instructionText: submission.instructionText,
    instructionFileName: submission.instructionFileName,
    headed: submission.headed,
    mobile: submission.mobile,
    ignoreHttpsErrors: submission.ignoreHttpsErrors,
    model: config.model,
    startedAt: aggregateStartedAt,
    maxRunDurationMs: config.maxSessionDurationMs,
    maxRunDurationSeconds: Math.round(config.maxSessionDurationMs / 1000),
    browserExecutionBudgetMs: config.browserExecutionBudgetMs,
    reportingReserveMs: config.reportingReserveMs,
    maxRunDurationClamped: false,
    deviceTimezone: config.deviceTimezone,
    synchronizedTimezone: timeZone,
    batchRole: "aggregate",
    parentSubmissionId: submission.id,
    agentCount: submission.agentCount,
    completedAgentCount: submission.completedAgentCount,
    failedAgentCount: submission.failedAgentCount,
    customTasks: submission.customTasks,
    aggregatedFromRunIds: results.map((result) => result.runId),
    agentRuns: submission.agentRuns.map((agentRun) => ({
      ...agentRun,
      runDir: null
    }))
  };

  writeJson(path.join(runDir, "inputs.json"), inputs);
  writeJson(path.join(runDir, "raw-events.json"), rawEvents);
  writeJson(path.join(runDir, "task-results.json"), taskRuns);
  writeJson(path.join(runDir, "accessibility.json"), accessibility);
  writeJson(path.join(runDir, "site-checks.json"), siteChecks);
  writeJson(path.join(runDir, "report.json"), report);
  writeText(
    path.join(runDir, "report.html"),
    renderHtmlReport({
      website: submission.url,
      persona: aggregatePersona,
      acceptedTasks: submission.customTasks,
      instructionText: submission.instructionText,
      report,
      taskResults: taskRuns,
      accessibility,
      siteChecks,
      rawEvents,
      runId,
      startedAt: aggregateStartedAt,
      mobile: submission.mobile,
      timeZone
    })
  );
  writeText(
    path.join(runDir, "report.md"),
    renderMarkdownReport({
      website: submission.url,
      persona: aggregatePersona,
      acceptedTasks: submission.customTasks,
      instructionText: submission.instructionText,
      report,
      taskResults: taskRuns,
      accessibility,
      siteChecks,
      rawEvents,
      startedAt: aggregateStartedAt,
      mobile: submission.mobile,
      timeZone
    })
  );

  return {
    runDir,
    runId,
    report,
    taskResults: taskRuns,
    accessibility,
    siteChecks
  };
}
