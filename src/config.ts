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
export const DETECTED_DEVICE_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

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

const EnvSchema = z.object({
  OPENAI_API_KEY: z.string().min(1, "OPENAI_API_KEY is required"),
  OPENAI_MODEL: z.string().default("gpt-5"),
  APP_BASE_URL: z.string().optional(),
  HEADLESS: z
    .string()
    .optional()
    .transform((value: string | undefined) => value !== "false"),
  MAX_SESSION_DURATION_MS: z.coerce.number().int().positive().default(DEFAULT_TOTAL_RUN_DURATION_MS),
  MAX_STEPS_PER_TASK: z.coerce.number().int().positive().default(10),
  ACTION_DELAY_MS: z.coerce.number().int().nonnegative().default(600),
  NAVIGATION_TIMEOUT_MS: z.coerce.number().int().positive().default(25000),
  REPORT_TTL_DAYS: z.coerce.number().int().positive().default(30)
});

const parsed = EnvSchema.parse(process.env);
const requestedMaxSessionDurationMs = parsed.MAX_SESSION_DURATION_MS;
const maxSessionDurationMs = clampRunDurationMs(requestedMaxSessionDurationMs);

export const config = {
  openaiApiKey: parsed.OPENAI_API_KEY,
  model: parsed.OPENAI_MODEL,
  appBaseUrl: parsed.APP_BASE_URL,
  headless: parsed.HEADLESS,
  deviceTimezone: DETECTED_DEVICE_TIMEZONE,
  requestedMaxSessionDurationMs,
  maxSessionDurationMs,
  browserExecutionBudgetMs: deriveBrowserExecutionBudgetMs(maxSessionDurationMs),
  reportingReserveMs: deriveReportingReserveMs(maxSessionDurationMs),
  maxStepsPerTask: parsed.MAX_STEPS_PER_TASK,
  actionDelayMs: parsed.ACTION_DELAY_MS,
  navigationTimeoutMs: parsed.NAVIGATION_TIMEOUT_MS,
  reportTtlDays: parsed.REPORT_TTL_DAYS,
  desktopViewport: { width: 1440, height: 900 },
  mobileViewport: { width: 390, height: 844 }
};
