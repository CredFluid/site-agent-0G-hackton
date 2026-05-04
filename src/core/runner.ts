import fs from "node:fs";
import path from "node:path";
import {
  chromium,
  devices,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type LaunchOptions,
  type Locator,
  type Page
} from "playwright";
import { captureInboxCheckpoint, waitForVerificationEmail } from "../auth/inbox.js";
import { getMailboxConfig, getPreferredAccessIdentity, isAuthBootstrapConfigured } from "../auth/profile.js";
import { detectAuthWall, runAuthFlowInContext } from "../auth/runner.js";
import { clampRunDurationMs, config } from "../config.js";
import {
  isWalletConfigured,
  getWalletConfig,
  getWalletChainId,
  getMetaMaskExtensionPath,
  getMetaMaskUserDataDir
} from "../wallet/wallet.js";
import { buildWeb3InjectionScript } from "../wallet/provider.js";
import { startSigningRelay, type SigningRelay } from "../wallet/relay.js";
import { runAccessibilityAudit } from "./audit.js";
import { buildLooseAccessiblePattern, prepareLocatorForInteraction } from "./interaction.js";
import { capturePageState } from "./pageState.js";
import { decideNextAction } from "./planner.js";
import { executeDecision, prepareClickDecision } from "./executor.js";
import { isGameplayTask, summarizeGameplayHistory } from "./gameplaySummary.js";
import { deriveSiteBrief } from "./siteBrief.js";
import { runSiteChecks } from "./siteChecks.js";
import type { LlmRuntimeOptions } from "../llm/client.js";
import { parseTaskDirectives } from "./taskDirectives.js";
import {
  classifyTaskText,
  hasTaskKeywordEvidence,
  isRegressiveTaskControlLabel,
  textHasInstructionCue,
  textHasOutcomeCue,
  textHasPlayActionCue
} from "./taskHeuristics.js";
import { ensureDir, writeJson } from "../utils/files.js";
import { debug, warn } from "../utils/log.js";
import { installPlaywrightPageCompat } from "../utils/playwrightCompat.js";
import { sleep } from "../utils/time.js";
import { extractSellInstruction, taskLooksLikeTrade } from "../trade/extractor.js";
import { executeTradeInstruction } from "../trade/engine.js";
import { getTradePolicy, buildDefaultTradeRunOptions } from "../trade/policy.js";
import type {
  PageState,
  PlannerDecision,
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
  tradeOptions?: {
    enabled?: boolean;
    dryRun?: boolean;
    strategy?: "auto" | "dapp_only" | "deposit_only";
    confirmations?: number;
  };
} & LlmRuntimeOptions;

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
const ACCOUNT_CREATION_TASK_PATTERN = /\b(?:sign ?up|signup|register|create(?:\s+your)?\s+(?:account|profile)|create\s+my\s+account|join)\b/i;
const ACCOUNT_CREATION_SUBMIT_PATTERN = /\b(?:submit|register|sign ?up|create\b.*\baccount|join)\b/i;
const ACCOUNT_CREATION_SUCCESS_PATTERN =
  /\b(?:registered users?|add another registration|account created|account ready|welcome|dashboard|profile active|view live market screen)\b/i;
const ACCOUNT_CREATION_LOCAL_ONLY_PATTERN =
  /\b(?:browser fallback|browser storage only|using browser storage only|local server is unavailable|api is unavailable)\b/i;
const ACCOUNT_CREATION_FORM_STILL_VISIBLE_PATTERN =
  /\b(?:first\s*name|last\s*name|email\s*address|confirm\s*password|phone\s*number|date\s*of\s*birth)\b.*\b(?:create\s*(?:my\s*)?account|sign\s*up|register)\b/is;
const ACCOUNT_CREATION_VERIFICATION_PENDING_PATTERN =
  /\b(?:please\s+verify|verify\s+your\s+email|check\s+your\s+email|send\s+otp|enter\s+(?:the\s+)?(?:code|otp)|verification\s+code)\b/i;
const OTP_TRIGGER_CLICK_PATTERN =
  /\b(?:send\s*(?:otp|code)|get\s*(?:otp|code)|verify\s*email|request\s*(?:otp|code))\b/i;
const OTP_FIELD_PATTERN =
  /\b(?:otp|one[- ]?time|verification|passcode|security\s*code|auth\s*code|enter\s*code)\b/i;
const WALLET_PENDING_PATTERN =
  /\b(?:requesting\s+account|check\s+(?:your\s+)?wallet|confirm\s+(?:in|with)\s+metamask|confirm\s+in\s+your\s+wallet|open\s+metamask|awaiting\s+wallet|signature\s+request|approval\s+pending|waiting\s+for\s+wallet)\b/i;
const WALLET_CONNECT_TARGET_PATTERN = /\bconnect\b.*\bwallet\b|\bwallet\b.*\bconnect\b/i;
const WALLET_CONNECT_SURFACE_PATTERN =
  /\b(?:connect(?:\s+your)?\s+wallet|select(?:\s+a)?\s+wallet|choose(?:\s+a)?\s+wallet|walletconnect|connect with metamask|wallet connection)\b/i;
const WALLET_CONNECT_PROVIDER_PATTERN = /\b(?:wallet|metamask|walletconnect|coinbase|phantom|rabby|rainbow|web3|ethereum)\b/i;
const OTP_VERIFY_SUBMIT_LABELS = [
  "verify",
  "confirm",
  "continue",
  "submit",
  "finish",
  "complete",
  "activate",
  "create my account",
  "create account",
  "register",
  "sign up",
  "signup"
];
const CONTINUATION_FLOW_PATTERN =
  /\b(?:wallet|metamask|popup|pop up|modal|dialog|signature|sign(?:ing)?|approve|approval|accept|confirm|execute|transaction|buy|sell|swap|deposit|withdraw|send|transfer|amount|qty|quantity|price|token|network|chain|checkout|cart|order|review|payment)\b/i;
const DIRECT_CONTINUATION_VERB_PATTERN = /^(?:accept|approve|confirm|sign|execute|submit|continue|next|finish|complete|review)\b/i;

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
  const useServerless = process.env.USE_SERVERLESS_CHROMIUM === "true";

  debug("chromium mode", {
    useServerless,
    USE_SERVERLESS_CHROMIUM: process.env.USE_SERVERLESS_CHROMIUM,
    RENDER: process.env.RENDER
  });

  return useServerless;
}

