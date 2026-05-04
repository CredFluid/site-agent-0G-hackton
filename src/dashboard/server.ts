import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import dotenv from "dotenv";
import ts from "typescript";
import {
  buildRunDetail,
  buildStandaloneReportHtml,
  listVisibleRunSummaries
} from "../backend/dashboardData.js";
import { artifactContentType, isAllowedDashboardArtifact, isImageArtifact } from "../backend/runArtifacts.js";
import { createLocalRunRepository } from "../backend/runRepository.js";
import { config } from "../config.js";
import { buildDefaultTradeRunOptions } from "../trade/policy.js";
import { TradeStrategySchema } from "../trade/types.js";
import { readUtf8 } from "../utils/files.js";
import { info, warn } from "../utils/log.js";
import {
  canAccessPublicReport,
  renderExpiredReportPage,
  renderLandingPage,
  renderReportUnavailablePage,
  renderSubmissionStatusPage
} from "../submissions/html.js";
import { readSubmittedInstructionSource, SUBMISSION_TASKS_REQUIRED_MESSAGE } from "../submissions/customTasks.js";
import { findSubmissionByReportToken } from "../submissions/store.js";
import { parseSubmissionTargetMode, validateSubmissionUrl } from "../submissions/publicUrl.js";
import { SubmissionService } from "../submissions/service.js";
import { DASHBOARD_CSS as SHARED_DASHBOARD_CSS, DASHBOARD_HEAD_TAGS } from "./theme.js";
import { handleWebhook } from "../paystack/index.js";


dotenv.config();

const DASHBOARD_SRC_DIR = path.join(process.cwd(), "src", "dashboard");
const CLIENT_ENTRY = path.join(DASHBOARD_SRC_DIR, "client.ts");
const NARRATIVE_ENTRY = path.join(DASHBOARD_SRC_DIR, "narrative.ts");
const DEFAULT_PORT = 4173;
const DEFAULT_HOST = "127.0.0.1";
const RENDER_HOST = "0.0.0.0";

function parsePort(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535 ? parsed : DEFAULT_PORT;
}

function resolveDashboardHost(): string {
  const configuredHost = process.env.DASHBOARD_HOST?.trim();
  if (configuredHost) {
    return configuredHost;
  }

  return process.env.RENDER === "true" ? RENDER_HOST : DEFAULT_HOST;
}

function transpileDashboardModule(entryPath: string): string {
  const source = readUtf8(entryPath);
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
      importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
      isolatedModules: true
    },
    fileName: entryPath
  });

  return transpiled.outputText;
}

function getClientScript(): string {
  return transpileDashboardModule(CLIENT_ENTRY);
}

function getNarrativeScript(): string {
  return transpileDashboardModule(NARRATIVE_ENTRY);
}

function renderDashboardHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Site Agent Dashboard</title>
    ${DASHBOARD_HEAD_TAGS}
    <style>${SHARED_DASHBOARD_CSS}</style>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/app.js"></script>
  </body>
