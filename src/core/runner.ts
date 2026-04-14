import fs from "node:fs";
import path from "node:path";
import {
  chromium,
  devices,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type LaunchOptions,
  type Page
} from "playwright";
import { isAuthBootstrapConfigured } from "../auth/profile.js";
import { detectAuthWall, runAuthFlowInContext } from "../auth/runner.js";
import { clampRunDurationMs, config } from "../config.js";
import { runAccessibilityAudit } from "./audit.js";
import { capturePageState } from "./pageState.js";
import { decideNextAction } from "./planner.js";
import { executeDecision, prepareClickDecision } from "./executor.js";
import { isGameplayTask, summarizeGameplayHistory } from "./gameplaySummary.js";
import { deriveSiteBrief } from "./siteBrief.js";
import { runSiteChecks } from "./siteChecks.js";
import {
  classifyTaskText,
  hasTaskKeywordEvidence,
  isRegressiveTaskControlLabel,
  textHasInstructionCue,
  textHasOutcomeCue,
  textHasPlayActionCue
} from "./taskHeuristics.js";
import { ensureDir, writeJson } from "../utils/files.js";
import { sleep } from "../utils/time.js";
import type {
  PageState,
  SiteBrief,
  SiteChecks,
  TaskHistoryEntry,
  TaskRunResult,
  TaskSuite
} from "../schemas/types.js";

export type RunOptions = {
  baseUrl: string;
  suite: TaskSuite;
  runDir: string;
  headed?: boolean;
  mobile?: boolean;
  ignoreHttpsErrors?: boolean;
  storageStatePath?: string | undefined;
  saveStorageStatePath?: string | undefined;
  maxSessionDurationMs?: number;
};

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
const AUTO_AUTH_SKIP_TASK_PATTERNS = [
  /before sign(?:-| )?up/i,
  /without (?:creating an account|signing up|registering|logging in|signing in)/i,
  /reach (?:the )?(?:sign ?up|signup|register|registration|login|sign in|sign-in) page/i
];
const STAGNATION_WINDOW = 5;

type ServerlessChromiumModule = {
  args: string[];
  executablePath: (input?: string) => Promise<string>;
  setGraphicsMode?: boolean;
  default?: {
    args: string[];
    executablePath: (input?: string) => Promise<string>;
    setGraphicsMode?: boolean;
  };
};

function shouldUseServerlessChromium(): boolean {
  const useServerless =
    process.env.USE_SERVERLESS_CHROMIUM === "true" ||
    process.env.NETLIFY_LOCAL === "true" ||
    Boolean(process.env.SITE_ID) ||
    Boolean(process.env.URL);

  console.log("chromium mode", {
    useServerless,
    USE_SERVERLESS_CHROMIUM: process.env.USE_SERVERLESS_CHROMIUM,
    NETLIFY: process.env.NETLIFY,
    NETLIFY_LOCAL: process.env.NETLIFY_LOCAL,
    SITE_ID: process.env.SITE_ID,
    URL: process.env.URL
  });

  return useServerless;
}

async function resolveLaunchOptions(options: { headed: boolean | undefined }): Promise<LaunchOptions> {
  const explicitExecutablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH?.trim();
  if (explicitExecutablePath) {
    console.log("launch options: using explicit executable path");
    return {
      executablePath: explicitExecutablePath,
      headless: options.headed ? false : config.headless
    };
  }

  if (!shouldUseServerlessChromium()) {
    console.log("launch options: using default Playwright browser");
    return {
      headless: options.headed ? false : config.headless
    };
  }

  const moduleName = "@sparticuz/chromium";
  const imported = (await import(moduleName)) as ServerlessChromiumModule;
  const serverlessChromium = imported.default ?? imported;
  const location = process.env.SPARTICUZ_CHROMIUM_LOCATION?.trim() || undefined;

  if ("setGraphicsMode" in serverlessChromium) {
    serverlessChromium.setGraphicsMode = false;
  }

  console.log("launch options: using serverless chromium", {
    location: location ?? null
  });

  return {
    args: serverlessChromium.args,
    executablePath: await serverlessChromium.executablePath(location),
    headless: true
  };
}

function cleanErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const withoutAnsi = message.replace(/\u001b\[[0-9;]*m/g, "");
  return withoutAnsi.replace(/\s+/g, " ").trim() || "Unknown error";
}

function resolveLocalPath(filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
}

function summarizeLocalPath(filePath: string): string {
  const relativePath = path.relative(process.cwd(), filePath);
  return relativePath && relativePath !== "" && !relativePath.startsWith("..")
    ? relativePath
    : path.basename(filePath);
}

function taskAllowsAutoAuth(taskGoal: string): boolean {
  return !AUTO_AUTH_SKIP_TASK_PATTERNS.some((pattern) => pattern.test(taskGoal));
}

function buildInteractionScreenshotName(args: {
  taskIndex: number;
  step: number;
  phase: "before" | "after";
}): string {
  return `task-${String(args.taskIndex + 1).padStart(2, "0")}-step-${String(args.step).padStart(2, "0")}-${args.phase}.png`;
}

