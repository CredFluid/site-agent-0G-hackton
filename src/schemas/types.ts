import { z } from "zod";

function normalizeToTenPointScore(value: number): number {
  const scaled = value > 10 ? value / 10 : value;
  return Math.min(10, Math.max(1, Math.round(scaled)));
}

const TenPointScoreSchema = z
  .number()
  .finite()
  .min(0)
  .max(100)
  .transform((value) => normalizeToTenPointScore(value))
  .pipe(z.number().int().min(1).max(10));

export const ActionTypeSchema = z.enum([
  "click",
  "type",
  "scroll",
  "wait",
  "back",
  "extract",
  "stop"
]);

export const FrictionSchema = z.enum(["none", "low", "medium", "high"]);

export const PlannerDecisionSchema = z.object({
  thought: z.string().min(1),
  action: ActionTypeSchema,
  target: z.string().default(""),
  text: z.string().default(""),
  expectation: z.string().min(1),
  friction: FrictionSchema
});

export const TaskSchema = z.object({
  name: z.string().min(1),
  goal: z.string().min(1),
  success_condition: z.string().min(1),
  failure_signals: z.array(z.string()).min(1)
});

export const PersonaSchema = z.object({
  name: z.string().min(1),
  intent: z.string().min(1),
  constraints: z.array(z.string()).min(1)
});

export const TaskSuiteSchema = z.object({
  persona: PersonaSchema,
  tasks: z.array(TaskSchema).min(1)
});

export const InteractiveElementSchema = z.object({
  role: z.string(),
  tag: z.string(),
  type: z.string().optional(),
  text: z.string(),
  href: z.string().optional(),
  disabled: z.boolean()
});

export const PageStateSchema = z.object({
  title: z.string(),
  url: z.string(),
  visibleText: z.string(),
  interactive: z.array(InteractiveElementSchema),
  headings: z.array(z.string()),
  formsPresent: z.boolean(),
  modalHints: z.array(z.string())
});

export const InteractionResultSchema = z.object({
  success: z.boolean(),
  stop: z.boolean().optional(),
  note: z.string(),
  matchedBy: z.string().optional(),
  elapsedMs: z.number().int().nonnegative().optional(),
  destinationUrl: z.string().optional(),
  destinationTitle: z.string().optional(),
  stateChanged: z.boolean().optional()
});

export const TaskHistoryEntrySchema = z.object({
  time: z.string(),
  task: z.string(),
  step: z.number().int().positive(),
  url: z.string(),
  title: z.string(),
  decision: PlannerDecisionSchema,
  result: InteractionResultSchema
});

export const TaskRunResultSchema = z.object({
  name: z.string(),
  status: z.enum(["success", "partial_success", "failed"]),
  finalUrl: z.string(),
  finalTitle: z.string(),
  history: z.array(TaskHistoryEntrySchema),
  reason: z.string()
});

export const AccessibilityViolationSchema = z.object({
  id: z.string(),
  impact: z.string().nullable().optional(),
  description: z.string(),
  help: z.string(),
  nodes: z.number().int().nonnegative()
});

export const AccessibilityResultSchema = z.object({
  violations: z.array(AccessibilityViolationSchema),
  error: z.string().optional()
});

export const FinalReportSchema = z.object({
  overall_score: TenPointScoreSchema,
  summary: z.string(),
  scores: z.object({
    clarity: TenPointScoreSchema,
    navigation: TenPointScoreSchema,
    trust: TenPointScoreSchema,
    friction: TenPointScoreSchema,
    conversion_readiness: TenPointScoreSchema,
    accessibility_basics: TenPointScoreSchema
  }),
  strengths: z.array(z.string()),
  weaknesses: z.array(z.string()),
  task_results: z.array(
    z.object({
      name: z.string(),
      status: z.enum(["success", "partial_success", "failed"]),
      reason: z.string(),
      evidence: z.array(z.string())
    })
  ),
  top_fixes: z.array(z.string())
});

export type PlannerDecision = z.infer<typeof PlannerDecisionSchema>;
export type TaskSuite = z.infer<typeof TaskSuiteSchema>;
export type PageState = z.infer<typeof PageStateSchema>;
export type TaskRunResult = z.infer<typeof TaskRunResultSchema>;
export type AccessibilityResult = z.infer<typeof AccessibilityResultSchema>;
export type FinalReport = z.infer<typeof FinalReportSchema>;
export type TaskHistoryEntry = z.infer<typeof TaskHistoryEntrySchema>;