</html>`;
}

function sendText(res: ServerResponse, statusCode: number, body: string, contentType: string): void {
  res.writeHead(statusCode, {
    "Content-Type": `${contentType}; charset=utf-8`,
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function sendJson(res: ServerResponse, data: unknown, statusCode = 200): void {
  sendText(res, statusCode, JSON.stringify(data, null, 2), "application/json");
}

function sendRedirect(res: ServerResponse, location: string, statusCode = 303): void {
  res.writeHead(statusCode, { Location: location });
  res.end();
}

async function readRequestBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }

  return Buffer.concat(chunks);
}

async function readRequestForm(req: IncomingMessage): Promise<FormData> {
  const body = await readRequestBody(req);
  const contentType = req.headers["content-type"] ?? "application/x-www-form-urlencoded";
  const request = new Request("http://site-agent.local/submit", {
    method: "POST",
    headers: {
      "content-type": Array.isArray(contentType) ? (contentType[0] ?? "application/x-www-form-urlencoded") : contentType
    },
    body: new Uint8Array(body)
  });

  return request.formData();
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  args: {
    appBaseUrl: string;
    runRepository: ReturnType<typeof createLocalRunRepository>;
    submissionService: SubmissionService;
  }
): Promise<void> {
  const requestUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const pathParts = requestUrl.pathname.split("/").filter(Boolean);

  if (requestUrl.pathname === "/favicon.ico") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/webhooks/paystack") {
    await handleWebhook(req, res, {
      onChargeSuccess: async (data) => {
        const amountNaira = (Number(data["amount"] ?? 0)) / 100;
        const customer = data["customer"] as Record<string, unknown> | undefined;
        const email = customer?.["email"] as string | undefined;

        info(`[paystack] Received ₦${amountNaira} from ${email ?? "unknown"} — triggering auto-audit`);

        // Trigger a default audit run when payment is received
        // In a real production app, you'd match the 'metadata' or 'email' to a specific user/site
        await args.submissionService.createSubmission({
          url: "https://www.hackquest.io/hackathons/0G-APAC-Hackathon", // Default target for this hackathon agent
          agentCount: 1,
          customTasks: [
            "Perform a full site audit focusing on the hackathon tracks and submission requirements.",
            "Verify all links in the overview and prize tabs are reachable.",
            "Check for any mobile layout issues on the main landing page."
          ],
          instructionText: "Automated audit triggered via Paystack payment."
        });
      },
      onTransferSuccess: (data) => {
        info(`[paystack] Transfer successful: ${data["transfer_code"]}`);
      },
      onTransferFailed: (data) => {
        warn(`[paystack] Transfer failed: ${data["transfer_code"]}`);
      }
    });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/submit") {
    const form = await readRequestForm(req);
    const urlInput = typeof form.get("url") === "string" ? (form.get("url") as string) : "";
    const selectedTargetMode = parseSubmissionTargetMode(form.get("target"));
    const submittedInstructions = await readSubmittedInstructionSource(form);
    const requestedAgentCount = Number(form.get("agents") ?? "1");
    const requestedTradeEnabled = form.has("trade_enabled");
    const requestedTradeDryRun = form.has("trade_dry_run");
    const requestedTradeStrategy = typeof form.get("trade_strategy") === "string" ? String(form.get("trade_strategy")) : "";
    const requestedTradeConfirmations = Number(form.get("trade_confirmations") ?? "");
    const normalizedAgentCount = Number.isFinite(requestedAgentCount)
      ? Math.min(5, Math.max(1, Math.round(requestedAgentCount)))
      : 1;
    const defaultTradeOptions = buildDefaultTradeRunOptions();
    const normalizedTradeOptions = {
      enabled: requestedTradeEnabled || requestedTradeDryRun || defaultTradeOptions.enabled,
      dryRun: requestedTradeDryRun,
      strategy: TradeStrategySchema.safeParse(requestedTradeStrategy).success
        ? TradeStrategySchema.parse(requestedTradeStrategy)
        : defaultTradeOptions.strategy,
      confirmations:
        Number.isInteger(requestedTradeConfirmations) && requestedTradeConfirmations >= 0 && requestedTradeConfirmations <= 12
          ? requestedTradeConfirmations
          : defaultTradeOptions.confirmations
    };
    const urlValidation = validateSubmissionUrl(urlInput, {
      allowPrivateHosts: true,
      targetMode: selectedTargetMode
    });
    const submissionError = !urlValidation.valid
      ? urlValidation.reason ?? "Enter a valid http or https URL."
      : submittedInstructions.customTasks.length === 0
        ? SUBMISSION_TASKS_REQUIRED_MESSAGE
        : null;

    if (submissionError) {
      sendText(
        res,
        400,
        renderLandingPage({
          error: submissionError,
          submittedUrl: urlInput,
          selectedAgentCount: normalizedAgentCount,
          submittedInstructions: submittedInstructions.instructionText,
          tradeOptions: normalizedTradeOptions,
          allowPrivateTargets: true,
          selectedTargetMode
        }),
        "text/html"
      );
      return;
    }

    const submission = await args.submissionService.createSubmission({
      url: urlValidation.normalizedUrl ?? urlInput.trim(),
      agentCount: normalizedAgentCount,
      tradeOptions: normalizedTradeOptions,
      customTasks: submittedInstructions.customTasks,
      instructionText: submittedInstructions.instructionText,
      instructionFileName: submittedInstructions.instructionFileName
    });

    sendRedirect(res, `/submissions/${encodeURIComponent(submission.id)}`);
    return;
  }

  if (req.method !== "GET") {
    sendText(res, 405, "Method not allowed", "text/plain");
    return;
  }

  if (requestUrl.pathname === "/health") {
    sendJson(res, { ok: true, service: "site-agent-dashboard" });
    return;
  }

  if (requestUrl.pathname === "/") {
    sendText(res, 200, renderLandingPage({ allowPrivateTargets: true }), "text/html");
    return;
  }

  if (requestUrl.pathname === "/dashboard") {
    sendText(res, 200, renderDashboardHtml(), "text/html");
    return;
  }

  if (requestUrl.pathname === "/app.js") {
    sendText(res, 200, getClientScript(), "application/javascript");
    return;
  }

  if (requestUrl.pathname === "/narrative.js") {
    sendText(res, 200, getNarrativeScript(), "application/javascript");
    return;
  }

  if (pathParts[0] === "submissions" && pathParts[1] && pathParts.length === 2) {
    const submission = await args.submissionService.getSubmission(decodeURIComponent(pathParts[1]));
    if (!submission) {
      sendText(
        res,
        404,
        renderReportUnavailablePage({
          title: "Submission not found",
          message: "We could not find that submission."
        }),
        "text/html"
      );
      return;
    }

    sendText(res, 200, renderSubmissionStatusPage({ appBaseUrl: args.appBaseUrl, submission }), "text/html");
    return;
  }

  if (pathParts[0] === "r" && pathParts[1] && pathParts.length === 2) {
    const submission = findSubmissionByReportToken(decodeURIComponent(pathParts[1]));
    if (!submission) {
      sendText(
        res,
        404,
        renderReportUnavailablePage({
          title: "Task output not found",
          message: "This task output link does not exist."
        }),
        "text/html"
      );
      return;
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
      sendText(res, statusCode, html, "text/html");
      return;
    }

    const htmlReport = await buildStandaloneReportHtml(args.runRepository, submission.runId ?? "");
    if (!htmlReport) {
      sendText(
        res,
        404,
        renderReportUnavailablePage({
          title: "Task output not found",
          message: "The task output artifact could not be loaded."
        }),
        "text/html"
      );
      return;
    }

    sendText(res, 200, htmlReport, "text/html");
    return;
  }

  if ((pathParts[0] === "reports" || pathParts[0] === "outputs") && pathParts[1] && pathParts.length === 2) {
    const runId = decodeURIComponent(pathParts[1]);
    const htmlReport = await buildStandaloneReportHtml(args.runRepository, runId);

    if (!htmlReport) {
      sendText(res, 404, "Task output not found", "text/plain");
      return;
    }

    sendText(res, 200, htmlReport, "text/html");
    return;
  }

  if (requestUrl.pathname === "/api/runs") {
    const runs = await listVisibleRunSummaries(args.runRepository);
    sendJson(res, runs);
    return;
  }

  if (pathParts[0] === "api" && pathParts[1] === "runs" && pathParts[2]) {
    const runId = decodeURIComponent(pathParts[2]);

    if (pathParts.length === 3) {
      const runDetail = await buildRunDetail(args.runRepository, runId);
      if (!runDetail) {
        sendJson(res, { error: `Run '${runId}' not found.` }, 404);
        return;
      }

      sendJson(res, runDetail);
      return;
    }

    if (pathParts.length === 5 && pathParts[3] === "artifacts" && pathParts[4]) {
      const fileName = decodeURIComponent(pathParts[4]);
      if (!isAllowedDashboardArtifact(fileName)) {
        sendJson(res, { error: "Artifact not available for download." }, 400);
        return;
      }

      if (!(await args.runRepository.hasRun(runId))) {
        sendJson(res, { error: `Run '${runId}' not found.` }, 404);
        return;
      }

      if (fileName === "report.html") {
        const htmlReport =
          (await args.runRepository.readTextArtifact(runId, "report.html")) ??
          (await buildStandaloneReportHtml(args.runRepository, runId));
        if (!htmlReport) {
          sendJson(res, { error: `Artifact '${fileName}' not found.` }, 404);
          return;
        }

        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Disposition": `attachment; filename="${runId}-${fileName}"`,
          "Cache-Control": "no-store"
        });
        res.end(htmlReport);
        return;
      }

      if (isImageArtifact(fileName)) {
        const artifact = await args.runRepository.readBinaryArtifact(runId, fileName);
        if (!artifact) {
          sendJson(res, { error: `Artifact '${fileName}' not found.` }, 404);
          return;
        }

        res.writeHead(200, {
          "Content-Type": artifactContentType(fileName),
          "Cache-Control": "no-store"
        });
        res.end(artifact);
        return;
      }

      const artifact = await args.runRepository.readTextArtifact(runId, fileName);
      if (!artifact) {
        sendJson(res, { error: `Artifact '${fileName}' not found.` }, 404);
        return;
      }

      res.writeHead(200, {
        "Content-Type": fileName.endsWith(".json") ? "application/json; charset=utf-8" : "text/markdown; charset=utf-8",
        "Content-Disposition": `attachment; filename="${runId}-${fileName}"`,
        "Cache-Control": "no-store"
      });
      res.end(artifact);
      return;
    }
  }

  sendText(res, 404, "Not found", "text/plain");
}

const port = parsePort(process.env.PORT ?? process.env.DASHBOARD_PORT);
const host = resolveDashboardHost();
const appBaseUrl = config.appBaseUrl || `http://${host === DEFAULT_HOST ? "localhost" : host}:${port}`;
const submissionService = new SubmissionService();
const runRepository = createLocalRunRepository();

const server = http.createServer((req, res) => {
  handleRequest(req, res, { appBaseUrl, runRepository, submissionService }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unknown dashboard error";
    warn(`Dashboard request failed: ${message}`);
    sendJson(res, { error: message }, 500);
  });
});

server.listen(port, host, () => {
  info(`Dashboard ready at http://${host === DEFAULT_HOST ? "localhost" : host}:${port}`);
  submissionService.resumePendingSubmissions();
});
