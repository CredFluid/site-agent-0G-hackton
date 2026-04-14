import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { chromium } from "playwright";
import { z } from "zod";
import { renderHtmlReport } from "../reporting/html.js";
import { renderMarkdownReport } from "../reporting/markdown.js";
import {
  AccessibilityResultSchema,
  FinalReportSchema,
  SiteChecksSchema,
  TaskRunResultSchema
} from "../schemas/types.js";
import { RunInputsSchema } from "../dashboard/contracts.js";
import { runSiteChecks } from "../core/siteChecks.js";
import { readUtf8, resolveRunsDir, writeJson, writeText } from "../utils/files.js";

const TaskRunResultsSchema = TaskRunResultSchema.array();
const RawEventsSchema = z.array(z.unknown());

function loadJson<T>(filePath: string, schema: { parse: (value: unknown) => T }): T | null {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return null;
  }

  return schema.parse(JSON.parse(readUtf8(filePath)));
}

function needsProbeRefresh(siteChecks: z.infer<typeof SiteChecksSchema> | null): boolean {
  if (!siteChecks) {
    return true;
  }

  return Object.values(siteChecks.coverage).some((coverage) =>
    coverage.blockers.some((blocker) =>
      /__name is not defined|scrollWidth|Timeout \d+ms exceeded|ERR_CONNECTION_CLOSED|ERR_SOCKET_NOT_CONNECTED/i.test(blocker)
    )
  );
}

async function backfillRun(
  runId: string,
  force: boolean,
  budgetMs: number
): Promise<{ runId: string; status: "updated" | "skipped" | "failed"; note: string }> {
  const runDir = path.join(resolveRunsDir(), runId);
  if (!fs.existsSync(runDir) || !fs.statSync(runDir).isDirectory()) {
    return { runId, status: "failed", note: "Run directory was not found." };
  }

  const siteChecksPath = path.join(runDir, "site-checks.json");
  const existingSiteChecks = fs.existsSync(siteChecksPath) ? loadJson(siteChecksPath, SiteChecksSchema) : null;
  if (!force && existingSiteChecks && !needsProbeRefresh(existingSiteChecks)) {
    return { runId, status: "skipped", note: "site-checks.json already exists." };
  }

  if (!force && existingSiteChecks && needsProbeRefresh(existingSiteChecks)) {
    process.stdout.write(`[refresh] ${runId}: existing site checks were created by an older broken probe build.\n`);
  }

  if (!force && fs.existsSync(siteChecksPath) && !existingSiteChecks) {
    process.stdout.write(`[refresh] ${runId}: existing site-checks.json was invalid and will be regenerated.\n`);
  }

  const inputs = loadJson(path.join(runDir, "inputs.json"), RunInputsSchema);
  const report = loadJson(path.join(runDir, "report.json"), FinalReportSchema);
  const accessibility = loadJson(path.join(runDir, "accessibility.json"), AccessibilityResultSchema);
  const taskResults = loadJson(path.join(runDir, "task-results.json"), TaskRunResultsSchema) ?? [];
  const rawEvents = loadJson(path.join(runDir, "raw-events.json"), RawEventsSchema) ?? [];

  if (!inputs || !report) {
    return { runId, status: "failed", note: "inputs.json or report.json is missing." };
  }

  const browser = await chromium.launch({ headless: true });

  try {
    const siteChecks = await runSiteChecks({
      browser,
      baseUrl: inputs.baseUrl,
      ignoreHttpsErrors: Boolean(inputs.ignoreHttpsErrors),
      browserTimezone: inputs.synchronizedTimezone ?? inputs.browserTimezone ?? inputs.deviceTimezone ?? "UTC",
      storageState: undefined,
      rawEvents: rawEvents ?? [],
      taskResults,
      budgetMs
    });

    writeJson(siteChecksPath, siteChecks);
    writeText(
      path.join(runDir, "report.html"),
      renderHtmlReport({
        website: inputs.baseUrl,
        persona: inputs.persona ?? "first-time visitor",
        report,
        taskResults,
        accessibility: accessibility ?? undefined,
        siteChecks,
        rawEvents: rawEvents ?? [],
        runId,
        startedAt: inputs.startedAt,
        mobile: inputs.mobile,
        timeZone: inputs.synchronizedTimezone ?? inputs.browserTimezone ?? inputs.deviceTimezone
      })
    );
    writeText(
      path.join(runDir, "report.md"),
      renderMarkdownReport({
        website: inputs.baseUrl,
        persona: inputs.persona ?? "first-time visitor",
        report,
        taskResults,
        accessibility: accessibility ?? undefined,
        siteChecks,
        rawEvents: rawEvents ?? [],
        startedAt: inputs.startedAt,
        mobile: inputs.mobile,
        timeZone: inputs.synchronizedTimezone ?? inputs.browserTimezone ?? inputs.deviceTimezone
      })
    );

    return { runId, status: "updated", note: "site-checks.json and rendered reports were refreshed." };
  } catch (error) {
    return {
      runId,
      status: "failed",
      note: error instanceof Error ? error.message : "Unknown backfill failure"
    };
  } finally {
    await browser.close().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const program = new Command();
  program
    .option("--run <runId>", "Backfill a single run by run ID")
    .option("--all", "Backfill every run under the runs directory")
    .option("--visible-only", "When used with --all, skip child agent runs that are hidden from the dashboard", false)
    .option("--budget-ms <ms>", "Override the supplemental site-check budget used during backfill", "45000")
    .option("--force", "Recompute site checks even if they already exist", false);
  program.parse(process.argv);
  const options = program.opts<{ run?: string; all?: boolean; visibleOnly?: boolean; budgetMs?: string; force?: boolean }>();
  const parsedBudgetMs = Number.parseInt(options.budgetMs ?? "45000", 10);
  const budgetMs = Number.isFinite(parsedBudgetMs) ? Math.max(12000, parsedBudgetMs) : 45000;

  const runIds = options.all
    ? fs
        .readdirSync(resolveRunsDir(), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .filter((entry) => {
          if (!options.visibleOnly) {
            return true;
          }

          const inputs = loadJson(path.join(resolveRunsDir(), entry.name, "inputs.json"), RunInputsSchema);
          if (!inputs) {
            return false;
          }

          return (inputs.batchRole ?? "single") !== "child";
        })
        .map((entry) => entry.name)
        .sort((left, right) => right.localeCompare(left))
    : options.run
      ? [options.run]
      : [];

  if (runIds.length === 0) {
    throw new Error("Provide either --run <runId> or --all.");
  }

  for (const runId of runIds) {
    const result = await backfillRun(runId, Boolean(options.force), budgetMs);
    process.stdout.write(`[${result.status}] ${result.runId}: ${result.note}\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
