import type { AccessibilityResult, FinalReport, SiteBrief, SiteChecks, TaskRunResult } from "../schemas/types.js";
import { buildStructuredReviewTemplate, labelForCoverageStatus, labelForMetricStatus, type ReportMetric, type ReportMetricGroup, type SectionCoverage } from "./template.js";

function renderList(items: string[]): string {
  return items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : "- None recorded.";
}

function renderMetricTable(metrics: ReportMetric[]): string {
  const header = "| Metric | Value | Status | Coverage |\n| --- | --- | --- | --- |";
  const rows = metrics.map((metric) => `| ${metric.label} | ${metric.value} | ${labelForMetricStatus(metric.status)} | ${labelForCoverageStatus(metric.verification)} |`);
  return [header, ...rows].join("\n");
}

function renderMetricGroups(groups: ReportMetricGroup[]): string {
  return groups
    .map((group) => `### ${group.title}\n\n${renderMetricTable(group.metrics)}`)
    .join("\n\n");
}

function renderCoverage(coverage: SectionCoverage): string {
  return `- Coverage: ${labelForCoverageStatus(coverage.status)}\n- Coverage note: ${coverage.summary}\n${coverage.evidence.length > 0 ? `- Evidence:\n${coverage.evidence.map((item) => `  - ${item}`).join("\n")}` : ""}${coverage.blockers.length > 0 ? `\n- Blockers:\n${coverage.blockers.map((item) => `  - ${item}`).join("\n")}` : ""}`;
}

function formatTaskOutcome(status: FinalReport["task_results"][number]["status"]): string {
  switch (status) {
    case "success":
      return "Succeeded";
    case "partial_success":
      return "Partially Succeeded";
    case "failed":
    default:
      return "Failed";
  }
}

export function renderMarkdownReport(args: {
  website: string;
  persona: string;
  acceptedTasks?: string[] | undefined;
  instructionText?: string | undefined;
  report: FinalReport;
  taskResults: TaskRunResult[];
  accessibility: AccessibilityResult | undefined;
  siteChecks: SiteChecks | undefined;
  siteBrief?: SiteBrief | null | undefined;
  rawEvents: unknown[] | undefined;
  startedAt: string | undefined;
  mobile: boolean | undefined;
  timeZone: string | undefined;
}): string {
  const template = buildStructuredReviewTemplate({
    website: args.website,
    report: args.report,
    taskResults: args.taskResults,
    accessibility: args.accessibility,
    siteChecks: args.siteChecks,
    rawEvents: args.rawEvents,
    startedAt: args.startedAt,
    mobile: args.mobile,
    timeZone: args.timeZone
  });

  return `# Task Execution Output: ${args.website}

## 1. Task Summary

- Website URL: ${template.executiveSummary.websiteUrl}
- Run Date: ${template.executiveSummary.auditDate}
- Overall Score: ${template.executiveSummary.overallScore}
- Visitor Lens: ${args.persona}

### Summary

${template.executiveSummary.summary}

### Key Strengths

${renderList(template.executiveSummary.keyStrengths)}

### Critical Issues

${renderList(template.executiveSummary.criticalIssues)}

### Business Impact

${template.executiveSummary.businessImpact}

${args.siteBrief
  ? `### What This Site Appears To Do

${args.siteBrief.summary}

${args.siteBrief.intendedUserActions.length > 0 ? renderList(args.siteBrief.intendedUserActions) : ""}
`
  : ""}

${(args.acceptedTasks?.length ?? 0) > 0 || args.instructionText?.trim()
  ? `### Instructions I Followed

${(args.acceptedTasks?.length ?? 0) > 0 ? renderList(args.acceptedTasks ?? []) : args.instructionText?.trim() ?? ""}
`
  : ""}

### Accepted Task Outcomes

${renderList(args.report.task_results.map((task) => `${task.name}: ${formatTaskOutcome(task.status)}. ${task.reason}`))}

${args.report.gameplay_summary
  ? `### Gameplay Results

- Summary: ${args.report.gameplay_summary.summary}
- Rounds requested: ${args.report.gameplay_summary.roundsRequested}
- Rounds recorded: ${args.report.gameplay_summary.roundsRecorded}
- Wins: ${args.report.gameplay_summary.wins}
- Losses: ${args.report.gameplay_summary.losses}
- Draws: ${args.report.gameplay_summary.draws}
- Inconclusive rounds: ${args.report.gameplay_summary.inconclusiveRounds}
- How-to-play confirmed: ${args.report.gameplay_summary.howToPlayConfirmed ? "Yes" : "No"}
- Replay confirmed: ${args.report.gameplay_summary.replayConfirmed ? "Yes" : "No"}
`
  : ""}

## 2. Performance Analysis

- Tools: ${template.performance.tools.join(", ")}

${renderCoverage(template.performance.coverage)}

${renderMetricTable(template.performance.metrics)}

### Insights

${renderList(template.performance.insights)}

### Recommendations

${renderList(template.performance.recommendations)}

## 3. SEO Audit

- Tools: ${template.seo.tools.join(", ")}

${renderCoverage(template.seo.coverage)}

${renderMetricGroups(template.seo.groups)}

### Recommendations

${renderList(template.seo.recommendations)}

## 4. UI/UX Evaluation

${renderCoverage(template.uiux.coverage)}

${renderMetricTable(template.uiux.metrics)}

### Key Issues

${renderList(template.uiux.issues)}

### Recommendations

${renderList(template.uiux.recommendations)}

## 5. Security Analysis

- Tools: ${template.security.tools.join(", ")}

${renderCoverage(template.security.coverage)}

${renderMetricTable(template.security.metrics)}

### Recommendations

${renderList(template.security.recommendations)}

## 6. Technical Health

${renderCoverage(template.technicalHealth.coverage)}

${renderMetricTable(template.technicalHealth.metrics)}

### Recommendations

${renderList(template.technicalHealth.recommendations)}

## 7. Mobile Optimization

${renderCoverage(template.mobileOptimization.coverage)}

${renderMetricTable(template.mobileOptimization.metrics)}

### Recommendations

${renderList(template.mobileOptimization.recommendations)}

## 8. Content Quality

${renderCoverage(template.contentQuality.coverage)}

${renderMetricTable(template.contentQuality.metrics)}

### Recommendations

${renderList(template.contentQuality.recommendations)}

## 9. Conversion Optimization (CRO)

${renderCoverage(template.cro.coverage)}

${renderMetricTable(template.cro.metrics)}

### Recommendations

${renderList(template.cro.recommendations)}

## 10. Action Plan (Prioritized)

### High Priority

${renderList(template.actionPlan.high)}

### Medium Priority

${renderList(template.actionPlan.medium)}

### Low Priority

${renderList(template.actionPlan.low)}

## 11. Final Score Breakdown

| Category | Score |
| --- | --- |
${template.scoreBreakdown.map((item) => `| ${item.category} | ${item.score} |`).join("\n")}

## 12. AI Agent Notes

- Confidence level: ${template.agentNotes.confidence}

### Data Sources Used

${renderList(template.agentNotes.dataSources)}

### Limitations of Analysis

${renderList(template.agentNotes.limitations)}

## Appendix: Task Evidence

${args.report.task_results
  .map(
    (task) => `### ${task.name}

- Status: ${task.status}
- Reason: ${task.reason}
- Evidence:
${task.evidence.length > 0 ? task.evidence.map((item) => `  - ${item}`).join("\n") : "  - None recorded."}`
  )
  .join("\n\n")}
`;
}
