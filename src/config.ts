import dotenv from "dotenv";
import { z } from "zod";
import { TradePolicySchema, type TradePolicy, type TradeTokenRegistryEntry } from "./trade/types.js";

dotenv.config();

export const MAX_TOTAL_RUN_DURATION_SECONDS = 600;
export const MAX_TOTAL_RUN_DURATION_MS = MAX_TOTAL_RUN_DURATION_SECONDS * 1000;
export const DEFAULT_TOTAL_RUN_DURATION_MS = MAX_TOTAL_RUN_DURATION_MS;
export const MIN_TOTAL_RUN_DURATION_MS = 60000;
export const MIN_BROWSER_EXECUTION_BUDGET_MS = 45000;
export const MIN_REPORTING_RESERVE_MS = 15000;
export const MAX_REPORTING_RESERVE_MS = 45000;
export const POST_RUN_AUDIT_RESERVE_MS = 45000;
export const DETECTED_DEVICE_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
export const LlmProviderSchema = z.enum(["openai", "ollama"]);
export type LlmProvider = z.infer<typeof LlmProviderSchema>;

export function clampRunDurationMs(value: number): number {
  return Math.min(MAX_TOTAL_RUN_DURATION_MS, Math.max(MIN_TOTAL_RUN_DURATION_MS, Math.round(value)));
}

export function deriveReportingReserveMs(totalRunDurationMs: number): number {
  const clampedTotalRunDurationMs = clampRunDurationMs(totalRunDurationMs);
  const desiredReserveMs = Math.round(clampedTotalRunDurationMs * 0.15);
  const maxAllowedReserveMs = Math.max(
    MIN_REPORTING_RESERVE_MS,
    clampedTotalRunDurationMs - MIN_BROWSER_EXECUTION_BUDGET_MS
  );

  return Math.min(
    MAX_REPORTING_RESERVE_MS,
    Math.max(MIN_REPORTING_RESERVE_MS, Math.min(desiredReserveMs, maxAllowedReserveMs))
  );
}

export function deriveBrowserExecutionBudgetMs(totalRunDurationMs: number): number {
  const clampedTotalRunDurationMs = clampRunDurationMs(totalRunDurationMs);
  return clampedTotalRunDurationMs - deriveReportingReserveMs(clampedTotalRunDurationMs);
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseBooleanFlag(value: string | undefined, fallback: boolean): boolean {
  const normalized = normalizeOptionalString(value)?.toLowerCase();
  if (!normalized) {
    return fallback;
  }

  if (["true", "1", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["false", "0", "no", "off"].includes(normalized)) {
    return false;
  }

  return fallback;
}

function parseChainIdList(value: string | undefined): number[] {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return [];
  }

  return normalized
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isFinite(item) && item > 0)
    .map((item) => Math.round(item));
}

