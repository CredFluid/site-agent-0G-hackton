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
  stepNumber: z.number().int().positive().nullable().default(null),
  instructionQuote: z.string().default(""),
  action: ActionTypeSchema,
  target_id: z.string().default(""),
  target: z.string().default(""),
  text: z.string().default(""),
  expectation: z.string().min(1),
  friction: FrictionSchema
});

export const TaskSchema = z.object({
  name: z.string().min(1),
  goal: z.string().min(1),
  success_condition: z.string().min(1),
  failure_signals: z.array(z.string()).min(1),
  gameplay: z
    .object({
      rounds: z.number().int().positive().optional(),
      requireHowToPlay: z.boolean().optional()
    })
    .optional()
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

export const SiteBriefSchema = z.object({
  sitePurpose: z.string(),
  intendedUserActions: z.array(z.string()).default([]),
  summary: z.string(),
  evidence: z.array(z.string()).default([])
});

export const InteractiveElementSchema = z.object({
  agentId: z.string(),
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
  visibleLines: z.array(z.string()),
  formFields: z.array(
    z.object({
      agentId: z.string(),
      label: z.string(),
      placeholder: z.string(),
      name: z.string(),
      id: z.string(),
      tag: z.string(),
      inputType: z.string(),
      autocomplete: z.string().default(""),
      inputMode: z.string().default(""),
      value: z.string(),
      required: z.boolean(),
      checked: z.boolean().optional(),
      maxLength: z.number().int().positive().nullable().optional(),
      options: z.array(z.string()).default([])
    })
  ),
  interactive: z.array(InteractiveElementSchema),
  numberedElements: z.array(z.string()).default([]),
  headings: z.array(z.string()),
  formsPresent: z.boolean(),
  modalHints: z.array(z.string())
});

export const ClickIndicatorSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().positive(),
  height: z.number().finite().positive(),
  targetLabel: z.string().min(1)
});

