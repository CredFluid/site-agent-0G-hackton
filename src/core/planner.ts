import { z } from "zod";
import { generateStructured } from "../llm/client.js";
import { BROWSER_AGENT_PROMPT } from "../prompts/browserAgent.js";
import {
  PlannerDecisionSchema,
  type PageState,
  type PlannerDecision,
  type TaskHistoryEntry,
  type TaskSuite
} from "../schemas/types.js";

const PLANNER_TIMEOUT_MS = 30000;
const PLANNER_MAX_RETRIES = 1;

const PlannerInputSchema = z.object({
  persona: z.object({
    name: z.string(),
    intent: z.string(),
    constraints: z.array(z.string())
  }),
  task: z.object({
    name: z.string(),
    goal: z.string(),
    success_condition: z.string(),
    failure_signals: z.array(z.string())
  }),
  pageState: z.object({
    title: z.string(),
    url: z.string(),
    visibleText: z.string(),
    interactive: z.array(z.object({
      role: z.string(),
      tag: z.string(),
      type: z.string().optional(),
      text: z.string(),
      href: z.string().optional(),
      disabled: z.boolean()
    })),
    headings: z.array(z.string()),
    formsPresent: z.boolean(),
    modalHints: z.array(z.string())
  }),
  remainingSeconds: z.number().int().positive().optional(),
  history: z.array(z.object({
    step: z.number(),
    url: z.string(),
    title: z.string(),
    decision: z.object({
      action: z.string(),
      target: z.string(),
      expectation: z.string(),
      friction: z.string()
    }),
    result: z.object({
      success: z.boolean(),
      note: z.string() 
    })
  }))
});

function cleanErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\u001b\[[0-9;]*m/g, "").replace(/\s+/g, " ").trim() || "Unknown planner error";
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function buildFallbackDecision(args: { pageState: PageState; history: TaskHistoryEntry[] }): PlannerDecision {
  const attemptedTargets = new Set(
    args.history
      .map((item) => normalizeText(item.decision.target).toLowerCase())
      .filter(Boolean)
  );

  const clickableRoles = new Set(["a", "link", "button", "tab", "menuitem", "summary"]);
  const fallbackTarget = args.pageState.interactive.find((item) => {
    if (item.disabled) {
      return false;
    }

    const label = normalizeText(item.text || item.href || "");
    if (!label) {
      return false;
    }

    const role = item.role.toLowerCase();
    const tag = item.tag.toLowerCase();
    if (!clickableRoles.has(role) && !clickableRoles.has(tag)) {
      return false;
    }

    return !attemptedTargets.has(label.toLowerCase());
  });

  if (fallbackTarget) {
    const target = normalizeText(fallbackTarget.text || fallbackTarget.href || "");
    return {
      thought: "Model planning was unavailable, so use a deterministic fallback and probe the next untried visible interaction.",
      action: "click",
      target,
      text: "",
      expectation: `Check whether '${target}' opens the expected destination or produces a clear visible state change.`,
      friction: "medium"
    };
  }

  const lastEntry = args.history.at(-1);
  if (lastEntry && lastEntry.url !== args.pageState.url) {
    return {
      thought: "Model planning was unavailable and there are no fresh visible targets, so step back to recover coverage.",
      action: "back",
      target: "",
      text: "",
      expectation: "Return to the previous page and continue exploring a different visible path.",
      friction: "medium"
    };
  }

  return {
    thought: "Model planning was unavailable and there are no obvious new visible targets, so wait briefly to detect delayed page changes before stopping.",
    action: "wait",
    target: "",
    text: "",
    expectation: "Observe whether the page changes on its own or reveals clearer next actions.",
    friction: "medium"
  };
}

export type PlannerResolution = {
  decision: PlannerDecision;
  fallbackReason?: string;
};

export async function decideNextAction(args: {
  suite: TaskSuite;
  taskIndex: number;
  pageState: PageState;
  history: TaskHistoryEntry[];
  remainingSeconds?: number;
}): Promise<PlannerResolution> {
  const task = args.suite.tasks[args.taskIndex];
  const payload = PlannerInputSchema.parse({
    persona: args.suite.persona,
    task,
    pageState: args.pageState,
    ...(args.remainingSeconds !== undefined ? { remainingSeconds: args.remainingSeconds } : {}),
    history: args.history.slice(-4).map((item) => ({
      step: item.step,
      url: item.url,
      title: item.title,
      decision: {
        action: item.decision.action,
        target: item.decision.target,
        expectation: item.decision.expectation,
        friction: item.decision.friction
      },
      result: {
        success: item.result.success,
        note: item.result.note
      }
    }))
  });

  try {
    const decision = await generateStructured<PlannerDecision>({
      systemPrompt: BROWSER_AGENT_PROMPT,
      userPayload: payload,
      schemaName: "planner_decision",
      schema: PlannerDecisionSchema,
      timeoutMs: PLANNER_TIMEOUT_MS,
      maxRetries: PLANNER_MAX_RETRIES
    });

    return { decision: PlannerDecisionSchema.parse(decision) };
  } catch (error) {
    return {
      decision: buildFallbackDecision({
        pageState: args.pageState,
        history: args.history
      }),
      fallbackReason: cleanErrorMessage(error)
    };
  }
}
