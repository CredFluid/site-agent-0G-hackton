import crypto from "node:crypto";
import { config } from "../config.js";
import { SubmissionSchema, type Submission } from "./types.js";

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
}): Submission {
  const createdAt = new Date().toISOString();
  const id = crypto.randomUUID();
  const reportToken = crypto.randomBytes(18).toString("base64url");

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
    taskPath: args.taskPath ?? "src/tasks/generic_interaction.json",
    headed: Boolean(args.headed),
    mobile: Boolean(args.mobile),
    ignoreHttpsErrors: Boolean(args.ignoreHttpsErrors),
    runId: null,
    runDir: null,
    error: null,
    reportSummary: null,
    overallScore: null
  });
}