export const InteractionResultSchema = z.object({
  success: z.boolean(),
  stop: z.boolean().optional(),
  note: z.string(),
  matchedBy: z.string().optional(),
  elapsedMs: z.number().int().nonnegative().optional(),
  destinationUrl: z.string().optional(),
  destinationTitle: z.string().optional(),
  stateChanged: z.boolean().optional(),
  visibleTextSnippet: z.string().optional(),
  clickIndicator: ClickIndicatorSchema.optional(),
  beforeScreenshotPath: z.string().optional(),
  afterScreenshotPath: z.string().optional()
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

export const CoverageStateSchema = z.enum(["verified", "inferred", "blocked"]);

export const CoverageNoteSchema = z.object({
  status: CoverageStateSchema,
  summary: z.string(),
  evidence: z.array(z.string()).default([]),
  blockers: z.array(z.string()).default([])
});

export const LinkCheckSchema = z.object({
  url: z.string(),
  ok: z.boolean(),
  statusCode: z.number().int().positive().nullable(),
  note: z.string()
});

export const SeoCrawlSummarySchema = z.object({
  totalPagesAudited: z.number().int().nonnegative(),
  crawlDepthReached: z.number().int().nonnegative(),
  pagesSkipped: z.number().int().nonnegative(),
  skipReasons: z.array(z.string()).default([])
});

export const SeoPageStatsSchema = z.object({
  pagesMissingTitle: z.number().int().nonnegative(),
  pagesBadTitleLength: z.number().int().nonnegative(),
  pagesMissingMetaDescription: z.number().int().nonnegative(),
  pagesBadMetaDescriptionLength: z.number().int().nonnegative(),
  pagesMissingCanonical: z.number().int().nonnegative(),
  pagesNonSelfCanonical: z.number().int().nonnegative(),
  noindexPages: z.number().int().nonnegative(),
  nofollowPages: z.number().int().nonnegative(),
  pagesMissingViewport: z.number().int().nonnegative(),
  pagesMissingCharset: z.number().int().nonnegative(),
  pagesWithStructuredData: z.number().int().nonnegative(),
  pagesMissingOpenGraphBasics: z.number().int().nonnegative(),
  pagesMissingTwitterCard: z.number().int().nonnegative(),
  pagesWithUrlIssues: z.number().int().nonnegative(),
  pagesMissingH1: z.number().int().nonnegative(),
  pagesWithMultipleH1: z.number().int().nonnegative(),
  pagesWithHeadingOrderIssues: z.number().int().nonnegative(),
  pagesLowWordCount: z.number().int().nonnegative(),
  pagesThinOrPlaceholder: z.number().int().nonnegative(),
  pagesWithGenericAnchors: z.number().int().nonnegative(),
  imagesMissingAlt: z.number().int().nonnegative(),
  imagesWithNonDescriptiveFilenames: z.number().int().nonnegative(),
  pagesWithRenderBlockingHeadScripts: z.number().int().nonnegative(),
  pagesWithNonLazyImages: z.number().int().nonnegative(),
  pagesWithResourceHints: z.number().int().nonnegative(),
  pagesMissingLang: z.number().int().nonnegative(),
  pagesWithUnlabeledInputs: z.number().int().nonnegative(),
  pagesWithUnlabeledInteractive: z.number().int().nonnegative(),
  pagesMissingSkipNav: z.number().int().nonnegative()
});

export const SeoAuditedPageSchema = z.object({
  url: z.string(),
  depth: z.number().int().nonnegative(),
  statusCode: z.number().int().positive().nullable(),
  issueCount: z.number().int().nonnegative(),
  wordCount: z.number().int().nonnegative(),
  titleLength: z.number().int().nonnegative(),
  metaDescriptionLength: z.number().int().nonnegative(),
  h1Count: z.number().int().nonnegative(),
  notableIssues: z.array(z.string()).default([])
});

export const HeaderCheckSchema = z.object({
  name: z.string(),
  present: z.boolean(),
  value: z.string().nullable(),
  note: z.string()
});

export const PageProbePerformanceSchema = z.object({
  domContentLoadedMs: z.number().finite().nullable(),
  loadMs: z.number().finite().nullable(),
  firstContentfulPaintMs: z.number().finite().nullable(),
  largestContentfulPaintMs: z.number().finite().nullable(),
  cumulativeLayoutShift: z.number().finite().nullable()
});

export const PageProbeSchema = z.object({
  viewport: z.enum(["desktop", "mobile"]),
  finalUrl: z.string(),
  title: z.string(),
  loadOk: z.boolean(),
  note: z.string(),
  statusCode: z.number().int().positive().nullable(),
  metaDescription: z.string().nullable(),
  canonical: z.string().nullable(),
  h1Count: z.number().int().nonnegative(),
  h2Count: z.number().int().nonnegative(),
  structuredDataCount: z.number().int().nonnegative(),
  visibleLinkCount: z.number().int().nonnegative(),
  internalLinkSamples: z.array(z.string()).default([]),
  ctaSamples: z.array(z.string()).default([]),
  formCount: z.number().int().nonnegative(),
  submitControlCount: z.number().int().nonnegative(),
  trustSignalCount: z.number().int().nonnegative(),
  trustSignalSamples: z.array(z.string()).default([]),
  wordCount: z.number().int().nonnegative(),
  readabilityScore: z.number().finite().nullable(),
  readabilityLabel: z.string(),
  longParagraphCount: z.number().int().nonnegative(),
  mediaCount: z.number().int().nonnegative(),
  horizontalOverflow: z.boolean(),
  tapTargetIssueCount: z.number().int().nonnegative(),
  smallTextIssueCount: z.number().int().nonnegative(),
  navigationLinkCount: z.number().int().nonnegative(),
  heroText: z.string().nullable(),
  performance: PageProbePerformanceSchema,
  evidence: z.array(z.string()).default([])
});

export const SiteChecksSchema = z.object({
  generatedAt: z.string(),
  baseUrl: z.string(),
  finalResolvedUrl: z.string().nullable(),
  coverage: z.object({
    performance: CoverageNoteSchema,
    seo: CoverageNoteSchema,
    uiux: CoverageNoteSchema,
    security: CoverageNoteSchema,
    technicalHealth: CoverageNoteSchema,
    mobileOptimization: CoverageNoteSchema,
    contentQuality: CoverageNoteSchema,
    cro: CoverageNoteSchema
  }),
  performance: z.object({
    desktop: PageProbeSchema.nullable(),
    mobile: PageProbeSchema.nullable(),
    failedRequestCount: z.number().int().nonnegative(),
    imageFailureCount: z.number().int().nonnegative(),
    apiFailureCount: z.number().int().nonnegative(),
    navigationErrorCount: z.number().int().nonnegative(),
    stalledInteractionCount: z.number().int().nonnegative(),
    evidence: z.array(z.string()).default([])
  }),
  seo: z.object({
    robotsTxt: LinkCheckSchema,
    sitemap: LinkCheckSchema,
    brokenLinkCount: z.number().int().nonnegative(),
    checkedLinkCount: z.number().int().nonnegative(),
    brokenLinks: z.array(LinkCheckSchema).default([]),
    crawlSummary: SeoCrawlSummarySchema.optional(),
    pageStats: SeoPageStatsSchema.optional(),
    auditedPages: z.array(SeoAuditedPageSchema).optional(),
    evidence: z.array(z.string()).default([])
  }),
  security: z.object({
    https: z.boolean(),
    secureTransportVerified: z.boolean(),
    initialStatusCode: z.number().int().positive().nullable(),
    securityHeaders: z.array(HeaderCheckSchema).default([]),
    missingHeaders: z.array(z.string()).default([]),
    evidence: z.array(z.string()).default([])
  }),
  technicalHealth: z.object({
    framework: z.string().nullable(),
    consoleErrorCount: z.number().int().nonnegative(),
    consoleWarningCount: z.number().int().nonnegative(),
    pageErrorCount: z.number().int().nonnegative(),
    apiFailureCount: z.number().int().nonnegative(),
    evidence: z.array(z.string()).default([])
  }),
  mobileOptimization: z.object({
    desktop: PageProbeSchema.nullable(),
    mobile: PageProbeSchema.nullable(),
    responsiveVerdict: z.enum(["responsive", "mixed", "poor", "blocked"]),
    evidence: z.array(z.string()).default([])
  }),
  contentQuality: z.object({
    readabilityScore: z.number().finite().nullable(),
    readabilityLabel: z.string(),
    wordCount: z.number().int().nonnegative(),
    longParagraphCount: z.number().int().nonnegative(),
    mediaCount: z.number().int().nonnegative(),
    evidence: z.array(z.string()).default([])
  }),
  cro: z.object({
    ctaCount: z.number().int().nonnegative(),
    primaryCtas: z.array(z.string()).default([]),
    formCount: z.number().int().nonnegative(),
    submitControlCount: z.number().int().nonnegative(),
    trustSignalCount: z.number().int().nonnegative(),
    evidence: z.array(z.string()).default([])
  })
});

export const GameplaySummarySchema = z.object({
  roundsRequested: z.number().int().positive(),
  roundsRecorded: z.number().int().nonnegative(),
  wins: z.number().int().nonnegative(),
  losses: z.number().int().nonnegative(),
  draws: z.number().int().nonnegative(),
  inconclusiveRounds: z.number().int().nonnegative(),
  howToPlayConfirmed: z.boolean(),
  replayConfirmed: z.boolean(),
  summary: z.string(),
  evidence: z.array(z.string()).default([])
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
  top_fixes: z.array(z.string()),
  gameplay_summary: GameplaySummarySchema.optional()
});

export type PlannerDecision = z.infer<typeof PlannerDecisionSchema>;
export type TaskSuite = z.infer<typeof TaskSuiteSchema>;
export type SiteBrief = z.infer<typeof SiteBriefSchema>;
export type PageState = z.infer<typeof PageStateSchema>;
export type ClickIndicator = z.infer<typeof ClickIndicatorSchema>;
export type TaskRunResult = z.infer<typeof TaskRunResultSchema>;
export type AccessibilityResult = z.infer<typeof AccessibilityResultSchema>;
export type CoverageNote = z.infer<typeof CoverageNoteSchema>;
export type PageProbe = z.infer<typeof PageProbeSchema>;
export type SiteChecks = z.infer<typeof SiteChecksSchema>;
export type FinalReport = z.infer<typeof FinalReportSchema>;
export type TaskHistoryEntry = z.infer<typeof TaskHistoryEntrySchema>;
export type SeoCrawlSummary = z.infer<typeof SeoCrawlSummarySchema>;
export type SeoPageStats = z.infer<typeof SeoPageStatsSchema>;
export type SeoAuditedPage = z.infer<typeof SeoAuditedPageSchema>;
export type GameplaySummary = z.infer<typeof GameplaySummarySchema>;
