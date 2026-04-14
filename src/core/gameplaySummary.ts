import type { GameplaySummary, TaskHistoryEntry, TaskRunResult, TaskSuite } from "../schemas/types.js";

const HOW_TO_PLAY_PATTERNS = [/\bhow to play\b/i, /\brules?\b/i, /\binstructions?\b/i, /\btutorial\b/i, /\bhow it works\b/i];
const REPLAY_PATTERNS = [/\bplay again\b/i, /\bnew game\b/i, /\brestart\b/i, /\bretry\b/i, /\bnext round\b/i];
const ROUND_CONTEXT_PATTERNS = [
  /\bgame over\b/i,
  /\bround\b/i,
  /\bscore\b/i,
  /\bresult\b/i,
  /\bplay again\b/i,
  /\bnew game\b/i,
  /\brestart\b/i,
  /\bretry\b/i
];
const WIN_PATTERNS = [/\byou win\b/i, /\bvictory\b/i, /\bwon\b/i, /\bwinner\b/i, /\blevel complete\b/i];
const LOSS_PATTERNS = [/\byou lose\b/i, /\blost\b/i, /\bdefeat\b/i, /\bgame over\b/i, /\bbetter luck next time\b/i];
const DRAW_PATTERNS = [/\bdraw\b/i, /\btie\b/i, /\bstalemate\b/i];

type GameplayHistorySummary = {
  roundsRecorded: number;
  wins: number;
  losses: number;
  draws: number;
  howToPlayConfirmed: boolean;
  replayConfirmed: boolean;
  evidence: string[];
};

type OutcomeType = "win" | "loss" | "draw";

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function uniqueItems(items: string[], limit: number): string[] {
  return [...new Set(items.map((item) => normalizeText(item)).filter(Boolean))].slice(0, limit);
}

function buildEntryText(entry: TaskHistoryEntry): string {
  return normalizeText(
    [
      entry.title,
      entry.url,
      entry.decision.target,
      entry.result.note,
      entry.result.destinationTitle ?? "",
      entry.result.destinationUrl ?? "",
      entry.result.visibleTextSnippet ?? ""
    ].join(" ")
  );
}

function buildEntrySignature(entry: TaskHistoryEntry, outcome: OutcomeType): string {
  const rawSignature = normalizeText(
    `${outcome} ${entry.result.destinationTitle ?? ""} ${entry.result.visibleTextSnippet ?? ""} ${entry.result.note}`
  ).toLowerCase();
  return rawSignature.slice(0, 280);
}

function detectOutcome(entry: TaskHistoryEntry): OutcomeType | null {
  const text = buildEntryText(entry);
  if (!text) {
    return null;
  }

  const looksLikeRulesCopy = HOW_TO_PLAY_PATTERNS.some((pattern) => pattern.test(text));
  const hasReplayCue = REPLAY_PATTERNS.some((pattern) => pattern.test(text));
  const hasRoundContext = ROUND_CONTEXT_PATTERNS.some((pattern) => pattern.test(text));
  if (!hasRoundContext) {
    return null;
  }

  const isWin = WIN_PATTERNS.some((pattern) => pattern.test(text));
  const isLoss = LOSS_PATTERNS.some((pattern) => pattern.test(text));
  const isDraw = DRAW_PATTERNS.some((pattern) => pattern.test(text));

  if (looksLikeRulesCopy && !hasReplayCue && !(isWin || isLoss || isDraw)) {
    return null;
  }

  if (isDraw) {
    return "draw";
  }

  if (isWin && !isLoss) {
    return "win";
  }

  if (isLoss && !isWin) {
    return "loss";
  }

  return null;
}

export function isGameplayTask(task: TaskSuite["tasks"][number]): boolean {
  return Boolean(task.gameplay);
}

