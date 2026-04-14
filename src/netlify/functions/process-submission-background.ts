import {
  claimSubmissionForProcessing,
  readSubmission,
  uploadRunArtifacts,
  writeSubmission
} from "../storage.js";
import { processSubmissionBatch } from "../../core/processSubmissionBatch.js";

export default async (req: Request) => {
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
    const body = await req.json();
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

  const claim = await claimSubmissionForProcessing(submissionId);

  if (!claim.ok) {
    console.log(`Background submission: not starting ${submissionId}`, {
      reason: claim.reason
    });
    return;
  }

  const submission = claim.submission;
  console.log(`Background submission: claimed and starting processing for ${submissionId}`);

  try {
    await processSubmissionBatch({
      submission,
      writeSubmission,
      uploadRunArtifacts,
      source: "netlify_submission_form"
    });

    console.log(`Background submission: completed processing for ${submissionId}`);
  } catch (error) {
    console.error(`Background submission: failed processing for ${submissionId}`, error);

    const latest = await readSubmission(submissionId);
    const base = latest ?? submission;

    await writeSubmission({
      ...base,
      status: "failed",
      completedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error)
    });

    throw error;
  }
};