import type { Locator, Page } from "playwright";
import type { ClickIndicator, PlannerDecision } from "../schemas/types.js";
import {
  findMatchingSelectOption,
  fitValueToField,
  scoreFormFieldTargetMatch,
  shouldCheckField
} from "./formHeuristics.js";
import {
  buildLooseAccessiblePattern,
  prepareLocatorForInteraction,
  typeLikeHuman
} from "./interaction.js";

type VisibleState = {
  url: string;
  title: string;
  textSnippet: string;
};

type FillableField = {
  agentId: string;
  marker: string;
  label: string;
  placeholder: string;
  name: string;
  id: string;
  tag: string;
  inputType: string;
  autocomplete: string;
  inputMode: string;
  checked: boolean | undefined;
  maxLength: number | null;
  options: string[];
};

type FieldRuntimeState = {
  value: string;
  checked: boolean | null;
};

type FillOperation = {
  expectedValue: string;
  mode: "fill" | "select" | "check";
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

function escapeAttributeValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function resolveDecisionTargetLabel(decision: PlannerDecision): string {
  return decision.target.trim() || decision.target_id.trim();
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

async function captureClickNeighborhood(locator: Locator): Promise<string> {
  try {
    return await locator.evaluate((element) => {
      const container =
        element.closest("section, article, nav, main, aside, dialog, [role='dialog'], [role='tabpanel'], .modal, .card, .panel, .accordion") ||
        element.parentElement;
      if (!container) {
        return "";
      }

      return (container.innerHTML || "").replace(/\s+/g, " ").trim().slice(0, 600);
    });
  } catch {
    return "";
  }
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
  const escapedTarget = escapeAttributeValue(target);
  const targetPattern = buildLooseAccessiblePattern(target);

  if (!targetPattern) {
    return null;
  }

  return firstVisible([
    { locator: page.getByRole("button", { name: targetPattern }), name: "getByRole(button)" },
    { locator: page.getByRole("link", { name: targetPattern }), name: "getByRole(link)" },
    { locator: page.getByRole("tab", { name: targetPattern }), name: "getByRole(tab)" },
    { locator: page.getByRole("menuitem", { name: targetPattern }), name: "getByRole(menuitem)" },
    {
      locator: page.locator(
        `input[type="submit"][value*="${escapedTarget}" i], input[type="button"][value*="${escapedTarget}" i], input[type="reset"][value*="${escapedTarget}" i]`
      ),
      name: "input[value contains]"
    },
    { locator: page.getByText(targetPattern), name: "getByText" },
    { locator: page.locator(`[aria-label*="${escapedTarget}" i]`), name: "aria-label contains" }
  ]);
}

async function findClickTargetById(page: Page, targetId: string): Promise<{ locator: Locator; name: string } | null> {
  const normalizedTargetId = targetId.trim();
  if (!normalizedTargetId) {
    return null;
  }

  const locator = page.locator(`[data-site-agent-id="${escapeAttributeValue(normalizedTargetId)}"]`).first();
  try {
    if (await locator.isVisible({ timeout: 1200 })) {
      return { locator, name: "target_id" };
    }
  } catch {
    // continue
  }

  return null;
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
  const targetLabel = resolveDecisionTargetLabel(decision);
  const targetId = decision.target_id.trim();

  if (targetId) {
    const match = await findClickTargetById(page, targetId);
    if (!match) {
      return { note: `Could not find numbered clickable element for target_id '${targetId}'` };
    }

    const clickIndicator = await buildClickIndicator(match.locator, targetLabel || targetId);
    return {
      preparedClick: {
        locator: match.locator,
        matchedBy: match.name,
        ...(clickIndicator ? { clickIndicator } : {})
      }
    };
  }

  if (!targetLabel) {
    return { note: "Decision required a target but did not provide one" };
  }

  const match = await findClickTarget(page, targetLabel);
  if (!match) {
    return { note: `Could not find clickable element for '${targetLabel}'` };
  }

  const clickIndicator = await buildClickIndicator(match.locator, targetLabel);
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
        const agentId = (element.getAttribute("data-site-agent-id") || "").trim() || marker;
        element.setAttribute("data-site-agent-id", agentId);

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
          agentId,
          marker,
          label: labelParts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim(),
          placeholder: (element.getAttribute("placeholder") || "").replace(/\s+/g, " ").trim(),
          name: (element.getAttribute("name") || "").replace(/\s+/g, " ").trim(),
          id: (element.id || "").replace(/\s+/g, " ").trim(),
          tag: element.tagName.toLowerCase(),
          inputType: inputType || element.tagName.toLowerCase(),
          autocomplete: (element.getAttribute("autocomplete") || "").replace(/\s+/g, " ").trim().toLowerCase(),
          inputMode: (element.getAttribute("inputmode") || "").replace(/\s+/g, " ").trim().toLowerCase(),
          checked: element instanceof HTMLInputElement ? element.checked : undefined,
          maxLength:
            element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
              ? element.maxLength > 0
                ? element.maxLength
                : null
              : null,
          options
        };
      })
      .filter(Boolean);
  });

  return fields.filter((field): field is FillableField => Boolean(field));
}

