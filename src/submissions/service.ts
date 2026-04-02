import path from "node:path";
import { config } from "../config.js";
import { runAuditJob } from "../core/runAuditJob.js";
import { createSubmissionRecord, listSubmissions, readSubmission, writeSubmission } from "./store.js";
import type { Submission } from "./types.js";

export class SubmissionService {
  private activeSubmissionId: string | null = null;
  private readonly queue: string[] = [];

  createSubmission(args: {
    url: string;
    taskPath?: string;
    headed?: boolean;
    mobile?: boolean;
    ignoreHttpsErrors?: boolean;
  }): Submission {
    const submission = createSubmissionRecord(args);
    writeSubmission(submission);
    this.enqueue(submission.id);
    return submission;
  }

  getSubmission(id: string): Submission | null {
    return readSubmission(id);
  }

  resumePendingSubmissions(): void {
    for (const submission of listSubmissions()) {
      if (submission.status === "queued" || submission.status === "running") {
        const resetSubmission: Submission = {
          ...submission,
          status: "queued",
          startedAt: submission.status === "running" ? null : submission.startedAt,
          completedAt: null,
          error: null
        };
        writeSubmission(resetSubmission);
        this.enqueue(resetSubmission.id);
      }
    }
  }

  private enqueue(id: string): void {
    if (!this.queue.includes(id) && this.activeSubmissionId !== id) {
      this.queue.push(id);
    }

    void this.processQueue();
  }

  private async processQueue(): Promise<void> {
    if (this.activeSubmissionId || this.queue.length === 0) {
      return;
    }

    const nextId = this.queue.shift();
    if (!nextId) {
      return;
    }

    this.activeSubmissionId = nextId;

    try {
      await this.runSubmission(nextId);
    } finally {
      this.activeSubmissionId = null;
      if (this.queue.length > 0) {
        void this.processQueue();
      }
    }
  }

  private async runSubmission(id: string): Promise<void> {
    const submission = readSubmission(id);
    if (!submission) {
      return;
    }

    const startedAt = new Date().toISOString();
    writeSubmission({
      ...submission,
      status: "running",
      startedAt,
      completedAt: null,
      error: null
    });

    try {
      const result = await runAuditJob({
        baseUrl: submission.url,
        taskPath: submission.taskPath,
        headed: submission.headed,
        mobile: submission.mobile,
        ignoreHttpsErrors: submission.ignoreHttpsErrors,
        maxSessionDurationMs: config.maxSessionDurationMs,
        extraInputs: {
          source: "submission_form",
          submissionId: submission.id,
          reportToken: submission.reportToken,
          expiresAt: submission.expiresAt
        }
      });

      const runId = path.basename(result.runDir);

      writeSubmission({
        ...submission,
        status: "completed",
        startedAt,
        completedAt: new Date().toISOString(),
        runId,
        runDir: result.runDir,
        error: null,
        reportSummary: result.report.summary,
        overallScore: result.report.overall_score
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown submission failure";

      writeSubmission({
        ...submission,
        status: "failed",
        startedAt,
        completedAt: new Date().toISOString(),
        error: message
      });
    }
  }
}
