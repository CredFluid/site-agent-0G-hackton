import path from "node:path";
import { runAuditJob } from "../../core/runAuditJob.js";
import { config } from "../../config.js";
import { readSubmission, uploadRunArtifacts, writeSubmission } from "../storage.js";

export default async (req: Request): Promise<void> => {
  if (req.method !== "POST") {
    return;
  }

  const configuredSecret = process.env.INTERNAL_JOB_SECRET?.trim();
  const providedSecret = req.headers.get("x-agentprobe-job-secret")?.trim();
  if (configuredSecret && configuredSecret !== providedSecret) {
    console.warn("Rejected background submission request with an invalid internal job secret.");
    return;
  }

  let submissionId = "";
  try {
    const body = (await req.json()) as { submissionId?: string };
    submissionId = body.submissionId?.trim() ?? "";
  } catch {
    console.warn("Background submission request did not contain valid JSON.");
    return;
  }

  if (!submissionId) {
    console.warn("Background submission request was missing a submissionId.");
    return;
  }

  const submission = await readSubmission(submissionId);
  if (!submission) {
    console.warn(`Submission '${submissionId}' was not found when the background worker started.`);
    return;
  }

  if (submission.status === "completed") {
    return;
  }

  const startedAt = new Date().toISOString();
  await writeSubmission({
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
        source: "netlify_submission_form",
        submissionId: submission.id,
        reportToken: submission.reportToken,
        expiresAt: submission.expiresAt
      }
    });

    const runId = path.basename(result.runDir);
    await uploadRunArtifacts(runId, result.runDir);

    await writeSubmission({
      ...submission,
      status: "completed",
      startedAt,
      completedAt: new Date().toISOString(),
      runId,
      runDir: null,
      error: null,
      reportSummary: result.report.summary,
      overallScore: result.report.overall_score
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown submission failure";

    await writeSubmission({
      ...submission,
      status: "failed",
      startedAt,
      completedAt: new Date().toISOString(),
      error: message
    });
  }
};
