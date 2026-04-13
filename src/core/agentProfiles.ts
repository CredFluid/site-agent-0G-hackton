import { loadTaskSuite } from "./loadTaskSuite.js";
import type { TaskSuite } from "../schemas/types.js";
import type { SubmissionAgentRun } from "../submissions/types.js";

type PersonaVariant = {
  key: string;
  profileLabel: string;
  intentShift: string;
  extraConstraints: string[];
};

export type AgentVariant = {
  id: string;
  index: number;
  label: string;
  profileLabel: string;
  personaVariantKey: string;
  personaName: string;
  taskSuite: TaskSuite;
};

const PERSONA_VARIANTS: PersonaVariant[] = [
  {
    key: "cautious_first_timer",
    profileLabel: "Cautious First-Timer",
    intentShift: "Move carefully, double-check whether the site feels understandable, and avoid assuming the next step is obvious until the page proves it.",
    extraConstraints: [
      "Pause after major navigation changes and check whether the page still feels oriented.",
      "Treat vague labels or surprising destinations as meaningful trust friction.",
      "Prefer clarity and predictability over speed."
    ]
  },
  {
    key: "impatient_skimmer",
    profileLabel: "Impatient Skimmer",
    intentShift: "Move fast, click obvious options quickly, and judge whether the site still makes sense when the visitor is not being patient.",
    extraConstraints: [
      "Prefer the most visually prominent actions first.",
      "Treat slow or ambiguous feedback as a serious problem.",
      "Abandon paths quickly when the next step is not obvious."
    ]
  },
  {
    key: "trust_skeptic",
    profileLabel: "Trust Skeptic",
    intentShift: "Explore like a visitor who is actively checking whether the site feels credible, dependable, and safe before going deeper.",
    extraConstraints: [
      "Notice whether copy, labels, and destinations feel mismatched or suspicious.",
      "Treat verification walls, broken pages, and inconsistent destination labels as major trust issues.",
      "Prefer paths that would help a skeptical visitor validate legitimacy."
    ]
  },
  {
    key: "comparison_shopper",
    profileLabel: "Comparison Shopper",
    intentShift: "Explore like a visitor comparing options quickly and trying to understand choices, categories, and next steps without wasting time.",
    extraConstraints: [
      "Prefer routes that reveal product, pricing, category, or feature differences when visible.",
      "Treat buried comparison details or confusing branching as friction.",
      "Favor breadth of navigation coverage over revisiting the same area."
    ]
  },
  {
    key: "accessibility_minded",
    profileLabel: "Accessibility-Minded Explorer",
    intentShift: "Explore like a visitor who is especially sensitive to clarity, structure, labels, and whether interactive states are understandable.",
    extraConstraints: [
      "Notice when labels, headings, or interactive controls feel unclear or inconsistent.",
      "Treat poor state feedback and confusing focus changes as meaningful friction.",
      "Prefer routes that reveal how understandable the interface feels over time."
    ]
  }
];

function buildVariantSuite(baseSuite: TaskSuite, variant: PersonaVariant): TaskSuite {
  return {
    ...baseSuite,
    persona: {
      name: `${baseSuite.persona.name} - ${variant.profileLabel}`,
      intent: `${baseSuite.persona.intent} ${variant.intentShift}`,
      constraints: Array.from(new Set([...baseSuite.persona.constraints, ...variant.extraConstraints]))
    }
  };
}

export function buildAgentVariants(taskPath: string, agentCount: number): AgentVariant[] {
  const baseSuite = loadTaskSuite(taskPath);
  const cappedAgentCount = Math.min(5, Math.max(1, Math.round(agentCount)));

  return PERSONA_VARIANTS.slice(0, cappedAgentCount).map((variant, index) => {
    const agentIndex = index + 1;

    return {
      id: `agent-${agentIndex}`,
      index: agentIndex,
      label: `Agent ${agentIndex}`,
      profileLabel: variant.profileLabel,
      personaVariantKey: variant.key,
      personaName: `${baseSuite.persona.name} - ${variant.profileLabel}`,
      taskSuite: buildVariantSuite(baseSuite, variant)
    };
  });
}

export function buildInitialAgentRuns(taskPath: string, agentCount: number): SubmissionAgentRun[] {
  return buildAgentVariants(taskPath, agentCount).map((variant) => ({
    id: variant.id,
    index: variant.index,
    label: variant.label,
    profileLabel: variant.profileLabel,
    personaName: variant.personaName,
    personaVariantKey: variant.personaVariantKey,
    status: "queued",
    startedAt: null,
    completedAt: null,
    runId: null,
    runDir: null,
    error: null,
    reportSummary: null,
    overallScore: null
  }));
}