async function captureInteractionScreenshot(args: {
  page: Page;
  runDir: string;
  taskName: string;
  taskIndex: number;
  step: number;
  phase: "before" | "after";
  rawEvents: unknown[];
}): Promise<string | undefined> {
  const fileName = buildInteractionScreenshotName({
    taskIndex: args.taskIndex,
    step: args.step,
    phase: args.phase
  });
  const filePath = path.join(args.runDir, fileName);

  try {
    await args.page.screenshot({
      path: filePath,
      animations: "disabled"
    });
    return fileName;
  } catch (error) {
    args.rawEvents.push({
      type: "screenshot_error",
      time: new Date().toISOString(),
      task: args.taskName,
      step: args.step,
      phase: args.phase,
      path: fileName,
      note: `Failed to capture ${args.phase} screenshot for task step ${args.step}: ${cleanErrorMessage(error)}`
    });
    return undefined;
  }
}

function collectTaskStrings(
  history: TaskHistoryEntry[],
  finalUrl: string,
  finalTitle: string,
  taskNotes: string[]
): string[] {
  return [
    finalUrl,
    finalTitle,
    ...taskNotes,
    ...history.flatMap((entry) => [
      entry.url,
      entry.title,
      entry.decision.target,
      entry.decision.expectation,
      entry.result.note,
      entry.result.destinationUrl ?? "",
      entry.result.destinationTitle ?? "",
      entry.result.visibleTextSnippet ?? ""
    ])
  ].filter(Boolean);
}

function matchesAnyPattern(values: string[], patterns: RegExp[]): boolean {
  return values.some((value) => patterns.some((pattern) => pattern.test(value)));
}

async function navigateToBaseUrl(args: {
  page: Page;
  baseUrl: string;
  rawEvents: unknown[];
  phase: "initial" | "task_reset";
  taskName?: string;
  taskNotes?: string[];
}): Promise<boolean> {
  try {
    await args.page.goto(args.baseUrl, { waitUntil: "domcontentloaded" });
    return true;
  } catch (error) {
    const note = `Navigation to '${args.baseUrl}' failed: ${cleanErrorMessage(error)}`;

    args.rawEvents.push({
      type: "navigation_error",
      time: new Date().toISOString(),
      phase: args.phase,
      task: args.taskName,
      url: args.baseUrl,
      currentUrl: args.page.url(),
      note
    });

    if (args.taskNotes) {
      args.taskNotes.push(note);
    }

    return false;
  }
}

