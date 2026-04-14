import { deriveGameplaySummary } from "./gameplaySummary.js";
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

type DerivedObservation = {
  text: string;
  priority: number;
  tone: "positive" | "negative" | "limitation";
  fix?: string;
};

function clampScore(value: number): number {
  return Math.min(10, Math.max(1, Math.round(value)));
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function uniqueItems(items: string[], limit: number): string[] {
  return [...new Set(items.map((item) => normalizeText(item)).filter(Boolean))].slice(0, limit);
}

function formatTaskStatus(status: TaskRunResult["status"]): string {
  switch (status) {
    case "success":
      return "succeeded";
    case "partial_success":
      return "partially succeeded";
    case "failed":
    default:
      return "failed";
  }
}

function buildTaskOutcomeSummary(taskResults: TaskRunResult[]): string {
  if (taskResults.length === 0) {
    return "";
  }

  const successCount = taskResults.filter((task) => task.status === "success").length;
  const partialCount = taskResults.filter((task) => task.status === "partial_success").length;
  const failedCount = taskResults.filter((task) => task.status === "failed").length;
  const perTask = taskResults
    .slice(0, 5)
    .map((task) => `${task.name} ${formatTaskStatus(task.status)}`)
    .join("; ");

  return ensureSentence(
    `Accepted task outcomes: ${successCount} succeeded, ${partialCount} partially succeeded, and ${failedCount} failed.${perTask ? ` Per task: ${perTask}.` : ""}`
  );
}

function ensureSentence(value: string): string {
  const trimmed = normalizeText(value);
  if (!trimmed) {
    return "";
  }

  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function readSiteLabel(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname.replace(/^www\./, "") || baseUrl;
  } catch {
    return baseUrl;
  }
}

function stripMilliseconds(value: string): string {
  return value.replace(/ after \d+ms/gi, "");
}

function isInternalToolingText(value: string): boolean {
  return /could not find clickable element for 'https?:\/\//i.test(value) ||
    /model evaluator/i.test(value) ||
    /planner request did not finish/i.test(value) ||
    /storage state/i.test(value);
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
      entry.result.visibleTextSnippet ?? "",
      entry.result.destinationTitle ?? "",
      entry.result.destinationUrl ?? ""
    ])
  ]
    .filter(Boolean)
    .join(" ");
}

function isInterstitialLimited(task: TaskRunResult): boolean {
  return INTERSTITIAL_PATTERNS.some((pattern) => pattern.test(taskTextBlob(task)));
}

function isTimeLimited(task: TaskRunResult): boolean {
  return TIME_LIMIT_PATTERNS.some((pattern) => pattern.test(taskTextBlob(task)));
}

function observationFromEntry(entry: TaskRunResult["history"][number]): DerivedObservation | null {
  const note = normalizeText(entry.result.note);
  const target = normalizeText(entry.decision.target);
  const targetLabel = target || "that path";

  if (!note || isInternalToolingText(note)) {
    return null;
  }

  const successMatch = note.match(/Clicked '([^']+)' and reached '([^']+)'(?: after (\d+)ms)?/i);
  if (successMatch) {
    const clickedLabel = successMatch[1] ?? targetLabel;
    const destination = successMatch[2] ?? entry.result.destinationTitle ?? entry.result.destinationUrl ?? "the next page";
    const elapsed = successMatch[3] ? ` in ${successMatch[3]}ms` : "";
    return {
      tone: "positive",
      priority: 70,
      text: `Clicking "${clickedLabel}" opened "${destination}"${elapsed}.`
    };
  }

  const noChangeMatch = note.match(/Clicked '([^']+)' but the page showed no clear visible change(?: after (\d+)ms)?/i);
  if (noChangeMatch) {
    const clickedLabel = noChangeMatch[1] ?? targetLabel;
    const elapsed = noChangeMatch[2] ? ` after ${noChangeMatch[2]}ms` : "";
    return {
      tone: "negative",
      priority: 100,
      text: `Clicking "${clickedLabel}" did not produce a clear visible change${elapsed}.`,
      fix: `Make the "${clickedLabel}" control lead to a clear destination or give obvious feedback that the click worked.`
    };
  }

  if (/security or verification interstitial/i.test(note)) {
    return {
      tone: "limitation",
      priority: 95,
      text: target
        ? `A security or verification interstitial blocked the path after clicking "${target}".`
        : "A security or verification interstitial blocked a visible navigation path.",
      fix: "Reduce how often verification walls interrupt normal first-visit navigation, or provide a trusted QA lane."
    };
  }

  if (/Stopped after repeated unchanged page states with no meaningful progress/i.test(note)) {
    return {
      tone: "negative",
      priority: 90,
      text: "After several attempts, the page stayed visually unchanged and the path stalled.",
      fix: "Make high-value navigation paths produce clearer state changes and stronger feedback when the interface is waiting or blocked."
    };
  }

  if (/Waited \d+ms with no clear visible page change/i.test(note)) {
    return {
      tone: "negative",
      priority: 45,
      text: "Waiting did not reveal any clearer next step or visible page change."
    };
  }

  if (/Tried to go back, but the visible page did not clearly change/i.test(note)) {
    return {
      tone: "negative",
      priority: 55,
      text: "Back navigation did not return to a clearly different visible state.",
      fix: "Make browser back behavior and in-product recovery paths more predictable."
    };
  }

  if (/Could not find clickable element for '([^']+)'/i.test(note)) {
    const match = note.match(/Could not find clickable element for '([^']+)'/i);
    const clickedLabel = normalizeText(match?.[1] ?? target);
    if (!clickedLabel || /^https?:\/\//i.test(clickedLabel)) {
      return null;
    }

    return {
      tone: "negative",
      priority: 75,
      text: `The interface did not expose "${clickedLabel}" as a clear visible click target when I tried to use it.`,
      fix: `Make "${clickedLabel}" visually obvious and reliably clickable as a normal first-visit control.`
    };
  }

  if (/Action failed:/i.test(note)) {
    const fix = target ? `Stabilize the "${target}" interaction so it completes reliably.` : undefined;
    return {
      tone: "negative",
      priority: 70,
      text: ensureSentence(stripMilliseconds(note.replace(/^Action failed:\s*/i, ""))),
      ...(fix ? { fix } : {})
    };
  }

  if (entry.result.success && entry.result.stateChanged) {
    const destination = entry.result.destinationTitle ?? entry.result.destinationUrl ?? "the next visible state";
    return {
      tone: "positive",
      priority: 40,
      text: target
        ? `Using "${target}" led to "${destination}".`
        : `One of the visible paths did lead to "${destination}".`
    };
  }

  return null;
}

