import type { TaskSuite } from "../schemas/types.js";
import path from "node:path";
import { clampRunDurationMs, config, deriveBrowserExecutionBudgetMs, deriveReportingReserveMs } from "../config.js";
import { evaluateRun } from "./evaluator.js";
import { loadTaskSuite } from "./loadTaskSuite.js";
import { runTaskSuite } from "./runner.js";
import { renderHtmlReport } from "../reporting/html.js";
import { renderMarkdownReport } from "../reporting/markdown.js";
import { resolveRunDir, writeJson, writeText } from "../utils/files.js";

export async function runAuditJob(options: {
  baseUrl: string;
  taskPath?: string;
  suiteOverride?: TaskSuite;
  headed?: boolean;
  mobile?: boolean;
  ignoreHttpsErrors?: boolean;
  maxSessionDurationMs?: number;
  extraInputs?: Record<string, unknown>;
}): Promise<{
  startedAt: string;
  runDir: string;
  report: Awaited<ReturnType<typeof evaluateRun>>;
  execution: Awaited<ReturnType<typeof runTaskSuite>>;
  taskPath: string;
}> {
  const taskPath = options.taskPath ?? "src/tasks/first_time_buyer.json";
  const suite = options.suiteOverride ?? loadTaskSuite(taskPath);
  const runDir = resolveRunDir(options.baseUrl);
  const inputsPath = path.join(runDir, "inputs.json");
  const startedAt = new Date().toISOString();
  const startedAtMs = Date.now();
  const requestedMaxSessionDurationMs = options.maxSessionDurationMs ?? config.maxSessionDurationMs;
  const maxRunDurationMs = clampRunDurationMs(requestedMaxSessionDurationMs);
  const browserExecutionBudgetMs = deriveBrowserExecutionBudgetMs(maxRunDurationMs);
  const reportingReserveMs = deriveReportingReserveMs(maxRunDurationMs);
  const baseInputs = {
    baseUrl: options.baseUrl,
    taskPath,
    persona: suite.persona.name,
    headed: Boolean(options.headed),
    mobile: Boolean(options.mobile),
    ignoreHttpsErrors: Boolean(options.ignoreHttpsErrors),
    model: config.model,
    startedAt,
    maxRunDurationMs,
    maxRunDurationSeconds: Math.round(maxRunDurationMs / 1000),
    browserExecutionBudgetMs,
    reportingReserveMs,
    maxRunDurationClamped: maxRunDurationMs !== requestedMaxSessionDurationMs,
    deviceTimezone: config.deviceTimezone,
    synchronizedTimezone: config.deviceTimezone,
    ...(options.extraInputs ?? {})
  };

  writeJson(inputsPath, baseInputs);

  const execution = await runTaskSuite({
    baseUrl: options.baseUrl,
    suite,
    runDir,
    headed: Boolean(options.headed),
    mobile: Boolean(options.mobile),
    ignoreHttpsErrors: Boolean(options.ignoreHttpsErrors),
    maxSessionDurationMs: browserExecutionBudgetMs
  });

  writeJson(inputsPath, {
    ...baseInputs,
    browserTimezone: execution.browserTimezone,
    synchronizedTimezone: execution.browserTimezone || execution.deviceTimezone
  });

  const remainingEvaluationBudgetMs = Math.max(0, maxRunDurationMs - (Date.now() - startedAtMs));
  const report = await evaluateRun({
    baseUrl: options.baseUrl,
    suite,
    taskResults: execution.taskResults,
    rawEvents: execution.rawEvents,
    accessibility: execution.accessibility,
    timeoutMs: remainingEvaluationBudgetMs,
    totalRunDurationMs: maxRunDurationMs
  });

  writeJson(path.join(runDir, "report.json"), report);
  writeText(
    path.join(runDir, "report.html"),
    renderHtmlReport({
      website: options.baseUrl,
      persona: suite.persona.name,
      report,
      taskResults: execution.taskResults,
      runId: path.basename(runDir),
      startedAt,
      timeZone: execution.browserTimezone || execution.deviceTimezone
    })
  );
  writeText(
    path.join(runDir, "report.md"),
    renderMarkdownReport({
      website: options.baseUrl,
      persona: suite.persona.name,
      report
    })
  );

  return {
    startedAt,
    runDir,
    report,
    execution,
    taskPath
  };
}
