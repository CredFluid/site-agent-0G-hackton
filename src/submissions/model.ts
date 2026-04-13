import crypto from "node:crypto";
import { config } from "../config.js";
import { type Submission, SubmissionSchema, type SubmissionAgentRun } from "./types.js";
import { buildInitialAgentRuns } from "../core/agentProfiles.js";

export function computeExpiresAt(createdAt: string): string {
  const createdMs = new Date(createdAt).getTime();
  return new Date(createdMs + config.reportTtlDays * 24 * 60 * 60 * 1000).toISOString();
}

export function isExpired(expiresAt: string, now = Date.now()): boolean {
  return new Date(expiresAt).getTime() <= now;
}

export function createSubmissionRecord(args: {
  url: string;
  taskPath?: string;
  headed?: boolean;
  mobile?: boolean;
  ignoreHttpsErrors?: boolean;
  agentCount?: number;
  agentRuns?: SubmissionAgentRun[];
}): Submission {
  const createdAt = new Date().toISOString();
  const id = crypto.randomUUID();
  const reportToken = crypto.randomBytes(18).toString("base64url");
  const taskPath = args.taskPath ?? "src/tasks/generic_interaction.json";
  const agentCount = Math.min(5, Math.max(1, Math.round(args.agentCount ?? args.agentRuns?.length ?? 1)));
  const agentRuns = args.agentRuns ?? buildInitialAgentRuns(taskPath, agentCount);

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
    taskPath,
    headed: Boolean(args.headed),
    mobile: Boolean(args.mobile),
    ignoreHttpsErrors: Boolean(args.ignoreHttpsErrors),
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