function scoreFieldMatch(field: FillableField, target: string): number {
  return scoreFormFieldTargetMatch(field, target);
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

function getFillableFieldLocator(page: Page, field: FillableField): Locator {
  return page.locator(`[data-site-agent-id="${escapeAttributeValue(field.agentId)}"]`).first();
}

async function readFieldRuntimeState(locator: Locator, field: FillableField): Promise<FieldRuntimeState> {
  if (field.inputType === "checkbox" || field.inputType === "radio") {
    const checked = await locator.isChecked().catch(async () => {
      return locator
        .evaluate((element) => (element instanceof HTMLInputElement ? element.checked : false))
        .catch(() => false);
    });

    return {
      value: checked ? "checked" : "",
      checked
    };
  }

  if (field.tag === "select") {
    const value = await locator
      .evaluate((element) => {
        if (!(element instanceof HTMLSelectElement)) {
          return "";
        }

        return ((element.selectedOptions[0]?.textContent || element.value || "") as string).replace(/\s+/g, " ").trim();
      })
      .catch(() => "");

    return {
      value: normalizeText(value),
      checked: null
    };
  }

  const value = await locator
    .inputValue()
    .catch(async () => {
      return locator
        .evaluate((element) => {
          if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
            return element.value;
          }

          return "";
        })
        .catch(() => "");
    });

  return {
    value: normalizeText(value),
    checked: null
  };
}

function didFieldStateChange(before: FieldRuntimeState, after: FieldRuntimeState): boolean {
  return normalizeKey(before.value) !== normalizeKey(after.value) || before.checked !== after.checked;
}

function doesFieldStateMatchExpected(args: {
  after: FieldRuntimeState;
  operation: FillOperation;
}): boolean {
  if (args.operation.mode === "check") {
    return args.after.checked === true;
  }

  return normalizeKey(args.after.value) === normalizeKey(args.operation.expectedValue);
}

async function fillFieldValue(args: {
  locator: Locator;
  field: FillableField;
  value: string;
}): Promise<FillOperation> {
  if (shouldCheckField(args.value) && (args.field.inputType === "checkbox" || args.field.inputType === "radio")) {
    const preparedLocator = await prepareLocatorForInteraction(args.locator);

    if (args.field.checked) {
      return {
        expectedValue: "checked",
        mode: "check"
      };
    }

    await preparedLocator.check({ force: true }).catch(async () => {
      await preparedLocator.click({ force: true });
    });
    return {
      expectedValue: "checked",
      mode: "check"
    };
  }

  if (args.field.tag === "select") {
    const preparedLocator = await prepareLocatorForInteraction(args.locator);
    const desired = normalizeText(args.value);
    const matchedOption = findMatchingSelectOption(args.field.options, [desired]);
    try {
      await preparedLocator.selectOption({ label: desired });
      return {
        expectedValue: desired,
        mode: "select"
      };
    } catch {
      if (matchedOption) {
        await preparedLocator.selectOption({ label: matchedOption });
        return {
          expectedValue: matchedOption,
          mode: "select"
        };
      }
    }
  }

  const fittedValue = fitValueToField(args.field, args.value);

  // Native date/time inputs require .fill() with ISO format — typeLikeHuman types
  // individual characters which the browser's native picker interprets incorrectly
  // (e.g. "1998-04-17" typed char-by-char becomes "12/09/80417").
  const isNativeDateInput = ["date", "time", "datetime-local", "month", "week"].includes(args.field.inputType);
  if (isNativeDateInput) {
    const preparedLocator = await prepareLocatorForInteraction(args.locator);
    await preparedLocator.fill(fittedValue);
    return {
      expectedValue: fittedValue,
      mode: "fill"
    };
  }

  await typeLikeHuman(args.locator, fittedValue);
  return {
    expectedValue: fittedValue,
    mode: "fill"
  };
}

