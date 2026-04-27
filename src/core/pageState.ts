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
    let nextAgentId = 1;

    const assignAgentId = (element: HTMLElement): string => {
      const existing = (element.getAttribute("data-site-agent-id") || "").trim();
      if (existing) {
        const existingNumber = Number(existing);
        if (Number.isFinite(existingNumber) && existingNumber >= nextAgentId) {
          nextAgentId = existingNumber + 1;
        }

        return existing;
      }

      const agentId = String(nextAgentId++);
      element.setAttribute("data-site-agent-id", agentId);
      return agentId;
    };

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

        const buttonValueText =
          element instanceof HTMLInputElement && ["submit", "button", "reset"].includes((element.type || "").toLowerCase())
            ? element.value || ""
            : "";

        const text = (
          element.innerText ||
          element.getAttribute("aria-label") ||
          buttonValueText ||
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

        if (!text) {
          return null;
        }

        const agentId = assignAgentId(element);

        return {
          agentId,
          role,
          tag,
          type,
          text,
          href,
          disabled
        };
      })
      .filter(Boolean)
      .slice(0, 100);

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

        const ariaLabel = (element.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
        if (ariaLabel) {
          labelParts.push(ariaLabel);
        }

        // If still no labels, look for a preceding text-heavy sibling or parent text
        if (labelParts.filter(Boolean).length === 0) {
          let prev = element.previousElementSibling;
          while (prev) {
            const text = (prev.textContent || "").replace(/\s+/g, " ").trim();
            if (text.length > 1 && text.length < 60) {
              labelParts.push(text);
              break;
            }
            prev = prev.previousElementSibling;
          }
        }

        const options =
          element instanceof HTMLSelectElement
            ? Array.from(element.options)
                .map((option) => (option.textContent || "").replace(/\s+/g, " ").trim())
                .filter(Boolean)
                .slice(0, 50)
            : [];

        const agentId = assignAgentId(element);

        return {
          agentId,
          label: labelParts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim(),
          placeholder: (element.getAttribute("placeholder") || "").replace(/\s+/g, " ").trim(),
          name: (element.getAttribute("name") || "").replace(/\s+/g, " ").trim(),
          id: (element.id || "").replace(/\s+/g, " ").trim(),
          tag: element.tagName.toLowerCase(),
          inputType: inputType || element.tagName.toLowerCase(),
          autocomplete: (element.getAttribute("autocomplete") || "").replace(/\s+/g, " ").trim().toLowerCase(),
          inputMode: (element.getAttribute("inputmode") || "").replace(/\s+/g, " ").trim().toLowerCase(),
          value:
            element instanceof HTMLSelectElement
              ? (element.selectedOptions[0]?.textContent || "").replace(/\s+/g, " ").trim()
              : (element.value || "").replace(/\s+/g, " ").trim(),
          required: element.required || element.getAttribute("aria-required") === "true",
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
      .filter(Boolean)
      .slice(0, 50);

    const numberedElements: string[] = [];
    const seenAgentIds = new Set<string>();

    for (const item of interactive) {
      if (!item) {
        continue;
      }

      if (seenAgentIds.has(item.agentId)) {
        continue;
      }

      seenAgentIds.add(item.agentId);
      numberedElements.push(`[${item.agentId}] ${item.role || item.tag}: "${item.text}"`);
    }

    for (const field of formFields) {
      if (!field) {
        continue;
      }

      if (seenAgentIds.has(field.agentId)) {
        continue;
      }

      seenAgentIds.add(field.agentId);
      const label = field.label || field.placeholder || field.name || field.id || field.inputType || field.tag;
      numberedElements.push(`[${field.agentId}] field: "${label}"`);
    }

    const headings = Array.from(document.querySelectorAll("h1, h2, h3"))
      .map((heading) => heading.textContent?.trim() || "")
      .filter(Boolean)
      .slice(0, 16);

    const formsPresent = document.querySelectorAll("form").length > 0;

    const modalHints = Array.from(document.querySelectorAll("dialog, [role='dialog'], .modal, [aria-modal='true']"))
      .map((element) => element.textContent?.trim()?.slice(0, 140) || "")
      .filter(Boolean)
      .slice(0, 4);

    return { interactive, formFields, numberedElements, headings, formsPresent, modalHints };
  });

  return PageStateSchema.parse({
    title,
    url,
    visibleText,
    visibleLines,
    formFields: snapshot.formFields,
    interactive: snapshot.interactive,
    numberedElements: snapshot.numberedElements,
    headings: snapshot.headings,
    formsPresent: snapshot.formsPresent,
    modalHints: snapshot.modalHints
  });
}
