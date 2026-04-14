import type { TaskSuite } from "../schemas/types.js";
import type { SubmissionAgentRun } from "../submissions/types.js";

export type AgentVariant = {
  id: string;
  index: number;
  label: string;
  profileLabel: string;
  personaVariantKey: string;
  personaName: string;
  taskSuite: TaskSuite;
};

function formatAgentOrdinal(index: number): string {
  return String(index).padStart(2, "0");
}

function formatAgentLabel(index: number): string {
  return `Agent-${formatAgentOrdinal(index)}`;
}

function cloneTaskSuite(baseSuite: TaskSuite): TaskSuite {
  return {
    tasks: baseSuite.tasks.map((task) => ({
      ...task,
      failure_signals: [...task.failure_signals],
      ...(task.gameplay ? { gameplay: { ...task.gameplay } } : {})
    })),
    persona: {
      name: baseSuite.persona.name,
      intent: baseSuite.persona.intent,
      constraints: [...baseSuite.persona.constraints]
    }
  };
}

export function buildAgentVariants(agentCount: number, baseSuiteOverride: TaskSuite): AgentVariant[] {
  const baseSuite = baseSuiteOverride;
  const cappedAgentCount = Math.min(5, Math.max(1, Math.round(agentCount)));

  return Array.from({ length: cappedAgentCount }, (_, index) => {
    const agentIndex = index + 1;
    const agentLabel = formatAgentLabel(agentIndex);

    return {
      id: `agent-${formatAgentOrdinal(agentIndex)}`,
      index: agentIndex,
      label: agentLabel,
      profileLabel: agentLabel,
      personaVariantKey: agentLabel.toLowerCase(),
      personaName: agentLabel,
      taskSuite: cloneTaskSuite(baseSuite)
    };
  });
}

export function buildInitialAgentRuns(agentCount: number, baseSuiteOverride: TaskSuite): SubmissionAgentRun[] {
  return buildAgentVariants(agentCount, baseSuiteOverride).map((variant) => ({
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