function parseTokenRegistry(value: string | undefined): TradeTokenRegistryEntry[] {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return [];
  }

  try {
    const parsedValue = JSON.parse(normalized);
    const result = z.array(
      z.object({
        chainId: z.number(),
        symbol: z.string(),
        assetKind: z.enum(["native", "erc20"]),
        contract: z.string().optional(),
        decimals: z.number()
      })
    ).parse(parsedValue);
    return result.map((entry) => ({
      chainId: Math.round(entry.chainId),
      symbol: entry.symbol.trim().toUpperCase(),
      assetKind: entry.assetKind,
      contract: entry.contract?.trim() ? entry.contract.trim() : undefined,
      decimals: Math.round(entry.decimals)
    }));
  } catch (error) {
    throw new Error(
      `TRADE_TOKEN_REGISTRY must be valid JSON (array of { chainId, symbol, assetKind, contract?, decimals }): ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

const EnvSchema = z.object({
  LLM_PROVIDER: LlmProviderSchema.default("openai"),
  OPENAI_API_KEY: z
    .string()
    .optional()
    .transform((value: string | undefined) => normalizeOptionalString(value)),
  OPENAI_MODEL: z.string().default("gpt-5"),
  OLLAMA_BASE_URL: z.string().url().default("http://127.0.0.1:11434"),
  OLLAMA_MODEL: z.string().default("llama3.1:8b"),
  APP_BASE_URL: z.string().optional(),
  HEADLESS: z
    .string()
    .optional()
    .transform((value: string | undefined) => value !== "false"),
  MAX_SESSION_DURATION_MS: z.coerce.number().int().positive().default(DEFAULT_TOTAL_RUN_DURATION_MS),
  MAX_STEPS_PER_TASK: z.coerce.number().int().positive().default(32),
  ACTION_DELAY_MS: z.coerce.number().int().nonnegative().default(600),
  NAVIGATION_TIMEOUT_MS: z.coerce.number().int().positive().default(25000),
  REPORT_TTL_DAYS: z.coerce.number().int().positive().default(30),
  PLAYWRIGHT_STORAGE_STATE_PATH: z
    .string()
    .optional()
    .transform((value: string | undefined) => normalizeOptionalString(value)),
  RECORD_VIDEO: z
    .string()
    .optional()
    .transform((value: string | undefined) => value === "true"),
  TRADE_ENABLED: z
    .string()
    .optional()
    .transform((value: string | undefined) => parseBooleanFlag(value, false)),
  TRADE_ALLOWLISTED_CHAIN_IDS: z
    .string()
    .optional()
    .transform((value: string | undefined) => parseChainIdList(value)),
  TRADE_TOKEN_REGISTRY: z
    .string()
    .optional()
    .transform((value: string | undefined) => parseTokenRegistry(value)),
  TRADE_MAX_TOKEN_AMOUNT: z
    .string()
    .optional()
    .transform((value: string | undefined) => normalizeOptionalString(value)),
  TRADE_REQUIRE_EXACT_TOKEN_CONTRACT: z
    .string()
    .optional()
    .transform((value: string | undefined) => parseBooleanFlag(value, true)),
  TRADE_CONFIRMATIONS_REQUIRED: z.coerce.number().int().min(0).max(12).default(1),
  TRADE_RECEIPT_TIMEOUT_MS: z.coerce.number().int().positive().default(120000)
});

const parsed = EnvSchema.parse(process.env);
const requestedMaxSessionDurationMs = parsed.MAX_SESSION_DURATION_MS;
const maxSessionDurationMs = clampRunDurationMs(requestedMaxSessionDurationMs);
const resolvedAppBaseUrl = normalizeOptionalString(parsed.APP_BASE_URL) ?? normalizeOptionalString(process.env.RENDER_EXTERNAL_URL);
const tradePolicy: TradePolicy = TradePolicySchema.parse({
  enabledByDefault: parsed.TRADE_ENABLED,
  allowlistedChainIds: parsed.TRADE_ALLOWLISTED_CHAIN_IDS,
  tokenRegistry: parsed.TRADE_TOKEN_REGISTRY,
  maxTokenAmount: parsed.TRADE_MAX_TOKEN_AMOUNT,
  requireExactTokenContract: parsed.TRADE_REQUIRE_EXACT_TOKEN_CONTRACT,
  receiptTimeoutMs: parsed.TRADE_RECEIPT_TIMEOUT_MS,
  confirmationsRequired: parsed.TRADE_CONFIRMATIONS_REQUIRED
});

function resolveDefaultModel(provider: LlmProvider): string {
  return provider === "ollama" ? parsed.OLLAMA_MODEL : parsed.OPENAI_MODEL;
}

export const config = {
  llmProvider: parsed.LLM_PROVIDER,
  openaiApiKey: parsed.OPENAI_API_KEY,
  openaiModel: parsed.OPENAI_MODEL,
  ollamaBaseUrl: parsed.OLLAMA_BASE_URL,
  ollamaModel: parsed.OLLAMA_MODEL,
  model: resolveDefaultModel(parsed.LLM_PROVIDER),
  appBaseUrl: resolvedAppBaseUrl,
  headless: parsed.HEADLESS,
  deviceTimezone: DETECTED_DEVICE_TIMEZONE,
  requestedMaxSessionDurationMs,
  maxSessionDurationMs,
  browserExecutionBudgetMs: deriveBrowserExecutionBudgetMs(maxSessionDurationMs),
  reportingReserveMs: deriveReportingReserveMs(maxSessionDurationMs),
  postRunAuditReserveMs: POST_RUN_AUDIT_RESERVE_MS,
  maxStepsPerTask: parsed.MAX_STEPS_PER_TASK,
  actionDelayMs: parsed.ACTION_DELAY_MS,
  navigationTimeoutMs: parsed.NAVIGATION_TIMEOUT_MS,
  reportTtlDays: parsed.REPORT_TTL_DAYS,
  playwrightStorageStatePath: parsed.PLAYWRIGHT_STORAGE_STATE_PATH,
  recordVideo: parsed.RECORD_VIDEO,
  tradePolicy,
  desktopViewport: { width: 1440, height: 900 },
  mobileViewport: { width: 390, height: 844 }
};

export function resolveLlmRuntime(options?: {
  provider?: LlmProvider;
  model?: string;
  ollamaBaseUrl?: string;
}): {
  provider: LlmProvider;
  model: string;
  ollamaBaseUrl: string;
} {
  const provider = options?.provider ?? config.llmProvider;
  const model =
    normalizeOptionalString(options?.model) ??
    (provider === "ollama" ? config.ollamaModel : config.openaiModel);
  const ollamaBaseUrl = normalizeOptionalString(options?.ollamaBaseUrl) ?? config.ollamaBaseUrl;

  return {
    provider,
    model,
    ollamaBaseUrl
  };
}
