import type { Page } from "playwright";
import { PageStateSchema, type PageState } from "../schemas/types.js";

const VISIBLE_TEXT_LIMIT = 9000;
const PRIMARY_VISIBLE_LINE_LIMIT = 180;
const TOTAL_VISIBLE_LINE_LIMIT = 260;
const INTERACTIVE_LIMIT = 120;
const FORM_FIELD_LIMIT = 40;
const HEADING_LIMIT = 24;
const MODAL_HINT_LIMIT = 6;
const PRIORITY_LINE_PATTERNS = [
  /\bhow to play\b/i,
  /\binstructions?\b/i,
  /\brules?\b/i,
  /\btutorial\b/i,
  /\bhow it works\b/i,
  /^step\s+\d+\b/i,
  /^\d+[.)]\s+/,
  /^(?:first|second|third|fourth|fifth|next|then|finally)\b/i,
  /\b(?:click|tap|press|select|choose|open|enter|type|fill|input|provide|scroll|wait|pause|back)\b/i
];

function normalizeLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function selectVisibleLines(rawVisibleText: string): string[] {
  const allLines = rawVisibleText
    .split(/\r?\n/)
    .map((line) => normalizeLine(line))
    .filter(Boolean);

  const chosenIndexes = new Set<number>();
  for (let index = 0; index < Math.min(PRIMARY_VISIBLE_LINE_LIMIT, allLines.length); index += 1) {
    chosenIndexes.add(index);
  }

  allLines.forEach((line, index) => {
    if (PRIORITY_LINE_PATTERNS.some((pattern) => pattern.test(line))) {
      chosenIndexes.add(index);
    }
  });

  return [...chosenIndexes]
    .sort((left, right) => left - right)
    .slice(0, TOTAL_VISIBLE_LINE_LIMIT)
    .map((index) => allLines[index] ?? "")
    .filter(Boolean);
}

export async function capturePageState(page: Page): Promise<PageState> {
  const title = await page.title().catch(() => "");
  const url = page.url();
  const rawVisibleText = await page.locator("body").innerText().catch(() => "");
  const visibleText = rawVisibleText.replace(/\s+/g, " ").slice(0, VISIBLE_TEXT_LIMIT);
  const visibleLines = selectVisibleLines(rawVisibleText);

  const snapshot = await page.evaluate(() => {
    const nodes = Array.from(
      document.querySelectorAll<HTMLElement>(
        "a, button, input, textarea, select, summary, [role='button'], [role='link'], [role='tab'], [role='menuitem'], [role='textbox']"
      )
    );

    const interactive = nodes
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        const visible =
          rect.width > 0 &&
          rect.height > 0 &&
          style.visibility !== "hidden" &&
          style.display !== "none";

        if (!visible) {
          return null;
        }

        const text = (
          element.innerText ||
          element.getAttribute("aria-label") ||
          element.getAttribute("placeholder") ||
          element.getAttribute("title") ||
          ""
        )
          .trim()
          .replace(/\s+/g, " ")
          .slice(0, 120);

        const role = element.getAttribute("role") || element.tagName.toLowerCase();
        const tag = element.tagName.toLowerCase();
        const type = element.getAttribute("type") || undefined;
        const href = element instanceof HTMLAnchorElement ? element.href : undefined;
        const disabled =
          element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true";

        return {
          role,
          tag,
          type,
          text,
          href,
          disabled
        };
      })
      .filter(Boolean)
      .slice(0, INTERACTIVE_LIMIT);

    const formFields = Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input, textarea, select"))
      .map((element) => {
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
                .slice(0, 50)
            : [];

        return {
          label: labelParts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim(),
          placeholder: (element.getAttribute("placeholder") || "").replace(/\s+/g, " ").trim(),
          name: (element.getAttribute("name") || "").replace(/\s+/g, " ").trim(),
          id: (element.id || "").replace(/\s+/g, " ").trim(),
          tag: element.tagName.toLowerCase(),
          inputType: inputType || element.tagName.toLowerCase(),
          value:
            element instanceof HTMLSelectElement
              ? (element.selectedOptions[0]?.textContent || "").replace(/\s+/g, " ").trim()
              : (element.value || "").replace(/\s+/g, " ").trim(),
          required: element.required || element.getAttribute("aria-required") === "true",
          options
        };
      })
      .filter(Boolean)
      .slice(0, FORM_FIELD_LIMIT);

    const headings = Array.from(document.querySelectorAll("h1, h2, h3"))
      .map((heading) => heading.textContent?.trim() || "")
      .filter(Boolean)
      .slice(0, HEADING_LIMIT);

    const formsPresent = document.querySelectorAll("form").length > 0;

    const modalHints = Array.from(document.querySelectorAll("dialog, [role='dialog'], .modal, [aria-modal='true']"))
      .map((element) => element.textContent?.trim()?.slice(0, 140) || "")
      .filter(Boolean)
      .slice(0, MODAL_HINT_LIMIT);

    return { interactive, formFields, headings, formsPresent, modalHints };
  });

  return PageStateSchema.parse({
    title,
    url,
    visibleText,
    visibleLines,
    formFields: snapshot.formFields,
    interactive: snapshot.interactive,
    headings: snapshot.headings,
    formsPresent: snapshot.formsPresent,
    modalHints: snapshot.modalHints
  });
}
