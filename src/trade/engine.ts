import crypto from "node:crypto";
import { sendTransaction } from "../wallet/wallet.js";
import { encodeErc20Transfer, parseTokenAmount, waitForEvmReceipt } from "./evm/erc20.js";
import { appendTradeExecutionRecord, computeInstructionFingerprint, readTradeExecutionRecords } from "./session.js";
import { validateSellInstruction } from "./validator.js";
import type { SellInstruction, TradeExecutionRecord, TradePolicy, TradeRunOptions } from "./types.js";

type ExecuteTradeInstructionArgs = {
  runDir: string;
  instruction: SellInstruction;
  runOptions: TradeRunOptions;
  policy: TradePolicy;
  source: "browser" | "cli";
};

function cleanErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\u001b\[[0-9;]*m/g, "").replace(/\s+/g, " ").trim() || "Unknown trade execution error";
}

function serializeJsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") {
    return value.toString();
  }

  if (Array.isArray(value)) {
    return value.map((item) => serializeJsonSafe(item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nestedValue]) => [key, serializeJsonSafe(nestedValue)])
    );
  }

  return value;
}

function createExecutionRecord(args: {
  fingerprint: string;
  source: "browser" | "cli";
  requestedStrategy: TradeRunOptions["strategy"];
  selectedMode: TradeExecutionRecord["selectedMode"];
  dryRun: boolean;
  status: TradeExecutionRecord["status"];
  instruction: SellInstruction;
  validation: TradeExecutionRecord["validation"];
  note: string;
  txHash?: string | null;
  confirmationsRequested: number;
  confirmationsReached?: number;
  receipt?: Record<string, unknown> | null;
  error?: string | null;
}): TradeExecutionRecord {
  return {
    id: crypto.randomUUID(),
    fingerprint: args.fingerprint,
    time: new Date().toISOString(),
    source: args.source,
    strategy: args.requestedStrategy,
    selectedMode: args.selectedMode,
    dryRun: args.dryRun,
    status: args.status,
    instruction: args.instruction,
    validation: args.validation,
    txHash: args.txHash ?? null,
    confirmationsRequested: args.confirmationsRequested,
    confirmationsReached: args.confirmationsReached ?? 0,
    receipt: args.receipt ?? null,
    error: args.error ?? null,
    note: args.note
  };
}

function resolveSelectedMode(args: {
  instruction: SellInstruction;
  runOptions: TradeRunOptions;
}): TradeExecutionRecord["selectedMode"] {
  if (args.instruction.mode === "dapp_managed") {
    return "dapp_managed";
  }

  if (args.instruction.mode === "deposit_address_transfer") {
    return "deposit_address_transfer";
  }

  return "unsupported";
}

function strategyAllowsMode(args: {
  selectedMode: TradeExecutionRecord["selectedMode"];
  runOptions: TradeRunOptions;
}): boolean {
  if (args.runOptions.strategy === "auto") {
    return true;
  }

  if (args.runOptions.strategy === "dapp_only") {
    return args.selectedMode === "dapp_managed";
  }

  if (args.runOptions.strategy === "deposit_only") {
    return args.selectedMode === "deposit_address_transfer";
  }

  return false;
}

