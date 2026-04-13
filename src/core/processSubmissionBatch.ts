import path from "node:path";
import { buildAgentVariants } from "./agentProfiles.js";
import { createAggregateRun, type CompletedAgentAudit } from "./aggregateReport.js";
import { runAuditJob } from "./runAuditJob.js";
import { SubmissionSchema, type Submission } from "../submissions/types.js";

export async function processSubmissionBatch(args: {
  submission: Submission;
  writeSubmission: (submission: Submission) => Promise<void>;
  uploadRunArtifacts: (runId: string, runDir: string) => Promise<void>;
  source: string;
}): Promise<Submission> {
  const variants = buildAgentVariants(args.submission.taskPath, args.submission.agentCount);
  let currentSubmission = SubmissionSchema.parse({
    ...args.submission,
    agentCount: args.submission.agentCount || variants.length,
    agentRuns: args.submission.agentRuns.length > 0 ? args.submission.agentRuns : variants.map((variant) => ({
      id: variant.id,
      index: variant.index,
      label: variant.label,
      profileLabel: variant.profileLabel,
      personaName: variant.personaName,
      personaVariantKey: variant.personaVariantKey,
      status: "queued",
      startedAt: null,
      completedAt: null,
      runId: null,
      runDir: null,
      error: null,
      reportSummary: null,
      overallScore: null
    }))
  });
  let mutationChain: Promise<void> = Promise.resolve();

  const syncCounts = (submission: Submission): Submission =>
    SubmissionSchema.parse({
      ...submission,
      completedAgentCount: submission.agentRuns.filter((agentRun) => agentRun.status === "completed").length,
      failedAgentCount: submission.agentRuns.filter((agentRun) => agentRun.status === "failed").length
    });

  const commit = async (mutator: (draft: Submission) => void): Promise<Submission> => {
    mutationChain = mutationChain.then(async () => {
      const nextSubmission = structuredClone(currentSubmission);
      mutator(nextSubmission);
      currentSubmission = syncCounts(nextSubmission);
      await args.writeSubmission(currentSubmission);
    });
    await mutationChain;
    return currentSubmission;
  };

  const batchStartedAt = new Date().toISOString();
  await commit((draft) => {
    draft.status = "running";
    draft.startedAt = batchStartedAt;
    draft.completedAt = null;
    draft.error = null;
    draft.runId = null;
    draft.runDir = null;
    draft.reportSummary = null;
    draft.overallScore = null;
    draft.agentRuns = draft.agentRuns.map((agentRun) => ({
      ...agentRun,
      status: "queued",
      startedAt: null,
      completedAt: null,
      runId: null,
      runDir: null,
      error: null,
      reportSummary: null,
      overallScore: null
    }));
  });

  const agentOutcomes = await Promise.all(
    variants.map(async (variant): Promise<CompletedAgentAudit | null> => {
      const agentStartedAt = new Date().toISOString();

      await commit((draft) => {
        draft.agentRuns = draft.agentRuns.map((agentRun) =>
          agentRun.id === variant.id
            ? {
                ...agentRun,
                status: "running",
                startedAt: agentStartedAt,
                completedAt: null,
                error: null
              }
            : agentRun
        );
      });

      try {
        const result = await runAuditJob({
          baseUrl: currentSubmission.url,
          taskPath: currentSubmission.taskPath,
          suiteOverride: variant.taskSuite,
          headed: currentSubmission.headed,
          mobile: currentSubmission.mobile,
          ignoreHttpsErrors: currentSubmission.ignoreHttpsErrors,
          extraInputs: {
            source: args.source,
            submissionId: currentSubmission.id,
            reportToken: currentSubmission.reportToken,
            expiresAt: currentSubmission.expiresAt,
            batchRole: "child",
            parentSubmissionId: currentSubmission.id,
            agentCount: currentSubmission.agentCount,
            agentIndex: variant.index,
            agentLabel: variant.label,
            agentProfileLabel: variant.profileLabel,
            personaVariantKey: variant.personaVariantKey
          }
        });

        const runId = path.basename(result.runDir);
        await args.uploadRunArtifacts(runId, result.runDir);

        const completedAt = new Date().toISOString();
        await commit((draft) => {
          draft.agentRuns = draft.agentRuns.map((agentRun) =>
            agentRun.id === variant.id
              ? {
                  ...agentRun,
                  status: "completed",
                  startedAt: agentStartedAt,
                  completedAt,
                  runId,
                  runDir: null,
                  error: null,
                  reportSummary: result.report.summary,
                  overallScore: result.report.overall_score
                }
              : agentRun
          );
        });

        return {
          agentRun: {
            id: variant.id,
            index: variant.index,
            label: variant.label,
            profileLabel: variant.profileLabel,
            personaName: variant.personaName,
            personaVariantKey: variant.personaVariantKey,
            status: "completed",
            startedAt: agentStartedAt,
            completedAt,
            runId,
            runDir: null,
            error: null,
            reportSummary: result.report.summary,
            overallScore: result.report.overall_score
          },
          report: result.report,
          taskResults: result.execution.taskResults,
          accessibility: result.execution.accessibility,
          runId
        };
      } catch (error) {
        const completedAt = new Date().toISOString();
        const message = error instanceof Error ? error.message : "Unknown submission failure";

        await commit((draft) => {
          draft.agentRuns = draft.agentRuns.map((agentRun) =>
            agentRun.id === variant.id
              ? {
                  ...agentRun,
                  status: "failed",
                  startedAt: agentStartedAt,
                  completedAt,
                  error: message
                }
              : agentRun
          );
        });

        return null;
      }
    })
  );

  const completedOutcomes = agentOutcomes.filter((outcome): outcome is CompletedAgentAudit => outcome !== null);

  if (completedOutcomes.length === 0) {
    await commit((draft) => {
      draft.status = "failed";
      draft.completedAt = new Date().toISOString();
      draft.error = `All ${draft.agentCount} agent runs failed before an aggregate report could be produced.`;
    });
    return currentSubmission;
  }

  const aggregateSubmissionSnapshot = structuredClone(currentSubmission);
  const aggregateRun = createAggregateRun(aggregateSubmissionSnapshot, completedOutcomes);
  await args.uploadRunArtifacts(aggregateRun.runId, aggregateRun.runDir);

  await commit((draft) => {
    draft.status = "completed";
    draft.completedAt = new Date().toISOString();
    draft.runId = aggregateRun.runId;
    draft.runDir = null;
    draft.error = null;
    draft.reportSummary = aggregateRun.report.summary;
    draft.overallScore = aggregateRun.report.overall_score;
  });

  return currentSubmission;
}
