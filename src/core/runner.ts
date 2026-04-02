import path from "node:path";
import { chromium, devices, type Browser, type BrowserContext, type BrowserContextOptions, type LaunchOptions, type Page } from "playwright";
import { clampRunDurationMs, config } from "../config.js";
import { runAccessibilityAudit } from "./audit.js";
import { capturePageState } from "./pageState.js";
import { decideNextAction } from "./planner.js";
import { executeDecision } from "./executor.js";
import { writeJson } from "../utils/files.js";
import { sleep } from "../utils/time.js";
import type { PageState, TaskHistoryEntry, TaskRunResult, TaskSuite } from "../schemas/types.js";

export type RunOptions = {
  baseUrl: string;
  suite: TaskSuite;
  runDir: string;
  headed?: boolean;
  mobile?: boolean;
  ignoreHttpsErrors?: boolean;
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
  return process.env.USE_SERVERLESS_CHROMIUM === "true" || process.env.NETLIFY === "true";
}

async function resolveLaunchOptions(options: { headed: boolean | undefined }): Promise<LaunchOptions> {
  const explicitExecutablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH?.trim();
  if (explicitExecutablePath) {
    return {
      executablePath: explicitExecutablePath,
      headless: options.headed ? false : config.headless
    };
  }

  if (!shouldUseServerlessChromium()) {
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
      entry.result.destinationTitle ?? ""
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
  const successfulClicks = history.filter((entry) => entry.decision.action === "click" && entry.result.success);
  const failedClicks = history.filter((entry) => entry.decision.action === "click" && !entry.result.success);
  const taskStrings = collectTaskStrings(history, finalUrl, finalTitle, taskNotes);
  const blockedByInterstitial = matchesAnyPattern(taskStrings, INTERSTITIAL_PATTERNS);
  const timeLimited = matchesAnyPattern(taskStrings, TIME_LIMIT_PATTERNS);
  const distinctTargets = new Set(successfulClicks.map((entry) => entry.decision.target.toLowerCase()).filter(Boolean));
  const distinctDestinations = new Set(
    successfulClicks
      .map((entry) => entry.result.destinationUrl ?? entry.url)
      .map((value) => value.replace(/[?#].*$/, ""))
      .filter(Boolean)
  );
  const visibleChanges = successfulClicks.filter((entry) => entry.result.stateChanged);

  if (blockedByInterstitial) {
    return {
      status: "failed",
      reason: "A security or verification interstitial blocked the destination page before the agent could fairly validate this navigation path."
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
  if (args.history.length < 2 || args.pageSignatures.length < 2) {
    return false;
  }

  const recentEntries = args.history.slice(-2);
  const recentSignatures = args.pageSignatures.slice(-2);
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

export async function runTaskSuite(options: RunOptions): Promise<{
  rawEvents: unknown[];
  taskResults: TaskRunResult[];
  accessibility: Awaited<ReturnType<typeof runAccessibilityAudit>>;
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

  const rawEvents: unknown[] = [];
  const taskResults: TaskRunResult[] = [];
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;
  let browserTimezone = config.deviceTimezone;
  let accessibility: Awaited<ReturnType<typeof runAccessibilityAudit>> = {
    violations: [],
    error: "Accessibility audit did not run because the session ended before it reached the audit phase."
  };

  try {
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

      for (let step = 1; step <= config.maxStepsPerTask; step += 1) {
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
        if (remainingSessionMs < minimumUsefulStepWindowMs) {
          rawEvents.push({
            type: "session_timeout",
            time: new Date().toISOString(),
            task: task.name,
            note: `Session stopped with ${Math.ceil(remainingSessionMs / 1000)} seconds left so the run could finish analysis cleanly.`
          });
          taskNotes.push("The agent stopped exploring because the remaining session time was too short for another meaningful interaction.");
          break;
        }

        const pageState = await capturePageState(page);
        const pageSignature = buildPageSignature(pageState);
        const shouldStop = shouldStopForStagnation({
          history,
          pageSignature,
          pageSignatures
        });
        const planning = shouldStop
          ? {
              decision: {
                thought: "The page has remained effectively unchanged across repeated high-friction or no-progress steps.",
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

        const result = shouldStop
          ? {
              success: true,
              stop: true,
              note: "Stopped early after repeated unchanged page states with no meaningful progress."
            }
          : await executeDecision(page, decision);
        const entry: TaskHistoryEntry = {
          time: new Date().toISOString(),
          task: task.name,
          step,
          url: page.url(),
          title: await page.title().catch(() => ""),
          decision,
          result
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
    writeJson(path.join(options.runDir, "raw-events.json"), rawEvents);
    writeJson(path.join(options.runDir, "task-results.json"), taskResults);
    writeJson(path.join(options.runDir, "accessibility.json"), accessibility);

    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
  }

  return { rawEvents, taskResults, accessibility, browserTimezone, deviceTimezone: config.deviceTimezone };
}
