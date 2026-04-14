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
import { clampRunDurationMs, config } from "../config.js";
import { ensureDir, writeJson } from "../utils/files.js";
import { captureInboxCheckpoint, waitForVerificationEmail, type InboxCheckpoint } from "./inbox.js";
import {
  authSettings,
  createAuthIdentityPlan,
  getMailboxConfig,
  resolveAuthSessionStatePath,
  type AuthIdentity
} from "./profile.js";

type AuthEvent = {
  type: string;
  time: string;
  note: string;
  [key: string]: unknown;
};

type VisibleSnapshot = {
  url: string;
  title: string;
  textSnippet: string;
};

type VisibleField = {
  marker: string;
  tag: string;
  inputType: string;
  label: string;
  placeholder: string;
  name: string;
  id: string;
  autocomplete: string;
  inputMode: string;
  required: boolean;
  disabled: boolean;
  value: string;
  maxLength: number | null;
  options: string[];
};

type VisibleCheckbox = {
  marker: string;
  label: string;
  checked: boolean;
  required: boolean;
  disabled: boolean;
};

type AuthFieldKind =
  | "email"
  | "username"
  | "password"
  | "confirmPassword"
  | "fullName"
  | "firstName"
  | "lastName"
  | "phone"
  | "addressLine1"
  | "addressLine2"
  | "city"
  | "state"
  | "postalCode"
  | "country"
  | "company"
  | "otp";

type AuthStatus = "authenticated" | "partial_success" | "failed";

export type AuthFlowResult = {
  status: AuthStatus;
  finalUrl: string;
  finalTitle: string;
  accessConfirmed: boolean;
  verificationMethod: "otp" | "link" | "none";
  runDir: string;
  savedStorageStatePath?: string;
  error?: string;
};

export type AuthFlowExecutionResult = AuthFlowResult & {
  accountEmail: string;
  events: AuthEvent[];
};

export type AuthWallDetection = {
  required: boolean;
  reason: string;
  kind: "login" | "signup" | "verification" | "unknown";
};

const SIGNUP_ENTRY_LABELS = [
  "sign up",
  "signup",
  "register",
  "create account",
  "get started",
  "join now",
  "start free trial",
  "start trial",
  "try free"
];

const LOGIN_ENTRY_LABELS = [
  "log in",
  "login",
  "sign in",
  "signin",
  "existing account",
  "already have an account"
];

const SIGNUP_SUBMIT_LABELS = [
  "create account",
  "sign up",
  "signup",
  "register",
  "continue",
  "next",
  "get started",
  "submit",
  "verify email",
  "send code"
];

const LOGIN_SUBMIT_LABELS = [
  "log in",
  "login",
  "sign in",
  "signin",
  "continue",
  "submit",
  "verify",
  "next"
];

const VERIFY_SUBMIT_LABELS = [
  "verify",
  "confirm",
  "continue",
  "submit",
  "finish",
  "complete",
  "activate"
];

const AUTHENTICATED_SIGNAL_PATTERNS = [
  /log out/i,
  /logout/i,
  /sign out/i,
  /my account/i,
  /account settings/i,
  /profile/i,
  /dashboard/i,
  /billing/i
];

const VERIFICATION_SIGNAL_PATTERNS = [
  /check your email/i,
  /verify your email/i,
  /verification code/i,
  /one[- ]time passcode/i,
  /one[- ]time code/i,
  /enter the code/i,
  /confirm your email/i,
  /activation link/i
];

const EXISTING_ACCOUNT_PATTERNS = [
  /already (?:have|has) an account/i,
  /already exists/i,
  /email.*already.*use/i,
  /account already/i,
  /user already/i
];

const AUTH_WALL_TEXT_PATTERNS = [
  /log in/i,
  /login/i,
  /sign in/i,
  /signin/i,
  /sign up/i,
  /signup/i,
  /register/i,
  /create account/i,
  /already have an account/i
];

const AUTH_WALL_EXCLUSION_PATTERNS = [/newsletter/i, /subscribe/i, /marketing emails?/i];