async function resolveLaunchOptions(options: { headed: boolean | undefined }): Promise<LaunchOptions> {
  const explicitExecutablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH?.trim();
  const metamaskPath = getMetaMaskExtensionPath();

  // When MetaMask extension mode is requested, force headed + extension args
  if (metamaskPath) {
    debug("launch options: MetaMask extension mode (headed)", { metamaskPath });
    const baseArgs = [
      `--disable-extensions-except=${metamaskPath}`,
      `--load-extension=${metamaskPath}`
    ];
    return {
      headless: false,
      args: baseArgs,
      ...(explicitExecutablePath ? { executablePath: explicitExecutablePath } : {})
    };
  }

  if (explicitExecutablePath) {
    debug("launch options: using explicit executable path");
    return {
      executablePath: explicitExecutablePath,
      headless: options.headed ? false : config.headless
    };
  }

  if (!shouldUseServerlessChromium()) {
    debug("launch options: using default Playwright browser");
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

  debug("launch options: using serverless chromium", {
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

function normalizeVisibleText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function countWords(value: string): number {
  return normalizeVisibleText(value)
    .split(/\s+/)
    .filter(Boolean).length;
}

function extractCompactAmountTaskValue(taskGoal: string): string | null {
  const match = normalizeVisibleText(taskGoal).match(/^(?:buy|sell|swap)\s+([0-9]+(?:\.[0-9]+)?)$/i);
  return match?.[1] ?? null;
}

function compactTargetsMatch(left: string, right: string): boolean {
  const normalizedLeft = normalizeVisibleText(left).toLowerCase().replace(/\s*\/\s*/g, " / ");
  const normalizedRight = normalizeVisibleText(right).toLowerCase().replace(/\s*\/\s*/g, " / ");
  if (!normalizedLeft || !normalizedRight) {
    return false;
  }

  if (normalizedLeft === normalizedRight || normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft)) {
    return true;
  }

  const leftWords = normalizedLeft.split(/\s+/).filter(Boolean);
  const rightWords = normalizedRight.split(/\s+/).filter(Boolean);
  const sharedWordCount = leftWords.filter((word) => rightWords.includes(word)).length;
  return sharedWordCount >= Math.min(leftWords.length, rightWords.length) || sharedWordCount >= 2;
}

function taskShouldEndAfterSuccessfulCompactStep(taskGoal: string, history: TaskHistoryEntry[]): boolean {
  const amountValue = extractCompactAmountTaskValue(taskGoal);
  if (amountValue) {
    return history.some(
      (entry) =>
        entry.result.success &&
        entry.decision.action === "type" &&
        compactTargetsMatch(entry.decision.target || entry.decision.instructionQuote || "", "amount")
    );
  }

  const directives = parseTaskDirectives(taskGoal).filter((directive) => directive.action !== "stop");
  if (directives.length !== 1) {
    return false;
  }

  const [directive] = directives;
  if (!directive || directive.action === "unstructured" || directive.action === "fill_visible_form") {
    return false;
  }

  if (directive.action === "click") {
    return history.some(
      (entry) =>
        entry.result.success &&
        entry.decision.action === "click" &&
        compactTargetsMatch(entry.decision.target || entry.decision.instructionQuote || "", directive.target)
    );
  }

  if (directive.action === "type_field") {
    return history.some(
      (entry) =>
        entry.result.success &&
        entry.decision.action === "type" &&
        (compactTargetsMatch(entry.decision.target || entry.decision.instructionQuote || "", directive.target) ||
          (directive.value !== undefined && normalizeVisibleText(entry.decision.text) === normalizeVisibleText(directive.value)))
    );
  }

  if (directive.action === "submit") {
    return history.some(
      (entry) =>
        entry.result.success &&
        entry.decision.action === "click" &&
        /^(?:submit|continue|next|finish|complete|done|send|verify|sign ?up|register|join|execute real transaction)$/i.test(
          normalizeVisibleText(entry.decision.target || entry.decision.instructionQuote || "")
        )
    );
  }

  return false;
}

function taskLooksLikeCompactActionFlowStep(taskGoal: string): boolean {
  const normalized = normalizeVisibleText(taskGoal);
  if (!normalized || countWords(normalized) > 8) {
    return false;
  }

  if (extractCompactAmountTaskValue(normalized)) {
    return true;
  }

  const directives = parseTaskDirectives(normalized).filter((directive) => directive.action !== "stop");
  if (directives.length === 0 || directives.length > 2) {
    return false;
  }

  return directives.every((directive) => directive.action !== "unstructured");
}

function taskNeedsContinuousContext(taskGoal: string): boolean {
  const normalized = normalizeVisibleText(taskGoal).toLowerCase();
  return DIRECT_CONTINUATION_VERB_PATTERN.test(normalized) || CONTINUATION_FLOW_PATTERN.test(normalized);
}

function directiveTargetMatches(directive: ReturnType<typeof parseTaskDirectives>[number] | undefined, pattern: RegExp): boolean {
  return Boolean(directive && "target" in directive && pattern.test(normalizeVisibleText(directive.target || directive.raw)));
}

function historyShowsMeaningfulProgress(history: TaskHistoryEntry[]): boolean {
  return history.some(
    (entry) =>
      entry.result.success &&
      (entry.result.stateChanged !== false ||
        Boolean(entry.result.destinationUrl) ||
        Boolean(entry.result.destinationTitle) ||
        Boolean(entry.result.visibleTextSnippet))
  );
}

function shouldContinueFromCurrentPage(args: {
  previousTask: TaskSuite["tasks"][number] | undefined;
  currentTask: TaskSuite["tasks"][number];
  previousHistory: TaskHistoryEntry[];
}): boolean {
  if (!args.previousTask || !historyShowsMeaningfulProgress(args.previousHistory)) {
    return false;
  }

  if (
    !taskLooksLikeCompactActionFlowStep(args.previousTask.goal) ||
    !taskLooksLikeCompactActionFlowStep(args.currentTask.goal)
  ) {
    return false;
  }

  if (taskNeedsContinuousContext(args.previousTask.goal) || taskNeedsContinuousContext(args.currentTask.goal)) {
    return true;
  }

  const previousDirectives = parseTaskDirectives(args.previousTask.goal);
  const currentDirectives = parseTaskDirectives(args.currentTask.goal);
  const previousLastDirective = previousDirectives[previousDirectives.length - 1];
  const currentFirstDirective = currentDirectives[0];
  if (!previousLastDirective || !currentFirstDirective) {
    return false;
  }

  const previousTarget = normalizeVisibleText(previousLastDirective.target || "");
  const currentTarget = normalizeVisibleText(currentFirstDirective.target || "");
  if (previousLastDirective.action === "type_field" && currentFirstDirective.action === "click") {
    return directiveTargetMatches(currentFirstDirective, /\b(?:continue|next|proceed|payment|review|confirm)\b/i);
  }

  if (previousLastDirective.action === "click" && currentFirstDirective.action === "type_field") {
    return (
      /\b(?:continue|next|proceed|payment|review)\b/i.test(previousTarget) &&
      directiveTargetMatches(currentFirstDirective, /\b(?:bank|account|receiving|recipient|wallet|address|amount)\b/i)
    );
  }

  if (previousLastDirective.action !== "click" || currentFirstDirective.action !== "click") {
    return false;
  }

  return (
    (/\b(?:connect|wallet)\b/i.test(previousTarget) &&
      /\b(?:wallet|buy|sell|swap|review|confirm|approve|sign)\b/i.test(currentTarget)) ||
    (/\b(?:continue|next|proceed|payment|review)\b/i.test(previousTarget) &&
      /\b(?:paid|payment|continue|next|proceed|confirm|done)\b/i.test(currentTarget))
  );
}

function findInteractiveLabelByTargetId(pageState: PageState, targetId: string): string {
  const normalizedTargetId = normalizeVisibleText(targetId);
  if (!normalizedTargetId) {
    return "";
  }

  return normalizeVisibleText(pageState.interactive.find((item) => item.agentId === normalizedTargetId)?.text || "");
}

function textLooksLikeWalletConnect(source: string): boolean {
  const normalizedSource = normalizeVisibleText(source);
  if (!normalizedSource) {
    return false;
  }

  if (WALLET_CONNECT_TARGET_PATTERN.test(normalizedSource) || WALLET_CONNECT_SURFACE_PATTERN.test(normalizedSource)) {
    return true;
  }

  return /\bconnect\b/i.test(normalizedSource) && WALLET_CONNECT_PROVIDER_PATTERN.test(normalizedSource);
}

async function readLocatorWalletConnectContext(locator: Locator): Promise<string> {
  const context = await locator
    .evaluate((element) => {
      const htmlElement = element as HTMLElement;
      const closestContainer =
        htmlElement.closest("dialog, [role='dialog'], form, section, article, main, nav, aside, header, div") || htmlElement.parentElement;
      const containerText = closestContainer?.textContent || "";
      const href = element instanceof HTMLAnchorElement ? element.href : "";
      const className = typeof htmlElement.className === "string" ? htmlElement.className : "";
      return [
        htmlElement.innerText || htmlElement.textContent || "",
        element.getAttribute("aria-label") || "",
        element.getAttribute("title") || "",
        element.getAttribute("name") || "",
        element.getAttribute("id") || "",
        element.getAttribute("data-testid") || "",
        element.getAttribute("data-test") || "",
        className,
        href,
        containerText.slice(0, 300)
      ]
        .join(" ")
        .trim();
    })
    .catch(() => "");

  return normalizeVisibleText(context);
}

async function decisionLooksLikeWalletConnect(args: {
  pageState: PageState;
  decision: PlannerDecision;
  locator?: Locator;
}): Promise<boolean> {
  if (args.decision.action !== "click") {
    return false;
  }

  const labels = [
    normalizeVisibleText(args.decision.target || ""),
    normalizeVisibleText(args.decision.instructionQuote || ""),
    findInteractiveLabelByTargetId(args.pageState, args.decision.target_id || "")
  ];

  if (args.locator) {
    labels.push(await readLocatorWalletConnectContext(args.locator));
  }

  return labels.some((label) => textLooksLikeWalletConnect(label));
}

type ActiveTaskRef = {
  name: string;
  index: number;
  history: TaskHistoryEntry[];
  step: number;
};

type MetaMaskPopupKind = "connect" | "signature" | "transaction" | "network" | "approval" | "generic";
type MetaMaskActionKey =
  | "next"
  | "connect"
  | "approve"
  | "confirm"
  | "sign"
  | "switchNetwork"
  | "addNetwork"
  | "gotIt";

type MetaMaskPopupState = {
  url: string;
  title: string;
  bodyText: string;
  kind: MetaMaskPopupKind;
  fingerprint: string;
};

type MetaMaskRuntimeState = {
  activePopupCount: number;
  lastDetectedAt: number;
  lastActionAt: number;
  lastClosedAt: number;
};

type MetaMaskActionDefinition = {
  key: MetaMaskActionKey;
  label: string;
  selectors: string[];
  buttonNames: RegExp[];
};

const METAMASK_EXTENSION_URL_PATTERN = "chrome-extension://";
const METAMASK_MAX_ATTEMPTS = 60;
const METAMASK_WAIT_MS = 1000;
const METAMASK_REPEAT_CLICK_COOLDOWN_MS = 2500;
const METAMASK_ACTIONS: Record<MetaMaskActionKey, MetaMaskActionDefinition> = {
  next: {
    key: "next",
    label: "Next",
    selectors: ['[data-testid="page-container-footer-next"]', 'button[data-testid*="next"]'],
    buttonNames: [/^next$/i, /^continue$/i, /^review$/i]
  },
  connect: {
    key: "connect",
    label: "Connect",
    selectors: ['button[data-testid*="connect"]', '[role="button"][data-testid*="connect"]'],
    buttonNames: [/^connect$/i, /^connect wallet$/i]
  },
  approve: {
    key: "approve",
    label: "Approve",
    selectors: [
      'button[data-testid*="approve"]',
      '[role="button"][data-testid*="approve"]',
      'button[data-testid*="allow"]'
    ],
    buttonNames: [/^approve$/i, /^allow$/i, /^approve and continue$/i]
  },
  confirm: {
    key: "confirm",
    label: "Confirm",
    selectors: [
      '[data-testid="confirm-footer-button"]',
      '[data-testid="confirm-btn"]',
      '[data-testid="confirmation-submit-button"]',
      'button[data-testid*="confirm"]',
      'button[data-testid*="submit"]'
    ],
    buttonNames: [/^confirm$/i, /^submit$/i]
  },
  sign: {
    key: "sign",
    label: "Sign",
    selectors: [
      '[data-testid="signature-request-footer__sign-button"]',
      'button[data-testid*="signature"][data-testid*="sign"]',
      'button[data-testid*="sign"]'
    ],
    buttonNames: [/^sign$/i, /^sign message$/i, /^sign typed data$/i]
  },
  switchNetwork: {
    key: "switchNetwork",
    label: "Switch network",
    selectors: ['button[data-testid*="switch-network"]', '[role="button"][data-testid*="switch-network"]'],
    buttonNames: [/^switch network$/i, /^switch to .+$/i]
  },
  addNetwork: {
    key: "addNetwork",
    label: "Add network",
    selectors: ['button[data-testid*="add-network"]', '[role="button"][data-testid*="add-network"]'],
    buttonNames: [/^add network$/i, /^add suggested network$/i]
  },
  gotIt: {
    key: "gotIt",
    label: "Got it",
    selectors: [
      'button[data-testid*="got-it"]',
      '[role="button"][data-testid*="got-it"]',
      'button[data-testid*="done"]'
    ],
    buttonNames: [/^got it$/i, /^done$/i, /^okay$/i, /^ok$/i]
  }
};
const METAMASK_ACTION_PLANS: Record<MetaMaskPopupKind, MetaMaskActionKey[]> = {
  connect: ["next", "connect", "approve", "confirm", "gotIt"],
  signature: ["sign", "confirm", "approve", "next", "gotIt"],
  transaction: ["next", "confirm", "approve", "gotIt"],
  network: ["approve", "switchNetwork", "addNetwork", "confirm", "next", "gotIt"],
  approval: ["approve", "confirm", "next", "gotIt"],
  generic: ["next", "connect", "approve", "confirm", "sign", "switchNetwork", "addNetwork", "gotIt"]
};

function classifyMetaMaskPopupKind(source: string): MetaMaskPopupKind {
  if (/\b(signature request|sign message|sign typed data|typed data|review signature|signature)\b/i.test(source)) {
    return "signature";
  }
  if (/\b(confirm transaction|transaction request|gas fee|max fee|network fee|nonce|spending cap)\b/i.test(source)) {
    return "transaction";
  }
  if (/\b(add network|switch network|allow this site to switch|allow this site to add)\b/i.test(source)) {
    return "network";
  }
  if (/\b(connect with metamask|connect this account|select an account|connect wallet|connect)\b/i.test(source)) {
    return "connect";
  }
  if (/\b(permission|permissions request|approve|allow)\b/i.test(source)) {
    return "approval";
  }
  return "generic";
}

async function locatorIsInteractable(locator: Locator): Promise<boolean> {
  try {
    return (await locator.isVisible({ timeout: 300 })) && (await locator.isEnabled({ timeout: 300 }));
  } catch {
    return false;
  }
}

async function readLocatorLabel(locator: Locator): Promise<string> {
  const label = await locator
    .evaluate((element) => {
      const htmlElement = element as HTMLElement;
      const text = htmlElement.innerText || htmlElement.textContent || "";
      const ariaLabel = element.getAttribute("aria-label") || "";
      const inputValue = element instanceof HTMLInputElement ? element.value : "";
      return (ariaLabel || inputValue || text).trim();
    })
    .catch(() => "");

  return normalizeVisibleText(label);
}

async function readMetaMaskPopupState(popupPage: Page): Promise<MetaMaskPopupState> {
  const url = popupPage.url();
  const title = normalizeVisibleText(await popupPage.title().catch(() => "MetaMask"));
  const bodyText = normalizeVisibleText(await popupPage.locator("body").innerText().catch(() => ""));
  const source = `${url} ${title} ${bodyText}`;

  return {
    url,
    title,
    bodyText,
    kind: classifyMetaMaskPopupKind(source),
    fingerprint: normalizeVisibleText(source).toLowerCase().slice(0, 600)
  };
}

async function isMetaMaskUnlockScreen(popupPage: Page, state: MetaMaskPopupState): Promise<boolean> {
  if (!/\bunlock\b/i.test(`${state.title} ${state.bodyText}`)) {
    return false;
  }

  const passwordField = popupPage.locator('input[type="password"]').first();
  const unlockButton = popupPage.getByRole("button", { name: /^unlock$/i }).first();
  return (await locatorIsInteractable(passwordField)) && (await locatorIsInteractable(unlockButton));
}

async function advanceMetaMaskReview(popupPage: Page): Promise<boolean> {
  let progressed = false;
  const scrollSelectors = [
    '[data-testid="page-scroll-down"]',
    '[data-testid*="scroll-down"]',
    '[data-testid*="scroll-button"]'
  ];

  for (const selector of scrollSelectors) {
    const scrollButton = popupPage.locator(selector).first();
    try {
      if (await scrollButton.isVisible({ timeout: 250 })) {
        await scrollButton.click({ timeout: 1000 });
        progressed = true;
        await popupPage.waitForTimeout(300);
      }
    } catch {
      // The scroll affordance is optional across MetaMask screens.
    }
  }

  const scrolledProgrammatically = await popupPage
    .evaluate(() => {
      const candidates = Array.from(document.querySelectorAll<HTMLElement>("main, section, article, div"))
        .filter((element) => {
          const style = window.getComputedStyle(element);
          return /(auto|scroll)/i.test(style.overflowY) && element.scrollHeight > element.clientHeight + 24;
        })
        .sort((left, right) => right.scrollHeight - right.clientHeight - (left.scrollHeight - left.clientHeight));

      const scrollingRoot =
        document.scrollingElement instanceof HTMLElement ? document.scrollingElement : document.documentElement;
      const target = candidates[0] ?? scrollingRoot;
      if (!target) {
        return false;
      }

      const before = target.scrollTop;
      target.scrollTop = target.scrollHeight;
      return target.scrollTop > before;
    })
    .catch(() => false);

  if (scrolledProgrammatically) {
    progressed = true;
    await popupPage.waitForTimeout(300);
  }

  return progressed;
}

async function resolveMetaMaskActionLocator(
  popupPage: Page,
  definition: MetaMaskActionDefinition
): Promise<Locator | null> {
  for (const selector of definition.selectors) {
    const locator = popupPage.locator(selector).first();
    if (await locatorIsInteractable(locator)) {
      return locator;
    }
  }

  for (const pattern of definition.buttonNames) {
    const locator = popupPage.getByRole("button", { name: pattern }).first();
    if (await locatorIsInteractable(locator)) {
      return locator;
    }
  }

  for (const pattern of definition.buttonNames) {
    const locator = popupPage
      .locator('button, [role="button"], input[type="button"], input[type="submit"]', { hasText: pattern })
      .first();
    if (await locatorIsInteractable(locator)) {
      return locator;
    }
  }

  return null;
}

async function captureMetaMaskPopupScreenshot(
  popupPage: Page,
  runDir: string,
  suffix: string
): Promise<string | null> {
  const filename = `metamask-${Date.now()}-${suffix}.png`;
  const targetPath = path.join(runDir, filename);
  try {
    await popupPage.screenshot({ path: targetPath, animations: "disabled" });
    return filename;
  } catch {
    return null;
  }
}

async function clickMetaMaskAction(args: {
  popupPage: Page;
  state: MetaMaskPopupState;
  definition: MetaMaskActionDefinition;
  locator: Locator;
  runDir: string;
  rawEvents: unknown[];
  runtimeState: MetaMaskRuntimeState;
  getCurrentTaskRef: () => ActiveTaskRef | null;
}): Promise<void> {
  const actualLabel = (await readLocatorLabel(args.locator)) || args.definition.label;
  const interactionTime = new Date().toISOString();
  const beforeScreenshot = await captureMetaMaskPopupScreenshot(args.popupPage, args.runDir, "before");

  await args.locator.scrollIntoViewIfNeeded().catch(() => undefined);
  await args.locator.click({ timeout: 3000 });
  await args.popupPage.waitForTimeout(METAMASK_WAIT_MS);

  const afterScreenshot = !args.popupPage.isClosed()
    ? await captureMetaMaskPopupScreenshot(args.popupPage, args.runDir, "after")
    : null;
  args.runtimeState.lastActionAt = Date.now();

  args.rawEvents.push({
    type: "metamask_popup_action",
    time: interactionTime,
    action: args.definition.key,
    label: actualLabel,
    popupKind: args.state.kind,
    url: args.state.url,
    note: `Auto-clicked '${actualLabel}' in MetaMask ${args.state.kind} flow.`,
    beforeScreenshot,
    afterScreenshot
  });

  const taskRef = args.getCurrentTaskRef();
  if (!taskRef) {
    return;
  }

  taskRef.step += 1;
  const activeStep = taskRef.step;
  taskRef.history.push({
    time: interactionTime,
    task: taskRef.name,
    step: activeStep,
    url: args.state.url,
    title: args.state.title,
    decision: {
      thought: `Automatically approving MetaMask ${args.state.kind} request: ${actualLabel}`,
      stepNumber: activeStep,
      instructionQuote: "MetaMask Approval",
      action: "click",
      target: actualLabel,
      target_id: "",
      text: "",
      expectation: "The MetaMask request should be approved and the popup should close or advance.",
      friction: "none"
    },
    result: {
      success: true,
      note: `Auto-clicked '${actualLabel}' in MetaMask popup.`,
      stateChanged: true,
      beforeScreenshotPath: beforeScreenshot ?? undefined,
      afterScreenshotPath: afterScreenshot ?? undefined
    }
  });
}

async function handleMetaMaskPopup(args: {
  popupPage: Page;
  runDir: string;
  rawEvents: unknown[];
  runtimeState: MetaMaskRuntimeState;
  getCurrentTaskRef: () => ActiveTaskRef | null;
}): Promise<void> {
  try {
    debug("Popup detected, waiting for URL...");
    await args.popupPage
      .waitForURL((url) => url.toString().includes(METAMASK_EXTENSION_URL_PATTERN), { timeout: 3000 })
      .catch(() => undefined);

    const popupUrl = args.popupPage.url();
    if (!popupUrl.includes(METAMASK_EXTENSION_URL_PATTERN)) {
      debug("Bailing from popup handler: not an extension URL", { url: popupUrl });
      return;
    }

    await args.popupPage.waitForLoadState("domcontentloaded").catch(() => undefined);
    await args.popupPage.waitForTimeout(METAMASK_WAIT_MS);
    args.runtimeState.activePopupCount += 1;
    args.runtimeState.lastDetectedAt = Date.now();
    args.popupPage.once("close", () => {
      args.runtimeState.activePopupCount = Math.max(0, args.runtimeState.activePopupCount - 1);
      args.runtimeState.lastClosedAt = Date.now();
    });

    let attempts = 0;
    let idleAttempts = 0;
    let lastClickedFingerprint = "";
    let lastClickAt = 0;
    let lastState = await readMetaMaskPopupState(args.popupPage);

    args.rawEvents.push({
      type: "metamask_popup_detected",
      time: new Date().toISOString(),
      url: lastState.url,
      title: lastState.title,
      popupKind: lastState.kind,
      note: `MetaMask extension popup detected for a ${lastState.kind} flow.`
    });

    debug("MetaMask popup detected", { url: lastState.url, kind: lastState.kind, title: lastState.title });

    while (!args.popupPage.isClosed() && attempts < METAMASK_MAX_ATTEMPTS) {
      attempts++;
      lastState = await readMetaMaskPopupState(args.popupPage);

      if (await isMetaMaskUnlockScreen(args.popupPage, lastState)) {
        args.rawEvents.push({
          type: "metamask_popup_blocked",
          time: new Date().toISOString(),
          url: lastState.url,
          title: lastState.title,
          popupKind: lastState.kind,
          note: "MetaMask is locked. Unlock the extension profile before running signing or confirmation flows."
        });
        return;
      }

      if (lastState.kind === "signature") {
        await advanceMetaMaskReview(args.popupPage).catch(() => undefined);
      }

      const plan = METAMASK_ACTION_PLANS[lastState.kind] ?? METAMASK_ACTION_PLANS.generic;
      let clickedAction = false;

      for (const actionKey of plan) {
        const definition = METAMASK_ACTIONS[actionKey];
        const locator = await resolveMetaMaskActionLocator(args.popupPage, definition);
        if (!locator) {
          continue;
        }

        const clickFingerprint = `${lastState.fingerprint}|${definition.key}`;
        const now = Date.now();
        if (clickFingerprint === lastClickedFingerprint && now - lastClickAt < METAMASK_REPEAT_CLICK_COOLDOWN_MS) {
          continue;
        }

        await clickMetaMaskAction({
          popupPage: args.popupPage,
          state: lastState,
          definition,
          locator,
          runDir: args.runDir,
          rawEvents: args.rawEvents,
          runtimeState: args.runtimeState,
          getCurrentTaskRef: args.getCurrentTaskRef
        });
        clickedAction = true;
        idleAttempts = 0;
        lastClickedFingerprint = clickFingerprint;
        lastClickAt = now;
        break;
      }

      if (clickedAction) {
        continue;
      }

      idleAttempts++;
      if (idleAttempts === 1 || idleAttempts % 10 === 0) {
        args.rawEvents.push({
          type: "metamask_popup_waiting",
          time: new Date().toISOString(),
          url: lastState.url,
          title: lastState.title,
          popupKind: lastState.kind,
          attempts,
          note: `MetaMask popup is still open without a clickable approval target. Visible content: '${lastState.bodyText.slice(0, 200) || "n/a"}'.`
        });
      }

      await advanceMetaMaskReview(args.popupPage).catch(() => undefined);
      await args.popupPage.waitForTimeout(800);
    }

    if (!args.popupPage.isClosed()) {
      args.rawEvents.push({
        type: "metamask_popup_timeout",
        time: new Date().toISOString(),
        url: lastState.url,
        title: lastState.title,
        popupKind: lastState.kind,
        note: `MetaMask popup remained open after ${METAMASK_MAX_ATTEMPTS} checks without a completed approval flow.`
      });
    }
  } catch (error) {
    args.rawEvents.push({
      type: "metamask_popup_error",
      time: new Date().toISOString(),
      note: `MetaMask popup handler error: ${cleanErrorMessage(error)}`
    });
  }
}

function pageLooksLikeWalletFlowIsPending(pageState: PageState): boolean {
  return WALLET_PENDING_PATTERN.test(`${pageState.title} ${pageState.visibleText}`);
}

async function pageStillNeedsOtpVerification(page: Page): Promise<boolean> {
  const bodyText = normalizeVisibleText(await page.locator("body").innerText().catch(() => ""));
  if (ACCOUNT_CREATION_VERIFICATION_PENDING_PATTERN.test(bodyText)) {
    return true;
  }

  const hasVisibleOtpField = await page
    .evaluate((otpPattern) => {
      const inputs = Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea"));
      return inputs.some((input) => {
        const rect = input.getBoundingClientRect();
        const style = window.getComputedStyle(input);
        if (
          rect.width <= 0 ||
          rect.height <= 0 ||
          style.visibility === "hidden" ||
          style.display === "none" ||
          input.disabled
        ) {
          return false;
        }

        const key = [
          input.getAttribute("placeholder") || "",
          input.getAttribute("name") || "",
          input.id || "",
          input.getAttribute("aria-label") || "",
          input.getAttribute("autocomplete") || "",
          input.type || ""
        ]
          .join(" ")
          .toLowerCase();

        return new RegExp(otpPattern, "i").test(key) || input.getAttribute("autocomplete") === "one-time-code";
      });
    }, OTP_FIELD_PATTERN.source)
    .catch(() => false);

  return hasVisibleOtpField;
}

async function clickFirstVisibleAction(page: Page, labels: string[]): Promise<string | null> {
  for (const label of labels) {
    const pattern = buildLooseAccessiblePattern(label);
    if (!pattern) {
      continue;
    }

    const locators = [
      page.getByRole("button", { name: pattern }),
      page.getByRole("link", { name: pattern }),
      page.getByText(pattern)
    ];

    for (const locator of locators) {
      const candidate = locator.first();
      try {
        if (!(await candidate.isVisible({ timeout: 500 }))) {
          continue;
        }
      } catch {
        continue;
      }

      const prepared = await prepareLocatorForInteraction(candidate).catch(() => candidate);
      await prepared.click({ timeout: 5000 }).catch(async () => {
        await prepared.click({ force: true, timeout: 5000 });
      });
      await page.waitForLoadState("domcontentloaded").catch(() => undefined);
      await page.waitForTimeout(config.actionDelayMs);
      return label;
    }
  }

  return null;
}

async function attemptOtpRetrieval(args: {
  page: Page;
  baseUrl: string;
  rawEvents: unknown[];
  taskName: string;
  step: number;
}): Promise<{ filled: boolean; otpCode?: string; error?: string }> {
  const mailbox = getMailboxConfig();
  if (!mailbox) {
    return { filled: false, error: "IMAP mailbox is not configured (AUTH_IMAP_* settings missing)." };
  }

  const identity = getPreferredAccessIdentity(args.baseUrl);
  const siteHost = new URL(args.baseUrl).hostname;

  try {
    const checkpoint = await captureInboxCheckpoint(mailbox);
    args.rawEvents.push({
      type: "otp_inbox_checkpoint",
      time: new Date().toISOString(),
      task: args.taskName,
      step: args.step,
      note: `Captured mailbox checkpoint at UID ${checkpoint.uidNext} to watch for verification email.`
    });

    const message = await waitForVerificationEmail({
      mailbox,
      checkpoint,
      siteHost,
      recipientEmail: identity.email,
      timeoutMs: 60000,
      pollIntervalMs: 3000
    });

    args.rawEvents.push({
      type: "otp_email_received",
      time: new Date().toISOString(),
      task: args.taskName,
      step: args.step,
      note: `Received verification email '${message.subject}' with ${message.otpCode ? "OTP code" : "no OTP code"}.`,
      hasOtpCode: Boolean(message.otpCode),
      hasVerificationLink: Boolean(message.verificationLink)
    });

    if (!message.otpCode) {
      return { filled: false, error: "Verification email arrived but no OTP code could be extracted." };
    }

    // Wait for OTP input fields to appear on the page (they may render after a short delay)
    await args.page.waitForTimeout(1500);

    // Detect OTP input fields — handles both split-digit (6 separate inputs) and single-field patterns
    const otpFieldInfo = await args.page.evaluate((otpPattern) => {
      const inputs = Array.from(document.querySelectorAll<HTMLInputElement>("input, textarea"));
      const visibleInputs = inputs.filter((input) => {
        const rect = input.getBoundingClientRect();
        const style = window.getComputedStyle(input);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          !input.disabled
        );
      });

      // Strategy 1: Detect split-digit OTP inputs (multiple single-char inputs with numeric inputMode)
      const singleDigitInputs = visibleInputs.filter(
        (input) =>
          input.maxLength === 1 &&
          (input.inputMode === "numeric" || input.type === "tel" || input.type === "number") &&
          input.type !== "hidden"
      );

      if (singleDigitInputs.length >= 4 && singleDigitInputs.length <= 8) {
        const agentIds = singleDigitInputs.map((input, index) => {
          let id = input.getAttribute("data-site-agent-id");
          if (!id) {
            id = `temp-otp-${index}`;
            input.setAttribute("data-site-agent-id", id);
          }
          return id;
        });
        return { type: "split-digit" as const, count: singleDigitInputs.length, agentIds };
      }

      // Strategy 2: Detect single OTP input field by semantic attributes
      for (const input of visibleInputs) {
        const fieldKey = [
          input.getAttribute("placeholder") || "",
          input.getAttribute("name") || "",
          input.id || "",
          input.getAttribute("aria-label") || "",
          input.getAttribute("autocomplete") || "",
          input.type || ""
        ].join(" ").toLowerCase();

        if (
          new RegExp(otpPattern, "i").test(fieldKey) ||
          input.getAttribute("autocomplete") === "one-time-code" ||
          (input.maxLength >= 4 && input.maxLength <= 8 && input.inputMode === "numeric" && !input.value)
        ) {
          let agentId = input.getAttribute("data-site-agent-id");
          if (!agentId) {
            agentId = "temp-otp-single";
            input.setAttribute("data-site-agent-id", agentId);
          }
          return { type: "single" as const, agentId, label: fieldKey.trim().slice(0, 60) };
        }
      }

      return null;
    }, OTP_FIELD_PATTERN.source);

    if (!otpFieldInfo) {
      return { filled: false, otpCode: message.otpCode, error: "OTP code was extracted from email but no OTP input field was found on the page." };
    }

    // Fill the OTP field(s)
    if (otpFieldInfo.type === "split-digit") {
      // Fill each digit input individually using keyboard input to trigger React onChange
      const digits = message.otpCode.split("").slice(0, otpFieldInfo.count);

      for (let i = 0; i < digits.length; i++) {
        const agentId = otpFieldInfo.agentIds[i];
        if (!agentId) {
          continue;
        }

        const digitLocator = args.page.locator(`[data-site-agent-id="${agentId}"]`).first();
        await digitLocator.click();
        await args.page.keyboard.press(digits[i]!);
        await args.page.waitForTimeout(100);
      }

      // Wait for auto-verification to complete (triggered when all digits are filled)
      await args.page.waitForTimeout(2000);

      args.rawEvents.push({
        type: "otp_field_filled",
        time: new Date().toISOString(),
        task: args.taskName,
        step: args.step,
        note: `Filled ${digits.length} split-digit OTP inputs with code from verification email.`,
        fieldType: "split-digit",
        digitCount: digits.length
      });
    } else {
      // Single OTP input field
      const locator = otpFieldInfo.agentId
        ? args.page.locator(`[data-site-agent-id="${otpFieldInfo.agentId}"]`).first()
        : args.page.locator("input[autocomplete='one-time-code']").first();

      await locator.fill(message.otpCode);
      await args.page.waitForTimeout(500);

      args.rawEvents.push({
        type: "otp_field_filled",
        time: new Date().toISOString(),
        task: args.taskName,
        step: args.step,
        note: `Filled OTP field with code from verification email.`,
        fieldType: "single",
        fieldLabel: otpFieldInfo.label
      });
    }

    if (await pageStillNeedsOtpVerification(args.page)) {
      const clickedLabel = await clickFirstVisibleAction(args.page, OTP_VERIFY_SUBMIT_LABELS);
      if (clickedLabel) {
        args.rawEvents.push({
          type: "otp_verify_submit",
          time: new Date().toISOString(),
          task: args.taskName,
          step: args.step,
          note: `Clicked '${clickedLabel}' after filling the OTP to finalize verification.`
        });
      }
    }

    return { filled: true, otpCode: message.otpCode };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    args.rawEvents.push({
      type: "otp_retrieval_error",
      time: new Date().toISOString(),
      task: args.taskName,
      step: args.step,
      note: `OTP retrieval failed: ${errorMessage}`
    });

    return { filled: false, error: errorMessage };
  }
}

function buildNavigationBlockedSiteBrief(args: { baseUrl: string; note: string }): SiteBrief {
  return {
    sitePurpose: "The submitted URL could not be loaded, so the site purpose could not be observed.",
    intendedUserActions: [],
    summary: `Navigation to '${args.baseUrl}' failed before any visible landing-page content could be captured.`,
    evidence: [args.baseUrl, args.note]
  };
}

function isBrowserErrorPage(url: string): boolean {
  return url === "about:blank" || url.startsWith("chrome-error://");
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

function taskLooksLikeAccountCreation(goal: string): boolean {
  return ACCOUNT_CREATION_TASK_PATTERN.test(goal);
}

async function navigateToBaseUrl(args: {
  page: Page;
  baseUrl: string;
  rawEvents: unknown[];
  phase: "initial" | "task_reset";
  taskName?: string;
  taskNotes?: string[];
}): Promise<{ success: true } | { success: false; note: string }> {
  try {
    await args.page.goto(args.baseUrl, { waitUntil: "domcontentloaded" });
    return { success: true };
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

    warn(
      args.phase === "initial"
        ? note
        : `${note}${args.taskName ? ` while preparing '${args.taskName}'` : ""}`
    );

    return { success: false, note };
  }
}

function inferTaskStatus(
  history: TaskHistoryEntry[],
  finalUrl: string,
  finalTitle: string,
  task: TaskSuite["tasks"][number],
  taskNotes: string[] = []
): { status: TaskRunResult["status"]; reason: string } {
  const successfulTrades = history.filter((entry) => entry.decision.action === "trade" && entry.result.success);
  if (successfulTrades.length > 0) {
    const lastSuccessfulTrade = successfulTrades[successfulTrades.length - 1]!;
    const note = lastSuccessfulTrade.result.note;
    return {
      status: /\bdry run\b/i.test(note) ? "partial_success" : "success",
      reason: note
    };
  }

  const failedTrades = history.filter((entry) => entry.decision.action === "trade" && !entry.result.success);
  if (failedTrades.length > 0) {
    return {
      status: "failed",
      reason: failedTrades[0]!.result.note
    };
  }

  const successfulRealTransactionClick = history.find(
    (entry) =>
      entry.decision.action === "click" &&
      entry.result.success &&
      /\bexecute\s+real\s+transaction\b/i.test(entry.decision.target || entry.decision.instructionQuote || "")
  );
  if (taskLooksLikeTrade(task.goal) && successfulRealTransactionClick) {
    const transactionEvidence = collectTaskStrings(history, finalUrl, finalTitle, taskNotes).join(" ");
    if (/\b(?:failed|reverted|rejected|denied|cancelled|canceled|error)\b/i.test(transactionEvidence)) {
      return {
        status: "failed",
        reason: "The real transaction was submitted, but the visible transaction history reported a failed or rejected outcome."
      };
    }

    if (/\b(?:succeeded|success|successful|confirmed|completed|broadcast)\b/i.test(transactionEvidence)) {
      return {
        status: "success",
        reason: "The real transaction was submitted and the visible transaction history reached a final successful or broadcast state."
      };
    }

    if (/\b(?:sending|pending|confirming|processing|submitted)\b/i.test(transactionEvidence)) {
      return {
        status: "partial_success",
        reason: "The real transaction was submitted and accepted, but the page still showed it as pending before the run ended."
      };
    }
  }

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
  const successfulSubmitEntry = [...history]
    .reverse()
    .find(
      (entry) =>
        entry.decision.action === "click" &&
        entry.result.success &&
        ACCOUNT_CREATION_SUBMIT_PATTERN.test(entry.decision.target || "")
    );
  const accountCreationEvidenceBlob = [
    successfulSubmitEntry?.result.note ?? "",
    successfulSubmitEntry?.result.visibleTextSnippet ?? "",
    successfulSubmitEntry?.result.destinationTitle ?? "",
    finalTitle,
    ...taskNotes
  ].join(" ");
  const accountCreationLocalOnly =
    taskLooksLikeAccountCreation(task.goal) &&
    Boolean(successfulSubmitEntry) &&
    ACCOUNT_CREATION_LOCAL_ONLY_PATTERN.test(accountCreationEvidenceBlob);
  const postSubmitSnippet = successfulSubmitEntry?.result.visibleTextSnippet ?? "";
  const accountCreationFormStillVisible = ACCOUNT_CREATION_FORM_STILL_VISIBLE_PATTERN.test(postSubmitSnippet);
  const accountCreationVerificationPending =
    taskLooksLikeAccountCreation(task.goal) &&
    Boolean(successfulSubmitEntry) &&
    ACCOUNT_CREATION_VERIFICATION_PENDING_PATTERN.test(postSubmitSnippet) &&
    accountCreationFormStillVisible;
  const accountCreationSucceeded =
    taskLooksLikeAccountCreation(task.goal) &&
    Boolean(successfulSubmitEntry) &&
    ACCOUNT_CREATION_SUCCESS_PATTERN.test(accountCreationEvidenceBlob) &&
    !accountCreationFormStillVisible;

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
    if (accountCreationSucceeded) {
      if (accountCreationLocalOnly) {
        return {
          status: "partial_success",
          reason:
            "The signup form submitted and the site showed a post-registration state, but it explicitly reported browser-only fallback storage, so the account was not confirmed on a shared backend/dashboard."
        };
      }

      return {
        status: "success",
        reason: "The signup flow submitted successfully and the visible page switched into a post-registration state."
      };
    }

    if (accountCreationVerificationPending) {
      return {
        status: "partial_success",
        reason:
          "The signup form was filled and submitted, but the page is still requesting email or OTP verification before the account can be created."
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
      reason: "The run did not gather enough task-specific evidence to confirm this requested path."
    };
  }

  if (distinctTargets.size >= 3 && visibleChanges.length >= 2 && distinctDestinations.size >= 2 && failedClicks.length === 0) {
    return {
      status: "success",
      reason: "Multiple visible links, tabs, or buttons opened clear destination pages or visible state changes as expected."
    };
  }

  if (accountCreationSucceeded) {
    if (accountCreationLocalOnly) {
      return {
        status: "partial_success",
        reason:
          "The signup form submitted and the site showed a post-registration state, but it explicitly reported browser-only fallback storage, so the account was not confirmed on a shared backend/dashboard."
      };
    }

    return {
      status: "success",
      reason: "The signup flow submitted successfully and the visible page switched into a post-registration state."
    };
  }

  if (accountCreationVerificationPending) {
    return {
      status: "partial_success",
      reason:
        "The signup form was filled and submitted, but the page is still requesting email or OTP verification before the account can be created."
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

async function executeTradeHandoff(args: {
  pageState: PageState;
  taskName: string;
  taskGoal: string;
  runDir: string;
  tradeOptions: NonNullable<RunOptions["tradeOptions"]>;
  rawEvents: unknown[];
}): Promise<{
  success: boolean;
  note: string;
  stop?: boolean;
  stateChanged?: boolean;
}> {
  const instruction = extractSellInstruction({
    pageState: args.pageState,
    taskGoal: args.taskGoal,
    defaultChainId: getWalletChainId()
  });

  if (!instruction) {
    args.rawEvents.push({
      type: "trade_instruction_missing",
      time: new Date().toISOString(),
      task: args.taskName,
      url: args.pageState.url,
      note: "Trade handoff was requested, but a deterministic sell instruction could not be extracted from the visible page."
    });
    return {
      success: false,
      note: "Trade handoff could not extract a deterministic recipient address, amount, token, and chain from the visible page."
    };
  }

  args.rawEvents.push({
    type: "trade_instruction_extracted",
    time: new Date().toISOString(),
    task: args.taskName,
    url: args.pageState.url,
    instruction
  });

  const record = await executeTradeInstruction({
    runDir: args.runDir,
    instruction,
    runOptions: {
      ...buildDefaultTradeRunOptions(),
      ...args.tradeOptions
    },
    policy: getTradePolicy(),
    source: "browser"
  });

  args.rawEvents.push({
    type: "trade_execution_result",
    time: new Date().toISOString(),
    task: args.taskName,
    url: args.pageState.url,
    status: record.status,
    selectedMode: record.selectedMode,
    txHash: record.txHash,
    validation: record.validation,
    note: record.note
  });

  return {
    success: record.status === "dry_run" || record.status === "broadcast" || record.status === "confirmed",
    note: record.note,
    stateChanged: record.status === "broadcast" || record.status === "confirmed"
  };
}

function buildPageSignature(pageState: PageState): string {
  const interactiveSummary = pageState.interactive
    .slice(0, 8)
    .map((item) => `${item.role}:${item.text}:${item.disabled ? "disabled" : "enabled"}`)
    .join("|");
  const formSummary = pageState.formFields
    .slice(0, 12)
    .map((field) => {
      const fieldLabel = [field.label, field.placeholder, field.name, field.id, field.inputType].find(Boolean) || "field";
      const state =
        field.inputType === "checkbox" || field.inputType === "radio"
          ? field.checked
            ? "checked"
            : "unchecked"
          : field.value
            ? "filled"
            : "empty";

      return `${fieldLabel}:${state}`;
    })
    .join("|");

  return [
    pageState.url,
    pageState.title,
    pageState.visibleText.slice(0, 900),
    interactiveSummary,
    formSummary
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
      entry.result.success === false ||
      (entry.decision.action === "type" && entry.result.stateChanged === false)
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
  const llm = {
    ...(options.provider ? { provider: options.provider } : {}),
    ...(options.model ? { model: options.model } : {}),
    ...(options.ollamaBaseUrl ? { ollamaBaseUrl: options.ollamaBaseUrl } : {})
  };
  const tradeOptions = {
    ...buildDefaultTradeRunOptions(),
    ...(options.tradeOptions ?? {})
  };
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
  if (config.recordVideo) {
    contextOptions.recordVideo = { dir: options.runDir };
  }

  const rawEvents: unknown[] = [];
  const taskResults: TaskRunResult[] = [];
  const perTaskStepCap = derivePerTaskStepCap(options.suite.tasks.length);
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;
  let signingRelay: SigningRelay | null = null;
  let browserTimezone = config.deviceTimezone;
  const metaMaskRuntimeState: MetaMaskRuntimeState = {
    activePopupCount: 0,
    lastDetectedAt: 0,
    lastActionAt: 0,
    lastClosedAt: 0
  };
  let accessibility: Awaited<ReturnType<typeof runAccessibilityAudit>> = {
    violations: [],
    error: "Accessibility audit did not run because the session ended before it reached the audit phase."
  };
  let currentTaskRef: {
    name: string;
    index: number;
    history: TaskHistoryEntry[];
    step: number;
  } | null = null;
  let walletConnectAttempt:
    | {
        taskName: string;
        step: number;
        target: string;
      }
    | null = null;
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

    const metamaskExtensionPath = getMetaMaskExtensionPath();
    const metaMaskBrowserMode = Boolean(metamaskExtensionPath);
    if (metaMaskBrowserMode) {
      const configuredUserDataDir = getMetaMaskUserDataDir();
      const defaultUserDataDir = path.join(process.env.HOME || process.cwd(), ".site-agent-metamask-profile");
      const userDataDir = resolveLocalPath(configuredUserDataDir || defaultUserDataDir);

      ensureDir(userDataDir);
      rawEvents.push({
        type: "metamask_profile",
        time: new Date().toISOString(),
        path: summarizeLocalPath(userDataDir),
        persistent: Boolean(configuredUserDataDir),
        note: configuredUserDataDir
          ? `Launching MetaMask with persistent Chromium user data from '${summarizeLocalPath(userDataDir)}'.`
          : `Launching MetaMask with the default persistent Chromium user data at '${summarizeLocalPath(
              userDataDir
            )}'. Set WALLET_METAMASK_USER_DATA_DIR to reuse a specific unlocked MetaMask profile.`
      });

      context = await chromium.launchPersistentContext(userDataDir, {
        ...(await resolveLaunchOptions({ headed: options.headed })),
        ...contextOptions
      });
      browser = context.browser();
    } else {
      browser = await chromium.launch(await resolveLaunchOptions({ headed: options.headed }));
      context = await browser.newContext(contextOptions);
    }
    await installPlaywrightPageCompat(context);

    // --- Web3 wallet injection ---
    if (isWalletConfigured()) {
      try {
        const walletConfig = await getWalletConfig();
        if (walletConfig) {
          signingRelay = await startSigningRelay();
          const injectionScript = buildWeb3InjectionScript({
            walletConfig,
            relayPort: signingRelay.port
          });
          await context.addInitScript(injectionScript);

          rawEvents.push({
            type: "wallet_injected",
            time: new Date().toISOString(),
            address: walletConfig.address,
            chainId: walletConfig.chainId,
            relayPort: signingRelay.port,
            mode: walletConfig.metamaskExtensionPath ? "metamask_extension" : "programmatic",
            note: `Web3 wallet injected — address ${walletConfig.address} on chain ${walletConfig.chainId} (relay on port ${signingRelay.port}).`
          });

          // MetaMask popup auto-approve handler
          if (metaMaskBrowserMode) {
            context.on("page", async (popupPage: Page) => {
              await handleMetaMaskPopup({
                popupPage,
                runDir: options.runDir,
                rawEvents,
                runtimeState: metaMaskRuntimeState,
                getCurrentTaskRef: () => currentTaskRef
              });
            });
          }
        }
      } catch (walletError) {
        rawEvents.push({
          type: "wallet_injection_error",
          time: new Date().toISOString(),
          note: `Failed to inject Web3 wallet: ${cleanErrorMessage(walletError)}`
        });
        warn(`Web3 wallet injection failed: ${cleanErrorMessage(walletError)}`);
      }
    }

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
      type: "trade_configuration",
      time: new Date().toISOString(),
      tradeOptions,
      note: tradeOptions.enabled
        ? `Deterministic trade execution is enabled for this run${tradeOptions.dryRun ? " in dry-run mode" : ""}.`
        : "Deterministic trade execution is disabled for this run."
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

    const initialNavigation = await navigateToBaseUrl({
      page,
      baseUrl: options.baseUrl,
      rawEvents,
      phase: "initial"
    });

    const initialPageState = await capturePageState(page);
    if (!initialNavigation.success || isBrowserErrorPage(initialPageState.url)) {
      const blockedNote = !initialNavigation.success
        ? initialNavigation.note
        : `The browser remained on '${initialPageState.url}' after attempting the submitted URL.`;
      siteBrief = buildNavigationBlockedSiteBrief({
        baseUrl: options.baseUrl,
        note: blockedNote
      });
      rawEvents.push({
        type: "site_brief",
        time: new Date().toISOString(),
        summary: siteBrief.summary,
        sitePurpose: siteBrief.sitePurpose,
        intendedUserActions: siteBrief.intendedUserActions,
        evidence: siteBrief.evidence,
        note: `Skipped model-based site brief because the submitted URL did not load cleanly: ${blockedNote}`
      });
    } else {
      const siteBriefResolution = await deriveSiteBrief({
        pageState: initialPageState,
        llm
      });
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

      if (siteBriefResolution.fallbackReason) {
        warn(`Site brief fallback for '${options.baseUrl}': ${siteBriefResolution.fallbackReason}`);
      }
    }
    const authBootstrapConfigured = isAuthBootstrapConfigured(options.baseUrl);
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
      currentTaskRef = {
        name: task.name,
        index,
        history,
        step: 0
      };

      const previousTask = index > 0 ? options.suite.tasks[index - 1] : undefined;
      const previousHistory = taskResults[taskResults.length - 1]?.history ?? [];
      const continueFromCurrentPage =
        !isBrowserErrorPage(page.url()) &&
        shouldContinueFromCurrentPage({
          previousTask,
          currentTask: task,
          previousHistory
        });

      if (continueFromCurrentPage) {
        rawEvents.push({
          type: "task_continuation",
          time: new Date().toISOString(),
          task: task.name,
          url: page.url(),
          note: `Continuing '${task.name}' from the current page because it appears to be the next compact step in the same flow rather than an independent resettable task.`
        });
        taskNotes.push("This task continued from the previous task's final page state because the submitted steps appeared to form one compact flow.");
        await sleep(config.actionDelayMs);
      } else {
        const resetNavigation = await navigateToBaseUrl({
          page,
          baseUrl: options.baseUrl,
          rawEvents,
          phase: "task_reset",
          taskName: task.name,
          taskNotes
        });
        if (resetNavigation.success) {
          await sleep(config.actionDelayMs);
        }
      }

      for (let step = 1; step <= perTaskStepCap; step += 1) {
        if (currentTaskRef) {
          currentTaskRef.step = Math.max(currentTaskRef.step, step - 1) + 1;
        }
        const activeStep = currentTaskRef ? currentTaskRef.step : step;
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
              step: activeStep,
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
              step: activeStep,
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
                const refreshedSiteBriefResolution = await deriveSiteBrief({
                  pageState: refreshedPageState,
                  llm
                });
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

                if (refreshedSiteBriefResolution.fallbackReason) {
                  warn(`Site brief refresh fallback for '${options.baseUrl}': ${refreshedSiteBriefResolution.fallbackReason}`);
                }
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
                target_id: "",
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
            remainingSeconds: Math.max(1, Math.floor((sessionDeadline - Date.now()) / 1000)),
            tradeOptions,
            llm
          });
        let decision = planning.decision;

        if (planning.fallbackReason) {
          rawEvents.push({
            type: "planner_fallback",
            time: new Date().toISOString(),
            task: task.name,
            step: activeStep,
            url: pageState.url,
            note: `Planner request did not finish cleanly, so a deterministic fallback action was used (${decision.action}${decision.target ? ` '${decision.target}'` : ""}): ${planning.fallbackReason}`
          });
          taskNotes.push(
            `The agent used a heuristic fallback action at step ${activeStep} because the planner did not respond in time: ${planning.fallbackReason}`
          );
          warn(`Planner fallback for '${task.name}' step ${activeStep} at '${pageState.url}': ${planning.fallbackReason}`);
        }

        const metaMaskFlowLooksPending =
          Boolean(metamaskExtensionPath) &&
          (pageLooksLikeWalletFlowIsPending(pageState) ||
            metaMaskRuntimeState.activePopupCount > 0 ||
            Date.now() - metaMaskRuntimeState.lastDetectedAt < 15000 ||
            Date.now() - metaMaskRuntimeState.lastActionAt < 10000);

        if (!shouldStop && decision.action === "stop" && metaMaskFlowLooksPending) {
          rawEvents.push({
            type: "metamask_pending_wait",
            time: new Date().toISOString(),
            task: task.name,
            step: activeStep,
            url: pageState.url,
            note: "A MetaMask interaction still appears to be in flight, so the runner will wait instead of stopping early."
          });
          decision = {
            thought:
              "A MetaMask interaction appears to still be pending, so pause briefly instead of stopping while the wallet popup opens or finishes auto-approval.",
            stepNumber: null,
            instructionQuote: decision.instructionQuote,
            action: "wait",
            target_id: "",
            target: "",
            text: "",
            expectation: "The MetaMask popup should appear, update, or finish auto-approval.",
            friction: "low"
          };
        }

        let preparedClickResolution =
          !shouldStop && decision.action === "click"
            ? await prepareClickDecision(page, decision)
            : null;
        const walletConnectClickDetected =
          !shouldStop && decision.action === "click"
            ? await decisionLooksLikeWalletConnect({
                pageState,
                decision,
                ...(preparedClickResolution?.preparedClick?.locator
                  ? { locator: preparedClickResolution.preparedClick.locator }
                  : {})
              })
            : false;

        if (!shouldStop && walletConnectClickDetected && walletConnectAttempt) {
          rawEvents.push({
            type: "wallet_connect_repeat_prevented",
            time: new Date().toISOString(),
            task: task.name,
            step: activeStep,
            url: pageState.url,
            note: `Skipped a repeated wallet-connect click because '${walletConnectAttempt.target}' was already clicked during '${walletConnectAttempt.taskName}' step ${walletConnectAttempt.step}.`
          });
          decision = {
            thought:
              metaMaskFlowLooksPending
                ? "A Connect Wallet click already happened earlier in this run, so wait for that wallet flow to resolve instead of clicking the trigger again."
                : "Connect Wallet was already clicked once, and there is no wallet popup or page transition currently in flight, so stop instead of waiting on the same unchanged step.",
            stepNumber: decision.stepNumber,
            instructionQuote: decision.instructionQuote,
            action: metaMaskFlowLooksPending ? "wait" : "stop",
            target_id: "",
            target: "",
            text: "",
            expectation: metaMaskFlowLooksPending
              ? "The existing wallet connection flow should complete or expose a clearer next step without opening duplicate requests."
              : "Stop this task and report that the single allowed wallet-connect click did not lead to a visible wallet flow or page change.",
            friction: metaMaskFlowLooksPending ? "low" : "high"
          };
          preparedClickResolution = null;
        } else if (walletConnectClickDetected && preparedClickResolution?.preparedClick && !walletConnectAttempt) {
          walletConnectAttempt = {
            taskName: task.name,
            step: activeStep,
            target: (await readLocatorLabel(preparedClickResolution.preparedClick.locator)) || decision.target || "Connect Wallet"
          };
        }

        const beforeScreenshotPath =
          decision.action === "click"
            ? await captureInteractionScreenshot({
                page,
                runDir: options.runDir,
                taskName: task.name,
                taskIndex: index,
                step: activeStep,
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
          : decision.action === "trade"
            ? await executeTradeHandoff({
                pageState,
                taskName: task.name,
                taskGoal: task.goal,
                runDir: options.runDir,
                tradeOptions,
                rawEvents
              })
          : decision.action === "click" && preparedClickResolution && !preparedClickResolution.preparedClick
            ? {
                success: false,
                note: preparedClickResolution.note ?? `Could not find clickable element for '${decision.target.trim()}'`
              }
            : await executeDecision(page, decision, preparedClickResolution?.preparedClick, {
                singleClickAttempt: walletConnectClickDetected
              });
        const afterScreenshotPath =
          decision.action === "click"
            ? await captureInteractionScreenshot({
                page,
                runDir: options.runDir,
                taskName: task.name,
                taskIndex: index,
                step: activeStep,
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
          step: activeStep,
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

        // After a successful OTP-trigger click, attempt to retrieve and fill the OTP code
        if (
          decision.action === "click" &&
          result.success &&
          OTP_TRIGGER_CLICK_PATTERN.test(decision.target || "")
        ) {
          rawEvents.push({
            type: "otp_trigger_detected",
            time: new Date().toISOString(),
            task: task.name,
            step,
            note: `Detected OTP trigger click on '${decision.target}'. Will attempt to retrieve OTP from email.`
          });

          const otpResult = await attemptOtpRetrieval({
            page,
            baseUrl: options.baseUrl,
            rawEvents,
            taskName: task.name,
            step
          });

          if (otpResult.filled) {
            taskNotes.push(`OTP code was retrieved from email and filled into the verification field.`);
          } else if (otpResult.error) {
            taskNotes.push(`OTP retrieval: ${otpResult.error}`);
            
            // Halt execution completely if OTP retrieval fails so the agent does not wander
            result.success = false;
            result.stop = true;
            result.note += ` (Stopped due to OTP retrieval failure: ${otpResult.error})`;
            history[history.length - 1]!.result = result;
            break;
          }
        }

        if (result.success && taskShouldEndAfterSuccessfulCompactStep(task.goal, history)) {
          rawEvents.push({
            type: "compact_task_completed",
            time: new Date().toISOString(),
            task: task.name,
            step: activeStep,
            url: page.url(),
            note: `Completed the explicit compact task '${task.goal}' and will continue to the next accepted task instead of exploring additional controls in the same view.`
          });
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
    const siteChecksBrowser = browser ?? context?.browser() ?? null;
    const remainingSiteChecksBudgetMs = Math.max(0, sessionDeadline - Date.now());
    if (siteChecksBrowser) {
      siteChecks = await runSiteChecks({
        browser: siteChecksBrowser,
        baseUrl: options.baseUrl,
        ignoreHttpsErrors: Boolean(options.ignoreHttpsErrors),
        browserTimezone,
        storageState: currentStorageState,
        rawEvents,
        taskResults,
        budgetMs: remainingSiteChecksBudgetMs
      });
    } else {
      rawEvents.push({
        type: "site_checks_skipped",
        time: new Date().toISOString(),
        note: "Skipped site checks because no browser instance was available after the MetaMask session."
      });
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

    // Clean up the signing relay if it was started
    if (signingRelay) {
      await signingRelay.close().catch(() => undefined);
    }
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
