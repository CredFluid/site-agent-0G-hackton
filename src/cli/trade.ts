import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { buildDefaultTradeRunOptions, getTradePolicy } from "../trade/policy.js";
import { executeTradeInstruction } from "../trade/engine.js";
import { SellInstructionSchema, TradeStrategySchema, type TradeStrategy } from "../trade/types.js";
import { ensureDir, resolveRunDir, writeJson } from "../utils/files.js";
import { info } from "../utils/log.js";

const program = new Command();

function parseTradeStrategy(value: string): TradeStrategy {
  const parsed = TradeStrategySchema.safeParse(value.trim());
  if (!parsed.success) {
    throw new Error(`Unsupported trade strategy '${value}'. Use 'auto', 'dapp_only', or 'deposit_only'.`);
  }

  return parsed.data;
}

function parseConfirmationCount(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 12) {
    throw new Error("Confirmations must be an integer between 0 and 12.");
  }

  return parsed;
}

program
  .name("site-agent-trade")
  .description("Execute a deterministic trade instruction from the CLI")
  .requiredOption("--instruction <file>", "Path to a JSON file containing a SellInstruction payload")
  .option("--broadcast", "Broadcast the transaction instead of running in dry-run mode")
  .option("--strategy <strategy>", "Trade strategy: auto, dapp_only, or deposit_only", parseTradeStrategy)
  .option("--confirmations <count>", "Confirmations to wait for before marking confirmed", parseConfirmationCount)
  .option("--run-dir <path>", "Directory to store trade execution artifacts")
  .action(async (options: {
    instruction: string;
    broadcast?: boolean;
    strategy?: TradeStrategy;
    confirmations?: number;
    runDir?: string;
  }) => {
    const instructionPath = path.resolve(options.instruction);
    const runDir = options.runDir?.trim()
      ? path.resolve(options.runDir)
      : resolveRunDir("https://trade-cli.local");
    const defaultTradeOptions = buildDefaultTradeRunOptions();
    const instructionPayload = JSON.parse(fs.readFileSync(instructionPath, "utf8"));
    const instruction = SellInstructionSchema.parse(instructionPayload);
    const tradeOptions = {
      enabled: true,
      dryRun: !options.broadcast,
      strategy: options.strategy ?? defaultTradeOptions.strategy,
      confirmations: options.confirmations ?? defaultTradeOptions.confirmations
    };

    ensureDir(runDir);
    writeJson(path.join(runDir, "trade-instruction.json"), instruction);

    const record = await executeTradeInstruction({
      runDir,
      instruction,
      runOptions: tradeOptions,
      policy: getTradePolicy(),
      source: "cli"
    });

    info(`Trade artifact directory: ${runDir}`);
    info(`Trade status: ${record.status}`);
    info(record.note);
    if (record.txHash) {
      info(`Transaction hash: ${record.txHash}`);
    }

    if (record.status === "blocked" || record.status === "failed") {
      process.exitCode = 1;
    }
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  process.stderr.write(`[ERROR] ${message}\n`);
  process.exit(1);
});
