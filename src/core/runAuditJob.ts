import type { TaskSuite } from "../schemas/types.js";
import path from "node:path";
import { getAccessIdentityLabel, runWithAccessIdentityContext, type AccessIdentityContext } from "../auth/profile.js";
import { clampRunDurationMs, config, deriveBrowserExecutionBudgetMs, deriveReportingReserveMs, resolveLlmRuntime, type LlmProvider } from "../config.js";
import { evaluateRun } from "./evaluator.js";
import { runTaskSuite } from "./runner.js";
import { generateClickReplay } from "../reporting/clickReplay.js";
import { renderHtmlReport } from "../reporting/html.js";
import { renderMarkdownReport } from "../reporting/markdown.js";
import type { TradeRunOptions } from "../trade/types.js";
import { ensureDir, resolveRunDir, writeJson, writeText } from "../utils/files.js";
import { info } from "../utils/log.js";
import { createAndRegisterZGProof } from "../zerog/proof.js";

function summarizeSessionPath(filePath: string): string {
  const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
  const relativePath = path.relative(process.cwd(), resolvedPath);
  return relativePath && relativePath !== "" && !relativePath.startsWith("..")
    ? relativePath
    : path.basename(resolvedPath);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s.`));
    }, timeoutMs);
  });

  promise.catch(() => undefined);

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function logZGProofExplorer(runId: string, explorerUrl: string, late = false): void {
  process.stdout.write(`[0G proof] ${runId} ${late ? "late " : ""}explorer: ${explorerUrl}\n`);
}

function formatElapsed(startedAtMs: number): string {
  return `${((Date.now() - startedAtMs) / 1000).toFixed(1)}s`;
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
  tradeOptions?: TradeRunOptions;
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
    const runId = path.basename(runDir);
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
      ...(options.tradeOptions ? { tradeOptions: options.tradeOptions } : {}),
      ...(options.extraInputs ?? {})
    };

    writeJson(inputsPath, baseInputs);
    info(`Run ${runId}: initialized artifacts directory`);

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
      ...(options.tradeOptions ? { tradeOptions: options.tradeOptions } : {}),
      provider: llmRuntime.provider,
      model: llmRuntime.model,
      ollamaBaseUrl: llmRuntime.ollamaBaseUrl
    });
    info(`Run ${runId}: browser execution completed in ${formatElapsed(startedAtMs)}`);

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
      info(
        clickReplayArtifact
          ? `Run ${runId}: click replay generated (${clickReplayFrameCount ?? 0} frames)`
          : `Run ${runId}: click replay skipped because no replay frames were available`
      );
    } catch {
      // Replay generation is optional and should never block the main report.
      info(`Run ${runId}: click replay skipped after a non-blocking generation error`);
    }

    let finalInputs: Record<string, unknown> = {
      ...baseInputs,
      ...(execution.siteBrief ? { siteBrief: execution.siteBrief } : {}),
      browserTimezone: execution.browserTimezone,
      synchronizedTimezone: execution.browserTimezone || execution.deviceTimezone,
      ...(clickReplayArtifact ? { clickReplayArtifact } : {}),
      ...(clickReplayFrameCount !== null ? { clickReplayFrameCount } : {}),
      ...(clickReplayDurationMs !== null ? { clickReplayDurationMs } : {})
    };

    writeJson(inputsPath, finalInputs);

    const remainingEvaluationBudgetMs = Math.max(0, maxRunDurationMs - (Date.now() - startedAtMs));
    let report = await evaluateRun({
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
    info(`Run ${runId}: model evaluation completed in ${formatElapsed(startedAtMs)}`);

    const persistZGProof = (zgProof: NonNullable<Awaited<ReturnType<typeof createAndRegisterZGProof>>>): void => {
      report = {
        ...report,
        zgProof
      };
      finalInputs = {
        ...finalInputs,
        zgProof,
        zgProofError: undefined,
        zgProofPending: undefined
      };
      writeJson(path.join(runDir, "report.json"), report);
      writeJson(inputsPath, finalInputs);
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
          timeZone: execution.browserTimezone || execution.deviceTimezone,
          clickReplayArtifact
        })
      );
    };

    try {
      const completedAt = new Date().toISOString();
      const proofPromise = createAndRegisterZGProof({
        runDir,
        runId,
        targetUrl: options.baseUrl,
        tasks: suite.tasks.map((task) => task.goal),
        overallScore: report.overall_score,
        agentId:
          typeof options.extraInputs?.agentRunId === "string"
            ? options.extraInputs.agentRunId
            : typeof options.extraInputs?.agentLabel === "string"
              ? options.extraInputs.agentLabel
              : accessIdentityName,
        completedAt
      });
      let proofLogged = false;
      proofPromise
        .then((lateProof) => {
          if (lateProof && !proofLogged) {
            proofLogged = true;
            logZGProofExplorer(runId, lateProof.explorerUrl, true);
            persistZGProof(lateProof);
          }
        })
        .catch(() => undefined);

      const zgProof = await withTimeout(
        proofPromise,
        config.zgProofTimeoutMs,
        "0G proof"
      );

      if (zgProof) {
        if (!proofLogged) {
          proofLogged = true;
          logZGProofExplorer(runId, zgProof.explorerUrl);
        }
        persistZGProof(zgProof);
        info(`Run ${runId}: 0G proof artifact saved`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const proofMayStillComplete = /timed out/i.test(message);
      process.stderr.write(
        `[0G proof] ${path.basename(runDir)}: ${message}${proofMayStillComplete ? " Waiting in background for a late explorer URL.\n" : "\n"}`
      );
      finalInputs = {
        ...finalInputs,
        ...(proofMayStillComplete ? { zgProofPending: message } : { zgProofError: message })
      };
      writeJson(inputsPath, finalInputs);
    }

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
        timeZone: execution.browserTimezone || execution.deviceTimezone,
        clickReplayArtifact
      })
    );
    info(`Run ${runId}: HTML report written`);
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
    info(`Run ${runId}: Markdown report written`);

    return {
      startedAt,
      runDir,
      report,
      execution
    };
  });
}
