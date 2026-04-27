import { TaskSuiteSchema, type TaskSuite } from "../schemas/types.js";
import { classifyTaskText, inferGameplayConfigFromTask } from "./taskHeuristics.js";
import { parseTaskDirectives } from "./taskDirectives.js";

const RUN_WIDE_CONSTRAINT_PATTERNS = [
  /^(?:do not|don't|never|avoid|without)\b/i,
  /^stop before\b/i,
  /^(?:no more than|at most)\b/i,
  /^(?:use|keep using|reuse)\s+(?:the\s+)?same\b/i,
  /^(?:only create|create only)\b/i,
  /\b(?:single|same|one)\s+(?:profile|account|identity)\b/i
];

function buildTaskName(task: string, index: number): string {
  const firstClause = task.split(/[.!?]/, 1)[0]?.trim() || task;
  const words = firstClause.split(/\s+/).filter(Boolean);
  const compactLabel =
    words.length <= 8 ? firstClause : `${words.slice(0, 8).join(" ").trimEnd()}...`;
  const shortened = compactLabel.length > 72 ? `${compactLabel.slice(0, 69).trimEnd()}...` : compactLabel;

  return `Task ${index}: ${shortened}`;
}

function stripTaskPrefix(value: string): string {
  return value.replace(/^Task \d+:\s*/, "").trim();
}

function buildPersonaName(tasks: string[]): string {
  const firstTask = stripTaskPrefix(buildTaskName(tasks[0] ?? "submitted task", 1));
  if (tasks.length === 1) {
    return `Task-focused visitor: ${firstTask}`;
  }

  return `Task-focused visitor: ${firstTask} + ${tasks.length - 1} more`;
}

function isRunWideConstraint(task: string): boolean {
  return RUN_WIDE_CONSTRAINT_PATTERNS.some((pattern) => pattern.test(task.trim()));
}

function partitionTaskDirectives(tasks: string[]): {
  actionTasks: string[];
  runWideConstraints: string[];
} {
  const actionTasks: string[] = [];
  const runWideConstraints: string[] = [];

  for (const task of tasks) {
    if (isRunWideConstraint(task)) {
      runWideConstraints.push(task);
      continue;
    }

    actionTasks.push(task);
  }

  return { actionTasks, runWideConstraints };
}

function collapseSequentialFormFlowTasks(tasks: string[]): string[] {
  if (tasks.length < 2 || tasks.length > 6) {
    return tasks;
  }

  const directivesByTask = tasks.map((task) => parseTaskDirectives(task));
  if (directivesByTask.some((directives) => directives.length === 0)) {
    return tasks;
  }

  const flattenedDirectives = directivesByTask.flat();
  const includesFormFlowStep = flattenedDirectives.some(
    (directive) => directive.action === "fill_visible_form" || directive.action === "type_field" || directive.action === "submit"
  );

  if (!includesFormFlowStep) {
    return tasks;
  }

  return [tasks.join("; ")];
}

function isNairaCryptoExchangeTask(task: string): boolean {
  return /\b(?:buy|sell)\s+flow\b/i.test(task) && /\bnaira|ngn\b/i.test(task) && /\bcrypto|token|wallet\b/i.test(task);
}

function isExchangeMonitoringTask(task: string): boolean {
  return /\bexchange-flow monitoring\b|\bmonitoring evidence\b/i.test(task) && /\bevents?|logs?\b/i.test(task);
}

export function buildCustomTaskSuite(tasks: string[]): TaskSuite {
  const { actionTasks, runWideConstraints } = partitionTaskDirectives(tasks);
  const collapsedActionTasks = collapseSequentialFormFlowTasks(actionTasks);
  const effectiveTasks = collapsedActionTasks.length > 0 ? collapsedActionTasks : tasks;
  const globalConstraintNotes =
    actionTasks.length > 0
      ? runWideConstraints.map((constraint) => `Run-wide user constraint: ${constraint}`)
      : [];

  return TaskSuiteSchema.parse({
    persona: {
      name: buildPersonaName(effectiveTasks),
      intent:
        `Visit the supplied website like a realistic, attentive human who first understands what the site appears to be for, then completes only the submitted tasks. Let the submitted task list set your priorities instead of any predefined agent profile. Requested tasks: ${effectiveTasks.join(" | ")}${
          globalConstraintNotes.length > 0 ? ` Run-wide constraints: ${runWideConstraints.join(" | ")}` : ""
        }`,
      constraints: [
        "First understand what the supplied site appears to help users do before attempting the accepted tasks.",
        "Use the provided task list as the primary navigation plan for the visit.",
        "Treat any run-wide user constraint as a hard guardrail that cannot be violated to satisfy a later task.",
        "Do not assume a predefined agent personality or profile beyond what the submitted tasks require.",
        "Use the site understanding only to interpret the accepted tasks, not to invent new ones.",
        "Use only visible page information and honest interaction evidence.",
        "Behave like a realistic first-time visitor rather than a rigid script runner.",
        "When a task contains explicit named controls or ordered action verbs, follow those literally in order. Only choose a reasonable visible path when the user did not specify the next step.",
        "Confirm whether the requested destination, content, or state actually appears before claiming success.",
        "If a task stalls, dead-ends, loops, or becomes misleading, verify that before moving on.",
        "Do not enter personal, financial, or secret information unless the accepted task explicitly requires harmless test wallet, bank, or amount values for a flow QA check.",
        "For exchange-flow QA tasks, stop before making any real Naira payment, crypto transfer, purchase, or irreversible payout.",
        "Use harmless test input only when typing is necessary to evaluate a public interaction safely.",
        "Record blockers honestly when a task requires login, payment, invite-only access, or other gated access.",
        "Give a direct, evidence-based account of which requested tasks worked, partially worked, or failed.",
        ...globalConstraintNotes
      ]
    },
    tasks: effectiveTasks.map((task, index) => {
      const taskProfile = classifyTaskText(task);
      const gameplay = inferGameplayConfigFromTask(task);
      const successCondition =
        isNairaCryptoExchangeTask(task)
          ? "The agent can safely exercise the requested exchange direction with harmless test values, verify the amount preview, required destination details, payment/address display card, copy behavior, and stop before any real money or crypto is transferred."
          : isExchangeMonitoringTask(task)
            ? "The agent can report whether relevant console logs, debug messages, analytics events, or visible emitted-event evidence appeared for the important exchange-flow stages."
            : gameplay?.rounds
          ? `The agent can reach a fair playable state, record ${gameplay.rounds} visible round outcome(s), and honestly report the wins, losses, or draws that actually appeared.`
          : taskProfile.engagement
            ? "The agent can follow the visible path, meaningfully use the live controls it reaches, and honestly report what visibly happened."
          : taskProfile.instructionFocus
            ? "The agent can confirm the visible rules or instructions, honestly report what they said, and verify whether the site reached a playable state."
            : "The agent can attempt this requested task on the live site, describe the visible outcome honestly, and confirm whether the expected destination, content, or state appeared.";
      const failureSignals = [
        "the site does not provide a clear visible path to complete the requested task",
        "the journey stalls, loops, errors, or becomes misleading before the task can be evaluated",
        "the task requires login, payment, or private information before a safe stopping point",
        "the expected page, content, or success state never clearly appears",
        "the final output cannot clearly explain what happened when attempting the task",
        ...(globalConstraintNotes.length > 0 ? ["the run violates a run-wide user constraint while attempting this task"] : []),
        ...(taskProfile.engagement
          ? ["the run never produces clear evidence of meaningful interaction with the live controls"]
          : []),
        ...(gameplay?.rounds
          ? [
              "the gameplay path never reaches a clearly playable state",
              "the requested wins, losses, draws, or round outcomes cannot be visibly confirmed"
            ]
          : []),
        ...(taskProfile.instructionFocus
          ? ["the visible rules, instructions, or how-to-play guidance cannot be clearly confirmed"]
          : []),
        ...(isNairaCryptoExchangeTask(task)
          ? [
              "the flow does not request the required wallet or bank destination before showing payment details",
              "the quoted conversion preview, account card, business wallet address, or copy control cannot be confirmed",
              "the flow attempts to require or trigger a real payment or crypto transfer during the test"
            ]
          : []),
        ...(isExchangeMonitoringTask(task)
          ? ["no relevant monitoring log, emitted event, debug message, or console evidence can be observed for the requested exchange stages"]
          : [])
      ];

      return {
        name: buildTaskName(task, index + 1),
        goal: task,
        success_condition: successCondition,
        failure_signals: failureSignals,
        ...(gameplay ? { gameplay } : {})
      };
    })
  });
}
