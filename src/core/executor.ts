import type { Locator, Page } from "playwright";
import type { ClickIndicator, PlannerDecision } from "../schemas/types.js";

type VisibleState = {
  url: string;
  title: string;
  textSnippet: string;
};

type FillableField = {
  marker: string;
  label: string;
  placeholder: string;
  name: string;
  id: string;
  tag: string;
  inputType: string;
  options: string[];
};

export type PreparedClickAction = {
  locator: Locator;
  matchedBy: string;
  clickIndicator?: ClickIndicator;
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

function cleanErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const withoutAnsi = message.replace(/\u001b\[[0-9;]*m/g, "");
  return withoutAnsi.replace(/\s+/g, " ").trim() || "Unknown error";
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeKey(value: string): string {
  return normalizeText(value).toLowerCase();
}

function truncateLabel(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(1, maxLength - 1)).trimEnd()}...`;
}

function isInterstitialState(state: VisibleState): boolean {
  const textBlob = `${state.title} ${state.textSnippet} ${state.url}`;
  return INTERSTITIAL_PATTERNS.some((pattern) => pattern.test(textBlob));
}

async function readVisibleState(page: Page): Promise<VisibleState> {
  const title = await page.title().catch(() => "");
  const url = page.url();
  const textSnippet = normalizeText(await page.locator("body").innerText().catch(() => "")).slice(0, 800);
  return { url, title, textSnippet };
}

function describeStateChange(before: VisibleState, after: VisibleState): {
  stateChanged: boolean;
  destinationLabel: string;
} {
  const stateChanged =
    before.url !== after.url ||
    normalizeText(before.title) !== normalizeText(after.title) ||
    before.textSnippet !== after.textSnippet;

  return {
    stateChanged,
    destinationLabel: normalizeText(after.title) || after.url
  };
}

async function firstVisible(locators: Array<{ locator: Locator; name: string }>): Promise<{ locator: Locator; name: string } | null> {
  for (const item of locators) {
    try {
      if (await item.locator.first().isVisible({ timeout: 1200 })) {
        return { locator: item.locator.first(), name: item.name };
      }
    } catch {
      // continue
    }
  }

  return null;
}

async function findClickTarget(page: Page, target: string): Promise<{ locator: Locator; name: string } | null> {
  return firstVisible([
    { locator: page.getByRole("button", { name: target, exact: false }), name: "getByRole(button)" },
    { locator: page.getByRole("link", { name: target, exact: false }), name: "getByRole(link)" },
    { locator: page.getByRole("tab", { name: target, exact: false }), name: "getByRole(tab)" },
    { locator: page.getByRole("menuitem", { name: target, exact: false }), name: "getByRole(menuitem)" },
    { locator: page.getByText(target, { exact: false }), name: "getByText" },
    { locator: page.locator(`[aria-label*="${target}"]`), name: "aria-label contains" }
  ]);
}

async function buildClickIndicator(locator: Locator, target: string): Promise<ClickIndicator | undefined> {
  await locator.scrollIntoViewIfNeeded().catch(() => undefined);

  const box = await locator.boundingBox().catch(() => null);
  if (!box || box.width <= 0 || box.height <= 0) {
    return undefined;
  }

  return {
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    targetLabel: truncateLabel(normalizeText(target) || "Click target", 72)
  };
}

export async function prepareClickDecision(page: Page, decision: PlannerDecision): Promise<{
  note?: string;
  preparedClick?: PreparedClickAction;
}> {
  const target = decision.target.trim();
  if (!target) {
    return { note: "Decision required a target but did not provide one" };
  }

  const match = await findClickTarget(page, target);
  if (!match) {
    return { note: `Could not find clickable element for '${target}'` };
  }

  const clickIndicator = await buildClickIndicator(match.locator, target);
  return {
    preparedClick: {
      locator: match.locator,
      matchedBy: match.name,
      ...(clickIndicator ? { clickIndicator } : {})
    }
  };
}

async function collectVisibleFillableFields(page: Page): Promise<FillableField[]> {
  const fields = await page.evaluate(() => {
    return Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input, textarea, select"))
      .map((element, index) => {
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
          return null;
        }

        const marker = String(index + 1);
        element.setAttribute("data-site-agent-fill-field", marker);

        const labelParts: string[] = [];
        if ("labels" in element && element.labels) {
          for (const label of Array.from(element.labels)) {
            labelParts.push((label.innerText || label.textContent || "").replace(/\s+/g, " ").trim());
          }
        }

        const ariaLabelledBy = element.getAttribute("aria-labelledby");
        if (ariaLabelledBy) {
          for (const id of ariaLabelledBy.split(/\s+/)) {
            const labelElement = document.getElementById(id);
            if (labelElement) {
              labelParts.push((labelElement.textContent || "").replace(/\s+/g, " ").trim());
            }
          }
        }

        const closestLabel = element.closest("label");
        if (closestLabel) {
          labelParts.push((closestLabel.innerText || closestLabel.textContent || "").replace(/\s+/g, " ").trim());
        }

        labelParts.push((element.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim());

        const options =
          element instanceof HTMLSelectElement
            ? Array.from(element.options)
                .map((option) => (option.textContent || "").replace(/\s+/g, " ").trim())
                .filter(Boolean)
                .slice(0, 60)
            : [];

        return {
          marker,
          label: labelParts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim(),
          placeholder: (element.getAttribute("placeholder") || "").replace(/\s+/g, " ").trim(),
          name: (element.getAttribute("name") || "").replace(/\s+/g, " ").trim(),
          id: (element.id || "").replace(/\s+/g, " ").trim(),
          tag: element.tagName.toLowerCase(),
          inputType: inputType || element.tagName.toLowerCase(),
          options
        };
      })
      .filter(Boolean);
  });

  return fields.filter((field): field is FillableField => Boolean(field));
}

function scoreFieldMatch(field: FillableField, target: string): number {
  const normalizedTarget = normalizeKey(target);
  const candidates = [field.label, field.placeholder, field.name, field.id].map((value) => normalizeKey(value)).filter(Boolean);
  let score = 0;

  for (const candidate of candidates) {
    if (candidate === normalizedTarget) {
      score = Math.max(score, 120);
    }
    if (candidate.includes(normalizedTarget) || normalizedTarget.includes(candidate)) {
      score = Math.max(score, 90);
    }
  }

  if (field.inputType === normalizedTarget) {
    score = Math.max(score, 110);
  }

  if (normalizedTarget.includes("password") && field.inputType === "password") {
    score = Math.max(score, 130);
  }
  if (normalizedTarget.includes("email") && field.inputType === "email") {
    score = Math.max(score, 130);
  }

  return score;
}

function findBestFillableField(fields: FillableField[], target: string): FillableField | null {
  const ranked = fields
    .map((field) => ({
      field,
      score: scoreFieldMatch(field, target)
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score);

  return ranked[0]?.field ?? null;
}

async function fillFieldValue(args: {
  page: Page;
  field: FillableField;
  value: string;
}): Promise<void> {
  const locator = args.page.locator(`[data-site-agent-fill-field="${args.field.marker}"]`);
  if (args.field.tag === "select") {
    const desired = normalizeText(args.value);
    try {
      await locator.selectOption({ label: desired });
      return;
    } catch {
      const matchingOption = args.field.options.find((option) => normalizeKey(option) === normalizeKey(desired));
      if (matchingOption) {
        await locator.selectOption({ label: matchingOption });
        return;
      }
    }
  }

  await locator.fill(args.value);
}

async function triggerLocatorClick(locator: Locator): Promise<string> {
  await locator.scrollIntoViewIfNeeded().catch(() => undefined);

  try {
    await locator.click({ timeout: 4000 });
    return "playwright-click";
  } catch {
    try {
      await locator.click({ force: true, timeout: 4000 });
      return "playwright-force-click";
    } catch {
      await locator.evaluate((element) => {
        if (!(element instanceof HTMLElement)) {
          return;
        }

        element.scrollIntoView({ block: "center", inline: "center" });

        if (element instanceof HTMLButtonElement && element.type === "submit" && element.form) {
          element.form.requestSubmit(element);
          return;
        }

        if (
          element instanceof HTMLInputElement &&
          element.type === "submit" &&
          element.form
        ) {
          element.form.requestSubmit(element);
          return;
        }

        element.click();
      });
      return "dom-click";
    }
  }
}

async function waitForPostActionState(page: Page): Promise<VisibleState> {
  await page.waitForLoadState("domcontentloaded").catch(() => undefined);
  await page.waitForTimeout(250);
  return readVisibleState(page);
}

export async function executeDecision(page: Page, decision: PlannerDecision, preparedClick?: PreparedClickAction): Promise<{
  success: boolean;
  stop?: boolean;
  note: string;
  matchedBy?: string;
  elapsedMs?: number;
  destinationUrl?: string;
  destinationTitle?: string;
  stateChanged?: boolean;
  visibleTextSnippet?: string;
  clickIndicator?: ClickIndicator;
}> {
  try {
    if (decision.action === "scroll") {
      await page.mouse.wheel(0, 850);
      const after = await readVisibleState(page);
      return { success: true, note: "Scrolled down page", destinationUrl: after.url, destinationTitle: after.title, visibleTextSnippet: after.textSnippet };
    }

    if (decision.action === "wait") {
      const before = await readVisibleState(page);
      const startedAt = Date.now();
      await page.waitForTimeout(1500);
      const after = await readVisibleState(page);
      const elapsedMs = Date.now() - startedAt;
      const { stateChanged, destinationLabel } = describeStateChange(before, after);
      return {
        success: true,
        note: stateChanged
          ? `Waited ${elapsedMs}ms and the visible page changed to '${destinationLabel}'`
          : `Waited ${elapsedMs}ms with no clear visible page change`,
        elapsedMs,
        destinationUrl: after.url,
        destinationTitle: after.title,
        stateChanged,
        visibleTextSnippet: after.textSnippet
      };
    }

    if (decision.action === "back") {
      const before = await readVisibleState(page);
      const startedAt = Date.now();
      await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => undefined);
      const after = await readVisibleState(page);
      const elapsedMs = Date.now() - startedAt;
      const { stateChanged, destinationLabel } = describeStateChange(before, after);
      return {
        success: stateChanged,
        note: stateChanged
          ? `Went back and reached '${destinationLabel}' after ${elapsedMs}ms`
          : `Tried to go back, but the visible page did not clearly change after ${elapsedMs}ms`,
        elapsedMs,
        destinationUrl: after.url,
        destinationTitle: after.title,
        stateChanged,
        visibleTextSnippet: after.textSnippet
      };
    }

    if (decision.action === "extract") {
      const after = await readVisibleState(page);
      return {
        success: true,
        note: `Recorded page state at '${normalizeText(after.title) || after.url}' without interaction`,
        destinationUrl: after.url,
        destinationTitle: after.title,
        visibleTextSnippet: after.textSnippet
      };
    }

    if (decision.action === "stop") {
      return { success: true, stop: true, note: "Planner decided to stop due to friction or completion" };
    }

    const target = decision.target.trim();
    if (!target) {
      return { success: false, note: "Decision required a target but did not provide one" };
    }

    if (decision.action === "click") {
      const preparedClickResolution = preparedClick ? { preparedClick } : await prepareClickDecision(page, decision);
      if (!preparedClickResolution.preparedClick) {
        return {
          success: false,
          note: preparedClickResolution.note ?? `Could not find clickable element for '${target}'`
        };
      }

      const before = await readVisibleState(page);
      const startedAt = Date.now();
      const clickStrategy = await triggerLocatorClick(preparedClickResolution.preparedClick.locator);
      let after = await waitForPostActionState(page);
      let elapsedMs = Date.now() - startedAt;
      let { stateChanged, destinationLabel } = describeStateChange(before, after);

      if (!stateChanged) {
        await page.waitForTimeout(1200);
        after = await readVisibleState(page);
        elapsedMs = Date.now() - startedAt;
        ({ stateChanged, destinationLabel } = describeStateChange(before, after));
      }

      const blockedByInterstitial = isInterstitialState(after);

      if (blockedByInterstitial) {
        return {
          success: false,
          note: `Clicked '${target}' and hit a security or verification interstitial after ${elapsedMs}ms`,
          matchedBy: `${preparedClickResolution.preparedClick.matchedBy}:${clickStrategy}`,
          elapsedMs,
          destinationUrl: after.url,
          destinationTitle: after.title,
          stateChanged,
          visibleTextSnippet: after.textSnippet,
          ...(preparedClickResolution.preparedClick.clickIndicator
            ? { clickIndicator: preparedClickResolution.preparedClick.clickIndicator }
            : {})
        };
      }

      return {
        success: stateChanged,
        note: stateChanged
          ? `Clicked '${target}' and reached '${destinationLabel}' after ${elapsedMs}ms`
          : `Clicked '${target}' but the page showed no clear visible change after ${elapsedMs}ms`,
        matchedBy: `${preparedClickResolution.preparedClick.matchedBy}:${clickStrategy}`,
        elapsedMs,
        destinationUrl: after.url,
        destinationTitle: after.title,
        stateChanged,
        visibleTextSnippet: after.textSnippet,
        ...(preparedClickResolution.preparedClick.clickIndicator
          ? { clickIndicator: preparedClickResolution.preparedClick.clickIndicator }
          : {})
      };
    }

    if (decision.action === "type") {
      const fields = await collectVisibleFillableFields(page);
      const matchedField = findBestFillableField(fields, target);

      if (!matchedField) {
        return { success: false, note: `Could not find input for '${target}'` };
      }

      await fillFieldValue({
        page,
        field: matchedField,
        value: decision.text || ""
      });
      const after = await readVisibleState(page);
      return {
        success: true,
        note: `Filled '${target}'`,
        matchedBy: `fillable-field:${matchedField.tag}/${matchedField.inputType}`,
        destinationUrl: after.url,
        destinationTitle: after.title,
        visibleTextSnippet: after.textSnippet
      };
    }

    return { success: false, note: `Unsupported action '${decision.action}'` };
  } catch (error) {
    return {
      success: false,
      note: `Action failed: ${cleanErrorMessage(error)}`
    };
  }
}
