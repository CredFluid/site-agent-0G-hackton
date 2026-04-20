import type { Locator, Page } from "playwright";
import type { FormFieldLike } from "./formHeuristics.js";

type LocatorCandidate = {
  locator: Locator;
  strategy: string;
};

type FieldDescriptor = Pick<FormFieldLike, "label" | "placeholder" | "name" | "id" | "tag" | "inputType">;
type AccessibleRole = Parameters<Page["getByRole"]>[0];

export const INTERACTION_VISIBLE_TIMEOUT_MS = 5000;
const HUMAN_TYPING_DELAY_MS = 30;

function normalizeInteractionText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeInteractionKey(value: string): string {
  return normalizeInteractionText(value).toLowerCase();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeAttributeValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function buildPattern(value: string, mode: "exact" | "loose"): RegExp | null {
  const normalized = normalizeInteractionText(value);
  if (!normalized) {
    return null;
  }

  const flexible = escapeRegExp(normalized).replace(/\s+/g, "\\s+");
  if (mode === "exact") {
    return new RegExp(`^\\s*${flexible}\\s*(?:[:*]\\s*)?$`, "i");
  }

  return new RegExp(flexible, "i");
}

function buildUniquePatterns(values: string[], mode: "exact" | "loose"): RegExp[] {
  const seen = new Set<string>();
  const patterns: RegExp[] = [];

  for (const value of values) {
    const pattern = buildPattern(value, mode);
    if (!pattern) {
      continue;
    }

    const key = `${pattern.source}/${pattern.flags}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    patterns.push(pattern);
  }

  return patterns;
}

function resolveFieldRoles(field: FieldDescriptor): AccessibleRole[] {
  if (field.tag === "textarea") {
    return ["textbox"];
  }

  if (field.tag === "select") {
    return ["combobox", "listbox"];
  }

  switch (field.inputType) {
    case "checkbox":
      return ["checkbox"];
    case "radio":
      return ["radio"];
    case "number":
      return ["spinbutton"];
    case "password":
      return [];
    default:
      return ["textbox"];
  }
}

async function firstVisibleCandidate(candidates: LocatorCandidate[]): Promise<LocatorCandidate | null> {
  for (const candidate of candidates) {
    const locator = candidate.locator.first();

    try {
      if (await locator.isVisible({ timeout: 400 })) {
        return {
          locator,
          strategy: candidate.strategy
        };
      }
    } catch {
      // continue
    }
  }

  return null;
}

export function buildLooseAccessiblePattern(value: string): RegExp | null {
  return buildPattern(value, "loose");
}

export async function waitForVisible(locator: Locator, timeout = INTERACTION_VISIBLE_TIMEOUT_MS): Promise<Locator> {
  const resolved = locator.first();
  await resolved.waitFor({ state: "visible", timeout });
  return resolved;
}

export async function prepareLocatorForInteraction(locator: Locator): Promise<Locator> {
  const resolved = await waitForVisible(locator);
  await resolved.scrollIntoViewIfNeeded().catch(() => undefined);
  return resolved;
}

export async function resolvePreferredFieldLocator(args: {
  page: Page;
  field: FieldDescriptor;
  fallbackLocator: Locator;
  preferredNames?: string[];
}): Promise<LocatorCandidate> {
  const exactNamePatterns = buildUniquePatterns([args.field.label], "exact");
  const looseNamePatterns = buildUniquePatterns([...(args.preferredNames ?? []), args.field.label], "loose");
  const exactPlaceholderPatterns = buildUniquePatterns([args.field.placeholder], "exact");
  const loosePlaceholderPatterns = buildUniquePatterns([args.field.placeholder, ...(args.preferredNames ?? [])], "loose");
  const roles = resolveFieldRoles(args.field);

  const candidates: LocatorCandidate[] = [];

  for (const pattern of exactNamePatterns) {
    for (const role of roles) {
      candidates.push({
        locator: args.page.getByRole(role, { name: pattern }),
        strategy: `getByRole(${role})`
      });
    }

    candidates.push({
      locator: args.page.getByLabel(pattern),
      strategy: "getByLabel"
    });
  }

  for (const pattern of exactPlaceholderPatterns) {
    candidates.push({
      locator: args.page.getByPlaceholder(pattern),
      strategy: "getByPlaceholder"
    });
  }

  for (const pattern of looseNamePatterns) {
    for (const role of roles) {
      candidates.push({
        locator: args.page.getByRole(role, { name: pattern }),
        strategy: `getByRole(${role})`
      });
    }

    candidates.push({
      locator: args.page.getByLabel(pattern),
      strategy: "getByLabel"
    });
  }

  for (const pattern of loosePlaceholderPatterns) {
    candidates.push({
      locator: args.page.getByPlaceholder(pattern),
      strategy: "getByPlaceholder"
    });
  }

  if (normalizeInteractionText(args.field.name)) {
    candidates.push({
      locator: args.page.locator(`[name="${escapeAttributeValue(args.field.name)}"]`),
      strategy: "name attribute"
    });
  }

  if (normalizeInteractionText(args.field.id)) {
    candidates.push({
      locator: args.page.locator(`[id="${escapeAttributeValue(args.field.id)}"]`),
      strategy: "id attribute"
    });
  }

  candidates.push({
    locator: args.fallbackLocator.first(),
    strategy: "marker fallback"
  });

  return (await firstVisibleCandidate(candidates)) ?? {
    locator: args.fallbackLocator.first(),
    strategy: "marker fallback"
  };
}

async function readLocatorValue(locator: Locator): Promise<string> {
  return locator
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
}

async function clearFieldValue(locator: Locator): Promise<void> {
  await locator.click({ timeout: 2000 }).catch(async () => {
    await locator.focus().catch(() => undefined);
  });

  await locator.selectText().catch(() => undefined);

  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  await locator.press(`${modifier}+A`).catch(() => undefined);
  await locator.press("Delete").catch(() => undefined);
  await locator.press("Backspace").catch(() => undefined);

  const remainingValue = normalizeInteractionKey(await readLocatorValue(locator));
  if (!remainingValue) {
    return;
  }

  // Fall back to a DOM-level clear only when keyboard selection did not take.
  await locator
    .evaluate((element) => {
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
        element.value = "";
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
      }
    })
    .catch(() => undefined);
}

export async function typeLikeHuman(locator: Locator, value: string): Promise<void> {
  const prepared = await prepareLocatorForInteraction(locator);
  await clearFieldValue(prepared);

  if (!value) {
    return;
  }

  await prepared.pressSequentially(value, { delay: HUMAN_TYPING_DELAY_MS });
}