type SignupAttemptOutcome = "existing_account" | "verification" | "authenticated" | "stalled";

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

  const imported = (await import("@sparticuz/chromium")) as ServerlessChromiumModule;
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
  return message.replace(/\u001b\[[0-9;]*m/g, "").replace(/\s+/g, " ").trim() || "Unknown error";
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function summarizeLocalPath(filePath: string): string {
  const relativePath = path.relative(process.cwd(), filePath);
  return relativePath && relativePath !== "" && !relativePath.startsWith("..") ? relativePath : filePath;
}

function pushEvent(events: AuthEvent[], type: string, note: string, extra: Record<string, unknown> = {}): void {
  events.push({
    type,
    time: new Date().toISOString(),
    note,
    ...extra
  });
}

async function readVisibleSnapshot(page: Page): Promise<VisibleSnapshot> {
  return {
    url: page.url(),
    title: await page.title().catch(() => ""),
    textSnippet: normalizeText(await page.locator("body").innerText().catch(() => "")).slice(0, 1200)
  };
}

function visibleStateChanged(before: VisibleSnapshot, after: VisibleSnapshot): boolean {
  return before.url !== after.url || before.title !== after.title || before.textSnippet !== after.textSnippet;
}

async function firstVisible(
  locators: Array<{ locator: Locator; label: string; strategy: string }>
): Promise<{ locator: Locator; label: string; strategy: string } | null> {
  for (const entry of locators) {
    try {
      if (await entry.locator.first().isVisible({ timeout: 1200 })) {
        return { locator: entry.locator.first(), label: entry.label, strategy: entry.strategy };
      }
    } catch {
      // continue
    }
  }

  return null;
}

function buildActionLocators(page: Page, labels: string[]): Array<{ locator: Locator; label: string; strategy: string }> {
  return labels.flatMap((label) => [
    { locator: page.getByRole("button", { name: label, exact: false }), label, strategy: "getByRole(button)" },
    { locator: page.getByRole("link", { name: label, exact: false }), label, strategy: "getByRole(link)" },
    { locator: page.getByText(label, { exact: false }), label, strategy: "getByText" }
  ]);
}

async function clickFirstMatchingAction(args: {
  page: Page;
  labels: string[];
  events: AuthEvent[];
  eventType: string;
  optional?: boolean;
}): Promise<boolean> {
  const match = await firstVisible(buildActionLocators(args.page, args.labels));
  if (!match) {
    if (!args.optional) {
      pushEvent(args.events, `${args.eventType}_missing`, `Could not find any visible action matching: ${args.labels.join(", ")}`);
    }

    return false;
  }

  const before = await readVisibleSnapshot(args.page);
  const startedAt = Date.now();

  await match.locator.click({ timeout: 5000 }).catch(async () => {
    await match.locator.click({ force: true, timeout: 5000 });
  });
  await args.page.waitForLoadState("domcontentloaded").catch(() => undefined);
  await args.page.waitForTimeout(config.actionDelayMs);

  const after = await readVisibleSnapshot(args.page);
  pushEvent(
    args.events,
    args.eventType,
    `Clicked '${match.label}' using ${match.strategy}.`,
    {
      label: match.label,
      strategy: match.strategy,
      elapsedMs: Date.now() - startedAt,
      stateChanged: visibleStateChanged(before, after),
      destinationUrl: after.url,
      destinationTitle: after.title
    }
  );

  return true;
}

async function gotoUrl(page: Page, url: string, events: AuthEvent[], eventType: string): Promise<void> {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(config.actionDelayMs);
  const snapshot = await readVisibleSnapshot(page);
  pushEvent(events, eventType, `Navigated to ${url}.`, {
    destinationUrl: snapshot.url,
    destinationTitle: snapshot.title
  });
}

async function collectVisibleFields(page: Page): Promise<VisibleField[]> {
  return page.evaluate(() => {
    const fields: VisibleField[] = [];
    const elements = Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input, textarea, select"));
    let visibleIndex = 0;

    for (const element of elements) {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      const inputType = element instanceof HTMLInputElement ? (element.type || "text").replace(/\s+/g, " ").trim().toLowerCase() : "";

      if (
        rect.width <= 0 ||
        rect.height <= 0 ||
        style.visibility === "hidden" ||
        style.display === "none" ||
        element.disabled ||
        inputType === "hidden" ||
        inputType === "submit" ||
        inputType === "button" ||
        inputType === "image"
      ) {
        continue;
      }

      visibleIndex += 1;
      const marker = String(visibleIndex);
      element.setAttribute("data-site-agent-auth-field", marker);

      const labelParts: string[] = [];
      if ("labels" in element && element.labels) {
        for (const label of Array.from(element.labels)) {
          const labelText = (label.innerText || label.textContent || "").replace(/\s+/g, " ").trim();
          if (labelText) {
            labelParts.push(labelText);
          }
        }
      }

      const ariaLabelledBy = element.getAttribute("aria-labelledby");
      if (ariaLabelledBy) {
        for (const id of ariaLabelledBy.split(/\s+/)) {
          const labelElement = document.getElementById(id);
          if (!labelElement) {
            continue;
          }

          const labelText = (labelElement.textContent || "").replace(/\s+/g, " ").trim();
          if (labelText) {
            labelParts.push(labelText);
          }
        }
      }

      const closestLabel = element.closest("label");
      if (closestLabel) {
        const labelText = (closestLabel.innerText || closestLabel.textContent || "").replace(/\s+/g, " ").trim();
        if (labelText) {
          labelParts.push(labelText);
        }
      }

      const ariaLabel = (element.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
      if (ariaLabel) {
        labelParts.push(ariaLabel);
      }

      const options: string[] = [];
      if (element instanceof HTMLSelectElement) {
        for (const option of Array.from(element.options)) {
          const optionText = (option.textContent || "").replace(/\s+/g, " ").trim();
          if (optionText && options.length < 120) {
            options.push(optionText);
          }
        }
      }

      fields.push({
        marker,
        tag: element.tagName.toLowerCase(),
        inputType: inputType || element.tagName.toLowerCase(),
        label: labelParts.join(" ").replace(/\s+/g, " ").trim(),
        placeholder: (element.getAttribute("placeholder") || "").replace(/\s+/g, " ").trim(),
        name: (element.getAttribute("name") || "").replace(/\s+/g, " ").trim(),
        id: (element.id || "").replace(/\s+/g, " ").trim(),
        autocomplete: (element.getAttribute("autocomplete") || "").replace(/\s+/g, " ").trim().toLowerCase(),
        inputMode: (element.getAttribute("inputmode") || "").replace(/\s+/g, " ").trim().toLowerCase(),
        required: element.required || element.getAttribute("aria-required") === "true",
        disabled: element.disabled,
        value:
          element instanceof HTMLSelectElement
            ? (element.selectedOptions[0]?.textContent || "").replace(/\s+/g, " ").trim()
            : (element.value || "").replace(/\s+/g, " ").trim(),
        maxLength:
          element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
            ? element.maxLength > 0
              ? element.maxLength
              : null
            : null,
        options
      });
    }

    return fields;
  });
}

async function collectVisibleCheckboxes(page: Page): Promise<VisibleCheckbox[]> {
  return page.evaluate(() => {
    const checkboxes: VisibleCheckbox[] = [];
    const elements = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
    let visibleIndex = 0;

    for (const element of elements) {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      if (
        rect.width <= 0 ||
        rect.height <= 0 ||
        style.visibility === "hidden" ||
        style.display === "none" ||
        element.disabled
      ) {
        continue;
      }

      visibleIndex += 1;
      const marker = String(visibleIndex);
      element.setAttribute("data-site-agent-auth-checkbox", marker);

      const labels: string[] = [];
      if (element.labels) {
        for (const label of Array.from(element.labels)) {
          const labelText = (label.innerText || label.textContent || "").replace(/\s+/g, " ").trim();
          if (labelText) {
            labels.push(labelText);
          }
        }
      }

      const closestLabel = element.closest("label");
      if (closestLabel) {
        const labelText = (closestLabel.innerText || closestLabel.textContent || "").replace(/\s+/g, " ").trim();
        if (labelText) {
          labels.push(labelText);
        }
      }

      const ariaLabel = (element.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
      if (ariaLabel) {
        labels.push(ariaLabel);
      }

      checkboxes.push({
        marker,
        label: labels.join(" ").replace(/\s+/g, " ").trim(),
        checked: element.checked,
        required: element.required || element.getAttribute("aria-required") === "true",
        disabled: element.disabled
      });
    }

    return checkboxes;
  });
}

function buildFieldKey(field: VisibleField): string {
  return normalizeText(
    [field.label, field.placeholder, field.name, field.id, field.autocomplete, field.inputType, field.inputMode].join(" ").toLowerCase()
  );
}

function inferFieldKind(field: VisibleField): AuthFieldKind | null {
  const key = buildFieldKey(field);

  if (field.autocomplete === "one-time-code" || /otp|one[- ]?time|verification|passcode|security code|auth code/.test(key)) {
    return "otp";
  }

  if (field.inputType === "email" || /\bemail\b|e-mail/.test(key)) {
    return "email";
  }

  if (/user.?name/.test(key)) {
    return "username";
  }

  if (field.inputType === "password" && /confirm|repeat|again/.test(key)) {
    return "confirmPassword";
  }

  if (field.inputType === "password") {
    return "password";
  }

  if (/first.?name|given.?name/.test(key)) {
    return "firstName";
  }

  if (/last.?name|family.?name|surname/.test(key)) {
    return "lastName";
  }

  if (/full.?name/.test(key) || (/\bname\b/.test(key) && !/company|business|organization/.test(key))) {
    return "fullName";
  }

  if (field.inputType === "tel" || /phone|mobile|telephone|tel\b/.test(key)) {
    return "phone";
  }

  if (/address.*line.*2|address 2|suite|unit|apt|apartment/.test(key)) {
    return "addressLine2";
  }

  if (/street|address/.test(key)) {
    return "addressLine1";
  }

  if (/city|town/.test(key)) {
    return "city";
  }

  if (/state|province|region/.test(key)) {
    return "state";
  }

  if (/zip|postal/.test(key)) {
    return "postalCode";
  }

  if (/country/.test(key)) {
    return "country";
  }

  if (/company|organization|business/.test(key)) {
    return "company";
  }

  return null;
}

function fieldValueForKind(kind: AuthFieldKind, identity: AuthIdentity, otpCode?: string): string | undefined {
  switch (kind) {
    case "email":
    case "username":
      return identity.email;
    case "password":
    case "confirmPassword":
      return identity.password;
    case "fullName":
      return identity.fullName;
    case "firstName":
      return identity.firstName;
    case "lastName":
      return identity.lastName;
    case "phone":
      return identity.phone;
    case "addressLine1":
      return identity.addressLine1;
    case "addressLine2":
      return identity.addressLine2;
    case "city":
      return identity.city;
    case "state":
      return identity.state;
    case "postalCode":
      return identity.postalCode;
    case "country":
      return identity.country;
    case "company":
      return identity.company;
    case "otp":
      return otpCode;
    default:
      return undefined;
  }
}

function fieldAllowedInPhase(kind: AuthFieldKind, phase: "signup" | "login" | "otp"): boolean {
  if (phase === "otp") {
    return kind === "otp";
  }

  if (phase === "login") {
    return kind === "email" || kind === "username" || kind === "password";
  }

  return kind !== "otp";
}

async function selectOption(locator: Locator, field: VisibleField, value: string): Promise<void> {
  const desiredOptions = [value];
  if (field.options.some((option) => option.toLowerCase() === "united states of america")) {
    desiredOptions.push("United States of America");
  }

  for (const desired of desiredOptions) {
    try {
      await locator.selectOption({ label: desired });
      return;
    } catch {
      // continue
    }
  }

  const matchingOption = field.options.find((option) => normalizeText(option).toLowerCase() === normalizeText(value).toLowerCase());
  if (matchingOption) {
    await locator.selectOption({ label: matchingOption });
    return;
  }

  throw new Error(`No select option matched '${value}'.`);
}

async function fillFields(args: {
  page: Page;
  identity: AuthIdentity;
  phase: "signup" | "login" | "otp";
  events: AuthEvent[];
  otpCode?: string;
}): Promise<number> {
  const fields = await collectVisibleFields(args.page);
  let filledCount = 0;

  for (const field of fields) {
    const kind = inferFieldKind(field);
    if (!kind || !fieldAllowedInPhase(kind, args.phase)) {
      continue;
    }

    const value = fieldValueForKind(kind, args.identity, args.otpCode);
    if (!value) {
      continue;
    }

    const currentValue = normalizeText(field.value).toLowerCase();
    if (currentValue === normalizeText(value).toLowerCase()) {
      continue;
    }

    const locator = args.page.locator(`[data-site-agent-auth-field="${field.marker}"]`);
    try {
      if (field.tag === "select") {
        await selectOption(locator, field, value);
      } else {
        await locator.fill(value);
      }

      filledCount += 1;
      pushEvent(args.events, `${args.phase}_field_filled`, `Filled ${kind} field '${field.label || field.name || field.id || field.placeholder}'.`, {
        fieldKind: kind,
        fieldLabel: field.label || field.name || field.id || field.placeholder
      });
    } catch (error) {
      pushEvent(
        args.events,
        `${args.phase}_field_fill_error`,
        `Failed to fill ${kind} field '${field.label || field.name || field.id || field.placeholder}': ${cleanErrorMessage(error)}.`,
        {
          fieldKind: kind,
          fieldLabel: field.label || field.name || field.id || field.placeholder
        }
      );
    }
  }

  return filledCount;
}

async function checkRequiredBoxes(page: Page, events: AuthEvent[]): Promise<number> {
  const checkboxes = await collectVisibleCheckboxes(page);
  let checkedCount = 0;

  for (const checkbox of checkboxes) {
    if (checkbox.checked || checkbox.disabled) {
      continue;
    }

    const key = checkbox.label.toLowerCase();
    const isTermsBox = /agree|accept|terms|privacy|conditions|policy/.test(key);
    if (!checkbox.required && !isTermsBox) {
      continue;
    }

    const locator = page.locator(`[data-site-agent-auth-checkbox="${checkbox.marker}"]`);
    await locator.check({ force: true }).catch(() => undefined);
    checkedCount += 1;
    pushEvent(events, "signup_checkbox_checked", `Checked '${checkbox.label || "required checkbox"}'.`, {
      label: checkbox.label
    });
  }

  return checkedCount;
}

async function pageContainsPattern(page: Page, patterns: RegExp[]): Promise<boolean> {
  const snapshot = await readVisibleSnapshot(page);
  return patterns.some((pattern) => pattern.test(`${snapshot.title} ${snapshot.textSnippet}`));
}

async function hasFieldKind(page: Page, kinds: AuthFieldKind[]): Promise<boolean> {
  const fields = await collectVisibleFields(page);
  return fields.some((field) => {
    const kind = inferFieldKind(field);
    return kind ? kinds.includes(kind) : false;
  });
}

async function hasLoginForm(page: Page): Promise<boolean> {
  return (await hasFieldKind(page, ["email", "username"])) && (await hasFieldKind(page, ["password"]));
}

async function hasOtpField(page: Page): Promise<boolean> {
  return hasFieldKind(page, ["otp"]);
}

async function isProbablyAuthenticated(page: Page): Promise<boolean> {
  if (await hasLoginForm(page)) {
    return false;
  }

  const snapshot = await readVisibleSnapshot(page);
  const haystack = `${snapshot.title} ${snapshot.textSnippet}`;

  if (AUTHENTICATED_SIGNAL_PATTERNS.some((pattern) => pattern.test(haystack))) {
    return true;
  }

  return !/login|sign in|sign up|register|verify/i.test(new URL(snapshot.url).pathname);
}

function isAuthGateUrl(url: string): boolean {
  try {
    const { pathname } = new URL(url);
    return /login|sign-in|signin|register|signup|sign-up|verify|confirmation|activate/i.test(pathname);
  } catch {
    return false;
  }
}

export async function detectAuthWall(page: Page): Promise<AuthWallDetection> {
  if (await hasOtpField(page)) {
    return {
      required: true,
      reason: "The page is asking for a verification or one-time code.",
      kind: "verification"
    };
  }

  if (await hasLoginForm(page)) {
    return {
      required: true,
      reason: "A visible login form is blocking access to the destination.",
      kind: "login"
    };
  }

  if (await pageContainsPattern(page, VERIFICATION_SIGNAL_PATTERNS)) {
    return {
      required: true,
      reason: "The page is asking the visitor to verify an email before continuing.",
      kind: "verification"
    };
  }

  const hasEntryFields = (await hasFieldKind(page, ["email", "username"])) || (await hasFieldKind(page, ["password"]));
  const snapshot = await readVisibleSnapshot(page);
  const haystack = `${snapshot.url} ${snapshot.title} ${snapshot.textSnippet}`;

  if (
    hasEntryFields &&
    AUTH_WALL_TEXT_PATTERNS.some((pattern) => pattern.test(haystack)) &&
    !AUTH_WALL_EXCLUSION_PATTERNS.some((pattern) => pattern.test(haystack))
  ) {
    return {
      required: true,
      reason: "The page is presenting visible login or registration copy instead of the requested content.",
      kind: /log in|login|sign in|signin/i.test(haystack) ? "login" : "signup"
    };
  }

  if (isAuthGateUrl(snapshot.url)) {
    return {
      required: true,
      reason: "The current URL path looks like an auth gate.",
      kind: "unknown"
    };
  }

  return {
    required: false,
    reason: "No obvious auth wall was detected.",
    kind: "unknown"
  };
}

async function ensureSignupEntry(args: {
  page: Page;
  signupUrl?: string | undefined;
  baseUrl: string;
  events: AuthEvent[];
}): Promise<void> {
  await gotoUrl(args.page, args.signupUrl ?? args.baseUrl, args.events, "signup_navigation");

  if ((await hasFieldKind(args.page, ["email"])) || (await pageContainsPattern(args.page, [/sign up|register|create account/i]))) {
    return;
  }

  await clickFirstMatchingAction({
    page: args.page,
    labels: SIGNUP_ENTRY_LABELS,
    events: args.events,
    eventType: "signup_entry_click",
    optional: true
  });
}

async function ensureLoginEntry(args: {
  page: Page;
  loginUrl?: string | undefined;
  baseUrl: string;
  events: AuthEvent[];
}): Promise<void> {
  if (args.loginUrl) {
    await gotoUrl(args.page, args.loginUrl, args.events, "login_navigation");
  }

  if (await hasLoginForm(args.page)) {
    return;
  }

  await clickFirstMatchingAction({
    page: args.page,
    labels: LOGIN_ENTRY_LABELS,
    events: args.events,
    eventType: "login_entry_click",
    optional: true
  });
}

async function submitPhase(args: {
  page: Page;
  phase: "signup" | "login" | "verify";
  events: AuthEvent[];
}): Promise<boolean> {
  const labels =
    args.phase === "signup" ? SIGNUP_SUBMIT_LABELS : args.phase === "login" ? LOGIN_SUBMIT_LABELS : VERIFY_SUBMIT_LABELS;

  return clickFirstMatchingAction({
    page: args.page,
    labels,
    events: args.events,
    eventType: `${args.phase}_submit_click`,
    optional: false
  });
}

async function attemptSignupWithIdentity(args: {
  page: Page;
  identity: AuthIdentity;
  events: AuthEvent[];
  mailboxCheckpoint?: InboxCheckpoint | undefined;
}): Promise<{ checkpoint: InboxCheckpoint | undefined; outcome: SignupAttemptOutcome }> {
  let checkpoint = args.mailboxCheckpoint;

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const filledCount = await fillFields({
      page: args.page,
      identity: args.identity,
      phase: "signup",
      events: args.events
    });
    await checkRequiredBoxes(args.page, args.events);

    if (await hasOtpField(args.page)) {
      pushEvent(args.events, "signup_requires_otp", "Signup flow reached an on-page OTP step.");
      return { checkpoint, outcome: "verification" };
    }

    if (await pageContainsPattern(args.page, EXISTING_ACCOUNT_PATTERNS)) {
      pushEvent(args.events, "signup_existing_account", "Signup page indicates the account already exists.", {
        accountEmail: args.identity.email
      });
      return { checkpoint, outcome: "existing_account" };
    }

    if (await pageContainsPattern(args.page, VERIFICATION_SIGNAL_PATTERNS)) {
      pushEvent(args.events, "signup_verification_prompt", "Signup page is asking for email verification.");
      return { checkpoint, outcome: "verification" };
    }

    if (await isProbablyAuthenticated(args.page)) {
      pushEvent(args.events, "signup_authenticated", "Signup flow appears to have already produced an authenticated session.");
      return { checkpoint, outcome: "authenticated" };
    }

    if (!checkpoint) {
      const mailbox = getMailboxConfig();
      if (mailbox) {
        checkpoint = await captureInboxCheckpoint(mailbox);
        pushEvent(args.events, "mailbox_checkpoint", `Captured mailbox checkpoint at UID ${checkpoint.uidNext}.`, {
          uidNext: checkpoint.uidNext
        });
      }
    }

    const submitted = await submitPhase({
      page: args.page,
      phase: "signup",
      events: args.events
    });

    if (!submitted && filledCount === 0) {
      break;
    }

    if (await pageContainsPattern(args.page, EXISTING_ACCOUNT_PATTERNS)) {
      pushEvent(args.events, "signup_existing_account", "Signup submission indicates the account already exists.", {
        accountEmail: args.identity.email
      });
      return { checkpoint, outcome: "existing_account" };
    }

    if ((await hasOtpField(args.page)) || (await pageContainsPattern(args.page, VERIFICATION_SIGNAL_PATTERNS))) {
      return { checkpoint, outcome: "verification" };
    }

    if (await isProbablyAuthenticated(args.page)) {
      return { checkpoint, outcome: "authenticated" };
    }
  }

  return { checkpoint, outcome: "stalled" };
}

async function driveSignup(args: {
  page: Page;
  baseUrl: string;
  signupUrl?: string | undefined;
  events: AuthEvent[];
  mailboxCheckpoint?: InboxCheckpoint | undefined;
}): Promise<{ checkpoint: InboxCheckpoint | undefined; identity: AuthIdentity }> {
  const identityPlan = createAuthIdentityPlan();
  let checkpoint = args.mailboxCheckpoint;
  let activeIdentity = identityPlan.identities[0]!;

  for (const [index, identity] of identityPlan.identities.entries()) {
    activeIdentity = identity;
    pushEvent(args.events, "signup_identity_attempt", `Attempting signup with test identity ${index + 1}/${identityPlan.maxAttempts}.`, {
      accountEmail: identity.email,
      attempt: index + 1,
      maxAttempts: identityPlan.maxAttempts
    });

    await ensureSignupEntry({
      page: args.page,
      signupUrl: args.signupUrl,
      baseUrl: args.baseUrl,
      events: args.events
    });

    const result = await attemptSignupWithIdentity({
      page: args.page,
      identity,
      events: args.events,
      mailboxCheckpoint: checkpoint
    });
    checkpoint = result.checkpoint;

    if (result.outcome !== "existing_account") {
      return { checkpoint, identity };
    }

    if (index < identityPlan.identities.length - 1) {
      checkpoint = undefined;
      pushEvent(
        args.events,
        "signup_identity_retry",
        `Signup rejected '${identity.email}' as an existing account, so the runner will retry with a fresh generated identity.`,
        {
          accountEmail: identity.email,
          nextAttempt: index + 2
        }
      );
    }
  }

  return { checkpoint, identity: activeIdentity };
}

async function handleVerification(args: {
  page: Page;
  events: AuthEvent[];
  baseUrl: string;
  identity: AuthIdentity;
  checkpoint?: InboxCheckpoint | undefined;
}): Promise<"otp" | "link" | "none"> {
  const needsVerification = (await hasOtpField(args.page)) || (await pageContainsPattern(args.page, VERIFICATION_SIGNAL_PATTERNS));
  if (!needsVerification) {
    return "none";
  }

  const mailbox = getMailboxConfig();
  if (!mailbox) {
    throw new Error("The page is asking for email verification, but AUTH_IMAP_* mailbox settings are not configured.");
  }

  const effectiveCheckpoint = args.checkpoint ?? (await captureInboxCheckpoint(mailbox));
  const siteHost = new URL(args.baseUrl).hostname;
  const message = await waitForVerificationEmail({
    mailbox,
    checkpoint: effectiveCheckpoint,
    siteHost
  });

  pushEvent(args.events, "verification_email_received", `Received verification email '${message.subject}'.`, {
    receivedAt: message.receivedAt,
    from: message.from,
    hasOtpCode: Boolean(message.otpCode),
    hasVerificationLink: Boolean(message.verificationLink)
  });

  if ((await hasOtpField(args.page)) && message.otpCode) {
    await fillFields({
      page: args.page,
      identity: args.identity,
      phase: "otp",
      events: args.events,
      otpCode: message.otpCode
    });
    await submitPhase({
      page: args.page,
      phase: "verify",
      events: args.events
    });
    pushEvent(args.events, "otp_submitted", "Submitted OTP from verification email.");
    return "otp";
  }

  if (message.verificationLink) {
    await gotoUrl(args.page, message.verificationLink, args.events, "verification_link_navigation");
    return "link";
  }

  throw new Error("A verification email arrived, but no usable OTP code or verification link could be extracted.");
}

async function driveLogin(args: {
  page: Page;
  identity: AuthIdentity;
  baseUrl: string;
  loginUrl?: string | undefined;
  events: AuthEvent[];
}): Promise<void> {
  if (await isProbablyAuthenticated(args.page)) {
    return;
  }

  await ensureLoginEntry({
    page: args.page,
    loginUrl: args.loginUrl,
    baseUrl: args.baseUrl,
    events: args.events
  });

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const filledCount = await fillFields({
      page: args.page,
      identity: args.identity,
      phase: "login",
      events: args.events
    });

    if (filledCount === 0 && !(await hasLoginForm(args.page))) {
      break;
    }

    await submitPhase({
      page: args.page,
      phase: "login",
      events: args.events
    });

    if (await isProbablyAuthenticated(args.page)) {
      pushEvent(args.events, "login_authenticated", "Login flow appears to have produced an authenticated session.");
      return;
    }
  }
}

async function confirmAccess(args: {
  page: Page;
  accessUrl?: string | undefined;
  events: AuthEvent[];
}): Promise<boolean> {
  if (args.accessUrl) {
    await gotoUrl(args.page, args.accessUrl, args.events, "access_navigation");
  }

  const snapshot = await readVisibleSnapshot(args.page);
  const authenticated = await isProbablyAuthenticated(args.page);
  const accessConfirmed = authenticated && !isAuthGateUrl(snapshot.url);

  pushEvent(
    args.events,
    "access_check",
    accessConfirmed
      ? "Protected content appears accessible with the authenticated session."
      : "Protected content still appears gated or redirected to auth.",
    {
      destinationUrl: snapshot.url,
      destinationTitle: snapshot.title
    }
  );

  return accessConfirmed;
}

async function saveStorageState(args: {
  context: BrowserContext | null;
  savePath: string;
  events: AuthEvent[];
}): Promise<string | undefined> {
  if (!args.context) {
    return undefined;
  }

  ensureDir(path.dirname(args.savePath));
  await args.context.storageState({ path: args.savePath });
  const summarizedPath = summarizeLocalPath(args.savePath);
  pushEvent(args.events, "storage_state_saved", `Saved Playwright storage state to '${summarizedPath}'.`, {
    path: summarizedPath
  });
  return summarizedPath;
}

async function executeAuthFlowInContext(args: {
  page: Page;
  context: BrowserContext;
  baseUrl: string;
  runDir: string;
  signupUrl?: string | undefined;
  loginUrl?: string | undefined;
  accessUrl?: string | undefined;
  saveStorageStatePath?: string | undefined;
  events: AuthEvent[];
  deadline: number;
}): Promise<{
  result: AuthFlowResult;
  accountEmail: string;
  verificationMethod: "otp" | "link" | "none";
  savedStorageStatePath?: string;
}> {
  let verificationMethod: "otp" | "link" | "none" = "none";
  let savedStorageStatePath: string | undefined;

  if (Date.now() >= args.deadline) {
    throw new Error("Auth flow ran out of time before it could begin.");
  }

  const signupResult = await driveSignup({
    page: args.page,
    baseUrl: args.baseUrl,
    signupUrl: args.signupUrl,
    events: args.events
  });
  const identity = signupResult.identity;

  if (Date.now() >= args.deadline) {
    throw new Error("Auth flow ran out of time before verification.");
  }

  verificationMethod = await handleVerification({
    page: args.page,
    events: args.events,
    baseUrl: args.baseUrl,
    identity,
    checkpoint: signupResult.checkpoint
  });

  if (Date.now() >= args.deadline) {
    throw new Error("Auth flow ran out of time before login.");
  }

  await driveLogin({
    page: args.page,
    identity,
    baseUrl: args.baseUrl,
    loginUrl: args.loginUrl,
    events: args.events
  });

  const accessConfirmed = await confirmAccess({
    page: args.page,
    accessUrl: args.accessUrl,
    events: args.events
  });

  if (args.saveStorageStatePath) {
    savedStorageStatePath = await saveStorageState({
      context: args.context,
      savePath: args.saveStorageStatePath,
      events: args.events
    });
  }

  const snapshot = await readVisibleSnapshot(args.page);
  return {
    result: {
      status: accessConfirmed ? "authenticated" : "partial_success",
      finalUrl: snapshot.url,
      finalTitle: snapshot.title,
      accessConfirmed,
      verificationMethod,
      runDir: args.runDir,
      ...(savedStorageStatePath ? { savedStorageStatePath } : {})
    },
    accountEmail: identity.email,
    verificationMethod,
    ...(savedStorageStatePath ? { savedStorageStatePath } : {})
  };
}

export async function runAuthFlowInContext(options: {
  page: Page;
  context: BrowserContext;
  baseUrl: string;
  runDir: string;
  signupUrl?: string | undefined;
  loginUrl?: string | undefined;
  accessUrl?: string | undefined;
  saveStorageStatePath?: string | undefined;
  timeoutMs?: number;
  headed?: boolean;
  mobile?: boolean;
}): Promise<AuthFlowExecutionResult> {
  const authFlowPath = path.join(options.runDir, "auth-flow.json");
  const events: AuthEvent[] = [];
  const timeoutMs = clampRunDurationMs(options.timeoutMs ?? config.maxSessionDurationMs);
  const deadline = Date.now() + timeoutMs;
  let verificationMethod: "otp" | "link" | "none" = "none";
  let savedStorageStatePath: string | undefined;
  let accountEmail = "";
  let result: AuthFlowResult = {
    status: "failed",
    finalUrl: options.page.url() || options.baseUrl,
    finalTitle: "",
    accessConfirmed: false,
    verificationMethod,
    runDir: options.runDir
  };

  pushEvent(events, "auth_flow_start", `Starting auth bootstrap for ${options.baseUrl}.`, {
    headed: Boolean(options.headed),
    mobile: Boolean(options.mobile),
    timeoutSeconds: Math.round(timeoutMs / 1000)
  });

  try {
    options.page.setDefaultNavigationTimeout(config.navigationTimeoutMs);
    options.page.setDefaultTimeout(config.navigationTimeoutMs);

    const execution = await executeAuthFlowInContext({
      page: options.page,
      context: options.context,
      baseUrl: options.baseUrl,
      runDir: options.runDir,
      signupUrl: options.signupUrl,
      loginUrl: options.loginUrl,
      accessUrl: options.accessUrl,
      saveStorageStatePath: options.saveStorageStatePath,
      events,
      deadline
    });
    verificationMethod = execution.verificationMethod;
    savedStorageStatePath = execution.savedStorageStatePath;
    accountEmail = execution.accountEmail;
    result = execution.result;
  } catch (error) {
    const snapshot = await readVisibleSnapshot(options.page).catch(() => ({
      url: options.baseUrl,
      title: "",
      textSnippet: ""
    }));

    pushEvent(events, "auth_flow_error", `Auth flow failed: ${cleanErrorMessage(error)}.`);
    result = {
      status: "failed",
      finalUrl: snapshot.url,
      finalTitle: snapshot.title,
      accessConfirmed: false,
      verificationMethod,
      runDir: options.runDir,
      error: cleanErrorMessage(error)
    };
  } finally {
    writeJson(authFlowPath, {
      ...result,
      accountEmail: accountEmail || null,
      savedStorageStatePath: savedStorageStatePath ?? null,
      verificationMethod,
      generatedAt: new Date().toISOString(),
      events
    });
  }

  return {
    ...result,
    accountEmail,
    events
  };
}

export async function runAuthFlow(options: {
  baseUrl: string;
  runDir: string;
  signupUrl?: string | undefined;
  loginUrl?: string | undefined;
  accessUrl?: string | undefined;
  headed?: boolean;
  mobile?: boolean;
  ignoreHttpsErrors?: boolean;
  saveStorageStatePath?: string | undefined;
}): Promise<AuthFlowResult> {
  const saveStorageStatePath = options.saveStorageStatePath ?? resolveAuthSessionStatePath();
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

  let browser: Browser | null = null;
  let context: BrowserContext | null = null;

  try {
    browser = await chromium.launch(await resolveLaunchOptions({ headed: options.headed }));
    context = await browser.newContext(contextOptions);
    const page = await context.newPage();
    const execution = await runAuthFlowInContext({
      page,
      context,
      baseUrl: options.baseUrl,
      runDir: options.runDir,
      signupUrl: options.signupUrl,
      loginUrl: options.loginUrl,
      accessUrl: options.accessUrl,
      saveStorageStatePath,
      timeoutMs: config.maxSessionDurationMs,
      headed: Boolean(options.headed),
      mobile: Boolean(options.mobile)
    });

    return execution;
  } finally {
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
  }
}
