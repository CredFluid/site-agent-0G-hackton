import dotenv from "dotenv";
import { z } from "zod";

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
    .transform((value: string | undefined) => value === "true")
});

const parsed = EnvSchema.parse(process.env);
const requestedMaxSessionDurationMs = parsed.MAX_SESSION_DURATION_MS;
const maxSessionDurationMs = clampRunDurationMs(requestedMaxSessionDurationMs);

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
  appBaseUrl: parsed.APP_BASE_URL,
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
