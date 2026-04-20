import { z } from "zod";
import { generateStructured, type LlmRuntimeOptions } from "../llm/client.js";
import { SiteBriefSchema, type PageState, type SiteBrief } from "../schemas/types.js";

const SITE_BRIEF_TIMEOUT_MS = 15000;
const SITE_BRIEF_MAX_RETRIES = 1;

const SITE_BRIEF_PROMPT = `You are a product-understanding analyst for live websites.

Use only the visible homepage or landing-page evidence provided.
Do not invent facts.
Infer what the site appears to be for, what a normal visitor is mainly meant to do on it, and the most obvious visible actions on the page.
Keep the result plain, practical, and grounded in visible text, headings, and visible controls.
Do not turn this into a critique.
Do not add tasks that were not visible on the page.

Return strict JSON with this exact shape:
{
  "sitePurpose": "1-2 sentence plain-English description of what the site appears to do",
  "intendedUserActions": ["short phrases for the most obvious things a visitor seems meant to do here"],
  "summary": "1-2 sentence human explanation of what this site seems built for and what a visitor is visibly guided to do first",
  "evidence": ["short visible clues such as headings, CTA labels, or page copy that support the inference"]
}`;

const SiteBriefInputSchema = z.object({
  pageState: z.object({
    title: z.string(),
    url: z.string(),
    visibleText: z.string(),
    headings: z.array(z.string()),
    interactive: z.array(
      z.object({
        role: z.string(),
        tag: z.string(),
        text: z.string(),
        disabled: z.boolean()
      })
    )
  })
});

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function uniqueItems(items: string[], limit: number): string[] {
  return [...new Set(items.map((item) => normalizeText(item)).filter(Boolean))].slice(0, limit);
}

function cleanErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\u001b\[[0-9;]*m/g, "").replace(/\s+/g, " ").trim() || "Unknown site-brief error";
}

function buildFallbackSiteBrief(pageState: PageState): SiteBrief {
  const primaryHeading = pageState.headings[0] || pageState.title || pageState.url;
  const actionLabels = uniqueItems(
    pageState.interactive
      .map((item) => item.text || "")
      .map((item) => normalizeText(item))
      .filter((item) => item.length >= 3 && item.length <= 80),
    5
  );
  const evidence = uniqueItems(
    [
      primaryHeading,
      ...pageState.headings.slice(0, 3),
      ...actionLabels.slice(0, 3),
      pageState.visibleText.slice(0, 180)
    ],
    5
  );

  return SiteBriefSchema.parse({
    sitePurpose: primaryHeading
      ? `This site appears to center on "${primaryHeading}" and guide visitors toward the main visible actions on the landing page.`
      : "This site appears to introduce a product or service and guide visitors toward its main visible actions.",
    intendedUserActions:
      actionLabels.length > 0
        ? actionLabels.map((label) => `Use "${label}"`)
        : ["Understand the offering from the landing page", "Follow the main visible CTA"],
    summary:
      actionLabels.length > 0
        ? `The landing page appears to explain "${primaryHeading}" and push visitors toward actions like ${actionLabels
            .slice(0, 3)
            .map((label) => `"${label}"`)
            .join(", ")}.`
        : `The landing page appears to explain "${primaryHeading}" and steer visitors through its primary visible path.`,
    evidence
  });
}

export async function deriveSiteBrief(args: { pageState: PageState; llm?: LlmRuntimeOptions }): Promise<{
  siteBrief: SiteBrief;
  fallbackReason?: string;
}> {
  const payload = SiteBriefInputSchema.parse({
    pageState: {
      title: args.pageState.title,
      url: args.pageState.url,
      visibleText: args.pageState.visibleText,
      headings: args.pageState.headings,
      interactive: args.pageState.interactive.map((item) => ({
        role: item.role,
        tag: item.tag,
        text: item.text,
        disabled: item.disabled
      }))
    }
  });

  try {
    const siteBrief = await generateStructured<SiteBrief>({
      ...(args.llm ?? {}),
      systemPrompt: SITE_BRIEF_PROMPT,
      userPayload: payload,
      schemaName: "site_brief",
      schema: SiteBriefSchema,
      timeoutMs: SITE_BRIEF_TIMEOUT_MS,
      maxRetries: SITE_BRIEF_MAX_RETRIES
    });

    return { siteBrief: SiteBriefSchema.parse(siteBrief) };
  } catch (error) {
    return {
      siteBrief: buildFallbackSiteBrief(args.pageState),
      fallbackReason: cleanErrorMessage(error)
    };
  }
}
