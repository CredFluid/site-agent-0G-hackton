import { readSubmission, uploadRunArtifacts, writeSubmission } from "../storage.js";
import { processSubmissionBatch } from "../../core/processSubmissionBatch.js";

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
  await processSubmissionBatch({
    submission: {
      ...submission,
      startedAt
    },
    writeSubmission,
    uploadRunArtifacts,
    source: "netlify_submission_form"
  });
};
