import type { PageState, TaskHistoryEntry, TaskSuite } from "../schemas/types.js";

const TASK_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "at",
  "be",
  "by",
  "check",
  "click",
  "do",
  "does",
  "every",
  "for",
  "from",
  "go",
  "how",
  "i",
  "if",
  "in",
  "interact",
  "into",
  "is",
  "it",
  "me",
  "of",
  "on",
  "or",
  "please",
  "read",
  "report",
  "step",
  "stepwise",
  "steps",
  "supplied",
  "that",
  "the",
  "them",
  "through",
  "to",
  "was",
  "were",
  "what",
  "when",
  "whether",
  "with",
  "you",
  "your"
]);

const INSTRUCTION_PATTERNS = [/\bhow to play\b/i, /\binstructions?\b/i, /\brules?\b/i, /\btutorial\b/i, /\bhow it works\b/i];
const BUTTON_COVERAGE_PATTERNS = [/\bevery button\b/i, /\ball buttons?\b/i, /\beach button\b/i, /\binteract with .*buttons?\b/i];
const ENGAGEMENT_PATTERNS = [/\bengage\b/i, /\binteract\b/i, /\binteraction\b/i, /\btry it\b/i, /\buse it\b/i];
const PLAY_ACTION_PATTERNS = [
  /\bplay\b/i,
  /\bplace bet\b/i,
  /\bbet\b/i,
  /\bstart\b/i,
  /\bspin\b/i,
  /\bdeal\b/i,
  /\blaunch\b/i,
  /\bcash ?out\b/i,
  /\bretry\b/i,
  /\brestart\b/i,
  /\bplay again\b/i,
  /\bnew game\b/i,
  /\bgo\b/i
];
const GAMEPLAY_PATTERNS = [
  /\bgame\b/i,
  /\bplay\b/i,
  /\bbet\b/i,
  /\bround\b/i,
  /\bscore\b/i,
  /\bwin\b/i,
  /\bwins\b/i,
  /\bloss\b/i,
  /\blost\b/i,
  /\blose\b/i,
  /\bdraw\b/i,
  /\bcrash\b/i,
  /\bmultiplier\b/i
];
const OUTCOME_PATTERNS = [
  /\byou win\b/i,
  /\bvictory\b/i,
  /\bwon\b/i,
  /\bwinner\b/i,
  /\blevel complete\b/i,
  /\byou lose\b/i,
  /\blost\b/i,
  /\bdefeat\b/i,
  /\bgame over\b/i,
  /\bbetter luck next time\b/i,
  /\bdraw\b/i,
  /\btie\b/i,
  /\bstalemate\b/i
];
const BROAD_NAVIGATION_PATTERNS = [/\bgo through\b/i, /\bexplore\b/i, /\bbrowse\b/i, /\breview\b/i, /\bvisit\b/i, /\bwalk through\b/i];

function hasPattern(patterns: RegExp[], value: string): boolean {
  return patterns.some((pattern) => pattern.test(value));
}

export function normalizeTaskText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function extractTaskKeywords(value: string): string[] {
  return [...new Set(
    normalizeTaskText(value)
      .toLowerCase()
      .split(/[^a-z0-9$%.+-]+/)
      .map((part) => part.trim())
      .filter((part) => part.length >= 3 && !TASK_STOP_WORDS.has(part))
  )];
}

function parseRequestedRounds(taskText: string): number | undefined {
  const explicitRoundCount = taskText.match(/\b(\d+)\s+(?:rounds?|games?|times?)\b/i);
  if (explicitRoundCount) {
    const rounds = Number(explicitRoundCount[1]);
    return Number.isFinite(rounds) && rounds > 0 ? rounds : undefined;
  }

  if (/\bhow many times\b/i.test(taskText) || /\bwins?\b.*\bloss(?:es)?\b/i.test(taskText)) {
    return 3;
  }

  if (hasPattern(GAMEPLAY_PATTERNS, taskText)) {
    return 1;
  }

  return undefined;
}

export function classifyTaskText(taskText: string): {
  broadNavigation: boolean;
  buttonCoverage: boolean;
  engagement: boolean;
  gameplay: boolean;
  instructionFocus: boolean;
  outcomeReporting: boolean;
  requestedRounds?: number;
  requireHowToPlay: boolean;
} {
  const normalized = normalizeTaskText(taskText);
  const instructionFocus = hasPattern(INSTRUCTION_PATTERNS, normalized);
  const buttonCoverage = hasPattern(BUTTON_COVERAGE_PATTERNS, normalized);
  const gameplay = hasPattern(GAMEPLAY_PATTERNS, normalized);
  const engagement = gameplay || buttonCoverage || hasPattern(ENGAGEMENT_PATTERNS, normalized);
  const outcomeReporting = /\bhow many times\b/i.test(normalized) || /\bwins?\b.*\bloss(?:es)?\b/i.test(normalized);
  const requestedRounds = gameplay ? parseRequestedRounds(normalized) : undefined;

  return {
    broadNavigation: hasPattern(BROAD_NAVIGATION_PATTERNS, normalized),
    buttonCoverage,
    engagement,
    gameplay,
    instructionFocus,
    outcomeReporting,
    ...(requestedRounds ? { requestedRounds } : {}),
    requireHowToPlay: instructionFocus
  };
}

