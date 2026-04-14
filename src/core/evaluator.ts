import { config } from "../config.js";
import { generateStructured } from "../llm/client.js";
import { TASK_OUTCOME_ANALYST_PROMPT } from "../prompts/reviewer.js";
import { buildFallbackReport } from "./fallbackReport.js";
import { deriveGameplaySummary } from "./gameplaySummary.js";
import { FinalReportSchema, type AccessibilityResult, type FinalReport, type SiteBrief, type TaskRunResult, type TaskSuite } from "../schemas/types.js";

function cleanErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\u001b\[[0-9;]*m/g, "").replace(/\s+/g, " ").trim() || "Unknown evaluation error";
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function uniqueItems(items: string[], limit: number): string[] {
  return [...new Set(items.map((item) => normalizeText(item)).filter(Boolean))].slice(0, limit);
}

function formatTaskStatus(status: TaskRunResult["status"]): string {
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

function buildTaskOutcomeSummary(taskResults: Array<{
  name: string;
  status: TaskRunResult["status"];
}>): string {
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

  return normalizeText(
    `Accepted task outcomes: ${successCount} succeeded, ${partialCount} partially succeeded, and ${failedCount} failed.${perTask ? ` Per task: ${perTask}.` : ""}`
  );
}

function mergeTaskOutcomesIntoSummary(summary: string, taskResults: Array<{
  name: string;
  status: TaskRunResult["status"];
}>): string {
  const taskOutcomeSummary = buildTaskOutcomeSummary(taskResults);
  return taskOutcomeSummary ? normalizeText(`${taskOutcomeSummary} ${summary}`) : summary;
}

function mergeGameplayIntoSummary(summary: string, gameplaySummary: FinalReport["gameplay_summary"] | undefined): string {
  if (!gameplaySummary) {
    return summary;
  }

  return /\b(?:wins?|loss(?:es)?|draws?|rounds?)\b/i.test(summary)
    ? summary
    : normalizeText(`${summary} ${gameplaySummary.summary}`);
}

function summarizeHistoryEntry(entry: TaskRunResult["history"][number]): string {
  const actionLabel =
    entry.decision.action === "click"
      ? `click${entry.decision.target ? ` "${entry.decision.target}"` : ""}`
      : entry.decision.action === "type"
        ? `type into "${entry.decision.target || "field"}"`
        : entry.decision.action;
  const locationLabel = entry.title || entry.url;
  const visibleSnippet = entry.result.visibleTextSnippet ? ` Visible text: ${entry.result.visibleTextSnippet.slice(0, 180)}.` : "";
  return `Step ${entry.step} on "${locationLabel}": ${actionLabel} -> ${entry.result.note}${visibleSnippet}`;
}

function rankHistoryEntry(entry: TaskRunResult["history"][number]): number {
  let score = 0;

  if (!entry.result.success) {
    score += 100;
  }
  if (entry.decision.friction === "high") {
    score += 50;
  }
  if (entry.result.stateChanged) {
    score += 20;
  }
  if (entry.result.elapsedMs && entry.result.elapsedMs > 2500) {
    score += 10;
  }
  if (entry.decision.action === "extract" || entry.decision.action === "back") {
    score += 5;
  }

  return score;
}

function distillTaskResult(taskResult: TaskRunResult): {
  name: string;
  status: TaskRunResult["status"];
  finalUrl: string;
  finalTitle: string;
  reason: string;
  evidence: string[];
} {
  const prioritizedEvidence = [...taskResult.history]
    .sort((left, right) => rankHistoryEntry(right) - rankHistoryEntry(left) || left.step - right.step)
    .slice(0, 6)
    .map((entry) => summarizeHistoryEntry(entry));

  return {
    name: taskResult.name,
    status: taskResult.status,
    finalUrl: taskResult.finalUrl,
    finalTitle: taskResult.finalTitle,
    reason: taskResult.reason,
    evidence: uniqueItems([taskResult.reason, ...prioritizedEvidence], 7)
  };
}

function summarizeRawEvent(event: unknown): string | null {
  if (!event || typeof event !== "object") {
    return null;
  }

  const record = event as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : "";
  const note = typeof record.note === "string" ? normalizeText(record.note) : "";

  if (type === "requestfailed") {
    const method = typeof record.method === "string" ? record.method : "request";
    const url = typeof record.url === "string" ? record.url : "";
    const failure = typeof record.failure === "string" ? record.failure : "unknown failure";
    return `${method} ${url} failed with ${failure}`;
  }

  if (type === "pageerror") {
    const text = typeof record.text === "string" ? normalizeText(record.text) : "";
    return text ? `Page error: ${text}` : null;
  }

  if (type === "console") {
    const level = typeof record.level === "string" ? record.level : "";
    const text = typeof record.text === "string" ? normalizeText(record.text) : "";
    return /error|warn/i.test(level) && text ? `Console ${level}: ${text}` : null;
  }

  if (["navigation_error", "session_timeout", "planner_fallback", "runner_error", "storage_state_load", "storage_state_save_error"].includes(type)) {
    return note || null;
  }

  return null;
}

export async function evaluateRun(args: {
  baseUrl: string;
  suite: TaskSuite;
  siteBrief?: SiteBrief | null;
  taskResults: TaskRunResult[];
  rawEvents: unknown[];
  accessibility: AccessibilityResult;
  mobile?: boolean;
  timeoutMs?: number;
  totalRunDurationMs?: number;
}): Promise<FinalReport> {
  const totalRunDurationSeconds = Math.round((args.totalRunDurationMs ?? config.maxSessionDurationMs) / 1000);
  const distilledTaskResults = args.taskResults.map((taskResult) => distillTaskResult(taskResult));
  const gameplaySummary = deriveGameplaySummary({
    suite: args.suite,
    taskResults: args.taskResults
  });
  const runSignals = uniqueItems(args.rawEvents.map((event) => summarizeRawEvent(event)).filter((value): value is string => Boolean(value)), 40);
  const payload = {
    website: args.baseUrl,
    visitMode: args.mobile ? "mobile" : "desktop",
    persona: {
      name: args.suite.persona.name,
      intent: args.suite.persona.intent,
      constraints: args.suite.persona.constraints.slice(0, 8)
    },
    ...(args.siteBrief
      ? {
          siteUnderstanding: {
            sitePurpose: args.siteBrief.sitePurpose,
            summary: args.siteBrief.summary,
            intendedUserActions: args.siteBrief.intendedUserActions,
            evidence: args.siteBrief.evidence
          }
        }
      : {}),
    tasks: args.suite.tasks.map((task) => ({
      name: task.name,
      goal: task.goal,
      success_condition: task.success_condition,
      ...(task.gameplay ? { gameplay: task.gameplay } : {})
    })),
    runOverview: {
      taskCount: args.taskResults.length,
      successCount: args.taskResults.filter((task) => task.status === "success").length,
      partialCount: args.taskResults.filter((task) => task.status === "partial_success").length,
      failedCount: args.taskResults.filter((task) => task.status === "failed").length
    },
    acceptedTaskOutcomes: distilledTaskResults.map((taskResult, index) => ({
      name: taskResult.name,
      goal: args.suite.tasks[index]?.goal ?? taskResult.name,
      status: taskResult.status,
      reason: taskResult.reason
    })),
    taskResults: distilledTaskResults,
    runSignals,
    accessibility: args.accessibility,
    ...(gameplaySummary ? { gameplaySummary } : {})
  };

  if ((args.timeoutMs ?? 0) <= 0) {
    return buildFallbackReport({
      baseUrl: args.baseUrl,
      suite: args.suite,
      taskResults: args.taskResults,
      accessibility: args.accessibility,
      ...(args.mobile !== undefined ? { mobile: args.mobile } : {}),
      fallbackReason: `The run exhausted its ${totalRunDurationSeconds}-second wall-clock budget before the model evaluator could start.`
    });
  }

  try {
    const report = await generateStructured<FinalReport>({
      systemPrompt: TASK_OUTCOME_ANALYST_PROMPT,
      userPayload: payload,
      schemaName: "final_report",
      schema: FinalReportSchema,
      ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
      maxRetries: 0
    });

    return FinalReportSchema.parse(
      gameplaySummary
        ? {
            ...report,
            summary: mergeTaskOutcomesIntoSummary(mergeGameplayIntoSummary(report.summary, gameplaySummary), distilledTaskResults),
            gameplay_summary: gameplaySummary
          }
        : {
            ...report,
            summary: mergeTaskOutcomesIntoSummary(report.summary, distilledTaskResults)
          }
    );
  } catch (error) {
    return buildFallbackReport({
      baseUrl: args.baseUrl,
      suite: args.suite,
      taskResults: args.taskResults,
      accessibility: args.accessibility,
      ...(args.mobile !== undefined ? { mobile: args.mobile } : {}),
      fallbackReason: `The model evaluator did not finish cleanly within the remaining run budget: ${cleanErrorMessage(error)}`
    });
  }
}
