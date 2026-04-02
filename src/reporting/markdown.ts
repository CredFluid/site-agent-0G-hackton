import type { FinalReport } from "../schemas/types.js";

export function renderMarkdownReport(args: {
  website: string;
  persona: string;
  report: FinalReport;
}): string {
  const { website, persona, report } = args;

  const scoreLines = Object.entries(report.scores)
    .map(([key, value]) => `- **${key.replace(/_/g, " ")}**: ${value}/10`)
    .join("\n");

  const taskBlocks = report.task_results
    .map(
      (task: FinalReport["task_results"][number]) => `### ${task.name}\n- Status: **${task.status}**\n- Reason: ${task.reason}\n- Evidence:\n${task.evidence
        .map((item: string) => `  - ${item}`)
        .join("\n")}`
    )
    .join("\n\n");

  return `# Website Review Report

- **Website**: ${website}
- **Persona**: ${persona}
- **Overall Score**: ${report.overall_score}/10

## Summary

${report.summary}

## Category Scores

${scoreLines}

## Strengths

${report.strengths.map((item: string) => `- ${item}`).join("\n") || "- None recorded"}

## Weaknesses

${report.weaknesses.map((item: string) => `- ${item}`).join("\n") || "- None recorded"}

## Task Results

${taskBlocks}

## Top Fixes

${report.top_fixes.map((item: string, index: number) => `${index + 1}. ${item}`).join("\n")}
`;
}
