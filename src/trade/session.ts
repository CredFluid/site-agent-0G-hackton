import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { writeJson } from "../utils/files.js";
import {
  SellInstructionSchema,
  TradeExecutionRecordsSchema,
  type SellInstruction,
  type TradeExecutionRecord
} from "./types.js";

const TRADE_EXECUTIONS_FILE = "trade-executions.json";

export function resolveTradeExecutionsPath(runDir: string): string {
  return path.join(runDir, TRADE_EXECUTIONS_FILE);
}

export function computeInstructionFingerprint(instruction: SellInstruction): string {
  const normalized = SellInstructionSchema.parse(instruction);
  return crypto.createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

export function readTradeExecutionRecords(runDir: string): TradeExecutionRecord[] {
  const artifactPath = resolveTradeExecutionsPath(runDir);
  if (!fs.existsSync(artifactPath)) {
    return [];
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
    return TradeExecutionRecordsSchema.parse(parsed);
  } catch {
    return [];
  }
}

export function appendTradeExecutionRecord(runDir: string, record: TradeExecutionRecord): TradeExecutionRecord[] {
  const nextRecords = [...readTradeExecutionRecords(runDir), record];
  writeJson(resolveTradeExecutionsPath(runDir), nextRecords);
  return nextRecords;
}
