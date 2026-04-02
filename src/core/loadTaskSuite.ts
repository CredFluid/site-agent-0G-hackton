import fs from "node:fs";
import path from "node:path";
import { PersonaSchema, TaskSuiteSchema, type TaskSuite } from "../schemas/types.js";
import { readUtf8 } from "../utils/files.js";

function buildGenericTaskSuite(raw: unknown): TaskSuite {
  const personaResult = PersonaSchema.safeParse((raw as { persona?: unknown } | null | undefined)?.persona);
  const persona = personaResult.success
    ? personaResult.data
    : {
        name: "generic first-time explorer",
        intent: "Interact with the site like a normal new visitor and record what happens after each visible click.",
        constraints: [
          "Use only visible page information",
          "Behave like a curious first-time visitor",
          "Prefer obvious visible navigation, tabs, buttons, cards, and links",
          "Do not fill forms or enter personal data",
          "Prefer destinations that have not been tried yet before repeating a path",
          "Treat security interstitials or verification checks as run limitations and record them explicitly"
        ]
      };

  return TaskSuiteSchema.parse({
    persona,
    tasks: [
      {
        name: "Generic site walkthrough",
        goal: "Freely explore the site's visible navigation and interactive elements like a normal first-time visitor. Follow obvious links, tabs, menus, cards, buttons, and back navigation while checking whether each action leads to the expected page or visible state change.",
        success_condition: "The agent reaches several distinct visible destinations, validates which interactions work cleanly, and records any slow, blocked, broken, or confusing paths.",
        failure_signals: [
          "dead click",
          "wrong destination",
          "tab or button does not visibly change the page",
          "loading feels stuck or ambiguous",
          "security or verification interstitial blocks the destination",
          "navigation becomes confusing after moving deeper"
        ]
      }
    ]
  });
}

function resolveTaskPath(taskPath: string): string {
  const candidates = path.isAbsolute(taskPath)
    ? [taskPath]
    : [
        path.join(process.cwd(), taskPath),
        ...(taskPath.startsWith("src/") ? [path.join(process.cwd(), "dist", taskPath.slice(4))] : [])
      ];

  const existingPath = candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
  return existingPath ?? candidates[0]!;
}

export function loadTaskSuite(taskPath: string): TaskSuite {
  const resolved = resolveTaskPath(taskPath);
  const raw = JSON.parse(readUtf8(resolved));
  if (!Array.isArray(raw.tasks) || raw.tasks.length === 0) {
    return buildGenericTaskSuite(raw);
  }
  return TaskSuiteSchema.parse(raw);
}