function collectTaskObservations(task: TaskRunResult): DerivedObservation[] {
  const observations = task.history
    .map((entry) => observationFromEntry(entry))
    .filter((value): value is DerivedObservation => Boolean(value));

  if (observations.length > 0) {
    return observations;
  }

  if (!isInternalToolingText(task.reason)) {
    return [
      {
        tone: task.status === "success" ? "positive" : "negative",
        priority: task.status === "success" ? 30 : 60,
        text: ensureSentence(stripMilliseconds(task.reason))
      }
    ];
  }

  return [];
}

function extractTaskEvidence(task: TaskRunResult): string[] {
  const observationEvidence = collectTaskObservations(task)
    .sort((left, right) => right.priority - left.priority)
    .map((item) => item.text);

  const rawHistoryEvidence = task.history
    .map((entry) => {
      const target = normalizeText(entry.decision.target);
      const prefix = target ? `${entry.decision.action} "${target}"` : entry.decision.action;
      const visibleSnippet = entry.result.visibleTextSnippet ? ` Visible text: ${entry.result.visibleTextSnippet.slice(0, 160)}.` : "";
      return `Step ${entry.step}: ${prefix} -> ${stripMilliseconds(entry.result.note)}${visibleSnippet}`;
    });

  return uniqueItems(
    [
      ...(isInternalToolingText(task.reason) ? [] : [task.reason]),
      ...observationEvidence,
      ...rawHistoryEvidence
    ],
    5
  );
}

