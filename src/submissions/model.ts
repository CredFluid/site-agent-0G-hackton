import crypto from "node:crypto";
import { config } from "../config.js";
import { buildDefaultTradeRunOptions } from "../trade/policy.js";
import type { TradeRunOptions } from "../trade/types.js";
import { type Submission, SubmissionSchema, type SubmissionAgentRun } from "./types.js";
import { buildInitialAgentRuns } from "../core/agentProfiles.js";
import { buildCustomTaskSuite } from "../core/customTaskSuite.js";
import { normalizeCustomTasks, SUBMISSION_TASKS_REQUIRED_MESSAGE } from "./customTasks.js";

export function computeExpiresAt(createdAt: string): string {
  const createdMs = new Date(createdAt).getTime();
  return new Date(createdMs + config.reportTtlDays * 24 * 60 * 60 * 1000).toISOString();
}

export function isExpired(expiresAt: string, now = Date.now()): boolean {
  return new Date(expiresAt).getTime() <= now;
}

export function createSubmissionRecord(args: {
  url: string;
  headed?: boolean;
  mobile?: boolean;
  ignoreHttpsErrors?: boolean;
  agentCount?: number;
  agentRuns?: SubmissionAgentRun[];
  tradeOptions?: TradeRunOptions;
  customTasks?: string[];
  instructionText?: string;
  instructionFileName?: string | null;
}): Submission {
  const createdAt = new Date().toISOString();
  const id = crypto.randomUUID();
  const reportToken = crypto.randomBytes(18).toString("base64url");
  const agentCount = Math.min(5, Math.max(1, Math.round(args.agentCount ?? args.agentRuns?.length ?? 1)));
  const customTasks = normalizeCustomTasks(args.customTasks ?? []);
  if (customTasks.length === 0) {
    throw new Error(SUBMISSION_TASKS_REQUIRED_MESSAGE);
  }

  const customSuite = buildCustomTaskSuite(customTasks);
  const agentRuns = args.agentRuns ?? buildInitialAgentRuns(agentCount, customSuite);

  return SubmissionSchema.parse({
    id,
    url: args.url,
    createdAt,
    startedAt: null,
    completedAt: null,
    expiresAt: computeExpiresAt(createdAt),
    status: "queued",
    reportToken,
    publicReportPath: `/r/${reportToken}`,
    headed: Boolean(args.headed),
    mobile: Boolean(args.mobile),
    ignoreHttpsErrors: Boolean(args.ignoreHttpsErrors),
    tradeOptions: {
      ...buildDefaultTradeRunOptions(),
      ...(args.tradeOptions ?? {})
    },
    customTasks,
    instructionText: args.instructionText?.trim() || customTasks.join("\n"),
    instructionFileName: args.instructionFileName?.trim() || null,
    agentCount,
    completedAgentCount: 0,
    failedAgentCount: 0,
    agentRuns,
    runId: null,
    runDir: null,
    error: null,
    reportSummary: null,
    overallScore: null
  });
}
