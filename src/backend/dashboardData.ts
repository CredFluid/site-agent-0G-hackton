import { z } from "zod";
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
import type { RunRepository } from "./runRepository.js";

const TaskRunResultsSchema = z.array(TaskRunResultSchema);
const RawEventsSchema = z.array(z.unknown());

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

function isVisibleDashboardRun(run: DashboardRunSummary): boolean {
  return run.batchRole !== "child";
}

function collectSiteCheckWarnings(runId: string, siteChecks: z.infer<typeof SiteChecksSchema> | null): string[] {
  if (!siteChecks) {
    return [
      `This run is missing supplemental site checks. Run \`npm run backfill:site-checks -- --run ${runId}\` or rerun the audit to verify performance, SEO, security, content, and mobile responsiveness.`
    ];
  }

  const blockers = Object.values(siteChecks.coverage).flatMap((coverage) => coverage.blockers);
  if (blockers.some((blocker) => /__name is not defined/i.test(blocker))) {
    return [
      `This run used an older broken probe build. Run \`npm run backfill:site-checks -- --run ${runId} --force\` or rerun the audit to refresh the blocked metrics, including the mobile responsiveness check.`
    ];
  }

  return [];
}

async function enrichAgentRunsWithReplay(repository: RunRepository, agentRuns: RunInputs["agentRuns"]): Promise<RunInputs["agentRuns"]> {
  return Promise.all(
    agentRuns.map(async (agentRun) => {
      const childRunId = agentRun.runId?.trim();
      if (!childRunId) {
        return agentRun;
      }

      const clickReplayAvailable = (await repository.readBinaryArtifact(childRunId, "click-replay.webp")) !== null;
      return {
        ...agentRun,
        clickReplayAvailable,
        clickReplayArtifact: clickReplayAvailable ? "click-replay.webp" : null
      };
    })
  );
}

export async function buildRunSummary(repository: RunRepository, runId: string): Promise<DashboardRunSummary> {
  const inputs = await repository.readJsonArtifact(runId, "inputs.json", RunInputsSchema);
  const report = await repository.readJsonArtifact(runId, "report.json", FinalReportSchema);
  const accessibility = await repository.readJsonArtifact(runId, "accessibility.json", AccessibilityResultSchema);

  return DashboardRunSummarySchema.parse({
    id: runId,
    baseUrl: inputs?.baseUrl ?? "",
    host: readHost(inputs?.baseUrl, runId),
    startedAt: inputs?.startedAt ?? null,
    headed: inputs?.headed ?? false,
    mobile: inputs?.mobile ?? false,
    llmProvider: inputs?.llmProvider ?? null,
    model: inputs?.model ?? null,
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

export async function listVisibleRunSummaries(repository: RunRepository): Promise<DashboardRunSummary[]> {
  const runIds = await repository.listRunIds();
  const allRuns = await Promise.all(runIds.map((runId) => buildRunSummary(repository, runId)));
  return allRuns.filter(isVisibleDashboardRun);
}

export async function buildRunDetail(repository: RunRepository, runId: string): Promise<DashboardRunDetail | null> {
  const inputs = await repository.readJsonArtifact(runId, "inputs.json", RunInputsSchema);
  const inferredClickReplayArtifact =
    (await repository.readBinaryArtifact(runId, "click-replay.webp")) !== null ? "click-replay.webp" : null;
  const inputsWithReplay =
    inputs
      ? {
          ...inputs,
          ...(inferredClickReplayArtifact && !inputs.clickReplayArtifact ? { clickReplayArtifact: inferredClickReplayArtifact } : {}),
          agentRuns: await enrichAgentRunsWithReplay(repository, inputs.agentRuns)
        }
      : inputs;
  const report = await repository.readJsonArtifact(runId, "report.json", FinalReportSchema);
  const accessibility = await repository.readJsonArtifact(runId, "accessibility.json", AccessibilityResultSchema);
  const siteChecks = await repository.readJsonArtifact(runId, "site-checks.json", SiteChecksSchema);
  const taskRuns = (await repository.readJsonArtifact(runId, "task-results.json", TaskRunResultsSchema)) ?? [];
  const rawEvents = (await repository.readJsonArtifact(runId, "raw-events.json", RawEventsSchema)) ?? [];

  if (!inputs && !report && !accessibility && !siteChecks && taskRuns.length === 0 && rawEvents.length === 0) {
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
  warnings.push(...collectSiteCheckWarnings(runId, siteChecks));

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
    host: readHost(inputsWithReplay?.baseUrl, runId),
    inputs: inputsWithReplay,
    report,
    accessibility,
    siteChecks,
    tasks,
    rawEventCount: rawEvents.length,
    warnings
  });
}

export async function buildStandaloneReportHtml(repository: RunRepository, runId: string): Promise<string | null> {
  const inputs = await repository.readJsonArtifact(runId, "inputs.json", RunInputsSchema);
  const report = await repository.readJsonArtifact(runId, "report.json", FinalReportSchema);
  const accessibility = await repository.readJsonArtifact(runId, "accessibility.json", AccessibilityResultSchema);
  const siteChecks = await repository.readJsonArtifact(runId, "site-checks.json", SiteChecksSchema);
  const taskRuns = (await repository.readJsonArtifact(runId, "task-results.json", TaskRunResultsSchema)) ?? [];
  const rawEvents = (await repository.readJsonArtifact(runId, "raw-events.json", RawEventsSchema)) ?? [];

  if (!report) {
    return repository.readTextArtifact(runId, "report.html");
  }

  return renderHtmlReport({
    website: inputs?.baseUrl ?? runId,
    persona: inputs?.persona ?? "first-time visitor",
    acceptedTasks: inputs?.customTasks ?? [],
    instructionText: inputs?.instructionText,
    report,
    taskResults: taskRuns,
    accessibility: accessibility ?? undefined,
    siteChecks: siteChecks ?? undefined,
    siteBrief: inputs?.siteBrief,
    rawEvents,
    runId,
    startedAt: inputs?.startedAt,
    mobile: inputs?.mobile,
    timeZone: inputs?.synchronizedTimezone ?? inputs?.browserTimezone ?? inputs?.deviceTimezone
  });
}

export async function loadDashboardData(repository: RunRepository, selectedRunId: string | null): Promise<{
  runs: DashboardRunSummary[];
  detail: DashboardRunDetail | null;
  selectedRunId: string | null;
}> {
  const runs = await listVisibleRunSummaries(repository);
  let resolvedRunId = selectedRunId;
  let detail = selectedRunId ? await buildRunDetail(repository, selectedRunId) : null;

  if (!detail) {
    resolvedRunId = runs.find((run) => run.id === selectedRunId)?.id ?? runs[0]?.id ?? null;
    detail = resolvedRunId ? await buildRunDetail(repository, resolvedRunId) : null;
  }

  return {
    runs,
    detail,
    selectedRunId: resolvedRunId
  };
}
