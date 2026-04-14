import { artifactContentType, isAllowedDashboardArtifact, isImageArtifact } from "../backend/runArtifacts.js";
import {
  buildRunDetail,
  buildRunSummary,
  buildStandaloneReportHtml,
  loadDashboardData,
  renderDashboardPage
} from "./dashboard.js";
import {
  findSubmissionByReportToken,
  listRunIds,
  readRunArtifactBinary,
  readRunArtifactText,
  readSubmission,
  writeSubmission
} from "./storage.js";
import { renderExpiredReportPage, renderLandingPage, renderReportUnavailablePage, renderSubmissionStatusPage, canAccessPublicReport } from "../submissions/html.js";
import { validatePublicUrl } from "../submissions/publicUrl.js";
import { createSubmissionRecord } from "../submissions/model.js";
import { config } from "../config.js";
import { readSubmittedInstructionSource, SUBMISSION_TASKS_REQUIRED_MESSAGE } from "../submissions/customTasks.js";

function respondText(body: string, init: ResponseInit & { contentType: string }): Response {
  return new Response(body, {
    ...init,
    headers: {
      "content-type": `${init.contentType}; charset=utf-8`,
      "cache-control": "no-store",
      ...(init.headers ?? {})
    }
  });
}

function respondBinary(body: ArrayBuffer, init: ResponseInit & { contentType: string }): Response {
  return new Response(body, {
    ...init,
    headers: {
      "content-type": init.contentType,
      "cache-control": "no-store",
      ...(init.headers ?? {})
    }
  });
}

function respondJson(data: unknown, status = 200): Response {
  return respondText(JSON.stringify(data, null, 2), { status, contentType: "application/json" });
}

function redirect(location: string, status = 303): Response {
  return new Response(null, {
    status,
    headers: {
      location,
      "cache-control": "no-store"
    }
  });
}

async function triggerBackgroundSubmission(args: { origin: string; submissionId: string }): Promise<void> {
  const endpoint = new URL("/.netlify/functions/process-submission-background", args.origin);
  const secret = process.env.INTERNAL_JOB_SECRET?.trim();
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(secret ? { "x-agentprobe-job-secret": secret } : {})
    },
    body: JSON.stringify({ submissionId: args.submissionId })
  });

  if (!response.ok) {
    throw new Error(`Background audit kickoff failed with ${response.status} ${response.statusText}`);
  }
}

