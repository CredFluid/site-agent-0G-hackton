import type { AccessibilityResult, FinalReport, TaskRunResult, TaskSuite } from "../schemas/types.js";

const INTERSTITIAL_PATTERNS = [
  /just a moment/i,
  /verification successful/i,
  /checking your browser/i,
  /cloudflare/i,
  /security check/i,
  /access denied/i,
  /captcha/i,
  /human verification/i
];

const TIME_LIMIT_PATTERNS = [
  /remaining session time/i,
  /execution budget/i,
  /time limit/i,
  /ran out of time/i,
  /too short for another meaningful interaction/i
];

function clampScore(value: number): number {
  return Math.min(10, Math.max(1, Math.round(value)));
}

function uniqueItems(items: string[], limit: number): string[] {
  return [...new Set(items.map((item) => item.trim()).filter(Boolean))].slice(0, limit);
}

function extractTaskEvidence(task: TaskRunResult): string[] {
  const historyEvidence = task.history
    .slice(-3)
    .map((entry) => `Step ${entry.step}: ${entry.result.note}`);

  return uniqueItems([task.reason, ...historyEvidence], 4);
}

function taskTextBlob(task: TaskRunResult): string {
  return [
    task.name,
    task.reason,
    task.finalTitle,
    task.finalUrl,
    ...task.history.flatMap((entry) => [
      entry.title,
      entry.url,
      entry.decision.target,
      entry.result.note,
      entry.result.destinationTitle ?? "",
      entry.result.destinationUrl ?? ""
    ])
  ]
    .filter(Boolean)
    .join(" ");
}

function isInterstitialLimited(task: TaskRunResult): boolean {
  const text = taskTextBlob(task);
  return INTERSTITIAL_PATTERNS.some((pattern) => pattern.test(text));
}

function isTimeLimited(task: TaskRunResult): boolean {
  const text = taskTextBlob(task);
  return TIME_LIMIT_PATTERNS.some((pattern) => pattern.test(text));
}

