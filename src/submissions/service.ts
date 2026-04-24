import { processSubmissionBatch } from "../core/processSubmissionBatch.js";
import { createSubmissionRecord, listSubmissions, readSubmission, writeSubmission } from "./store.js";
import type { TradeRunOptions } from "../trade/types.js";
import type { Submission } from "./types.js";

export class SubmissionService {
  private activeSubmissionId: string | null = null;
  private readonly queue: string[] = [];

  async createSubmission(args: {
    url: string;
    headed?: boolean;
    mobile?: boolean;
    ignoreHttpsErrors?: boolean;
    tradeOptions?: TradeRunOptions;
    agentCount?: number;
    customTasks?: string[];
    instructionText?: string;
    instructionFileName?: string | null;
  }): Promise<Submission> {
    const submission = createSubmissionRecord(args);
    writeSubmission(submission);
    this.enqueue(submission.id);
    return submission;
  }

  async getSubmission(id: string): Promise<Submission | null> {
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

    await processSubmissionBatch({
      submission: {
        ...submission,
        startedAt: new Date().toISOString()
      },
      writeSubmission: async (nextSubmission) => {
        writeSubmission(nextSubmission);
      },
      uploadRunArtifacts: async () => {
        return;
      },
      source: "submission_form"
    });
  }
}