export function inferGameplayConfigFromTask(taskText: string): { rounds?: number; requireHowToPlay?: boolean } | undefined {
  const profile = classifyTaskText(taskText);
  if (!profile.gameplay) {
    return undefined;
  }

  const gameplay = {
    ...(profile.requestedRounds ? { rounds: profile.requestedRounds } : {}),
    ...(profile.requireHowToPlay ? { requireHowToPlay: true } : {})
  };

  return Object.keys(gameplay).length > 0 ? gameplay : {};
}

export function textHasInstructionCue(value: string): boolean {
  return hasPattern(INSTRUCTION_PATTERNS, value);
}

export function textHasOutcomeCue(value: string): boolean {
  return hasPattern(OUTCOME_PATTERNS, value);
}

export function textHasPlayActionCue(value: string): boolean {
  return hasPattern(PLAY_ACTION_PATTERNS, value);
}

export function hasTaskKeywordEvidence(taskText: string, values: string[]): boolean {
  const keywords = extractTaskKeywords(taskText);
  if (keywords.length === 0) {
    return false;
  }

  const blob = normalizeTaskText(values.join(" ")).toLowerCase();
  return keywords.some((keyword) => blob.includes(keyword));
}

function countKeywordMatches(label: string, taskText: string): number {
  const keywords = extractTaskKeywords(taskText);
  if (keywords.length === 0) {
    return 0;
  }

  const normalizedLabel = normalizeTaskText(label).toLowerCase();
  return keywords.filter((keyword) => normalizedLabel.includes(keyword)).length;
}

function labelMatchesPatterns(label: string, patterns: RegExp[]): boolean {
  return hasPattern(patterns, label);
}

function isGenericUtilityLabel(label: string): boolean {
  return /^(?:home|about|contact|privacy|terms|menu|close|cancel)$/i.test(label);
}

export function isRegressiveTaskControlLabel(label: string): boolean {
  return /^(?:update|edit|change|reset|clear)\s+(?:profile|details?|settings?)$/i.test(label) ||
    /^(?:log ?out|sign ?out|back|previous)$/i.test(label);
}

export function scoreInteractiveForTask(args: {
  task: TaskSuite["tasks"][number];
  item: PageState["interactive"][number];
  history: TaskHistoryEntry[];
}): number {
  const taskProfile = classifyTaskText(args.task.goal);
  const label = normalizeTaskText(args.item.text || args.item.href || "");
  if (!label || args.item.disabled) {
    return Number.NEGATIVE_INFINITY;
  }

  const attemptedTargets = new Set(
    args.history
      .map((entry) => normalizeTaskText(entry.decision.target).toLowerCase())
      .filter(Boolean)
  );
  if (attemptedTargets.has(label.toLowerCase())) {
    return -1000;
  }

  let score = 0;
  const role = args.item.role.toLowerCase();
  const tag = args.item.tag.toLowerCase();

  if (role === "button" || tag === "button") {
    score += 18;
  } else if (role === "tab" || role === "menuitem") {
    score += 14;
  } else if (role === "link" || tag === "a") {
    score += 10;
  } else {
    score += 4;
  }

  if (taskProfile.buttonCoverage && (role === "button" || tag === "button")) {
    score += 40;
  }

  if (taskProfile.engagement && (role === "button" || tag === "button")) {
    score += 22;
  }

  if (taskProfile.instructionFocus && labelMatchesPatterns(label, INSTRUCTION_PATTERNS)) {
    score += 120;
  }

  const isInstructionLabel = labelMatchesPatterns(label, INSTRUCTION_PATTERNS);
  if ((taskProfile.gameplay || taskProfile.engagement) && labelMatchesPatterns(label, PLAY_ACTION_PATTERNS)) {
    score += taskProfile.gameplay
      ? isInstructionLabel ? (taskProfile.instructionFocus ? 36 : 6) : 110
      : 90;
  }

  if (taskProfile.gameplay && !taskProfile.instructionFocus && isInstructionLabel) {
    score += 10;
  }

  if (taskProfile.gameplay && /\$\d+|^\d+(?:\.\d+)?x$/i.test(label)) {
    score += 24;
  }

  if (taskProfile.outcomeReporting && /(?:history|results?|stats?|dashboard|recent)/i.test(label)) {
    score += 50;
  }

  const keywordMatches = countKeywordMatches(label, args.task.goal);
  score += keywordMatches * 30;

  if (taskProfile.engagement && isRegressiveTaskControlLabel(label)) {
    score -= 140;
  }

  if (isGenericUtilityLabel(label) && keywordMatches === 0) {
    score -= 18;
  }

  if (/^https?:\/\//i.test(label)) {
    score -= 24;
  }

  if (label.length <= 2 && !/\$\d+|^\d+(?:\.\d+)?x$/i.test(label)) {
    score -= 8;
  }

  return score;
}