export function buildFallbackReport(args: {
  baseUrl: string;
  suite: TaskSuite;
  taskResults: TaskRunResult[];
  accessibility: AccessibilityResult;
  fallbackReason: string;
}): FinalReport {
  const totalTasks = Math.max(1, args.taskResults.length);
  const successCount = args.taskResults.filter((task) => task.status === "success").length;
  const partialCount = args.taskResults.filter((task) => task.status === "partial_success").length;
  const failedCount = args.taskResults.filter((task) => task.status === "failed").length;
  const interstitialLimitedTasks = args.taskResults.filter((task) => isInterstitialLimited(task));
  const timeLimitedTasks = args.taskResults.filter((task) => isTimeLimited(task));
  const actionableFailures = args.taskResults.filter(
    (task) => task.status === "failed" && !isInterstitialLimited(task) && !isTimeLimited(task)
  ).length;
  const assessableTaskCount = Math.max(1, totalTasks - interstitialLimitedTasks.length);
  const totalSteps = args.taskResults.reduce((sum, task) => sum + task.history.length, 0);
  const failedSteps = args.taskResults.reduce(
    (sum, task) => sum + task.history.filter((entry) => !entry.result.success || entry.decision.friction === "high").length,
    0
  );

  const weightedCompletion = (successCount + partialCount * 0.6) / assessableTaskCount;
  const frictionRatio = totalSteps > 0 ? failedSteps / totalSteps : actionableFailures / assessableTaskCount;
  const violationCount = args.accessibility.violations.length;
  const severeViolationCount = args.accessibility.violations.filter((item) => item.impact === "serious" || item.impact === "critical").length;

  const clarity = clampScore(4 + weightedCompletion * 4 - actionableFailures * 0.6 - Math.min(1, interstitialLimitedTasks.length * 0.2));
  const navigation = clampScore(4 + weightedCompletion * 4 - frictionRatio * 3 - actionableFailures * 0.6);
  const trust = clampScore(4 + successCount * 0.5 - actionableFailures * 0.6);
  const friction = clampScore(8 - frictionRatio * 4 - actionableFailures * 0.4 - Math.min(1, timeLimitedTasks.length * 0.3));
  const conversionReadiness = clampScore(4 + weightedCompletion * 4 - actionableFailures * 0.6);
  const accessibilityBasics = clampScore(8 - severeViolationCount * 2 - Math.min(3, violationCount * 0.4));
  const overallScore = clampScore(
    (clarity + navigation + trust + friction + conversionReadiness + accessibilityBasics) / 6
  );

  const strengths = uniqueItems(
    [
      ...args.taskResults
        .filter((task) => task.status !== "failed" && !isTimeLimited(task) && !isInterstitialLimited(task))
        .map((task) => `${task.name}: ${task.reason}`),
      ...(violationCount === 0 ? ["No automated accessibility violations were recorded in the saved axe pass."] : [])
    ],
    5
  );

  const weaknesses = uniqueItems(
    [
      ...(interstitialLimitedTasks.length > 0
        ? [`Run limitation: ${interstitialLimitedTasks.length} navigation path(s) were blocked by a security or verification interstitial before the destination page could be validated.`]
        : []),
      ...(timeLimitedTasks.length > 0
        ? [`Run limitation: ${timeLimitedTasks.length} task(s) ended before the agent had enough time to validate more visible destinations.`]
        : []),
      ...args.taskResults
        .filter((task) => task.status !== "success" && !isInterstitialLimited(task) && !isTimeLimited(task))
        .map((task) => `${task.name}: ${task.reason}`),
      ...args.accessibility.violations
        .slice(0, 3)
        .map((violation) => `Accessibility: ${violation.help} (${violation.nodes} affected nodes).`),
      args.accessibility.error ? `Accessibility audit issue: ${args.accessibility.error}` : "",
      args.fallbackReason
    ],
    6
  );

  const topFixes = uniqueItems(
    [
      ...(interstitialLimitedTasks.length > 0
        ? ["If ordinary visitors also see the same security or verification interstitials, reduce how often they interrupt core navigation paths or allowlist trusted QA traffic."]
        : []),
      ...(timeLimitedTasks.length > 0
        ? ["Split broad site exploration into targeted audits when you need deeper link coverage than one session can fairly provide."]
        : []),
      ...args.taskResults
        .filter((task) => task.status !== "success" && !isInterstitialLimited(task) && !isTimeLimited(task))
        .map((task) => `Fix the blockers around "${task.name}" so a new visitor can complete it without stalling.`),
      ...args.accessibility.violations
        .slice(0, 2)
        .map((violation) => `Resolve the "${violation.id}" accessibility issue surfaced by axe.`),
      "Make sure the main navigation labels, tabs, and destination pages match each other clearly on first visit."
    ],
    5
  );

  const summaryParts = [
    `The agent completed ${successCount} of ${totalTasks} tasks, partially completed ${partialCount}, and failed ${failedCount}.`,
    interstitialLimitedTasks.length > 0
      ? `Some navigation paths were blocked by security or verification interstitials, so parts of the run were inconclusive rather than clearly broken.`
      : "",
    timeLimitedTasks.length > 0
      ? `The run also hit its session limit before every visible destination in scope could be validated.`
      : "",
    violationCount > 0
      ? `The automated accessibility pass found ${violationCount} issue${violationCount === 1 ? "" : "s"}, including ${severeViolationCount} higher-impact item${severeViolationCount === 1 ? "" : "s"}.`
      : "The automated accessibility pass did not record any axe violations.",
    `The final report was synthesized directly from recorded evidence because the model-based review step could not finish cleanly within the remaining run budget.`
  ];

  return {
    overall_score: overallScore,
    summary: summaryParts.join(" "),
    scores: {
      clarity,
      navigation,
      trust,
      friction,
      conversion_readiness: conversionReadiness,
      accessibility_basics: accessibilityBasics
    },
    strengths: strengths.length > 0 ? strengths : ["The agent collected enough interaction evidence to produce a grounded report."],
    weaknesses: weaknesses.length > 0 ? weaknesses : [`The run on ${args.baseUrl} did not produce enough clean evidence for a stronger conclusion.`],
    task_results: args.taskResults.map((task) => ({
      name: task.name,
      status: task.status,
      reason: task.reason,
      evidence: extractTaskEvidence(task)
    })),
    top_fixes: topFixes
  };
}
