import type { Page } from "playwright";
import { PageStateSchema, type PageState } from "../schemas/types.js";

export async function capturePageState(page: Page): Promise<PageState> {
  const title = await page.title().catch(() => "");
  const url = page.url();
  const visibleText = (await page.locator("body").innerText().catch(() => ""))
    .replace(/\s+/g, " ")
    .slice(0, 4200);

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

    const headings = Array.from(document.querySelectorAll("h1, h2, h3"))
      .map((heading) => heading.textContent?.trim() || "")
      .filter(Boolean)
      .slice(0, 16);

    const formsPresent = document.querySelectorAll("form").length > 0;

    const modalHints = Array.from(document.querySelectorAll("dialog, [role='dialog'], .modal, [aria-modal='true']"))
      .map((element) => element.textContent?.trim()?.slice(0, 140) || "")
      .filter(Boolean)
      .slice(0, 4);

    return { interactive, headings, formsPresent, modalHints };
  });

  return PageStateSchema.parse({
    title,
    url,
    visibleText,
    interactive: snapshot.interactive,
    headings: snapshot.headings,
    formsPresent: snapshot.formsPresent,
    modalHints: snapshot.modalHints
  });
}