export function summarizeGameplayHistory(history: TaskHistoryEntry[]): GameplayHistorySummary {
  const evidence: string[] = [];
  let wins = 0;
  let losses = 0;
  let draws = 0;
  let howToPlayConfirmed = false;
  let replayConfirmed = false;
  let lastOutcomeSignature = "";
  let lastOutcomeIndex = -100;

  for (const [index, entry] of history.entries()) {
    const text = buildEntryText(entry);
    if (!text) {
      continue;
    }

    if (!howToPlayConfirmed && HOW_TO_PLAY_PATTERNS.some((pattern) => pattern.test(text))) {
      howToPlayConfirmed = true;
      evidence.push(`Visible rules or how-to-play guidance appeared during step ${entry.step}.`);
    }

    if (!replayConfirmed && REPLAY_PATTERNS.some((pattern) => pattern.test(text))) {
      replayConfirmed = true;
      evidence.push(`A replay or restart path was visible during step ${entry.step}.`);
    }

    const outcome = detectOutcome(entry);
    if (!outcome) {
      continue;
    }

    const signature = buildEntrySignature(entry, outcome);
    if (signature === lastOutcomeSignature && index - lastOutcomeIndex <= 1) {
      continue;
    }

    lastOutcomeSignature = signature;
    lastOutcomeIndex = index;
    if (outcome === "win") {
      wins += 1;
    } else if (outcome === "loss") {
      losses += 1;
    } else {
      draws += 1;
    }

    const label = outcome === "win" ? "win" : outcome === "loss" ? "loss" : "draw";
    evidence.push(`Step ${entry.step} showed a visible ${label} state.`);
  }

  return {
    roundsRecorded: wins + losses + draws,
    wins,
    losses,
    draws,
    howToPlayConfirmed,
    replayConfirmed: replayConfirmed || wins + losses + draws > 1,
    evidence: uniqueItems(evidence, 8)
  };
}

export function deriveGameplaySummary(args: {
  suite: TaskSuite;
  taskResults: TaskRunResult[];
}): GameplaySummary | undefined {
  const gameplayTasks = args.suite.tasks.filter((task) => isGameplayTask(task));
  const roundsRequested = Math.max(0, ...gameplayTasks.map((task) => task.gameplay?.rounds ?? 0));
  if (roundsRequested <= 0) {
    return undefined;
  }

  const gameplayTaskNames = new Set(gameplayTasks.map((task) => task.name));
  const roundTaskNames = new Set(gameplayTasks.filter((task) => (task.gameplay?.rounds ?? 0) > 0).map((task) => task.name));
  const relevantResults = args.taskResults.filter((task) => gameplayTaskNames.has(task.name));
  const combinedHistory = relevantResults.flatMap((task) => task.history);
  const roundHistory = args.taskResults.filter((task) => roundTaskNames.has(task.name)).flatMap((task) => task.history);
  const combinedSummary = summarizeGameplayHistory(combinedHistory);
  const roundSummary = summarizeGameplayHistory(roundHistory);
  const inconclusiveRounds = Math.max(0, roundsRequested - roundSummary.roundsRecorded);
  const blockerReason =
    relevantResults.find((task) => task.status !== "success" && normalizeText(task.reason))?.reason ??
    (inconclusiveRounds > 0 ? "The requested number of clear round outcomes was not fully observed." : "");

  const narrative =
    roundSummary.roundsRecorded >= roundsRequested
      ? `Recorded ${roundSummary.roundsRecorded}/${roundsRequested} requested rounds: ${roundSummary.wins} wins, ${roundSummary.losses} losses, and ${roundSummary.draws} draws.`
      : `Recorded ${roundSummary.roundsRecorded}/${roundsRequested} requested rounds: ${roundSummary.wins} wins, ${roundSummary.losses} losses, ${roundSummary.draws} draws, and ${inconclusiveRounds} inconclusive round(s).`;

  return {
    roundsRequested,
    roundsRecorded: roundSummary.roundsRecorded,
    wins: roundSummary.wins,
    losses: roundSummary.losses,
    draws: roundSummary.draws,
    inconclusiveRounds,
    howToPlayConfirmed: combinedSummary.howToPlayConfirmed,
    replayConfirmed: combinedSummary.replayConfirmed,
    summary: normalizeText(
      [
        narrative,
        combinedSummary.howToPlayConfirmed ? "Visible how-to-play guidance was confirmed." : "Visible how-to-play guidance was not clearly confirmed.",
        combinedSummary.replayConfirmed ? "A replay or restart path was visible." : "A replay or restart path was not clearly confirmed.",
        inconclusiveRounds > 0 && blockerReason ? blockerReason : ""
      ].join(" ")
    ),
    evidence: uniqueItems(
      [
        ...combinedSummary.evidence,
        ...roundSummary.evidence,
        combinedSummary.howToPlayConfirmed ? "How-to-play guidance was visibly encountered." : "",
        combinedSummary.replayConfirmed ? "Replay or restart controls were visibly encountered." : "",
        inconclusiveRounds > 0 && blockerReason ? blockerReason : ""
      ],
      8
    )
  };
}
