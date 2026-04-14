import { TaskSuiteSchema, type TaskSuite } from "../schemas/types.js";
import { classifyTaskText, inferGameplayConfigFromTask } from "./taskHeuristics.js";

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

export function buildCustomTaskSuite(tasks: string[]): TaskSuite {
  return TaskSuiteSchema.parse({
    persona: {
      name: buildPersonaName(tasks),
      intent:
        `Visit the supplied website like a realistic, attentive human who first understands what the site appears to be for, then completes only the submitted tasks. Let the submitted task list set your priorities instead of any predefined agent profile. Requested tasks: ${tasks.join(" | ")}`,
      constraints: [
        "First understand what the supplied site appears to help users do before attempting the accepted tasks.",
        "Use the provided task list as the primary navigation plan for the visit.",
        "Do not assume a predefined agent personality or profile beyond what the submitted tasks require.",
        "Use the site understanding only to interpret the accepted tasks, not to invent new ones.",
        "Use only visible page information and honest interaction evidence.",
        "Behave like a realistic first-time visitor rather than a rigid script runner.",
        "When a task is ambiguous, choose the most reasonable visible path and explain that choice through the recorded evidence.",
        "Confirm whether the requested destination, content, or state actually appears before claiming success.",
        "If a task stalls, dead-ends, loops, or becomes misleading, verify that before moving on.",
        "Do not enter personal, financial, or secret information.",
        "Use harmless test input only when typing is necessary to evaluate a public interaction safely.",
        "Record blockers honestly when a task requires login, payment, invite-only access, or other gated access.",
        "Give a direct, evidence-based account of which requested tasks worked, partially worked, or failed."
      ]
    },
    tasks: tasks.map((task, index) => {
      const taskProfile = classifyTaskText(task);
      const gameplay = inferGameplayConfigFromTask(task);
      const successCondition =
        gameplay?.rounds
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
