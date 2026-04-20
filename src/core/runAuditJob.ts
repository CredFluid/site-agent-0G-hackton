import type { TaskSuite } from "../schemas/types.js";
import path from "node:path";
import { getAccessIdentityLabel, runWithAccessIdentityContext, type AccessIdentityContext } from "../auth/profile.js";
import { clampRunDurationMs, config, deriveBrowserExecutionBudgetMs, deriveReportingReserveMs, resolveLlmRuntime, type LlmProvider } from "../config.js";
import { evaluateRun } from "./evaluator.js";
import { runTaskSuite } from "./runner.js";
import { generateClickReplay } from "../reporting/clickReplay.js";
import { renderHtmlReport } from "../reporting/html.js";
import { renderMarkdownReport } from "../reporting/markdown.js";
import { ensureDir, resolveRunDir, writeJson, writeText } from "../utils/files.js";

function summarizeSessionPath(filePath: string): string {
  const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
  const relativePath = path.relative(process.cwd(), resolvedPath);
  return relativePath && relativePath !== "" && !relativePath.startsWith("..")
    ? relativePath
    : path.basename(resolvedPath);
}

export async function runAuditJob(options: {
  baseUrl: string;
  runDir?: string;
  suiteOverride: TaskSuite;
  headed?: boolean;
  mobile?: boolean;
  ignoreHttpsErrors?: boolean;
  storageStatePath?: string | undefined;
  saveStorageStatePath?: string | undefined;
  maxSessionDurationMs?: number;
  llmProvider?: LlmProvider;
  model?: string;
  ollamaBaseUrl?: string;
  extraInputs?: Record<string, unknown>;
}): Promise<{
  startedAt: string;
  runDir: string;
  report: Awaited<ReturnType<typeof evaluateRun>>;
  execution: Awaited<ReturnType<typeof runTaskSuite>>;
}> {
  const accessIdentityContext: AccessIdentityContext = {
    ...(typeof options.extraInputs?.agentIndex === "number" ? { agentIndex: options.extraInputs.agentIndex } : {}),
    ...(typeof options.extraInputs?.agentLabel === "string" ? { agentLabel: options.extraInputs.agentLabel } : {}),
    ...(typeof options.extraInputs?.agentProfileLabel === "string"
      ? { agentProfileLabel: options.extraInputs.agentProfileLabel }
      : {})
  };

  return await runWithAccessIdentityContext(accessIdentityContext, async () => {
    const suite = options.suiteOverride;
    const runDir = options.runDir ?? resolveRunDir(options.baseUrl);
    ensureDir(runDir);
    const inputsPath = path.join(runDir, "inputs.json");
    const startedAt = new Date().toISOString();
    const startedAtMs = Date.now();
    const requestedMaxSessionDurationMs = options.maxSessionDurationMs ?? config.maxSessionDurationMs;
    const maxRunDurationMs = clampRunDurationMs(requestedMaxSessionDurationMs);
    const browserExecutionBudgetMs = deriveBrowserExecutionBudgetMs(maxRunDurationMs);
    const reportingReserveMs = deriveReportingReserveMs(maxRunDurationMs);
    const llmRuntime = resolveLlmRuntime({
      ...(options.llmProvider ? { provider: options.llmProvider } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(options.ollamaBaseUrl ? { ollamaBaseUrl: options.ollamaBaseUrl } : {})
    });
    const storageStatePath = options.storageStatePath ?? config.playwrightStorageStatePath;
    const saveStorageStatePath = options.saveStorageStatePath;
    const instructionText =
      typeof options.extraInputs?.instructionText === "string"
        ? options.extraInputs.instructionText
        : suite.tasks.map((task) => task.goal).join("\n");
    const accessIdentityName = getAccessIdentityLabel(accessIdentityContext);
    const baseInputs = {
      baseUrl: options.baseUrl,
      persona: suite.persona.name,
      headed: Boolean(options.headed),
      mobile: Boolean(options.mobile),
      ignoreHttpsErrors: Boolean(options.ignoreHttpsErrors),
      llmProvider: llmRuntime.provider,
      storageStateLoaded: Boolean(storageStatePath),
      storageStateSource: storageStatePath ? summarizeSessionPath(storageStatePath) : null,
      saveStorageStateRequested: Boolean(saveStorageStatePath),
      saveStorageStateTarget: saveStorageStatePath ? summarizeSessionPath(saveStorageStatePath) : null,
      model: llmRuntime.model,
      startedAt,
      maxRunDurationMs,
      maxRunDurationSeconds: Math.round(maxRunDurationMs / 1000),
      browserExecutionBudgetMs,
      reportingReserveMs,
      maxRunDurationClamped: maxRunDurationMs !== requestedMaxSessionDurationMs,
      deviceTimezone: config.deviceTimezone,
      synchronizedTimezone: config.deviceTimezone,
      customTasks: suite.tasks.map((task) => task.goal),
      accessIdentityName,
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
      storageStatePath,
      saveStorageStatePath,
      maxSessionDurationMs: browserExecutionBudgetMs,
      provider: llmRuntime.provider,
      model: llmRuntime.model,
      ollamaBaseUrl: llmRuntime.ollamaBaseUrl
    });

    let clickReplayArtifact: string | null = null;
    let clickReplayFrameCount: number | null = null;
    let clickReplayDurationMs: number | null = null;

    try {
      const clickReplay = await generateClickReplay({
        runDir,
        taskResults: execution.taskResults
      });
      clickReplayArtifact = clickReplay?.artifactName ?? null;
      clickReplayFrameCount = clickReplay?.frameCount ?? null;
      clickReplayDurationMs = clickReplay?.durationMs ?? null;
    } catch {
      // Replay generation is optional and should never block the main report.
    }

    writeJson(inputsPath, {
      ...baseInputs,
      ...(execution.siteBrief ? { siteBrief: execution.siteBrief } : {}),
      browserTimezone: execution.browserTimezone,
      synchronizedTimezone: execution.browserTimezone || execution.deviceTimezone,
      ...(clickReplayArtifact ? { clickReplayArtifact } : {}),
      ...(clickReplayFrameCount !== null ? { clickReplayFrameCount } : {}),
      ...(clickReplayDurationMs !== null ? { clickReplayDurationMs } : {})
    });

    const remainingEvaluationBudgetMs = Math.max(0, maxRunDurationMs - (Date.now() - startedAtMs));
    const report = await evaluateRun({
      baseUrl: options.baseUrl,
      suite,
      siteBrief: execution.siteBrief,
      taskResults: execution.taskResults,
      rawEvents: execution.rawEvents,
      accessibility: execution.accessibility,
      mobile: Boolean(options.mobile),
      timeoutMs: remainingEvaluationBudgetMs,
      totalRunDurationMs: maxRunDurationMs,
      llm: {
        provider: llmRuntime.provider,
        model: llmRuntime.model,
        ollamaBaseUrl: llmRuntime.ollamaBaseUrl
      }
    });

    writeJson(path.join(runDir, "report.json"), report);
    writeText(
      path.join(runDir, "report.html"),
      renderHtmlReport({
        website: options.baseUrl,
        persona: suite.persona.name,
        acceptedTasks: suite.tasks.map((task) => task.goal),
        instructionText,
        report,
        taskResults: execution.taskResults,
        accessibility: execution.accessibility,
        siteChecks: execution.siteChecks,
        siteBrief: execution.siteBrief,
        rawEvents: execution.rawEvents,
        runId: path.basename(runDir),
        startedAt,
        mobile: Boolean(options.mobile),
        timeZone: execution.browserTimezone || execution.deviceTimezone
      })
    );
    writeText(
      path.join(runDir, "report.md"),
      renderMarkdownReport({
        website: options.baseUrl,
        persona: suite.persona.name,
        acceptedTasks: suite.tasks.map((task) => task.goal),
        instructionText,
        report,
        taskResults: execution.taskResults,
        accessibility: execution.accessibility,
        siteChecks: execution.siteChecks,
        siteBrief: execution.siteBrief,
        rawEvents: execution.rawEvents,
        startedAt,
        mobile: Boolean(options.mobile),
        timeZone: execution.browserTimezone || execution.deviceTimezone
      })
    );

    return {
      startedAt,
      runDir,
      report,
      execution
    };
  });
}