export function buildFallbackReport(args: {
  baseUrl: string;
  suite: TaskSuite;
  taskResults: TaskRunResult[];
  accessibility: AccessibilityResult;
  mobile?: boolean;
  fallbackReason: string;
}): FinalReport {
  const gameplaySummary = deriveGameplaySummary({
    suite: args.suite,
    taskResults: args.taskResults
  });
  const totalTasks = Math.max(1, args.taskResults.length);
  const successCount = args.taskResults.filter((task) => task.status === "success").length;
  const partialCount = args.taskResults.filter((task) => task.status === "partial_success").length;
  const failedCount = args.taskResults.filter((task) => task.status === "failed").length;
  const interstitialLimitedTasks = args.taskResults.filter((task) => isInterstitialLimited(task));
  const timeLimitedTasks = args.taskResults.filter((task) => isTimeLimited(task));
  const assessableTaskCount = Math.max(1, totalTasks - interstitialLimitedTasks.length);
  const totalSteps = args.taskResults.reduce((sum, task) => sum + task.history.length, 0);
  const failedSteps = args.taskResults.reduce(
    (sum, task) => sum + task.history.filter((entry) => !entry.result.success || entry.decision.friction === "high").length,
    0
  );
  const actionableFailures = args.taskResults.filter(
    (task) =>
      task.status === "failed" &&
      !isInterstitialLimited(task) &&
      !isTimeLimited(task) &&
      collectTaskObservations(task).some((item) => item.tone === "negative")
  ).length;

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
  const overallScore = clampScore((clarity + navigation + trust + friction + conversionReadiness + accessibilityBasics) / 6);

  const allObservations = args.taskResults
    .flatMap((task) => collectTaskObservations(task))
    .sort((left, right) => right.priority - left.priority);

  const positiveObservations = uniqueItems(
    allObservations.filter((item) => item.tone === "positive").map((item) => item.text),
    5
  );
  const negativeObservations = uniqueItems(
    allObservations.filter((item) => item.tone === "negative").map((item) => item.text),
    6
  );
  const limitationObservations = uniqueItems(
    [
      ...allObservations.filter((item) => item.tone === "limitation").map((item) => item.text),
      ...(interstitialLimitedTasks.length > 0
        ? [`${interstitialLimitedTasks.length} visible path${interstitialLimitedTasks.length === 1 ? "" : "s"} were blocked by a verification or security wall before the destination could be validated.`]
        : []),
      ...(timeLimitedTasks.length > 0
        ? [`${timeLimitedTasks.length} task${timeLimitedTasks.length === 1 ? "" : "s"} ended before there was enough time to validate more visible destinations.`]
        : [])
    ],
    4
  );

  const accessibilityObservations = args.accessibility.violations
    .slice(0, 3)
    .map((violation) => `${violation.help} affected ${violation.nodes} part${violation.nodes === 1 ? "" : "s"} of the page.`);

  const strengths = uniqueItems(
    [
      ...positiveObservations,
      ...(violationCount === 0 ? ["The saved axe scan did not flag any automated accessibility violations on this run."] : [])
    ],
    5
  );

  const weaknesses = uniqueItems(
    [
      ...negativeObservations,
      ...limitationObservations,
      ...accessibilityObservations,
      ...(args.accessibility.error ? [args.accessibility.error] : [])
    ],
    6
  );

  const topFixes = uniqueItems(
    [
      ...allObservations
        .filter((item) => item.tone !== "positive" && item.fix)
        .map((item) => item.fix as string),
      ...args.accessibility.violations
        .slice(0, 2)
        .map((violation) => `Resolve the "${violation.id}" accessibility issue so the page stops failing on ${violation.help.toLowerCase()}.`),
      ...(timeLimitedTasks.length > 0
        ? ["Narrow very broad navigation journeys into clearer, higher-signal paths so a first visit can validate the important destinations faster."]
        : []),
      "Make the primary navigation and key calls to action produce obvious, trustworthy next states on first click."
    ],
    5
  );

  const siteLabel = readSiteLabel(args.baseUrl);
  const summaryParts = [
    `I checked ${siteLabel}${args.mobile ? " on a mobile-sized screen" : ""}.`,
    buildTaskOutcomeSummary(args.taskResults),
    gameplaySummary ? gameplaySummary.summary : "",
    negativeObservations[0] ?? "",
    positiveObservations[0] ?? "",
    limitationObservations[0] ? `Coverage was still limited because ${limitationObservations[0].replace(/[.!?]$/g, "").toLowerCase()}.` : "",
    violationCount > 0
      ? `The saved accessibility pass also flagged ${violationCount} issue${violationCount === 1 ? "" : "s"}, including ${severeViolationCount} higher-impact item${severeViolationCount === 1 ? "" : "s"}.`
      : "The saved accessibility pass did not flag any automated accessibility issues."
  ];

  return {
    overall_score: overallScore,
    summary: uniqueItems(summaryParts.map((part) => ensureSentence(part)), 5).join(" "),
    scores: {
      clarity,
      navigation,
      trust,
      friction,
      conversion_readiness: conversionReadiness,
      accessibility_basics: accessibilityBasics
    },
    strengths: strengths.length > 0 ? strengths : ["I still gathered enough concrete interaction evidence to describe what a first visit felt like."],
    weaknesses: weaknesses.length > 0 ? weaknesses : [`The run on ${siteLabel} stayed too inconclusive to support a stronger claim.`],
    task_results: args.taskResults.map((task) => ({
      name: task.name,
      status: task.status,
      reason:
        collectTaskObservations(task).map((item) => item.text).find(Boolean) ??
        (isInternalToolingText(task.reason) ? "The path stayed inconclusive on this run." : task.reason),
      evidence: extractTaskEvidence(task)
    })),
    top_fixes: topFixes,
    ...(gameplaySummary ? { gameplay_summary: gameplaySummary } : {})
  };
}
