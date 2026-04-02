import { z } from "zod";

export const SubmissionStatusSchema = z.enum(["queued", "running", "completed", "failed"]);

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

export const SubmissionSchema = z.object({
  id: z.string(),
  url: z.string().url(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  expiresAt: z.string(),
  status: SubmissionStatusSchema,
  reportToken: z.string(),
  publicReportPath: z.string(),
  taskPath: z.string(),
  headed: z.boolean(),
  mobile: z.boolean(),
  ignoreHttpsErrors: z.boolean(),
  runId: z.string().nullable(),
  runDir: z.string().nullable(),
  error: z.string().nullable(),
  reportSummary: z.string().nullable(),
  overallScore: TenPointNullableScoreSchema
});

export type Submission = z.infer<typeof SubmissionSchema>;
export type SubmissionStatus = z.infer<typeof SubmissionStatusSchema>;
