import type { Page } from "playwright";
import { AxeBuilder } from "@axe-core/playwright";
import { AccessibilityResultSchema, type AccessibilityResult } from "../schemas/types.js";

export async function runAccessibilityAudit(page: Page): Promise<AccessibilityResult> {
  try {
    const results = await new AxeBuilder({ page }).analyze();
    return AccessibilityResultSchema.parse({
      violations: results.violations.map((violation: { id: string; impact?: string | null; description: string; help: string; nodes: Array<unknown> }) => ({
        id: violation.id,
        impact: violation.impact ?? null,
        description: violation.description,
        help: violation.help,
        nodes: violation.nodes.length
      }))
    });
  } catch (error) {
    return AccessibilityResultSchema.parse({
      error: error instanceof Error ? error.message : "Unknown accessibility audit error",
      violations: []
    });
  }
}