async function triggerLocatorClick(locator: Locator): Promise<string> {
  const preparedLocator = await prepareLocatorForInteraction(locator);

  try {
    await preparedLocator.click({ timeout: 4000 });
    return "playwright-click";
  } catch {
    try {
      await preparedLocator.click({ force: true, timeout: 4000 });
      return "playwright-force-click";
    } catch {
      await preparedLocator.evaluate((element) => {
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

    const target = resolveDecisionTargetLabel(decision);
    const targetId = decision.target_id.trim();
    if (!target && !targetId) {
      return { success: false, note: "Decision required a target but did not provide one" };
    }

    if (decision.action === "click") {
      const preparedClickResolution = preparedClick ? { preparedClick } : await prepareClickDecision(page, decision);
      if (!preparedClickResolution.preparedClick) {
        return {
          success: false,
          note: preparedClickResolution.note ?? `Could not find clickable element for '${target || targetId}'`
        };
      }

      const before = await readVisibleState(page);
      const neighborhoodBefore = await captureClickNeighborhood(preparedClickResolution.preparedClick.locator);
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

      if (!stateChanged) {
        const neighborhoodAfter = await captureClickNeighborhood(preparedClickResolution.preparedClick.locator);
        if (neighborhoodBefore && neighborhoodAfter && neighborhoodBefore !== neighborhoodAfter) {
          stateChanged = true;
          destinationLabel = normalizeText(after.title) || after.url;
        }
      }

      const blockedByInterstitial = isInterstitialState(after);

      if (blockedByInterstitial) {
        return {
          success: false,
          note: `Clicked '${target || targetId}' and hit a security or verification interstitial after ${elapsedMs}ms`,
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
          ? `Clicked '${target || targetId}' and reached '${destinationLabel}' after ${elapsedMs}ms`
          : `Clicked '${target || targetId}' but the page showed no clear visible change after ${elapsedMs}ms`,
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
      const matchedField = targetId
        ? fields.find((field) => field.agentId === targetId) ?? null
        : findBestFillableField(fields, target);

      if (!matchedField) {
        return { success: false, note: `Could not find input for '${target || targetId}'` };
      }

      const locator = getFillableFieldLocator(page, matchedField);
      const beforeFieldState = await readFieldRuntimeState(locator, matchedField).catch(() => ({
        value: "",
        checked: matchedField.checked ?? null
      }));
      const operation = await fillFieldValue({
        locator,
        field: matchedField,
        value: decision.text || ""
      });
      const afterFieldState = await readFieldRuntimeState(locator, matchedField).catch(() => beforeFieldState);
      const stateChanged = didFieldStateChange(beforeFieldState, afterFieldState);
      const valueApplied = doesFieldStateMatchExpected({
        after: afterFieldState,
        operation
      });
      const after = await readVisibleState(page);

      if (!valueApplied) {
        return {
          success: false,
          note: `Tried to fill '${target || targetId}', but the field did not keep the requested value`,
          matchedBy: `target_id:${matchedField.tag}/${matchedField.inputType}`,
          destinationUrl: after.url,
          destinationTitle: after.title,
          stateChanged,
          visibleTextSnippet: after.textSnippet
        };
      }

      return {
        success: true,
        note: stateChanged ? `Filled '${target || targetId}'` : `Field '${target || targetId}' already held the requested value`,
        matchedBy: `target_id:${matchedField.tag}/${matchedField.inputType}`,
        destinationUrl: after.url,
        destinationTitle: after.title,
        stateChanged,
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
