import path from "node:path";
import { Command } from "commander";
import { config } from "../config.js";
import { runAuditJob } from "../core/runAuditJob.js";
import { info } from "../utils/log.js";

const program = new Command();

program
  .name("site-agent-pro")
  .description("Audit a website like a realistic user and generate an evidence-based review")
  .requiredOption("--url <url>", "Website URL to audit")
  .option("--task <path>", "Path to task suite JSON", "src/tasks/first_time_buyer.json")
  .option("--generic", "Run a generic first-time walkthrough instead of the structured task suite")
  .option("--headed", "Run browser in headed mode")
  .option("--mobile", "Run using a mobile device profile")
  .option("--ignore-https-errors", "Allow invalid or self-signed HTTPS certificates")
  .action(async (options: { url: string; task: string; generic?: boolean; headed?: boolean; mobile?: boolean; ignoreHttpsErrors?: boolean }) => {
    const baseUrl = options.url as string;
    const taskPath = options.generic ? "src/tasks/generic_interaction.json" : options.task;

    info(`Running site agent against ${baseUrl}`);
    info(`Total run budget is capped at ${Math.round(config.maxSessionDurationMs / 1000)} seconds`);
    if (options.generic) {
      info("Using generic first-time walkthrough mode");
    }
    if (options.ignoreHttpsErrors) {
      info("Ignoring HTTPS certificate errors for this run");
    }

    const result = await runAuditJob({
      baseUrl,
      taskPath,
      headed: Boolean(options.headed),
      mobile: Boolean(options.mobile),
      ignoreHttpsErrors: Boolean(options.ignoreHttpsErrors)
    });

    info(`Artifacts will be written to ${result.runDir}`);
    info(`Completed. Overall score: ${result.report.overall_score}/10`);
    info(`Review summary: ${result.report.summary}`);
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  process.stderr.write(`[ERROR] ${message}\n`);
  process.exit(1);
});