function inferTaskStatus(
  history: TaskHistoryEntry[],
  finalUrl: string,
  finalTitle: string,
  task: TaskSuite["tasks"][number],
  taskNotes: string[] = []
): { status: TaskRunResult["status"]; reason: string } {
  const taskProfile = classifyTaskText(task.goal);
  const taskStrings = collectTaskStrings(history, finalUrl, finalTitle, taskNotes);
  const taskEvidenceBlob = taskStrings.join(" ");
  const successfulActions = history.filter((entry) => entry.result.success);
  const successfulClicks = history.filter((entry) => entry.decision.action === "click" && entry.result.success);
  const isSetupOrGateControl = (target: string): boolean =>
    /(?:create|register|sign ?up|log ?in|continue|enter|unlock|access|submit|profile)/i.test(target);
  const meaningfulEngagementClicks = successfulClicks.filter((entry) => {
    const target = entry.decision.target.trim();
    const engagementText = [
      target,
      entry.result.note,
      entry.result.visibleTextSnippet ?? "",
      entry.result.destinationTitle ?? ""
    ].join(" ");

    if (textHasPlayActionCue(engagementText)) {
      return true;
    }

    if (isRegressiveTaskControlLabel(target)) {
      return false;
    }

    if (isSetupOrGateControl(target) && !textHasPlayActionCue(engagementText)) {
      return false;
    }

    return Boolean(entry.result.stateChanged) && target.length > 0;
  });
  const failedClicks = history.filter((entry) => entry.decision.action === "click" && !entry.result.success);
  const distinctTargets = new Set(successfulClicks.map((entry) => entry.decision.target.toLowerCase()).filter(Boolean));
  const distinctDestinations = new Set(
    successfulClicks
      .map((entry) => entry.result.destinationUrl ?? entry.url)
      .map((value) => value.replace(/[?#].*$/, ""))
      .filter(Boolean)
  );
  const visibleChanges = successfulClicks.filter((entry) => entry.result.stateChanged);
  const blockedByInterstitial = matchesAnyPattern(taskStrings, INTERSTITIAL_PATTERNS);
  const timeLimited = matchesAnyPattern(taskStrings, TIME_LIMIT_PATTERNS);
  const hasGoalAlignedEvidence = taskProfile.broadNavigation || hasTaskKeywordEvidence(task.goal, taskStrings);
  const extractSucceeded = history.some((entry) => entry.decision.action === "extract" && entry.result.success);
  const sawEngagementOpportunity = history.some((entry) => {
    const visibleText = [
      entry.result.visibleTextSnippet ?? "",
      entry.result.note,
      entry.result.destinationTitle ?? "",
      entry.result.destinationUrl ?? ""
    ].join(" ");

    return textHasPlayActionCue(visibleText) ||
      /(?:bet amount|target multiplier|cash out|play again|recent crashes|how to play|round|multiplier)/i.test(visibleText);
  });

  if (isGameplayTask(task)) {
    const gameplay = summarizeGameplayHistory(history);
    const gameplayText = taskEvidenceBlob;
    const reachedPlayableState = history.some(
      (entry) =>
        entry.result.success &&
        (Boolean(entry.result.stateChanged) ||
          /(?:\bplay\b|\bstart\b|\bnew game\b|\bplay again\b|\bretry\b|\brestart\b)/i.test(
            `${entry.decision.target} ${entry.result.note} ${entry.result.visibleTextSnippet ?? ""}`
          ))
    );

    if (task.gameplay?.rounds) {
      const requestedRounds = task.gameplay.rounds;
      const recordedSummary = `${gameplay.wins} win(s), ${gameplay.losses} loss(es), ${gameplay.draws} draw(s)`;

      if (gameplay.roundsRecorded >= requestedRounds) {
        return {
          status: "success",
          reason: `Recorded ${gameplay.roundsRecorded}/${requestedRounds} requested round outcome(s): ${recordedSummary}.`
        };
      }

      if (gameplay.roundsRecorded > 0) {
        return {
          status: "partial_success",
          reason: `Recorded only ${gameplay.roundsRecorded}/${requestedRounds} requested round outcome(s): ${recordedSummary}. ${taskNotes[0] ?? "Further rounds stayed blocked or inconclusive."}`.trim()
        };
      }

      if (taskNotes.length > 0) {
        return { status: "failed", reason: taskNotes[0]! };
      }

      return {
        status: "failed",
        reason: /(?:play|game|round|retry|restart)/i.test(gameplayText)
          ? "The game path was reached, but no clear round outcome could be recorded."
          : "The agent could not reach a clearly playable round state."
      };
    }

    if (task.gameplay?.requireHowToPlay) {
      if (gameplay.howToPlayConfirmed && reachedPlayableState) {
        return {
          status: "success",
          reason: "Visible how-to-play guidance was confirmed and the agent reached a playable game state."
        };
      }

      if (gameplay.howToPlayConfirmed || reachedPlayableState) {
        return {
          status: "partial_success",
          reason: gameplay.howToPlayConfirmed
            ? "The visible rules or how-to-play guidance appeared, but the path into a clearly playable state stayed under-validated."
            : "The agent reached a playable-looking state, but the visible rules or how-to-play guidance were not clearly confirmed."
        };
      }

      if (taskNotes.length > 0) {
        return { status: "failed", reason: taskNotes[0]! };
      }

      return {
        status: "failed",
        reason: "The agent could not clearly confirm the visible how-to-play guidance or reach a stable playable state."
      };
    }

    if (gameplay.roundsRecorded > 0 && reachedPlayableState) {
      return {
        status: "success",
        reason: `Recorded ${gameplay.roundsRecorded} visible round outcome(s): ${gameplay.wins} win(s), ${gameplay.losses} loss(es), ${gameplay.draws} draw(s).`
      };
    }

    if (reachedPlayableState || gameplay.howToPlayConfirmed || textHasOutcomeCue(gameplayText)) {
      return {
        status: "partial_success",
        reason: gameplay.howToPlayConfirmed
          ? "Visible gameplay guidance appeared and the agent got partway through the playable flow, but the requested outcome evidence stayed incomplete."
          : "The agent reached part of the gameplay flow, but the visible outcome evidence stayed incomplete."
      };
    }

    if (taskNotes.length > 0) {
      return { status: "failed", reason: taskNotes[0]! };
    }

    return {
      status: "failed",
      reason: "The agent could not clearly reach a playable state or capture a visible outcome for this gameplay task."
    };
  }

  if (blockedByInterstitial) {
    return {
      status: "failed",
      reason: "A security or verification interstitial blocked the destination page before the agent could fairly validate this navigation path."
    };
  }

  if (taskProfile.instructionFocus) {
    if (taskProfile.engagement) {
      if (textHasInstructionCue(taskEvidenceBlob) && meaningfulEngagementClicks.length > 0) {
        return {
          status: "success",
          reason: "The run confirmed the visible instructions and also used live on-page controls instead of stopping at the instruction copy alone."
        };
      }

      if (textHasInstructionCue(taskEvidenceBlob) && (extractSucceeded || successfulActions.length > 0 || sawEngagementOpportunity)) {
        return {
          status: "partial_success",
          reason: sawEngagementOpportunity
            ? "The run confirmed the visible instructions and reached an interactive state, but it did not capture enough direct engagement evidence from the live controls."
            : "The run confirmed the visible instructions, but it did not gather direct evidence of meaningful engagement beyond that."
        };
      }
    }

    if (textHasInstructionCue(taskEvidenceBlob) && (extractSucceeded || successfulActions.length > 0)) {
      return {
        status: "success",
        reason: "The run captured visible rules, instructions, or how-to-play guidance that matched this task."
      };
    }

    if (failedClicks.length > 0) {
      return { status: "failed", reason: failedClicks[0]!.result.note };
    }

    if (taskNotes.length > 0) {
      return { status: "failed", reason: taskNotes[0]! };
    }

    return {
      status: "failed",
      reason: "The run did not capture clear visible instructions or rules that matched this task."
    };
  }

  if (taskProfile.buttonCoverage) {
    if (distinctTargets.size >= 5) {
      return {
        status: "success",
        reason: `The agent interacted with ${distinctTargets.size} distinct visible controls and recorded their visible responses step by step.`
      };
    }

    if (distinctTargets.size >= 2) {
      return {
        status: "partial_success",
        reason: `The agent interacted with ${distinctTargets.size} distinct visible controls, but did not capture broad enough button coverage to call the task complete.`
      };
    }

    if (failedClicks.length > 0) {
      return { status: "failed", reason: failedClicks[0]!.result.note };
    }

    return {
      status: "failed",
      reason: "The run did not gather enough button-by-button interaction evidence to support this task."
    };
  }

  if (!hasGoalAlignedEvidence && !taskProfile.broadNavigation) {
    if (failedClicks.length > 0) {
      return { status: "failed", reason: failedClicks[0]!.result.note };
    }

    if (taskNotes.length > 0) {
      return { status: "failed", reason: taskNotes[0]! };
    }

    return {
      status: "failed",
      reason: "The run did not gather enough task-specific evidence to confirm this requested path."
    };
  }

  if (distinctTargets.size >= 3 && visibleChanges.length >= 2 && distinctDestinations.size >= 2 && failedClicks.length === 0) {
    return {
      status: "success",
      reason: "Multiple visible links, tabs, or buttons opened clear destination pages or visible state changes as expected."
    };
  }

  if (timeLimited && successfulClicks.length > 0) {
    return {
      status: "partial_success",
      reason: "The agent validated some visible destinations, but the run ended before it could cover more of this navigation path."
    };
  }

  if (distinctTargets.size >= 2 && visibleChanges.length >= 1) {
    return {
      status: "partial_success",
      reason: "Several visible destinations responded correctly, but not enough unique paths were validated to mark the whole task complete."
    };
  }

  if (failedClicks.length > 0) {
    return { status: "failed", reason: failedClicks[0]!.result.note };
  }

  if (taskNotes.length > 0) {
    return { status: "failed", reason: taskNotes[0]! };
  }

  return {
    status: "failed",
    reason: "The agent did not gather enough visible evidence to confirm whether this navigation path worked as expected."
  };
}

function buildPageSignature(pageState: PageState): string {
  const interactiveSummary = pageState.interactive
    .slice(0, 8)
    .map((item) => `${item.role}:${item.text}:${item.disabled ? "disabled" : "enabled"}`)
    .join("|");

  return [
    pageState.url,
    pageState.title,
    pageState.visibleText.slice(0, 900),
    interactiveSummary
  ].join("::");
}

function shouldStopForStagnation(args: {
  history: TaskHistoryEntry[];
  pageSignature: string;
  pageSignatures: string[];
}): boolean {
  if (args.history.length < STAGNATION_WINDOW || args.pageSignatures.length < STAGNATION_WINDOW) {
    return false;
  }

  const recentEntries = args.history.slice(-STAGNATION_WINDOW);
  const recentSignatures = args.pageSignatures.slice(-STAGNATION_WINDOW);
  const repeatedPage = recentSignatures.every((signature) => signature === args.pageSignature);
  const stalledAttempts = recentEntries.every(
    (entry) =>
      entry.decision.action === "wait" ||
      entry.decision.friction === "high" ||
      entry.result.success === false
  );

  return repeatedPage && stalledAttempts;
}

function shouldPauseAfterStep(args: {
  decisionAction: TaskHistoryEntry["decision"]["action"];
  resultSuccess: boolean;
  stopped: boolean;
}): boolean {
  if (args.stopped) {
    return false;
  }

  if (args.decisionAction === "wait") {
    return false;
  }

  if (!args.resultSuccess) {
    return false;
  }

  return true;
}

function derivePerTaskStepCap(totalTasks: number): number {
  if (totalTasks <= 1) {
    return config.maxStepsPerTask;
  }

  return Math.max(8, Math.min(config.maxStepsPerTask, Math.ceil((config.maxStepsPerTask * 2) / totalTasks)));
}

function shouldPreserveCoverageForRemainingTasks(args: {
  remainingSessionMs: number;
  remainingTasksAfterCurrent: number;
  minimumUsefulStepWindowMs: number;
}): boolean {
  if (args.remainingTasksAfterCurrent <= 0) {
    return false;
  }

  const futureTaskReserveMs = args.remainingTasksAfterCurrent * Math.max(8000, Math.min(20000, args.minimumUsefulStepWindowMs));
  return args.remainingSessionMs < config.postRunAuditReserveMs + args.minimumUsefulStepWindowMs + futureTaskReserveMs;
}

export async function runTaskSuite(options: RunOptions): Promise<{
  rawEvents: unknown[];
  taskResults: TaskRunResult[];
  accessibility: Awaited<ReturnType<typeof runAccessibilityAudit>>;
  siteChecks: SiteChecks;
  siteBrief: SiteBrief | null;
  browserTimezone: string;
  deviceTimezone: string;
}> {
  const executionBudgetMs = clampRunDurationMs(options.maxSessionDurationMs ?? config.maxSessionDurationMs);
  const executionBudgetSeconds = Math.round(executionBudgetMs / 1000);
  const sessionDeadline = Date.now() + executionBudgetMs;
  const minimumUsefulStepWindowMs = Math.min(
    30000,
    Math.max(12000, config.navigationTimeoutMs + 2000)
  );
  const storageStatePath = options.storageStatePath ? resolveLocalPath(options.storageStatePath) : undefined;
  const saveStorageStatePath = options.saveStorageStatePath ? resolveLocalPath(options.saveStorageStatePath) : undefined;
  const contextOptions: BrowserContextOptions = options.mobile
    ? {
        ...devices["iPhone 13"],
        viewport: config.mobileViewport,
        ignoreHTTPSErrors: Boolean(options.ignoreHttpsErrors),
        timezoneId: config.deviceTimezone
      }
    : {
        viewport: config.desktopViewport,
        ignoreHTTPSErrors: Boolean(options.ignoreHttpsErrors),
        timezoneId: config.deviceTimezone,
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
      };
  if (storageStatePath) {
    contextOptions.storageState = storageStatePath;
  }

  const rawEvents: unknown[] = [];
  const taskResults: TaskRunResult[] = [];
  const perTaskStepCap = derivePerTaskStepCap(options.suite.tasks.length);
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;
  let browserTimezone = config.deviceTimezone;
  let accessibility: Awaited<ReturnType<typeof runAccessibilityAudit>> = {
    violations: [],
    error: "Accessibility audit did not run because the session ended before it reached the audit phase."
  };
  let siteBrief: SiteBrief | null = null;
  let siteChecks: SiteChecks = {
    generatedAt: new Date().toISOString(),
    baseUrl: options.baseUrl,
    finalResolvedUrl: null,
    coverage: {
      performance: { status: "blocked", summary: "Performance checks did not run.", evidence: [], blockers: [] },
      seo: { status: "blocked", summary: "SEO checks did not run.", evidence: [], blockers: [] },
      uiux: { status: "inferred", summary: "UI and UX coverage relies on the interaction audit only.", evidence: [], blockers: [] },
      security: { status: "blocked", summary: "Security checks did not run.", evidence: [], blockers: [] },
      technicalHealth: { status: "inferred", summary: "Technical health relies on runtime signals only.", evidence: [], blockers: [] },
      mobileOptimization: { status: "blocked", summary: "Mobile checks did not run.", evidence: [], blockers: [] },
      contentQuality: { status: "blocked", summary: "Content checks did not run.", evidence: [], blockers: [] },
      cro: { status: "inferred", summary: "CRO coverage relies on the interaction audit only.", evidence: [], blockers: [] }
    },
    performance: {
      desktop: null,
      mobile: null,
      failedRequestCount: 0,
      imageFailureCount: 0,
      apiFailureCount: 0,
      navigationErrorCount: 0,
      stalledInteractionCount: 0,
      evidence: []
    },
    seo: {
      robotsTxt: { url: new URL("/robots.txt", options.baseUrl).toString(), ok: false, statusCode: null, note: "Checks did not run." },
      sitemap: { url: new URL("/sitemap.xml", options.baseUrl).toString(), ok: false, statusCode: null, note: "Checks did not run." },
      brokenLinkCount: 0,
      checkedLinkCount: 0,
      brokenLinks: [],
      evidence: []
    },
    security: {
      https: options.baseUrl.startsWith("https://"),
      secureTransportVerified: false,
      initialStatusCode: null,
      securityHeaders: [],
      missingHeaders: [],
      evidence: []
    },
    technicalHealth: {
      framework: null,
      consoleErrorCount: 0,
      consoleWarningCount: 0,
      pageErrorCount: 0,
      apiFailureCount: 0,
      evidence: []
    },
    mobileOptimization: {
      desktop: null,
      mobile: null,
      responsiveVerdict: "blocked",
      evidence: []
    },
    contentQuality: {
      readabilityScore: null,
      readabilityLabel: "Blocked",
      wordCount: 0,
      longParagraphCount: 0,
      mediaCount: 0,
      evidence: []
    },
    cro: {
      ctaCount: 0,
      primaryCtas: [],
      formCount: 0,
      submitControlCount: 0,
      trustSignalCount: 0,
      evidence: []
    }
  };

  try {
    if (storageStatePath) {
      const storageStateLabel = summarizeLocalPath(storageStatePath);
      if (!fs.existsSync(storageStatePath)) {
        throw new Error(`Configured storage state file '${storageStateLabel}' was not found.`);
      }

      rawEvents.push({
        type: "storage_state_load",
        time: new Date().toISOString(),
        path: storageStateLabel,
        note: `Loading Playwright storage state from '${storageStateLabel}'.`
      });
    }

    browser = await chromium.launch(await resolveLaunchOptions({ headed: options.headed }));
    context = await browser.newContext(contextOptions);
    page = await context.newPage();
    page.setDefaultNavigationTimeout(config.navigationTimeoutMs);
    page.setDefaultTimeout(config.navigationTimeoutMs);

    browserTimezone =
      (await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone).catch(() => config.deviceTimezone)) ||
      config.deviceTimezone;
    rawEvents.push({
      type: "execution_budget",
      time: new Date().toISOString(),
      budgetSeconds: executionBudgetSeconds,
      note: `Browser execution budget is capped at ${executionBudgetSeconds} seconds for this run.`
    });
    rawEvents.push({
      type: "timezone_sync",
      time: new Date().toISOString(),
      deviceTimezone: config.deviceTimezone,
      browserTimezone,
      note:
        browserTimezone === config.deviceTimezone
          ? `Browser timezone was synchronized to ${browserTimezone}.`
          : `Browser reported ${browserTimezone} while the device timezone is ${config.deviceTimezone}.`
    });

    page.on("console", (msg: { type(): string; text(): string }) => {
      rawEvents.push({ type: "console", level: msg.type(), text: msg.text(), time: new Date().toISOString() });
    });

    page.on("pageerror", (error: Error) => {
      rawEvents.push({ type: "pageerror", text: error.message, time: new Date().toISOString() });
    });

    page.on("requestfailed", (request: { url(): string; method(): string; failure(): { errorText?: string } | null }) => {
      rawEvents.push({
        type: "requestfailed",
        url: request.url(),
        method: request.method(),
        failure: request.failure()?.errorText ?? "unknown",
        time: new Date().toISOString()
      });
    });

    await navigateToBaseUrl({
      page,
      baseUrl: options.baseUrl,
      rawEvents,
      phase: "initial"
    });

    const initialPageState = await capturePageState(page);
    const siteBriefResolution = await deriveSiteBrief({ pageState: initialPageState });
    siteBrief = siteBriefResolution.siteBrief;
    rawEvents.push({
      type: "site_brief",
      time: new Date().toISOString(),
      summary: siteBrief.summary,
      sitePurpose: siteBrief.sitePurpose,
      intendedUserActions: siteBrief.intendedUserActions,
      evidence: siteBrief.evidence,
      note: siteBriefResolution.fallbackReason
        ? `The site brief fell back to a deterministic summary after the model-based comprehension step failed: ${siteBriefResolution.fallbackReason}`
        : "The run generated an upfront site brief before the accepted tasks started."
    });
    const authBootstrapConfigured = isAuthBootstrapConfigured();
    let autoAuthAttempted = false;

    for (const [index, task] of options.suite.tasks.entries()) {
      if (Date.now() >= sessionDeadline) {
        rawEvents.push({
          type: "session_timeout",
          time: new Date().toISOString(),
          note: `Session reached its ${executionBudgetSeconds}-second execution budget before the next task started.`
        });
        break;
      }

      const history: TaskHistoryEntry[] = [];
      const taskNotes: string[] = [];
      const pageSignatures: string[] = [];

      const resetSucceeded = await navigateToBaseUrl({
        page,
        baseUrl: options.baseUrl,
        rawEvents,
        phase: "task_reset",
        taskName: task.name,
        taskNotes
      });
      if (resetSucceeded) {
        await sleep(config.actionDelayMs);
      }

      for (let step = 1; step <= perTaskStepCap; step += 1) {
        const remainingSessionMs = sessionDeadline - Date.now();
        if (remainingSessionMs <= 0) {
          rawEvents.push({
            type: "session_timeout",
            time: new Date().toISOString(),
            task: task.name,
            note: `Session reached its ${executionBudgetSeconds}-second execution budget before the next action.`
          });
          break;
        }
        if (remainingSessionMs < minimumUsefulStepWindowMs + config.postRunAuditReserveMs) {
          rawEvents.push({
            type: "session_timeout",
            time: new Date().toISOString(),
            task: task.name,
            note: `Session stopped with ${Math.ceil(remainingSessionMs / 1000)} seconds left to preserve time for supplemental site checks and final analysis.`
          });
          taskNotes.push("The agent stopped exploring because the remaining session time was too short for another meaningful interaction while still preserving post-run verification time.");
          break;
        }
        if (
          shouldPreserveCoverageForRemainingTasks({
            remainingSessionMs,
            remainingTasksAfterCurrent: options.suite.tasks.length - index - 1,
            minimumUsefulStepWindowMs
          })
        ) {
          rawEvents.push({
            type: "session_timeout",
            time: new Date().toISOString(),
            task: task.name,
            note: `This task stopped early because the remaining session time needed to be preserved for the remaining coverage lanes and supplemental site checks.`
          });
          taskNotes.push(
            "The agent stopped this task because the remaining session time needed to be preserved for the remaining coverage lanes and supplemental site checks."
          );
          break;
        }

        const pageState = await capturePageState(page);
        if (authBootstrapConfigured && !autoAuthAttempted && context && taskAllowsAutoAuth(task.goal)) {
          const authWall = await detectAuthWall(page);
          const autoAuthBudgetMs = Math.max(0, remainingSessionMs - config.postRunAuditReserveMs);

          if (authWall.required && autoAuthBudgetMs >= Math.max(20000, minimumUsefulStepWindowMs)) {
            autoAuthAttempted = true;
            rawEvents.push({
              type: "auto_auth_start",
              time: new Date().toISOString(),
              task: task.name,
              step,
              url: pageState.url,
              authKind: authWall.kind,
              note: `Detected an auth wall during task execution and will attempt automatic signup/login: ${authWall.reason}`
            });

            const authExecution = await runAuthFlowInContext({
              page,
              context,
              baseUrl: options.baseUrl,
              runDir: options.runDir,
              accessUrl: pageState.url,
              timeoutMs: autoAuthBudgetMs,
              headed: Boolean(options.headed),
              mobile: Boolean(options.mobile)
            });

            rawEvents.push({
              type: "auto_auth_result",
              time: new Date().toISOString(),
              task: task.name,
              step,
              status: authExecution.status,
              accessConfirmed: authExecution.accessConfirmed,
              accountEmail: authExecution.accountEmail || null,
              verificationMethod: authExecution.verificationMethod,
              note:
                authExecution.status === "failed"
                  ? `Automatic signup/login failed: ${authExecution.error ?? "Unknown auth error"}`
                  : `Automatic signup/login completed with status '${authExecution.status}'.`
            });

            if (authExecution.status !== "failed") {
              if (authExecution.accessConfirmed) {
                const refreshedPageState = await capturePageState(page);
                const refreshedSiteBriefResolution = await deriveSiteBrief({ pageState: refreshedPageState });
                siteBrief = refreshedSiteBriefResolution.siteBrief;
                rawEvents.push({
                  type: "site_brief_refresh",
                  time: new Date().toISOString(),
                  summary: siteBrief.summary,
                  sitePurpose: siteBrief.sitePurpose,
                  intendedUserActions: siteBrief.intendedUserActions,
                  evidence: siteBrief.evidence,
                  note: refreshedSiteBriefResolution.fallbackReason
                    ? `The site brief was refreshed after automatic auth using a deterministic fallback: ${refreshedSiteBriefResolution.fallbackReason}`
                    : "The site brief was refreshed after the automatic auth recovery succeeded."
                });
              }

              await sleep(config.actionDelayMs);
              continue;
            }

            taskNotes.push(`Automatic signup/login failed: ${authExecution.error ?? authWall.reason}`);
          }
        }

        const pageSignature = buildPageSignature(pageState);
        const shouldStop = shouldStopForStagnation({
          history,
          pageSignature,
          pageSignatures
        });
        const planning = shouldStop
          ? {
              decision: {
                thought: "The page has remained effectively unchanged across repeated high-friction or no-progress steps even after extended follow-up attempts.",
                stepNumber: null,
                instructionQuote: "",
                action: "stop" as const,
                target: "",
                text: "",
                expectation: "Stop this task and record that the page appears stalled or blocked.",
                friction: "high" as const
              }
            }
          : await decideNextAction({
              suite: options.suite,
              taskIndex: index,
              siteBrief: siteBrief ?? {
                sitePurpose: "The site purpose could not be confidently summarized before task execution began.",
                intendedUserActions: [],
                summary: "The site purpose could not be confidently summarized before task execution began.",
                evidence: []
              },
              pageState,
              history,
              remainingSeconds: Math.max(1, Math.floor((sessionDeadline - Date.now()) / 1000))
            });
        const decision = planning.decision;

        if (planning.fallbackReason) {
          rawEvents.push({
            type: "planner_fallback",
            time: new Date().toISOString(),
            task: task.name,
            step,
            url: pageState.url,
            note: `Planner request did not finish cleanly, so a deterministic fallback action was used (${decision.action}${decision.target ? ` '${decision.target}'` : ""}): ${planning.fallbackReason}`
          });
        }

        const preparedClickResolution =
          !shouldStop && decision.action === "click"
            ? await prepareClickDecision(page, decision)
            : null;
        const beforeScreenshotPath =
          decision.action === "click"
            ? await captureInteractionScreenshot({
                page,
                runDir: options.runDir,
                taskName: task.name,
                taskIndex: index,
                step,
                phase: "before",
                rawEvents
              })
            : undefined;
        const result = shouldStop
          ? {
              success: true,
              stop: true,
              note: "Stopped after repeated unchanged page states with no meaningful progress even after extended follow-up attempts."
            }
          : decision.action === "click" && preparedClickResolution && !preparedClickResolution.preparedClick
            ? {
                success: false,
                note: preparedClickResolution.note ?? `Could not find clickable element for '${decision.target.trim()}'`
              }
            : await executeDecision(page, decision, preparedClickResolution?.preparedClick);
        const afterScreenshotPath =
          decision.action === "click"
            ? await captureInteractionScreenshot({
                page,
                runDir: options.runDir,
                taskName: task.name,
                taskIndex: index,
                step,
                phase: "after",
                rawEvents
              })
            : undefined;
        const resultWithArtifacts = {
          ...result,
          ...(beforeScreenshotPath ? { beforeScreenshotPath } : {}),
          ...(afterScreenshotPath ? { afterScreenshotPath } : {})
        };
        const entry: TaskHistoryEntry = {
          time: new Date().toISOString(),
          task: task.name,
          step,
          url: page.url(),
          title: await page.title().catch(() => ""),
          decision,
          result: resultWithArtifacts
        };

        history.push(entry);
        pageSignatures.push(pageSignature);
        rawEvents.push({ type: "interaction", ...entry });

        if (result.stop || decision.action === "stop") {
          break;
        }

        if (shouldPauseAfterStep({
          decisionAction: decision.action,
          resultSuccess: result.success,
          stopped: Boolean(result.stop)
        })) {
          await sleep(config.actionDelayMs);
        }
      }

      const finalUrl = page.url();
      const finalTitle = await page.title().catch(() => "");
      const inferred = inferTaskStatus(history, finalUrl, finalTitle, task, taskNotes);

      taskResults.push({
        name: task.name,
        status: inferred.status,
        finalUrl,
        finalTitle,
        history,
        reason: inferred.reason
      });

      if (Date.now() >= sessionDeadline) {
        break;
      }
    }

    const currentStorageState = context ? await context.storageState().catch(() => undefined) : undefined;
    const remainingSiteChecksBudgetMs = Math.max(0, sessionDeadline - Date.now());
    siteChecks = await runSiteChecks({
      browser,
      baseUrl: options.baseUrl,
      ignoreHttpsErrors: Boolean(options.ignoreHttpsErrors),
      browserTimezone,
      storageState: currentStorageState,
      rawEvents,
      taskResults,
      budgetMs: remainingSiteChecksBudgetMs
    });

    const remainingAccessibilityBudgetMs = sessionDeadline - Date.now();
    accessibility =
      remainingAccessibilityBudgetMs < 5000
        ? {
            violations: [],
            error: `Accessibility audit skipped because the ${executionBudgetSeconds}-second browser execution budget was exhausted.`
          }
        : await runAccessibilityAudit(page).catch((error) => ({
            violations: [],
            error: `Accessibility audit failed: ${cleanErrorMessage(error)}`
          }));
  } catch (error) {
    const note = `Runner recovered from an unexpected error and will finalize the report with partial evidence: ${cleanErrorMessage(error)}`;
    rawEvents.push({
      type: "runner_error",
      time: new Date().toISOString(),
      note
    });

    accessibility = {
      violations: accessibility.violations,
      error: `Accessibility audit could not be completed because the session ended early: ${cleanErrorMessage(error)}`
    };
  } finally {
    if (saveStorageStatePath) {
      const storageStateLabel = summarizeLocalPath(saveStorageStatePath);
      if (!context) {
        rawEvents.push({
          type: "storage_state_save_error",
          time: new Date().toISOString(),
          path: storageStateLabel,
          note: `Requested storage state save to '${storageStateLabel}', but no browser context was available.`
        });
      } else {
        try {
          ensureDir(path.dirname(saveStorageStatePath));
          await context.storageState({ path: saveStorageStatePath });
          rawEvents.push({
            type: "storage_state_save",
            time: new Date().toISOString(),
            path: storageStateLabel,
            note: `Saved Playwright storage state to '${storageStateLabel}'.`
          });
        } catch (error) {
          rawEvents.push({
            type: "storage_state_save_error",
            time: new Date().toISOString(),
            path: storageStateLabel,
            note: `Failed to save Playwright storage state to '${storageStateLabel}': ${cleanErrorMessage(error)}`
          });
        }
      }
    }

    writeJson(path.join(options.runDir, "raw-events.json"), rawEvents);
    writeJson(path.join(options.runDir, "task-results.json"), taskResults);
    writeJson(path.join(options.runDir, "accessibility.json"), accessibility);
    writeJson(path.join(options.runDir, "site-checks.json"), siteChecks);

    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
  }

  return {
    rawEvents,
    taskResults,
    accessibility,
    siteChecks,
    siteBrief,
    browserTimezone,
    deviceTimezone: config.deviceTimezone
  };
}