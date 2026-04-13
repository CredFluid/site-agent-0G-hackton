import path from "node:path";
import { config } from "../config.js";
import { renderHtmlReport } from "../reporting/html.js";
import { renderMarkdownReport } from "../reporting/markdown.js";
import type { AccessibilityResult, FinalReport, TaskRunResult } from "../schemas/types.js";
import type { Submission, SubmissionAgentRun } from "../submissions/types.js";
import { resolveRunDir, writeJson, writeText } from "../utils/files.js";

export type CompletedAgentAudit = {
  agentRun: SubmissionAgentRun;
  report: FinalReport;
  taskResults: TaskRunResult[];
  accessibility: AccessibilityResult;
  runId: string;
};

type AggregateArtifacts = {
  runDir: string;
  runId: string;
  report: FinalReport;
  taskResults: TaskRunResult[];
  accessibility: AccessibilityResult;
};

const IMPACT_ORDER = ["minor", "moderate", "serious", "critical"];

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
          return reportEvidence.map((item) => `${entry.agentRun.label} (${entry.agentRun.profileLabel}): ${item}`);
        }

        const fallbackReason = entry.reportTask?.reason ?? entry.rawTask?.reason;
        return fallbackReason ? [`${entry.agentRun.label} (${entry.agentRun.profileLabel}): ${fallbackReason}`] : [];
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

function buildAggregateReport(submission: Submission, results: CompletedAgentAudit[]): {
  report: FinalReport;
  taskRuns: TaskRunResult[];
  accessibility: AccessibilityResult;
  rawEvents: unknown[];
} {
  const completedAgentCount = results.length;
  const failedAgentCount = submission.failedAgentCount;
  const firstStrength = summarizeRankedItems(results.flatMap((result) => result.report.strengths), 6);
  const firstWeakness = summarizeRankedItems(results.flatMap((result) => result.report.weaknesses), 6);
  const firstFixes = summarizeRankedItems(results.flatMap((result) => result.report.top_fixes), 6);
  const accessibility = mergeAccessibility(results);
  const { taskResults, syntheticRuns } = aggregateTaskResults(results);
  const overallScore = average(results.map((result) => result.report.overall_score));

  const report: FinalReport = {
    overall_score: overallScore,
    summary: `${completedAgentCount} of ${submission.agentCount} agent perspectives completed for ${submission.url}. The average overall score was ${overallScore}/10.${failedAgentCount > 0 ? ` ${failedAgentCount} agent run${failedAgentCount === 1 ? "" : "s"} failed before completion.` : ""}`,
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
    top_fixes: firstFixes
  };

  const rawEvents = [
    {
      type: "batch_summary",
      time: new Date().toISOString(),
      completedAgentCount,
      failedAgentCount,
      note: `Batch review finished with ${completedAgentCount} completed agent runs and ${failedAgentCount} failed agent runs.`
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
    rawEvents
  };
}

export function createAggregateRun(submission: Submission, results: CompletedAgentAudit[]): AggregateArtifacts {
  const aggregateStartedAt = submission.startedAt ?? new Date().toISOString();
  const runDir = resolveRunDir(submission.url);
  const runId = path.basename(runDir);
  const aggregatePersona = `${submission.agentCount}-agent review panel`;
  const { report, taskRuns, accessibility, rawEvents } = buildAggregateReport(submission, results);
  const timeZone = config.deviceTimezone;
  const inputs = {
    baseUrl: submission.url,
    taskPath: submission.taskPath,
    persona: aggregatePersona,
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
  writeJson(path.join(runDir, "report.json"), report);
  writeText(
    path.join(runDir, "report.html"),
    renderHtmlReport({
      website: submission.url,
      persona: aggregatePersona,
      report,
      taskResults: taskRuns,
      runId,
      startedAt: aggregateStartedAt,
      timeZone
    })
  );
  writeText(
    path.join(runDir, "report.md"),
    renderMarkdownReport({
      website: submission.url,
      persona: aggregatePersona,
      report
    })
  );

  return {
    runDir,
    runId,
    report,
    taskResults: taskRuns,
    accessibility
  };
}