export async function executeTradeInstruction(args: ExecuteTradeInstructionArgs): Promise<TradeExecutionRecord> {
  const fingerprint = computeInstructionFingerprint(args.instruction);
  const selectedMode = resolveSelectedMode({
    instruction: args.instruction,
    runOptions: args.runOptions
  });
  const { validation, normalizedInstruction } = await validateSellInstruction({
    instruction: args.instruction,
    policy: args.policy,
    runOptions: args.runOptions
  });

  if (!strategyAllowsMode({ selectedMode, runOptions: args.runOptions })) {
    const blockedRecord = createExecutionRecord({
      fingerprint,
      source: args.source,
      requestedStrategy: args.runOptions.strategy,
      selectedMode,
      dryRun: args.runOptions.dryRun,
      status: "blocked",
      instruction: normalizedInstruction,
      validation: {
        ok: false,
        reasons: [
          `Requested trade strategy '${args.runOptions.strategy}' does not allow the extracted mode '${selectedMode}'.`,
          ...validation.reasons
        ]
      },
      confirmationsRequested: args.runOptions.confirmations,
      note: `Blocked trade execution because strategy '${args.runOptions.strategy}' does not permit '${selectedMode}'.`
    });
    appendTradeExecutionRecord(args.runDir, blockedRecord);
    return blockedRecord;
  }

  if (!validation.ok) {
    const blockedRecord = createExecutionRecord({
      fingerprint,
      source: args.source,
      requestedStrategy: args.runOptions.strategy,
      selectedMode,
      dryRun: args.runOptions.dryRun,
      status: "blocked",
      instruction: normalizedInstruction,
      validation,
      confirmationsRequested: args.runOptions.confirmations,
      note: `Blocked trade execution after validation: ${validation.reasons.join(" ")}`
    });
    appendTradeExecutionRecord(args.runDir, blockedRecord);
    return blockedRecord;
  }

  const previousExecution = readTradeExecutionRecords(args.runDir).find(
    (record) =>
      record.fingerprint === fingerprint &&
      !record.dryRun &&
      (record.status === "broadcast" || record.status === "confirmed")
  );
  if (previousExecution) {
    const blockedRecord = createExecutionRecord({
      fingerprint,
      source: args.source,
      requestedStrategy: args.runOptions.strategy,
      selectedMode,
      dryRun: args.runOptions.dryRun,
      status: "blocked",
      instruction: normalizedInstruction,
      validation,
      confirmationsRequested: args.runOptions.confirmations,
      txHash: previousExecution.txHash,
      note: "Blocked duplicate trade execution because the same instruction was already broadcast in this run."
    });
    appendTradeExecutionRecord(args.runDir, blockedRecord);
    return blockedRecord;
  }

  if (args.runOptions.dryRun) {
    const dryRunRecord = createExecutionRecord({
      fingerprint,
      source: args.source,
      requestedStrategy: args.runOptions.strategy,
      selectedMode,
      dryRun: true,
      status: "dry_run",
      instruction: normalizedInstruction,
      validation,
      confirmationsRequested: args.runOptions.confirmations,
      note: `Dry run validated a ${selectedMode} trade without broadcasting a transaction.`
    });
    appendTradeExecutionRecord(args.runDir, dryRunRecord);
    return dryRunRecord;
  }

  if (selectedMode === "dapp_managed") {
    const blockedRecord = createExecutionRecord({
      fingerprint,
      source: args.source,
      requestedStrategy: args.runOptions.strategy,
      selectedMode,
      dryRun: false,
      status: "blocked",
      instruction: normalizedInstruction,
      validation,
      confirmationsRequested: args.runOptions.confirmations,
      note:
        "Dapp-managed trades must be initiated by the page through the injected wallet provider; the direct trade engine only broadcasts deposit-address transfers."
    });
    appendTradeExecutionRecord(args.runDir, blockedRecord);
    return blockedRecord;
  }

  if (selectedMode !== "deposit_address_transfer") {
    const blockedRecord = createExecutionRecord({
      fingerprint,
      source: args.source,
      requestedStrategy: args.runOptions.strategy,
      selectedMode: "unsupported",
      dryRun: false,
      status: "blocked",
      instruction: normalizedInstruction,
      validation,
      confirmationsRequested: args.runOptions.confirmations,
      note: "The extracted trade mode is not supported by the direct trade engine."
    });
    appendTradeExecutionRecord(args.runDir, blockedRecord);
    return blockedRecord;
  }

  try {
    const tx =
      normalizedInstruction.assetKind === "native"
        ? {
            to: normalizedInstruction.recipientAddress,
            value: await parseTokenAmount(
              normalizedInstruction.amount,
              normalizedInstruction.tokenDecimals ?? 18
            ),
            chainId: normalizedInstruction.chainId
          }
        : {
            to: normalizedInstruction.tokenContract!,
            data: await encodeErc20Transfer({
              recipientAddress: normalizedInstruction.recipientAddress,
              amountBaseUnits: await parseTokenAmount(
                normalizedInstruction.amount,
                normalizedInstruction.tokenDecimals ?? 0
              )
            }),
            value: 0n,
            chainId: normalizedInstruction.chainId
          };

    const txHash = await sendTransaction(tx);
    const receipt = await waitForEvmReceipt({
      txHash,
      confirmations: Math.max(0, args.runOptions.confirmations),
      timeoutMs: args.policy.receiptTimeoutMs
    });

    const confirmed = Boolean(receipt);
    const record = createExecutionRecord({
      fingerprint,
      source: args.source,
      requestedStrategy: args.runOptions.strategy,
      selectedMode,
      dryRun: false,
      status: confirmed ? "confirmed" : "broadcast",
      instruction: normalizedInstruction,
      validation,
      txHash,
      confirmationsRequested: args.runOptions.confirmations,
      confirmationsReached: confirmed ? Math.max(1, args.runOptions.confirmations) : 0,
      receipt: serializeJsonSafe(receipt) as Record<string, unknown> | null,
      note: confirmed
        ? `Broadcast and confirmed ${normalizedInstruction.assetKind} transfer ${txHash}.`
        : `Broadcast ${normalizedInstruction.assetKind} transfer ${txHash}, but no receipt was observed before timeout.`
    });
    appendTradeExecutionRecord(args.runDir, record);
    return record;
  } catch (error) {
    const message = cleanErrorMessage(error);
    const failedRecord = createExecutionRecord({
      fingerprint,
      source: args.source,
      requestedStrategy: args.runOptions.strategy,
      selectedMode,
      dryRun: false,
      status: "failed",
      instruction: normalizedInstruction,
      validation,
      confirmationsRequested: args.runOptions.confirmations,
      error: message,
      note: `Trade execution failed: ${message}`
    });
    appendTradeExecutionRecord(args.runDir, failedRecord);
    return failedRecord;
  }
}
