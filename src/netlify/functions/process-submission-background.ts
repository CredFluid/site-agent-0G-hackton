import { readSubmission, uploadRunArtifacts, writeSubmission } from "../storage.js";
import { processSubmissionBatch } from "../../core/processSubmissionBatch.js";

export default async (req: Request): Promise<void> => {
  console.log("Background submission function started");
  if (req.method !== "POST") {
    console.log("Background submission: not POST, returning");
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
    console.log(`Background submission: received submissionId ${submissionId}`);
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
    console.log(`Background submission: submission ${submissionId} already completed`);
    return;
  }

  console.log(`Background submission: starting processing for ${submissionId}`);
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
  console.log(`Background submission: completed processing for ${submissionId}`);
};
