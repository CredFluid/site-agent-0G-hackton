import { z } from "zod";
import {
  AccessibilityResultSchema,
  FinalReportSchema,
  TaskHistoryEntrySchema
} from "../schemas/types.js";

const TenPointNullableScoreSchema = z
  .number()
  .finite()
  .min(0)
  .max(100)
  .transform((value) => {
    const scaled = value > 10 ? value / 10 : value;
    return Math.min(10, Math.max(1, Math.round(scaled)));
  })
  .pipe(z.number().int().min(1).max(10))
  .nullable();

export const RunInputsSchema = z.object({
  baseUrl: z.string(),
  taskPath: z.string(),
  persona: z.string().optional(),
  headed: z.boolean(),
  mobile: z.boolean(),
  ignoreHttpsErrors: z.boolean().optional(),
  model: z.string().optional(),
  startedAt: z.string().optional(),
  maxRunDurationMs: z.number().int().positive().optional(),
  maxRunDurationSeconds: z.number().int().positive().optional(),
  browserExecutionBudgetMs: z.number().int().positive().optional(),
  reportingReserveMs: z.number().int().nonnegative().optional(),
  maxRunDurationClamped: z.boolean().optional(),
  deviceTimezone: z.string().optional(),
  browserTimezone: z.string().optional(),
  synchronizedTimezone: z.string().optional()
});

export const DashboardRunSummarySchema = z.object({
  id: z.string(),
  baseUrl: z.string(),
  host: z.string(),
  startedAt: z.string().nullable(),
  headed: z.boolean(),
  mobile: z.boolean(),
  model: z.string().nullable(),
  taskPath: z.string().nullable(),
  persona: z.string().nullable(),
  overallScore: TenPointNullableScoreSchema,
  summary: z.string().nullable(),
  taskCount: z.number().int().nonnegative(),
  accessibilityViolationCount: z.number().int().nonnegative().nullable()
});

export const DashboardTaskHistoryEntrySchema = TaskHistoryEntrySchema.extend({
});

export const DashboardTaskSchema = z.object({
  name: z.string(),
  status: z.enum(["success", "partial_success", "failed"]),
  reason: z.string(),
  evidence: z.array(z.string()),
  finalUrl: z.string(),
  finalTitle: z.string(),
  history: z.array(DashboardTaskHistoryEntrySchema)
});

export const DashboardRunDetailSchema = z.object({
  id: z.string(),
  host: z.string(),
  inputs: RunInputsSchema.nullable(),
  report: FinalReportSchema.nullable(),
  accessibility: AccessibilityResultSchema.nullable(),
  tasks: z.array(DashboardTaskSchema),
  rawEventCount: z.number().int().nonnegative(),
  warnings: z.array(z.string())
});

export type RunInputs = z.infer<typeof RunInputsSchema>;
export type DashboardRunSummary = z.infer<typeof DashboardRunSummarySchema>;
export type DashboardRunDetail = z.infer<typeof DashboardRunDetailSchema>;
