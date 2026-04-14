import type { DashboardRunDetail } from "./contracts.js";

const INTERNAL_REPORT_PATTERNS = [
  /model evaluator did not finish/i,
  /final output was synthesized directly from recorded evidence/i,
  /model-based evaluation step could not finish cleanly/i,
  /remaining run budget/i,
  /wall-clock budget/i,
  /request timed out/i,
  /current quota/i,
  /429\b/i
];

const NO_CHANGE_CLICK_PATTERN = /Clicked '([^']+)' but the page showed no clear visible change(?: after \d+ms)?/i;
const SUCCESS_CLICK_PATTERN = /Clicked '([^']+)' and reached '([^']+)'(?: after \d+ms)?/i;

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function stripTrailingPeriod(value: string): string {
  return value.replace(/[.!\s]+$/g, "").trim();
}

function ensureSentence(value: string): string {
  const trimmed = normalizeWhitespace(value);
  if (!trimmed) {
    return "";
  }

  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function lowerFirst(value: string): string {
  if (!value) {
    return value;
  }

  return value.charAt(0).toLowerCase() + value.slice(1);
}

function toTitleCaseWords(value: string): string {
  return value
    .split(" ")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function formatQuotedList(labels: string[]): string {
  if (labels.length === 0) {
    return "";
  }

  if (labels.length === 1) {
    return `"${labels[0]}"`;
  }

  if (labels.length === 2) {
    return `"${labels[0]}" and "${labels[1]}"`;
  }

  return `${labels.slice(0, -1).map((label) => `"${label}"`).join(", ")}, and "${labels.at(-1) ?? ""}"`;
}

function problemLabelPriority(label: string): number {
  const normalized = label.toLowerCase();
  if (/\bhome\b/.test(normalized)) {
    return 0;
  }

  if (/\b(menu|nav|navigation|about|contact|pricing|developers|docs|swap|login|sign in)\b/.test(normalized)) {
    return 1;
  }

  if (/\b(start|get started|launch|convert|buy|shop)\b/.test(normalized)) {
    return 3;
  }

  return 2;
}

function readSiteLabel(detail: DashboardRunDetail): string {
  const baseUrl = detail.inputs?.baseUrl;
  if (!baseUrl) {
    return detail.host;
  }

  try {
    return new URL(baseUrl).hostname.replace(/^www\./, "") || detail.host;
  } catch {
    return detail.host;
  }
}

function overallFeeling(score: number | null | undefined): string {
  if ((score ?? 0) >= 8) {
    return "smooth";
  }

  if ((score ?? 0) >= 6) {
    return "mostly okay";
  }

  if ((score ?? 0) >= 4) {
    return "mixed";
  }

  return "frustrating";
}

function dedupeStrings(items: string[]): string[] {
  const seen = new Set<string>();
  const results: string[] = [];

  for (const item of items) {
    const normalized = normalizeWhitespace(item).toLowerCase();
    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    results.push(normalizeWhitespace(item));
  }

  return results;
}

function cleanObservation(value: string): string {
  const withoutAgentPrefix = value.replace(/^Agent \d+ \([^)]+\):\s*/i, "");
  const withoutStepPrefix = withoutAgentPrefix.replace(/^Step \d+:\s*/i, "");
  const withoutTaskPrefix = withoutStepPrefix.replace(
    /^[^:]{1,80}:\s+(?=(Clicked|Waited|Stopped|Accessibility|Run limitation))/i,
    ""
  );

  return normalizeWhitespace(withoutTaskPrefix);
}

export function isVisitorFacingItem(value: string): boolean {
  const cleaned = cleanObservation(value);
  if (!cleaned) {
    return false;
  }

  return !INTERNAL_REPORT_PATTERNS.some((pattern) => pattern.test(cleaned));
}

export function filterVisitorFacingItems(items: string[]): string[] {
  return dedupeStrings(items.map((item) => cleanObservation(item)).filter((item) => isVisitorFacingItem(item)));
}

function describeObservation(observation: string): string | null {
  const cleaned = cleanObservation(observation);
  if (!isVisitorFacingItem(cleaned)) {
    return null;
  }

  const noChangeMatch = cleaned.match(NO_CHANGE_CLICK_PATTERN);
  if (noChangeMatch) {
    return `When I clicked "${noChangeMatch[1] ?? "that item"}", nothing clearly changed, so it was hard to tell whether that navigation was working.`;
  }

  const successMatch = cleaned.match(SUCCESS_CLICK_PATTERN);
  if (successMatch) {
    return `Clicking "${successMatch[1] ?? "that item"}" did take me to "${successMatch[2] ?? "the next page"}", so not every path was broken.`;
  }

  if (/Stopped early after repeated unchanged page states with no meaningful progress/i.test(cleaned)) {
    return "After a few tries, I stopped because the page kept looking unchanged and I was no longer making meaningful progress.";
  }

  const accessibilityMatch = cleaned.match(/^Accessibility:\s*(.+?)\s*\((\d+)\s+affected nodes\)\.?$/i);
  if (accessibilityMatch) {
    return `The accessibility scan also flagged ${lowerFirst(stripTrailingPeriod(accessibilityMatch[1] ?? "an accessibility issue"))} in ${accessibilityMatch[2] ?? "some"} places.`;
  }

  if (/^Run limitation:/i.test(cleaned)) {
    return ensureSentence(cleaned.replace(/^Run limitation:\s*/i, "Some parts of the visit were inconclusive because "));
  }

  return ensureSentence(cleaned);
}

function buildIntro(detail: DashboardRunDetail): string {
  const siteLabel = readSiteLabel(detail);
  const score = detail.report?.overall_score ?? null;
  const batchRole = detail.inputs?.batchRole ?? "single";
  const mobileLabel = detail.inputs?.mobile ? " on a mobile-sized screen" : "";

  if (batchRole === "aggregate") {
    return `I checked ${siteLabel} from a few different visitor perspectives, and overall the experience felt ${overallFeeling(score)}.`;
  }

  return `I visited ${siteLabel}${mobileLabel}, and overall the experience felt ${overallFeeling(score)}.`;
}

function collectNoResponseLabels(detail: DashboardRunDetail): string[] {
  const labels = detail.tasks.flatMap((task) => {
    const fromHistory = task.history
      .map((entry) => entry.result.note.match(NO_CHANGE_CLICK_PATTERN)?.[1] ?? "")
      .filter(Boolean);
    const fromEvidence = task.evidence
      .map((evidence) => cleanObservation(evidence).match(NO_CHANGE_CLICK_PATTERN)?.[1] ?? "")
      .filter(Boolean);

    return [...fromHistory, ...fromEvidence];
  });

  return dedupeStrings(labels)
    .sort((left, right) => problemLabelPriority(left) - problemLabelPriority(right) || left.localeCompare(right))
    .slice(0, 4);
}

function buildNoResponseSentence(detail: DashboardRunDetail): string | null {
  const labels = collectNoResponseLabels(detail);
  if (labels.length === 0) {
    return null;
  }

  if (labels.length === 1) {
    return `When I clicked "${labels[0]}", nothing clearly changed, so it was hard to tell whether that navigation was working.`;
  }

  const [firstLabel, ...otherLabels] = labels;
  return `When I clicked "${firstLabel}", nothing clearly changed, and I ran into the same problem with ${formatQuotedList(otherLabels)}.`;
}

function collectPositiveLabels(detail: DashboardRunDetail): string[] {
  const labels = detail.tasks.flatMap((task) => {
    const fromHistory = task.history
      .map((entry) => entry.result.note.match(SUCCESS_CLICK_PATTERN)?.[1] ?? "")
      .filter(Boolean);
    const fromEvidence = task.evidence
      .map((evidence) => cleanObservation(evidence).match(SUCCESS_CLICK_PATTERN)?.[1] ?? "")
      .filter(Boolean);

    return [...fromHistory, ...fromEvidence];
  });

  return dedupeStrings(labels).slice(0, 3);
}

function buildPositiveSentence(detail: DashboardRunDetail): string | null {
  const labels = collectPositiveLabels(detail);
  if (labels.length === 0) {
    const strengths = filterVisitorFacingItems(detail.report?.strengths ?? []);
    const firstStrength = strengths[0];
    return firstStrength ? ensureSentence(firstStrength) : null;
  }

  return `Some paths still worked: ${formatQuotedList(labels)} all led somewhere clear enough to keep the visit moving.`;
}

function buildAccessibilitySentence(detail: DashboardRunDetail): string | null {
  const primaryViolation = detail.accessibility?.violations?.[0];
  if (primaryViolation) {
    if (primaryViolation.id === "color-contrast" || /color contrast/i.test(primaryViolation.help)) {
      return `The accessibility scan also flagged low color contrast in ${primaryViolation.nodes} places, so some text may be harder to read than it should be.`;
    }

    return `The accessibility scan also flagged ${lowerFirst(stripTrailingPeriod(primaryViolation.help))} in ${primaryViolation.nodes} places.`;
  }

  const accessibilityObservation = filterVisitorFacingItems(detail.report?.weaknesses ?? []).find((item) =>
    item.startsWith("Accessibility:")
  );
  return accessibilityObservation ? describeObservation(accessibilityObservation) : null;
}

function buildSupportingIssueSentences(detail: DashboardRunDetail): string[] {
  const observations = filterVisitorFacingItems([
    ...detail.tasks.flatMap((task) => task.evidence),
    ...(detail.report?.weaknesses ?? []),
    ...detail.tasks.flatMap((task) => task.history.map((entry) => entry.result.note))
  ]);

  const sentences: string[] = [];
  const seen = new Set<string>();

  for (const observation of observations) {
    const sentence = describeObservation(observation);
    if (!sentence) {
      continue;
    }

    if (NO_CHANGE_CLICK_PATTERN.test(cleanObservation(observation))) {
      continue;
    }

    const key = sentence.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    sentences.push(sentence);

    if (sentences.length >= 2) {
      break;
    }
  }

  return sentences;
}

function buildFallbackSentence(detail: DashboardRunDetail): string {
  const firstTask = detail.tasks[0];
  if (firstTask && isVisitorFacingItem(firstTask.reason)) {
    return ensureSentence(firstTask.reason);
  }

  if (detail.report?.summary) {
    return ensureSentence(detail.report.summary);
  }

  return "I did not capture enough clean interaction evidence to describe the visit in more detail yet.";
}

export function buildVisitRecap(detail: DashboardRunDetail): string[] {
  const paragraphs: string[] = [];
  const intro = buildIntro(detail);
  const mainIssue = buildNoResponseSentence(detail);
  const supportingIssues = buildSupportingIssueSentences(detail);
  const positive = buildPositiveSentence(detail);
  const accessibility = buildAccessibilitySentence(detail);

  paragraphs.push(intro);

  const issueParagraph = [mainIssue, ...supportingIssues].filter(Boolean).join(" ");
  if (issueParagraph) {
    paragraphs.push(issueParagraph);
  }

  const closingParagraph = [positive, accessibility].filter(Boolean).join(" ");
  if (closingParagraph) {
    paragraphs.push(closingParagraph);
  }

  if (paragraphs.length === 1) {
    paragraphs.push(buildFallbackSentence(detail));
  }

  return paragraphs;
}

export function buildVisitSummary(detail: DashboardRunDetail): string {
  return buildVisitRecap(detail).slice(0, 2).join(" ");
}

export function humanizeAgentPerspectiveLabel(label: string | null | undefined): string | null {
  if (!label) {
    return null;
  }

  const cleaned = normalizeWhitespace(label.replace(/\s+-\s+/g, " ").replace(/\bfirst-time\b/gi, "first time"));
  return cleaned ? toTitleCaseWords(cleaned) : null;
}
