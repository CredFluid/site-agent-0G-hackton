import type { Page } from "playwright";
import axeCore from "axe-core";
import { AccessibilityResultSchema, type AccessibilityResult } from "../schemas/types.js";

export async function runAccessibilityAudit(page: Page): Promise<AccessibilityResult> {
  try {
    await page.addScriptTag({ content: axeCore.source });
    const results = await page.evaluate(`(async () => {
      const axe = globalThis.axe;
      if (!axe) {
        throw new Error("axe-core did not load into the page context.");
      }

      return axe.run(document);
    })()`);

    return AccessibilityResultSchema.parse({
      violations: (results as { violations: Array<{ id: string; impact?: string | null; description: string; help: string; nodes: Array<unknown> }> }).violations.map(
        (violation) => ({
          id: violation.id,
          impact: violation.impact ?? null,
          description: violation.description,
          help: violation.help,
          nodes: violation.nodes.length
        })
      )
    });
  } catch (error) {
    return AccessibilityResultSchema.parse({
      error: error instanceof Error ? error.message : "Unknown accessibility audit error",
      violations: []
    });
  }
}
