import type { Locator, Page } from "playwright";
import type { PlannerDecision } from "../schemas/types.js";

type VisibleState = {
  url: string;
  title: string;
  textSnippet: string;
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

export async function executeDecision(page: Page, decision: PlannerDecision): Promise<{
  success: boolean;
  stop?: boolean;
  note: string;
  matchedBy?: string;
  elapsedMs?: number;
  destinationUrl?: string;
  destinationTitle?: string;
  stateChanged?: boolean;
}> {
  try {
    if (decision.action === "scroll") {
      await page.mouse.wheel(0, 850);
      return { success: true, note: "Scrolled down page" };
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
        stateChanged
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
        stateChanged
      };
    }

    if (decision.action === "extract") {
      return { success: true, note: "Recorded page state without interaction" };
    }

    if (decision.action === "stop") {
      return { success: true, stop: true, note: "Planner decided to stop due to friction or completion" };
    }

    const target = decision.target.trim();
    if (!target) {
      return { success: false, note: "Decision required a target but did not provide one" };
    }

    if (decision.action === "click") {
      const before = await readVisibleState(page);
      const match = await firstVisible([
        { locator: page.getByRole("button", { name: target, exact: false }), name: "getByRole(button)" },
        { locator: page.getByRole("link", { name: target, exact: false }), name: "getByRole(link)" },
        { locator: page.getByRole("tab", { name: target, exact: false }), name: "getByRole(tab)" },
        { locator: page.getByRole("menuitem", { name: target, exact: false }), name: "getByRole(menuitem)" },
        { locator: page.getByText(target, { exact: false }), name: "getByText" },
        { locator: page.locator(`[aria-label*="${target}"]`), name: "aria-label contains" }
      ]);

      if (!match) {
        return { success: false, note: `Could not find clickable element for '${target}'` };
      }

      const startedAt = Date.now();
      await match.locator.click({ timeout: 4000 }).catch(async () => {
        await match.locator.click({ force: true, timeout: 4000 });
      });
      await page.waitForLoadState("domcontentloaded").catch(() => undefined);
      const after = await readVisibleState(page);
      const elapsedMs = Date.now() - startedAt;
      const { stateChanged, destinationLabel } = describeStateChange(before, after);
      const blockedByInterstitial = isInterstitialState(after);

      if (blockedByInterstitial) {
        return {
          success: false,
          note: `Clicked '${target}' and hit a security or verification interstitial after ${elapsedMs}ms`,
          matchedBy: match.name,
          elapsedMs,
          destinationUrl: after.url,
          destinationTitle: after.title,
          stateChanged
        };
      }

      return {
        success: stateChanged,
        note: stateChanged
          ? `Clicked '${target}' and reached '${destinationLabel}' after ${elapsedMs}ms`
          : `Clicked '${target}' but the page showed no clear visible change after ${elapsedMs}ms`,
        matchedBy: match.name,
        elapsedMs,
        destinationUrl: after.url,
        destinationTitle: after.title,
        stateChanged
      };
    }

    if (decision.action === "type") {
      const match = await firstVisible([
        { locator: page.getByLabel(target, { exact: false }), name: "getByLabel" },
        { locator: page.getByPlaceholder(target, { exact: false }), name: "getByPlaceholder" },
        { locator: page.getByRole("textbox", { name: target, exact: false }), name: "getByRole(textbox)" },
        { locator: page.locator(`input[aria-label*="${target}" i], textarea[aria-label*="${target}" i]`), name: "aria-label contains" }
      ]);

      if (!match) {
        return { success: false, note: `Could not find input for '${target}'` };
      }

      await match.locator.fill(decision.text || "");
      return { success: true, note: `Filled '${target}'`, matchedBy: match.name };
    }

    return { success: false, note: `Unsupported action '${decision.action}'` };
  } catch (error) {
    return {
      success: false,
      note: `Action failed: ${cleanErrorMessage(error)}`
    };
  }
}
