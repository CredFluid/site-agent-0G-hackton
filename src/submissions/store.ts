import fs from "node:fs";
import path from "node:path";
import { ensureDir, readUtf8, resolveSubmissionsDir, writeJson } from "../utils/files.js";
import { createSubmissionRecord } from "./model.js";
import { SubmissionSchema, type Submission } from "./types.js";

const SUBMISSIONS_DIR = resolveSubmissionsDir();

function submissionPath(id: string): string {
  return path.join(SUBMISSIONS_DIR, `${id}.json`);
}

export function getSubmissionsDir(): string {
  ensureDir(SUBMISSIONS_DIR);
  return SUBMISSIONS_DIR;
}

export function writeSubmission(submission: Submission): void {
  writeJson(submissionPath(submission.id), SubmissionSchema.parse(submission));
}

export function readSubmission(id: string): Submission | null {
  const filePath = submissionPath(id);
  if (!fs.existsSync(filePath)) {
    return null;
  }

  return SubmissionSchema.parse(JSON.parse(readUtf8(filePath)));
}

export function listSubmissions(): Submission[] {
  getSubmissionsDir();

  return fs
    .readdirSync(SUBMISSIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => SubmissionSchema.parse(JSON.parse(readUtf8(path.join(SUBMISSIONS_DIR, entry.name)))))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export function findSubmissionByReportToken(reportToken: string): Submission | null {
  return listSubmissions().find((submission) => submission.reportToken === reportToken) ?? null;
}

export function findSubmissionByRunId(runId: string): Submission | null {
  return listSubmissions().find((submission) => submission.runId === runId) ?? null;
}

export { createSubmissionRecord } from "./model.js";
