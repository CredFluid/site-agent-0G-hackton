import { z } from "zod";
import {
  AccessibilityResultSchema,
  FinalReportSchema,
  SiteBriefSchema,
  SiteChecksSchema,
  TaskHistoryEntrySchema
} from "../schemas/types.js";
import { SubmissionAgentRunSchema } from "../submissions/types.js";

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
  persona: z.string().optional(),
  headed: z.boolean(),
  mobile: z.boolean(),
  ignoreHttpsErrors: z.boolean().optional(),
  llmProvider: z.enum(["openai", "ollama"]).optional(),
  model: z.string().optional(),
  startedAt: z.string().optional(),
  maxRunDurationMs: z.number().int().positive().optional(),
  maxRunDurationSeconds: z.number().int().positive().optional(),
  browserExecutionBudgetMs: z.number().int().positive().optional(),
  reportingReserveMs: z.number().int().nonnegative().optional(),
  maxRunDurationClamped: z.boolean().optional(),
  deviceTimezone: z.string().optional(),
  browserTimezone: z.string().optional(),
  synchronizedTimezone: z.string().optional(),
  clickReplayArtifact: z.string().optional(),
  clickReplayFrameCount: z.number().int().positive().optional(),
  clickReplayDurationMs: z.number().int().positive().optional(),
  instructionText: z.string().optional(),
  instructionFileName: z.string().nullable().optional(),
  siteBrief: SiteBriefSchema.optional(),
  batchRole: z.enum(["single", "child", "aggregate"]).default("single"),
  parentSubmissionId: z.string().optional(),
  agentCount: z.number().int().min(1).max(5).default(1),
  completedAgentCount: z.number().int().nonnegative().default(0),
  failedAgentCount: z.number().int().nonnegative().default(0),
  customTasks: z.array(z.string()).default([]),
  agentIndex: z.number().int().min(1).max(5).optional(),
  agentLabel: z.string().optional(),
  agentProfileLabel: z.string().optional(),
  personaVariantKey: z.string().optional(),
  aggregatedFromRunIds: z.array(z.string()).default([]),
  agentRuns: z.array(SubmissionAgentRunSchema).max(5).default([])
});

export const DashboardRunSummarySchema = z.object({
  id: z.string(),
  baseUrl: z.string(),
  host: z.string(),
  startedAt: z.string().nullable(),
  headed: z.boolean(),
  mobile: z.boolean(),
  llmProvider: z.enum(["openai", "ollama"]).nullable().default(null),
  model: z.string().nullable(),
  persona: z.string().nullable(),
  overallScore: TenPointNullableScoreSchema,
  summary: z.string().nullable(),
  taskCount: z.number().int().nonnegative(),
  accessibilityViolationCount: z.number().int().nonnegative().nullable(),
  batchRole: z.enum(["single", "child", "aggregate"]).default("single"),
  agentCount: z.number().int().min(1).max(5).default(1),
  completedAgentCount: z.number().int().nonnegative().default(0),
  failedAgentCount: z.number().int().nonnegative().default(0),
  agentLabel: z.string().nullable().default(null),
  agentProfileLabel: z.string().nullable().default(null)
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
  siteChecks: SiteChecksSchema.nullable(),
  tasks: z.array(DashboardTaskSchema),
  rawEventCount: z.number().int().nonnegative(),
  warnings: z.array(z.string())
});

export type RunInputs = z.infer<typeof RunInputsSchema>;
export type DashboardRunSummary = z.infer<typeof DashboardRunSummarySchema>;
export type DashboardRunDetail = z.infer<typeof DashboardRunDetailSchema>;
