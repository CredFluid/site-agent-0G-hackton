import { config } from "../config.js";
import { generateStructured } from "../llm/client.js";
import { REVIEWER_PROMPT } from "../prompts/reviewer.js";
import { buildFallbackReport } from "./fallbackReport.js";
import { FinalReportSchema, type AccessibilityResult, type FinalReport, type TaskRunResult, type TaskSuite } from "../schemas/types.js";

function cleanErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\u001b\[[0-9;]*m/g, "").replace(/\s+/g, " ").trim() || "Unknown evaluation error";
}

export async function evaluateRun(args: {
  baseUrl: string;
  suite: TaskSuite;
  taskResults: TaskRunResult[];
  rawEvents: unknown[];
  accessibility: AccessibilityResult;
  timeoutMs?: number;
  totalRunDurationMs?: number;
}): Promise<FinalReport> {
  const totalRunDurationSeconds = Math.round((args.totalRunDurationMs ?? config.maxSessionDurationMs) / 1000);
  const payload = {
    website: args.baseUrl,
    persona: args.suite.persona,
    taskResults: args.taskResults.map((taskResult) => ({
      name: taskResult.name,
      status: taskResult.status,
      finalUrl: taskResult.finalUrl,
      finalTitle: taskResult.finalTitle,
      reason: taskResult.reason,
      history: taskResult.history.map((entry: TaskRunResult["history"][number]) => ({
        step: entry.step,
        url: entry.url,
        title: entry.title,
        decision: entry.decision,
        result: entry.result
      }))
    })),
    rawEvents: args.rawEvents.slice(-200),
    accessibility: args.accessibility
  };

  if ((args.timeoutMs ?? 0) <= 0) {
    return buildFallbackReport({
      baseUrl: args.baseUrl,
      suite: args.suite,
      taskResults: args.taskResults,
      accessibility: args.accessibility,
      fallbackReason: `The run exhausted its ${totalRunDurationSeconds}-second wall-clock budget before the model reviewer could start.`
    });
  }

  try {
    const report = await generateStructured<FinalReport>({
      systemPrompt: REVIEWER_PROMPT,
      userPayload: payload,
      schemaName: "final_report",
      schema: FinalReportSchema,
      ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
      maxRetries: 0
    });

    return FinalReportSchema.parse(report);
  } catch (error) {
    return buildFallbackReport({
      baseUrl: args.baseUrl,
      suite: args.suite,
      taskResults: args.taskResults,
      accessibility: args.accessibility,
      fallbackReason: `The model reviewer did not finish cleanly within the remaining run budget: ${cleanErrorMessage(error)}`
    });
  }
}
