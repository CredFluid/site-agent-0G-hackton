import type { Page } from "playwright";
import { PageStateSchema, type PageState } from "../schemas/types.js";

export async function capturePageState(page: Page): Promise<PageState> {
  const title = await page.title().catch(() => "");
  const url = page.url();
  const rawVisibleText = await page.locator("body").innerText().catch(() => "");
  const visibleText = rawVisibleText.replace(/\s+/g, " ").slice(0, 4200);
  const visibleLines = rawVisibleText
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 140);

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
      .slice(0, 60);

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
      .slice(0, 30);

    const headings = Array.from(document.querySelectorAll("h1, h2, h3"))
      .map((heading) => heading.textContent?.trim() || "")
      .filter(Boolean)
      .slice(0, 16);

    const formsPresent = document.querySelectorAll("form").length > 0;

    const modalHints = Array.from(document.querySelectorAll("dialog, [role='dialog'], .modal, [aria-modal='true']"))
      .map((element) => element.textContent?.trim()?.slice(0, 140) || "")
      .filter(Boolean)
      .slice(0, 4);

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