export async function handleNetlifyAppRequest(req: Request): Promise<Response> {
  const requestUrl = new URL(req.url);
  const pathParts = requestUrl.pathname.split("/").filter(Boolean);
  const appBaseUrl = config.appBaseUrl || requestUrl.origin;

  if (requestUrl.pathname === "/favicon.ico") {
    return new Response(null, { status: 204 });
  }

  if (req.method === "POST" && requestUrl.pathname === "/submit") {
    const form = await req.formData();
    const urlInput = typeof form.get("url") === "string" ? (form.get("url") as string) : "";
    const submittedInstructions = await readSubmittedInstructionSource(form);
    const requestedAgentCount = Number(form.get("agents") ?? "1");
    const normalizedAgentCount = Number.isFinite(requestedAgentCount)
      ? Math.min(5, Math.max(1, Math.round(requestedAgentCount)))
      : 1;
    const urlValidation = validatePublicUrl(urlInput);
    const submissionError = !urlValidation.valid
      ? urlValidation.reason ?? "Enter a valid public URL."
      : submittedInstructions.customTasks.length === 0
        ? SUBMISSION_TASKS_REQUIRED_MESSAGE
        : null;

    if (submissionError) {
      return respondText(
        renderLandingPage({
          error: submissionError,
          submittedUrl: urlInput,
          selectedAgentCount: normalizedAgentCount,
          submittedInstructions: submittedInstructions.instructionText
        }),
        { status: 400, contentType: "text/html" }
      );
    }

    const submission = createSubmissionRecord({
      url: urlValidation.normalizedUrl ?? urlInput.trim(),
      agentCount: normalizedAgentCount,
      customTasks: submittedInstructions.customTasks,
      instructionText: submittedInstructions.instructionText,
      instructionFileName: submittedInstructions.instructionFileName
    });

    await writeSubmission(submission);

    try {
      await triggerBackgroundSubmission({
        origin: requestUrl.origin,
        submissionId: submission.id
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown background invocation failure";
      await writeSubmission({
        ...submission,
        status: "failed",
        completedAt: new Date().toISOString(),
        error: message
      });
    }

    return redirect(`/submissions/${encodeURIComponent(submission.id)}`);
  }

  if (req.method !== "GET") {
    return respondText("Method not allowed", { status: 405, contentType: "text/plain" });
  }

  if (requestUrl.pathname === "/") {
    return respondText(renderLandingPage({}), { status: 200, contentType: "text/html" });
  }

  if (requestUrl.pathname === "/dashboard") {
    const requestedRunId = requestUrl.searchParams.get("run");
    const data = await loadDashboardData(requestedRunId);
    return respondText(
      renderDashboardPage({
        runs: data.runs,
        detail: data.detail,
        selectedRunId: data.selectedRunId,
        error: requestedRunId && !data.detail ? `Run '${requestedRunId}' was not found.` : null
      }),
      { status: 200, contentType: "text/html" }
    );
  }

  if (pathParts[0] === "submissions" && pathParts[1] && pathParts.length === 2) {
    const submission = await readSubmission(decodeURIComponent(pathParts[1]));
    if (!submission) {
      return respondText(
        renderReportUnavailablePage({
          title: "Submission not found",
          message: "We could not find that submission."
        }),
        { status: 404, contentType: "text/html" }
      );
    }

    return respondText(
      renderSubmissionStatusPage({ appBaseUrl, submission }),
      { status: 200, contentType: "text/html" }
    );
  }

  if (pathParts[0] === "r" && pathParts[1] && pathParts.length === 2) {
    const submission = await findSubmissionByReportToken(decodeURIComponent(pathParts[1]));
    if (!submission) {
      return respondText(
        renderReportUnavailablePage({
          title: "Task output not found",
          message: "This task output link does not exist."
        }),
        { status: 404, contentType: "text/html" }
      );
    }

    const access = canAccessPublicReport(submission);
    if (!access.allowed) {
      const html =
        access.reason === "This task output link has expired."
          ? renderExpiredReportPage(submission)
          : renderReportUnavailablePage({
              title: "Task output not ready",
              message: access.reason ?? "This task output is not ready yet."
            });
      const statusCode = access.reason === "This task output link has expired." ? 410 : 202;
      return respondText(html, { status: statusCode, contentType: "text/html" });
    }

    const htmlReport = await buildStandaloneReportHtml(submission.runId ?? "");
    if (!htmlReport) {
      return respondText(
        renderReportUnavailablePage({
          title: "Task output not found",
          message: "The task output artifact could not be loaded."
        }),
        { status: 404, contentType: "text/html" }
      );
    }

    return respondText(htmlReport, { status: 200, contentType: "text/html" });
  }

  if ((pathParts[0] === "reports" || pathParts[0] === "outputs") && pathParts[1] && pathParts.length === 2) {
    const runId = decodeURIComponent(pathParts[1]);
    const htmlReport = await buildStandaloneReportHtml(runId);
    if (!htmlReport) {
      return respondText("Task output not found", { status: 404, contentType: "text/plain" });
    }

    return respondText(htmlReport, { status: 200, contentType: "text/html" });
  }

  if (requestUrl.pathname === "/api/runs") {
    const summaries = (await Promise.all((await listRunIds()).map((runId) => buildRunSummary(runId))))
      .filter((run) => run.batchRole !== "child");
    return respondJson(summaries);
  }

  if (pathParts[0] === "api" && pathParts[1] === "runs" && pathParts[2]) {
    const runId = decodeURIComponent(pathParts[2]);

    if (pathParts.length === 3) {
      const runDetail = await buildRunDetail(runId);
      if (!runDetail) {
        return respondJson({ error: `Run '${runId}' not found.` }, 404);
      }

      return respondJson(runDetail);
    }

    if (pathParts.length === 5 && pathParts[3] === "artifacts" && pathParts[4]) {
      const fileName = decodeURIComponent(pathParts[4]);
      if (!isAllowedDashboardArtifact(fileName)) {
        return respondJson({ error: "Artifact not available for download." }, 400);
      }

      if (isImageArtifact(fileName)) {
        const artifact = await readRunArtifactBinary(runId, fileName);
        if (!artifact) {
          return respondJson({ error: `Artifact '${fileName}' not found.` }, 404);
        }

        return respondBinary(
          Uint8Array.from(artifact).buffer,
          {
            status: 200,
            contentType: artifactContentType(fileName)
          }
        );
      }

      if (fileName === "report.html") {
        const htmlReport = (await readRunArtifactText(runId, "report.html")) ?? (await buildStandaloneReportHtml(runId));
        if (!htmlReport) {
          return respondJson({ error: `Artifact '${fileName}' not found.` }, 404);
        }

        return respondText(htmlReport, {
          status: 200,
          contentType: "text/html",
          headers: {
            "content-disposition": `attachment; filename="${runId}-${fileName}"`
          }
        });
      }

      const artifact = await readRunArtifactText(runId, fileName as "report.json" | "report.md");
      if (!artifact) {
        return respondJson({ error: `Artifact '${fileName}' not found.` }, 404);
      }

      return respondText(artifact, {
        status: 200,
        contentType: fileName.endsWith(".json") ? "application/json" : "text/markdown",
        headers: {
          "content-disposition": `attachment; filename="${runId}-${fileName}"`
        }
      });
    }
  }

  return respondText("Not found", { status: 404, contentType: "text/plain" });
}
