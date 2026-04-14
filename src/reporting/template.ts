import type { AccessibilityResult, CoverageNote, FinalReport, SiteChecks, TaskRunResult } from "../schemas/types.js";

export type ReportMetricStatus = "good" | "warning" | "poor" | "blocked";
export type ReportCoverageStatus = "verified" | "inferred" | "blocked";

export type ReportMetric = {
  label: string;
  value: string;
  status: ReportMetricStatus;
  verification: ReportCoverageStatus;
};

export type ReportMetricGroup = {
  title: string;
  metrics: ReportMetric[];
};

export type SectionCoverage = {
  status: ReportCoverageStatus;
  summary: string;
  evidence: string[];
  blockers: string[];
};

export type StructuredReviewTemplate = {
  executiveSummary: {
    websiteUrl: string;
    auditDate: string;
    overallScore: string;
    summary: string;
    keyStrengths: string[];
    criticalIssues: string[];
    businessImpact: string;
  };
  performance: {
    coverage: SectionCoverage;
    tools: string[];
    metrics: ReportMetric[];
    insights: string[];
    recommendations: string[];
  };
  seo: {
    coverage: SectionCoverage;
    tools: string[];
    groups: ReportMetricGroup[];
    recommendations: string[];
  };
  uiux: {
    coverage: SectionCoverage;
    metrics: ReportMetric[];
    issues: string[];
    recommendations: string[];
  };
  security: {
    coverage: SectionCoverage;
    tools: string[];
    metrics: ReportMetric[];
    recommendations: string[];
  };
  technicalHealth: {
    coverage: SectionCoverage;
    metrics: ReportMetric[];
    recommendations: string[];
  };
  mobileOptimization: {
    coverage: SectionCoverage;
    metrics: ReportMetric[];
    recommendations: string[];
  };
  contentQuality: {
    coverage: SectionCoverage;
    metrics: ReportMetric[];
    recommendations: string[];
  };
  cro: {
    coverage: SectionCoverage;
    metrics: ReportMetric[];
    recommendations: string[];
  };
  actionPlan: {
    high: string[];
    medium: string[];
    low: string[];
  };
  scoreBreakdown: Array<{
    category: string;
    score: string;
  }>;
  agentNotes: {
    confidence: "High" | "Medium" | "Low";
    dataSources: string[];
    limitations: string[];
  };
};

type RawSignals = {
  navigationErrors: number;
  requestFailures: number;
  imageFailures: number;
  apiFailures: number;
  consoleErrors: number;
  consoleWarnings: number;
  pageErrors: number;
  securityBarriers: number;
  failedInteractions: number;
  stalledInteractions: number;
  formInteractions: number;
  formFailures: number;
  visitedTitles: string[];
};

const IMAGE_URL_PATTERN = /\.(?:avif|gif|ico|jpe?g|png|svg|webp)(?:[?#]|$)/i;
const API_URL_PATTERN = /\/api(?:\/|$)|graphql|wp-json|\.json(?:[?#]|$)/i;
const SECURITY_PATTERN = /security|verification|captcha|cloudflare|access denied/i;

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function uniqueItems(items: string[], limit: number): string[] {
  return [...new Set(items.map((item) => normalizeText(item)).filter(Boolean))].slice(0, limit);
}

function ensureSentence(value: string): string {
  const trimmed = normalizeText(value);
  if (!trimmed) {
    return "";
  }

  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function scoreToHundred(score: number): number {
  return Math.round(score * 10);
}

function formatScore(score: number): string {
  return `${scoreToHundred(score)}/100`;
}

function clampScore(value: number): number {
  return Math.min(10, Math.max(1, Math.round(value)));
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function labelFromScore(score: number): ReportMetricStatus {
  if (score >= 8) {
    return "good";
  }

  if (score >= 6) {
    return "warning";
  }

  return "poor";
}

function metricFromBoolean(label: string, value: boolean, verification: ReportCoverageStatus, positiveLabel: string, negativeLabel: string): ReportMetric {
  return {
    label,
    value: value ? positiveLabel : negativeLabel,
    status: verification === "blocked" ? "blocked" : value ? "good" : "poor",
    verification
  };
}

function metricFromCount(label: string, count: number, verification: ReportCoverageStatus, options: { goodAtMost: number; warningAtMost: number; singular: string; plural: string }): ReportMetric {
  return {
    label,
    value: `${count} ${count === 1 ? options.singular : options.plural}`,
    status:
      verification === "blocked"
        ? "blocked"
        : count <= options.goodAtMost
          ? "good"
          : count <= options.warningAtMost
            ? "warning"
            : "poor",
    verification
  };
}

function metricFromMs(label: string, value: number | null, verification: ReportCoverageStatus, thresholds: { goodAtMost: number; warningAtMost: number }, fallback: string): ReportMetric {
  if (value === null || value <= 0) {
    return {
      label,
      value: fallback,
      status: verification === "blocked" ? "blocked" : "warning",
      verification
    };
  }

  return {
    label,
    value: `${Math.round(value)}ms`,
    status:
      verification === "blocked"
        ? "blocked"
        : value <= thresholds.goodAtMost
          ? "good"
          : value <= thresholds.warningAtMost
            ? "warning"
            : "poor",
    verification
  };
}

function metricFromRatio(label: string, value: number | null, verification: ReportCoverageStatus, thresholds: { goodAtMost: number; warningAtMost: number }, digits: number, fallback: string): ReportMetric {
  if (value === null) {
    return {
      label,
      value: fallback,
      status: verification === "blocked" ? "blocked" : "warning",
      verification
    };
  }

  return {
    label,
    value: value.toFixed(digits),
    status:
      verification === "blocked"
        ? "blocked"
        : value <= thresholds.goodAtMost
          ? "good"
          : value <= thresholds.warningAtMost
            ? "warning"
            : "poor",
    verification
  };
}

function metricFromText(label: string, value: string, status: ReportMetricStatus, verification: ReportCoverageStatus): ReportMetric {
  return { label, value, status, verification };
}

function metricFromAffectedPages(
  label: string,
  affectedPages: number,
  totalPages: number,
  verification: ReportCoverageStatus,
  thresholds: { goodAtMostPct: number; warningAtMostPct: number },
  fallback: string
): ReportMetric {
  if (totalPages <= 0) {
    return {
      label,
      value: fallback,
      status: verification === "blocked" ? "blocked" : "warning",
      verification
    };
  }

  const percentage = (affectedPages / totalPages) * 100;
  return {
    label,
    value: `${affectedPages}/${totalPages} pages`,
    status:
      verification === "blocked"
        ? "blocked"
        : percentage <= thresholds.goodAtMostPct
          ? "good"
          : percentage <= thresholds.warningAtMostPct
            ? "warning"
            : "poor",
    verification
  };
}

export function labelForMetricStatus(status: ReportMetricStatus): string {
  switch (status) {
    case "good":
      return "Good";
    case "warning":
      return "Needs improvement";
    case "poor":
      return "Poor";
    case "blocked":
      return "Blocked";
    default:
      return "Needs improvement";
  }
}

export function labelForCoverageStatus(status: ReportCoverageStatus): string {
  switch (status) {
    case "verified":
      return "Verified";
    case "inferred":
      return "Inferred";
    case "blocked":
      return "Blocked";
    default:
      return "Inferred";
  }
}

function formatAuditDate(startedAt: string | undefined, timeZone: string | undefined): string {
  if (!startedAt) {
    return "Unknown";
  }

  const parsed = new Date(startedAt);
  if (Number.isNaN(parsed.getTime())) {
    return startedAt;
  }

  return parsed.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
    ...(timeZone ? { timeZone } : {})
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function coverageFrom(note: CoverageNote | undefined, fallback: SectionCoverage): SectionCoverage {
  if (!note) {
    return fallback;
  }

  return {
    status: note.status,
    summary: ensureSentence(note.summary),
    evidence: uniqueItems(note.evidence.map((item) => ensureSentence(item)), 5),
    blockers: uniqueItems(note.blockers.map((item) => ensureSentence(item)), 4)
  };
}

function hasProbeDomEvidence(probe: SiteChecks["performance"]["desktop"] | SiteChecks["performance"]["mobile"] | null | undefined): boolean {
  if (!probe) {
    return false;
  }

  return Boolean(
    probe.title ||
      probe.metaDescription ||
      probe.h1Count > 0 ||
      probe.h2Count > 0 ||
      probe.visibleLinkCount > 0 ||
      probe.internalLinkSamples.length > 0 ||
      probe.ctaSamples.length > 0 ||
      probe.formCount > 0 ||
      probe.wordCount > 0 ||
      probe.mediaCount > 0 ||
      probe.heroText
  );
}

function probeVerification(
  probe: SiteChecks["performance"]["desktop"] | SiteChecks["performance"]["mobile"] | null | undefined,
  fallback: ReportCoverageStatus
): ReportCoverageStatus {
  if (!probe) {
    return fallback;
  }

  return probe.loadOk || hasProbeDomEvidence(probe) ? "verified" : fallback;
}

function performanceVerification(
  probe: SiteChecks["performance"]["desktop"] | SiteChecks["performance"]["mobile"] | null | undefined,
  fallback: ReportCoverageStatus
): ReportCoverageStatus {
  if (!probe) {
    return fallback;
  }

  return probe.loadOk ||
    probe.performance.domContentLoadedMs !== null ||
    probe.performance.loadMs !== null ||
    probe.performance.firstContentfulPaintMs !== null ||
    probe.performance.largestContentfulPaintMs !== null ||
    probe.performance.cumulativeLayoutShift !== null
    ? "verified"
    : fallback;
}

function collectRawSignals(args: {
  report: FinalReport;
  taskResults: TaskRunResult[];
  rawEvents: unknown[] | undefined;
}): RawSignals {
  const visitedTitles = uniqueItems(
    args.taskResults.flatMap((task) => [
      task.finalTitle,
      ...task.history.map((entry) => entry.title)
    ]),
    10
  );

  const signals: RawSignals = {
    navigationErrors: 0,
    requestFailures: 0,
    imageFailures: 0,
    apiFailures: 0,
    consoleErrors: 0,
    consoleWarnings: 0,
    pageErrors: 0,
    securityBarriers: 0,
    failedInteractions: 0,
    stalledInteractions: 0,
    formInteractions: 0,
    formFailures: 0,
    visitedTitles
  };

  for (const event of args.rawEvents ?? []) {
    if (!isRecord(event)) {
      continue;
    }

    const type = typeof event.type === "string" ? event.type : "";
    const level = typeof event.level === "string" ? event.level : "";
    const note = typeof event.note === "string" ? event.note : "";
    const text = typeof event.text === "string" ? event.text : "";
    const url = typeof event.url === "string" ? event.url : "";
    const combined = `${note} ${text} ${url}`;

    if (type === "navigation_error") {
      signals.navigationErrors += 1;
    }

    if (type === "requestfailed") {
      signals.requestFailures += 1;
      if (IMAGE_URL_PATTERN.test(url) || /\/images?\//i.test(url)) {
        signals.imageFailures += 1;
      }
      if (API_URL_PATTERN.test(url)) {
        signals.apiFailures += 1;
      }
    }

    if (type === "pageerror") {
      signals.pageErrors += 1;
    }

    if (type === "console") {
      if (/error/i.test(level)) {
        signals.consoleErrors += 1;
      } else if (/warn/i.test(level)) {
        signals.consoleWarnings += 1;
      }
    }

    if (SECURITY_PATTERN.test(combined)) {
      signals.securityBarriers += 1;
    }
  }

  for (const task of args.taskResults) {
    for (const entry of task.history) {
      const note = entry.result.note ?? "";

      if (!entry.result.success) {
        signals.failedInteractions += 1;
      }

      if (/timeout|no clear visible change|unchanged page states/i.test(note)) {
        signals.stalledInteractions += 1;
      }

      if (entry.decision.action === "type") {
        signals.formInteractions += 1;
        if (!entry.result.success) {
          signals.formFailures += 1;
        }
      }

      if (SECURITY_PATTERN.test(note)) {
        signals.securityBarriers += 1;
      }
    }
  }

  return signals;
}

function buildFallbackSiteChecks(args: { website: string; report: FinalReport; signals: RawSignals }): SiteChecks {
  return {
    generatedAt: new Date().toISOString(),
    baseUrl: args.website,
    finalResolvedUrl: null,
    coverage: {
      performance: { status: "blocked", summary: "Performance checks were not available for this run.", evidence: [], blockers: [] },
      seo: { status: "blocked", summary: "SEO checks were not available for this run.", evidence: [], blockers: [] },
      uiux: { status: "inferred", summary: "UI and UX coverage relies on task interaction evidence.", evidence: [], blockers: [] },
      security: { status: "blocked", summary: "Security checks were not available for this run.", evidence: [], blockers: [] },
      technicalHealth: { status: "inferred", summary: "Technical health relies on saved browser events.", evidence: [], blockers: [] },
      mobileOptimization: { status: "blocked", summary: "Mobile checks were not available for this run.", evidence: [], blockers: [] },
      contentQuality: { status: "blocked", summary: "Content checks were not available for this run.", evidence: [], blockers: [] },
      cro: { status: "inferred", summary: "CRO relies on visible task outcomes in this run.", evidence: [], blockers: [] }
    },
    performance: {
      desktop: null,
      mobile: null,
      failedRequestCount: args.signals.requestFailures,
      imageFailureCount: args.signals.imageFailures,
      apiFailureCount: args.signals.apiFailures,
      navigationErrorCount: args.signals.navigationErrors,
      stalledInteractionCount: args.signals.stalledInteractions,
      evidence: []
    },
    seo: {
      robotsTxt: { url: new URL("/robots.txt", args.website).toString(), ok: false, statusCode: null, note: "No SEO artifact was saved for this run." },
      sitemap: { url: new URL("/sitemap.xml", args.website).toString(), ok: false, statusCode: null, note: "No SEO artifact was saved for this run." },
      brokenLinkCount: 0,
      checkedLinkCount: 0,
      brokenLinks: [],
      evidence: []
    },
    security: {
      https: args.website.startsWith("https://"),
      secureTransportVerified: false,
      initialStatusCode: null,
      securityHeaders: [],
      missingHeaders: [],
      evidence: []
    },
    technicalHealth: {
      framework: null,
      consoleErrorCount: args.signals.consoleErrors,
      consoleWarningCount: args.signals.consoleWarnings,
      pageErrorCount: args.signals.pageErrors,
      apiFailureCount: args.signals.apiFailures,
      evidence: []
    },
    mobileOptimization: {
      desktop: null,
      mobile: null,
      responsiveVerdict: "blocked",
      evidence: []
    },
    contentQuality: {
      readabilityScore: null,
      readabilityLabel: "Blocked",
      wordCount: 0,
      longParagraphCount: 0,
      mediaCount: 0,
      evidence: []
    },
    cro: {
      ctaCount: 0,
      primaryCtas: [],
      formCount: 0,
      submitControlCount: 0,
      trustSignalCount: 0,
      evidence: []
    }
  };
}

function buildBusinessImpact(report: FinalReport): string {
  if (report.scores.conversion_readiness <= 4) {
    return "Current friction is likely to reduce trust in the primary conversion path and increase drop-off before visitors complete a high-value action.";
  }

  if (report.scores.navigation <= 4 || report.scores.clarity <= 4) {
    return "Unclear navigation and weak first-click feedback are likely to slow discovery of important pages and suppress engagement.";
  }

  if (report.scores.trust <= 4) {
    return "Trust gaps may hold visitors back from moving forward, even when the site appears technically usable.";
  }

  return "The experience is usable in parts, but sharper execution on the main path would make the site more reliable and conversion-ready.";
}

function scorePerformance(siteChecks: SiteChecks, report: FinalReport): number {
  let score = average([report.scores.navigation, report.scores.friction]);
  const desktop = siteChecks.performance.desktop;
  if (desktop?.performance.largestContentfulPaintMs) {
    score += desktop.performance.largestContentfulPaintMs <= 2500 ? 1 : desktop.performance.largestContentfulPaintMs <= 4000 ? 0 : -1;
  }
  if (desktop?.performance.cumulativeLayoutShift !== null && desktop?.performance.cumulativeLayoutShift !== undefined) {
    score += desktop.performance.cumulativeLayoutShift <= 0.1 ? 1 : desktop.performance.cumulativeLayoutShift <= 0.25 ? 0 : -1;
  }
  score -= Math.min(2, siteChecks.performance.failedRequestCount * 0.2);
  return clampScore(score);
}

function scoreSeo(siteChecks: SiteChecks): number {
  const desktop = siteChecks.performance.desktop;
  const crawlSummary = siteChecks.seo.crawlSummary;
  const pageStats = siteChecks.seo.pageStats;
  const auditedPages = crawlSummary?.totalPagesAudited ?? 0;
  let score = 5;
  if (desktop?.title) {
    score += desktop.title.length >= 10 && desktop.title.length <= 65 ? 1 : 0;
  }
  if (desktop?.metaDescription) {
    score += desktop.metaDescription.length >= 50 && desktop.metaDescription.length <= 160 ? 1 : 0;
  }
  if (desktop?.h1Count === 1) {
    score += 1;
  } else if ((desktop?.h1Count ?? 0) === 0) {
    score -= 1;
  }
  if (siteChecks.seo.robotsTxt.ok) {
    score += 1;
  }
  if (siteChecks.seo.sitemap.ok) {
    score += 1;
  }
  score -= Math.min(2, siteChecks.seo.brokenLinkCount);
  if ((desktop?.structuredDataCount ?? 0) > 0) {
    score += 1;
  }
  if (auditedPages > 0 && pageStats) {
    const titleIssueRate = (pageStats.pagesMissingTitle + pageStats.pagesBadTitleLength) / auditedPages;
    const metaIssueRate = (pageStats.pagesMissingMetaDescription + pageStats.pagesBadMetaDescriptionLength) / auditedPages;
    const contentIssueRate =
      (pageStats.pagesMissingH1 +
        pageStats.pagesWithMultipleH1 +
        pageStats.pagesLowWordCount +
        pageStats.pagesThinOrPlaceholder +
        pageStats.pagesWithHeadingOrderIssues) /
      auditedPages;
    const metadataIssueRate =
      (pageStats.pagesMissingCanonical +
        pageStats.pagesNonSelfCanonical +
        pageStats.pagesMissingOpenGraphBasics +
        pageStats.pagesMissingTwitterCard +
        pageStats.pagesWithUrlIssues) /
      auditedPages;
    const technicalIssueRate =
      (pageStats.pagesMissingViewport +
        pageStats.pagesMissingCharset +
        pageStats.pagesMissingLang +
        pageStats.pagesWithRenderBlockingHeadScripts +
        pageStats.pagesWithNonLazyImages +
        pageStats.pagesWithUnlabeledInputs +
        pageStats.pagesWithUnlabeledInteractive +
        pageStats.pagesMissingSkipNav) /
      auditedPages;

    score += 1;
    score -= Math.min(1.5, titleIssueRate * 3);
    score -= Math.min(1.5, metaIssueRate * 3);
    score -= Math.min(1.5, contentIssueRate * 1.5);
    score -= Math.min(1, metadataIssueRate * 1.5);
    score -= Math.min(1, technicalIssueRate);
    if (pageStats.pagesWithStructuredData > 0) {
      score += 0.5;
    }
  }
  return clampScore(score);
}

function scoreSecurity(siteChecks: SiteChecks): number {
  let score = siteChecks.security.https ? 6 : 2;
  if (siteChecks.security.secureTransportVerified) {
    score += 1;
  }
  const presentHeaders = siteChecks.security.securityHeaders.filter((header) => header.present).length;
  score += presentHeaders / 2;
  return clampScore(score);
}

function scoreMobile(siteChecks: SiteChecks): number {
  const mobile = siteChecks.mobileOptimization.mobile;
  if (!mobile || siteChecks.mobileOptimization.responsiveVerdict === "blocked") {
    return 2;
  }

  let score = 7;
  if (mobile.horizontalOverflow) {
    score -= 3;
  }
  score -= Math.min(2, mobile.tapTargetIssueCount * 0.5);
  score -= Math.min(2, mobile.smallTextIssueCount * 0.2);
  if (siteChecks.mobileOptimization.responsiveVerdict === "mixed") {
    score -= 1;
  }
  if (siteChecks.mobileOptimization.responsiveVerdict === "responsive") {
    score += 1;
  }
  return clampScore(score);
}

function buildAccessibilityMetric(accessibility: AccessibilityResult | undefined): ReportMetric {
  if (!accessibility) {
    return {
      label: "Accessibility",
      value: "Accessibility artifact was unavailable for this run",
      status: "blocked",
      verification: "blocked"
    };
  }

  const severeIssues = accessibility.violations.filter(
    (violation) => violation.impact === "serious" || violation.impact === "critical"
  ).length;

  if (accessibility.error && accessibility.violations.length === 0) {
    return {
      label: "Accessibility",
      value: accessibility.error,
      status: "blocked",
      verification: "blocked"
    };
  }

  if (accessibility.violations.length === 0) {
    return {
      label: "Accessibility",
      value: "No automated violations found in the saved scan",
      status: "good",
      verification: "verified"
    };
  }

  return {
    label: "Accessibility",
    value: `${accessibility.violations.length} automated issue(s), including ${severeIssues} higher-impact finding(s)`,
    status: severeIssues > 0 ? "poor" : "warning",
    verification: accessibility.error ? "inferred" : "verified"
  };
}

function buildActionPlan(args: {
  report: FinalReport;
  accessibility: AccessibilityResult | undefined;
  siteChecks: SiteChecks;
}): StructuredReviewTemplate["actionPlan"] {
  const accessibilityFixes = (args.accessibility?.violations ?? [])
    .slice(0, 2)
    .map((violation) => `Fix the "${violation.id}" accessibility issue affecting ${violation.nodes} node(s).`);
  const securityFixes =
    args.siteChecks.security.missingHeaders.length > 0
      ? [`Add the missing security headers: ${args.siteChecks.security.missingHeaders.join(", ")}.`]
      : [];
  const mobileFixes =
    args.siteChecks.mobileOptimization.responsiveVerdict === "poor" || args.siteChecks.mobileOptimization.responsiveVerdict === "mixed"
      ? args.siteChecks.mobileOptimization.evidence
          .filter((item) => /overflow|tap target|small-text|text sizing/i.test(item))
          .map((item) => `Resolve the mobile issue highlighted by the probe: ${item}`)
      : [];

  const high = uniqueItems(
    [...args.report.top_fixes, ...mobileFixes, ...accessibilityFixes].map((item) => ensureSentence(item)),
    3
  );
  const medium = uniqueItems(
    [...securityFixes, ...accessibilityFixes, ...args.siteChecks.seo.brokenLinks.map((item) => `Repair or redirect the failing sampled link: ${item.url}`)].map((item) => ensureSentence(item)),
    3
  ).filter((item) => !high.includes(item));
  const low = uniqueItems(
    [
      args.siteChecks.performance.desktop?.performance.largestContentfulPaintMs && args.siteChecks.performance.desktop.performance.largestContentfulPaintMs > 2500
        ? "Optimize above-the-fold assets to bring the largest contentful paint down."
        : "",
      args.siteChecks.contentQuality.longParagraphCount > 0
        ? "Shorten long paragraphs and increase scanability in dense content blocks."
        : "",
      args.siteChecks.cro.trustSignalCount === 0
        ? "Add stronger trust signals near the main CTA and conversion path."
        : ""
    ].map((item) => ensureSentence(item)),
    3
  ).filter((item) => !high.includes(item) && !medium.includes(item));

  return { high, medium, low };
}

function buildConfidence(args: {
  report: FinalReport;
  taskResults: TaskRunResult[];
  accessibility: AccessibilityResult | undefined;
  siteChecks: SiteChecks;
  signals: RawSignals;
}): "High" | "Medium" | "Low" {
  const allFailed = args.report.task_results.length > 0 && args.report.task_results.every((task) => task.status === "failed");
  const blockedSections = Object.values(args.siteChecks.coverage).filter((coverage) => coverage.status === "blocked").length;
  const limitedAccessibility = Boolean(args.accessibility?.error) && args.accessibility?.violations.length === 0;
  const majorLimitations = [allFailed, limitedAccessibility, blockedSections >= 3, args.signals.securityBarriers > 0].filter(Boolean).length;

  if (majorLimitations >= 2) {
    return "Low";
  }

  if (majorLimitations === 0 && args.report.task_results.some((task) => task.status !== "failed")) {
    return "High";
  }

  return "Medium";
}

export function buildStructuredReviewTemplate(args: {
  website: string;
  report: FinalReport;
  taskResults: TaskRunResult[];
  accessibility: AccessibilityResult | undefined;
  siteChecks: SiteChecks | undefined;
  rawEvents: unknown[] | undefined;
  startedAt: string | undefined;
  mobile: boolean | undefined;
  timeZone: string | undefined;
}): StructuredReviewTemplate {
  const signals = collectRawSignals({
    report: args.report,
    taskResults: args.taskResults,
    rawEvents: args.rawEvents
  });
  const siteChecks = args.siteChecks ?? buildFallbackSiteChecks({ website: args.website, report: args.report, signals });
  const performanceScore = scorePerformance(siteChecks, args.report);
  const seoScore = scoreSeo(siteChecks);
  const uiuxScore = clampScore(average([args.report.scores.clarity, args.report.scores.navigation, args.report.scores.trust]));
  const securityScore = scoreSecurity(siteChecks);
  const mobileScore = scoreMobile(siteChecks);

  const performanceCoverage = coverageFrom(siteChecks.coverage.performance, {
    status: "blocked",
    summary: "Performance checks were unavailable for this run.",
    evidence: [],
    blockers: []
  });
  const seoCoverage = coverageFrom(siteChecks.coverage.seo, {
    status: "blocked",
    summary: "SEO checks were unavailable for this run.",
    evidence: [],
    blockers: []
  });
  const uiuxCoverage = coverageFrom(siteChecks.coverage.uiux, {
    status: "inferred",
    summary: "UI and UX findings were inferred from the interaction audit.",
    evidence: [],
    blockers: []
  });
  const securityCoverage = coverageFrom(siteChecks.coverage.security, {
    status: "blocked",
    summary: "Security checks were unavailable for this run.",
    evidence: [],
    blockers: []
  });
  const technicalCoverage = coverageFrom(siteChecks.coverage.technicalHealth, {
    status: "inferred",
    summary: "Technical health relies on runtime browser signals.",
    evidence: [],
    blockers: []
  });
  const mobileCoverage = coverageFrom(siteChecks.coverage.mobileOptimization, {
    status: "blocked",
    summary: "Mobile checks were unavailable for this run.",
    evidence: [],
    blockers: []
  });
  const contentCoverage = coverageFrom(siteChecks.coverage.contentQuality, {
    status: "blocked",
    summary: "Content checks were unavailable for this run.",
    evidence: [],
    blockers: []
  });
  const croCoverage = coverageFrom(siteChecks.coverage.cro, {
    status: "inferred",
    summary: "CRO findings rely on visible task outcomes.",
    evidence: [],
    blockers: []
  });
  const seoCrawlSummary =
    siteChecks.seo.crawlSummary ?? {
      totalPagesAudited: 0,
      crawlDepthReached: 0,
      pagesSkipped: 0,
      skipReasons: []
    };
  const seoPageStats =
    siteChecks.seo.pageStats ?? {
      pagesMissingTitle: 0,
      pagesBadTitleLength: 0,
      pagesMissingMetaDescription: 0,
      pagesBadMetaDescriptionLength: 0,
      pagesMissingCanonical: 0,
      pagesNonSelfCanonical: 0,
      noindexPages: 0,
      nofollowPages: 0,
      pagesMissingViewport: 0,
      pagesMissingCharset: 0,
      pagesWithStructuredData: 0,
      pagesMissingOpenGraphBasics: 0,
      pagesMissingTwitterCard: 0,
      pagesWithUrlIssues: 0,
      pagesMissingH1: 0,
      pagesWithMultipleH1: 0,
      pagesWithHeadingOrderIssues: 0,
      pagesLowWordCount: 0,
      pagesThinOrPlaceholder: 0,
      pagesWithGenericAnchors: 0,
      imagesMissingAlt: 0,
      imagesWithNonDescriptiveFilenames: 0,
      pagesWithRenderBlockingHeadScripts: 0,
      pagesWithNonLazyImages: 0,
      pagesWithResourceHints: 0,
      pagesMissingLang: 0,
      pagesWithUnlabeledInputs: 0,
      pagesWithUnlabeledInteractive: 0,
      pagesMissingSkipNav: 0
    };
  const seoAuditedPages = siteChecks.seo.auditedPages ?? [];

  const executiveSummary = {
    websiteUrl: args.website,
    auditDate: formatAuditDate(args.startedAt, args.timeZone),
    overallScore: formatScore(args.report.overall_score),
    summary: ensureSentence(args.report.summary),
    keyStrengths: uniqueItems(args.report.strengths.map((item) => ensureSentence(item)), 3),
    criticalIssues: uniqueItems(args.report.weaknesses.map((item) => ensureSentence(item)), 3),
    businessImpact: buildBusinessImpact(args.report)
  };

  const desktopDomVerification = probeVerification(siteChecks.performance.desktop, seoCoverage.status);
  const mobileDomVerification = probeVerification(siteChecks.performance.mobile, mobileCoverage.status);
  const desktopPerformanceVerification = performanceVerification(siteChecks.performance.desktop, performanceCoverage.status);
  const mobilePerformanceVerification = performanceVerification(siteChecks.performance.mobile, mobileCoverage.status);
  const seoCrawlVerification: ReportCoverageStatus =
    siteChecks.seo.robotsTxt.statusCode !== null ||
    siteChecks.seo.sitemap.statusCode !== null ||
    siteChecks.seo.checkedLinkCount > 0 ||
    seoCrawlSummary.totalPagesAudited > 0
      ? "verified"
      : seoCoverage.status;
  const securityHeaderVerification: ReportCoverageStatus =
    siteChecks.security.initialStatusCode !== null ||
    siteChecks.security.secureTransportVerified ||
    siteChecks.security.securityHeaders.some((header) => /^Present with value|^Missing from the main document response\./i.test(header.note))
      ? "verified"
      : securityCoverage.status;
  const httpsVerification: ReportCoverageStatus =
    siteChecks.security.initialStatusCode !== null || siteChecks.security.secureTransportVerified ? "verified" : securityCoverage.status;
  const contentMetricVerification: ReportCoverageStatus =
    siteChecks.performance.desktop?.loadOk
      ? "verified"
      : siteChecks.performance.desktop &&
          (siteChecks.performance.desktop.wordCount > 0 ||
            siteChecks.performance.desktop.mediaCount > 0 ||
            siteChecks.performance.desktop.readabilityScore !== null ||
            siteChecks.performance.desktop.longParagraphCount > 0)
        ? "verified"
        : contentCoverage.status;
  const croMetricVerification: ReportCoverageStatus =
    siteChecks.performance.desktop?.loadOk
      ? "verified"
      : siteChecks.cro.ctaCount > 0 || siteChecks.cro.formCount > 0 || siteChecks.cro.trustSignalCount > 0
        ? "verified"
        : croCoverage.status;

  const performanceMetrics: ReportMetric[] = [
    metricFromMs(
      "Desktop load time",
      siteChecks.performance.desktop?.performance.loadMs ?? null,
      desktopPerformanceVerification,
      { goodAtMost: 2500, warningAtMost: 4000 },
      desktopPerformanceVerification === "blocked" ? performanceCoverage.blockers[0] ?? "Blocked" : "Load metric unavailable"
    ),
    metricFromMs(
      "Mobile load time",
      siteChecks.performance.mobile?.performance.loadMs ?? null,
      mobilePerformanceVerification,
      { goodAtMost: 3000, warningAtMost: 4500 },
      mobilePerformanceVerification === "blocked" ? mobileCoverage.blockers[0] ?? "Blocked" : "Load metric unavailable"
    ),
    metricFromMs(
      "Largest Contentful Paint",
      siteChecks.performance.desktop?.performance.largestContentfulPaintMs ?? null,
      desktopPerformanceVerification,
      { goodAtMost: 2500, warningAtMost: 4000 },
      desktopPerformanceVerification === "blocked" ? performanceCoverage.blockers[0] ?? "Blocked" : "LCP metric unavailable"
    ),
    metricFromRatio(
      "Cumulative Layout Shift",
      siteChecks.performance.desktop?.performance.cumulativeLayoutShift ?? null,
      desktopPerformanceVerification,
      { goodAtMost: 0.1, warningAtMost: 0.25 },
      3,
      desktopPerformanceVerification === "blocked" ? performanceCoverage.blockers[0] ?? "Blocked" : "CLS metric unavailable"
    ),
    metricFromCount(
      "Failed requests",
      siteChecks.performance.failedRequestCount,
      "verified",
      { goodAtMost: 0, warningAtMost: 2, singular: "failed request", plural: "failed requests" }
    )
  ];

  const seoGroups: ReportMetricGroup[] = [
    {
      title: "Crawl Coverage",
      metrics: [
        metricFromText(
          "Pages audited",
          seoCrawlSummary.totalPagesAudited > 0
            ? `${seoCrawlSummary.totalPagesAudited} pages up to depth ${seoCrawlSummary.crawlDepthReached}`
            : seoCrawlVerification === "blocked"
              ? seoCoverage.blockers[0] ?? "Blocked"
              : "No crawl pages were captured",
          seoCrawlVerification === "blocked" ? "blocked" : seoCrawlSummary.totalPagesAudited >= 5 ? "good" : seoCrawlSummary.totalPagesAudited >= 1 ? "warning" : "poor",
          seoCrawlVerification
        ),
        metricFromText(
          "Pages skipped",
          seoCrawlSummary.totalPagesAudited > 0 || seoCrawlSummary.pagesSkipped > 0
            ? `${seoCrawlSummary.pagesSkipped} skipped`
            : seoCrawlVerification === "blocked"
              ? seoCoverage.blockers[0] ?? "Blocked"
              : "No crawl skip data",
          seoCrawlVerification === "blocked"
            ? "blocked"
            : seoCrawlSummary.pagesSkipped === 0
              ? "good"
              : seoCrawlSummary.pagesSkipped <= Math.max(2, seoCrawlSummary.totalPagesAudited)
                ? "warning"
                : "poor",
          seoCrawlVerification
        ),
        metricFromText(
          "Top skip reasons",
          seoCrawlSummary.skipReasons.length > 0 ? seoCrawlSummary.skipReasons.join("; ") : "No major crawl skips recorded",
          seoCrawlVerification === "blocked" ? "blocked" : seoCrawlSummary.skipReasons.length === 0 ? "good" : "warning",
          seoCrawlVerification
        )
      ]
    },
    {
      title: "Metadata Hygiene",
      metrics: [
        metricFromBoolean("Robots.txt", siteChecks.seo.robotsTxt.ok, siteChecks.seo.robotsTxt.statusCode !== null ? "verified" : seoCrawlVerification, "Present and reachable", siteChecks.seo.robotsTxt.note),
        metricFromBoolean("Sitemap", siteChecks.seo.sitemap.ok, siteChecks.seo.sitemap.statusCode !== null ? "verified" : seoCrawlVerification, "Present and reachable", siteChecks.seo.sitemap.note),
        metricFromAffectedPages("Title-tag issues", seoPageStats.pagesMissingTitle + seoPageStats.pagesBadTitleLength, seoCrawlSummary.totalPagesAudited, seoCrawlVerification, {
          goodAtMostPct: 10,
          warningAtMostPct: 35
        }, "Title-tag coverage unavailable"),
        metricFromAffectedPages("Meta-description issues", seoPageStats.pagesMissingMetaDescription + seoPageStats.pagesBadMetaDescriptionLength, seoCrawlSummary.totalPagesAudited, seoCrawlVerification, {
          goodAtMostPct: 10,
          warningAtMostPct: 35
        }, "Meta-description coverage unavailable"),
        metricFromAffectedPages("Canonical issues", seoPageStats.pagesMissingCanonical + seoPageStats.pagesNonSelfCanonical, seoCrawlSummary.totalPagesAudited, seoCrawlVerification, {
          goodAtMostPct: 5,
          warningAtMostPct: 20
        }, "Canonical coverage unavailable")
      ]
    },
    {
      title: "Content & Indexability",
      metrics: [
        metricFromAffectedPages("H1 issues", seoPageStats.pagesMissingH1 + seoPageStats.pagesWithMultipleH1, seoCrawlSummary.totalPagesAudited, seoCrawlVerification, {
          goodAtMostPct: 5,
          warningAtMostPct: 20
        }, "Heading coverage unavailable"),
        metricFromAffectedPages("Heading-order issues", seoPageStats.pagesWithHeadingOrderIssues, seoCrawlSummary.totalPagesAudited, seoCrawlVerification, {
          goodAtMostPct: 5,
          warningAtMostPct: 20
        }, "Heading-order coverage unavailable"),
        metricFromAffectedPages("Low-word-count pages", seoPageStats.pagesLowWordCount, seoCrawlSummary.totalPagesAudited, seoCrawlVerification, {
          goodAtMostPct: 10,
          warningAtMostPct: 30
        }, "Word-count coverage unavailable"),
        metricFromAffectedPages("Thin or placeholder pages", seoPageStats.pagesThinOrPlaceholder, seoCrawlSummary.totalPagesAudited, seoCrawlVerification, {
          goodAtMostPct: 5,
          warningAtMostPct: 20
        }, "Thin-content coverage unavailable"),
        metricFromAffectedPages("Nofollow pages", seoPageStats.nofollowPages, seoCrawlSummary.totalPagesAudited, seoCrawlVerification, {
          goodAtMostPct: 5,
          warningAtMostPct: 20
        }, "Follow-directive coverage unavailable"),
        metricFromAffectedPages("Noindex pages", seoPageStats.noindexPages, seoCrawlSummary.totalPagesAudited, seoCrawlVerification, {
          goodAtMostPct: 5,
          warningAtMostPct: 20
        }, "Indexability coverage unavailable")
      ]
    },
    {
      title: "Search Enhancements",
      metrics: [
        metricFromAffectedPages("Missing Open Graph basics", seoPageStats.pagesMissingOpenGraphBasics, seoCrawlSummary.totalPagesAudited, seoCrawlVerification, {
          goodAtMostPct: 10,
          warningAtMostPct: 35
        }, "Open Graph coverage unavailable"),
        metricFromAffectedPages("Missing Twitter cards", seoPageStats.pagesMissingTwitterCard, seoCrawlSummary.totalPagesAudited, seoCrawlVerification, {
          goodAtMostPct: 10,
          warningAtMostPct: 35
        }, "Twitter-card coverage unavailable"),
        metricFromAffectedPages("Pages with URL issues", seoPageStats.pagesWithUrlIssues, seoCrawlSummary.totalPagesAudited, seoCrawlVerification, {
          goodAtMostPct: 5,
          warningAtMostPct: 20
        }, "URL-structure coverage unavailable"),
        metricFromAffectedPages("Pages missing structured data", Math.max(0, seoCrawlSummary.totalPagesAudited - seoPageStats.pagesWithStructuredData), seoCrawlSummary.totalPagesAudited, seoCrawlVerification, {
          goodAtMostPct: 15,
          warningAtMostPct: 50
        }, "Structured-data coverage unavailable")
      ]
    },
    {
      title: "Links & HTML Signals",
      metrics: [
        metricFromCount("Sampled broken links", siteChecks.seo.brokenLinkCount, siteChecks.seo.checkedLinkCount > 0 ? "verified" : seoCrawlVerification, {
          goodAtMost: 0,
          warningAtMost: 1,
          singular: "broken sampled link",
          plural: "broken sampled links"
        }),
        metricFromAffectedPages("Generic-anchor pages", seoPageStats.pagesWithGenericAnchors, seoCrawlSummary.totalPagesAudited, seoCrawlVerification, {
          goodAtMostPct: 10,
          warningAtMostPct: 35
        }, "Anchor-text coverage unavailable"),
        metricFromText(
          "Images missing alt text",
          seoCrawlSummary.totalPagesAudited > 0 ? `${seoPageStats.imagesMissingAlt} image(s)` : seoCrawlVerification === "blocked" ? seoCoverage.blockers[0] ?? "Blocked" : "Image-alt coverage unavailable",
          seoCrawlVerification === "blocked"
            ? "blocked"
            : seoPageStats.imagesMissingAlt === 0
              ? "good"
              : seoPageStats.imagesMissingAlt <= Math.max(3, seoCrawlSummary.totalPagesAudited)
                ? "warning"
                : "poor",
          seoCrawlVerification
        ),
        metricFromText(
          "Non-descriptive image filenames",
          seoCrawlSummary.totalPagesAudited > 0 ? `${seoPageStats.imagesWithNonDescriptiveFilenames} image(s)` : seoCrawlVerification === "blocked" ? seoCoverage.blockers[0] ?? "Blocked" : "Image-filename coverage unavailable",
          seoCrawlVerification === "blocked"
            ? "blocked"
            : seoPageStats.imagesWithNonDescriptiveFilenames === 0
              ? "good"
              : seoPageStats.imagesWithNonDescriptiveFilenames <= Math.max(2, seoCrawlSummary.totalPagesAudited)
                ? "warning"
                : "poor",
          seoCrawlVerification
        )
      ]
    },
    {
      title: "Performance Signals",
      metrics: [
        metricFromAffectedPages("Viewport or charset missing", seoPageStats.pagesMissingViewport + seoPageStats.pagesMissingCharset, seoCrawlSummary.totalPagesAudited, seoCrawlVerification, {
          goodAtMostPct: 5,
          warningAtMostPct: 15
        }, "Viewport/charset coverage unavailable"),
        metricFromAffectedPages("Render-blocking head scripts", seoPageStats.pagesWithRenderBlockingHeadScripts, seoCrawlSummary.totalPagesAudited, seoCrawlVerification, {
          goodAtMostPct: 10,
          warningAtMostPct: 30
        }, "Head-script coverage unavailable"),
        metricFromAffectedPages("Pages with non-lazy images", seoPageStats.pagesWithNonLazyImages, seoCrawlSummary.totalPagesAudited, seoCrawlVerification, {
          goodAtMostPct: 10,
          warningAtMostPct: 35
        }, "Image-loading coverage unavailable"),
        metricFromAffectedPages("Pages missing resource hints", Math.max(0, seoCrawlSummary.totalPagesAudited - seoPageStats.pagesWithResourceHints), seoCrawlSummary.totalPagesAudited, seoCrawlVerification, {
          goodAtMostPct: 25,
          warningAtMostPct: 60
        }, "Resource-hint coverage unavailable")
      ]
    },
    {
      title: "Accessibility Signals",
      metrics: [
        metricFromAffectedPages("Pages without lang", seoPageStats.pagesMissingLang, seoCrawlSummary.totalPagesAudited, seoCrawlVerification, {
          goodAtMostPct: 5,
          warningAtMostPct: 15
        }, "Lang coverage unavailable"),
        metricFromAffectedPages("Pages with unlabeled form fields", seoPageStats.pagesWithUnlabeledInputs, seoCrawlSummary.totalPagesAudited, seoCrawlVerification, {
          goodAtMostPct: 5,
          warningAtMostPct: 20
        }, "Form-label coverage unavailable"),
        metricFromAffectedPages("Pages with unlabeled controls", seoPageStats.pagesWithUnlabeledInteractive, seoCrawlSummary.totalPagesAudited, seoCrawlVerification, {
          goodAtMostPct: 5,
          warningAtMostPct: 20
        }, "Interactive-label coverage unavailable"),
        metricFromAffectedPages("Pages missing skip nav", seoPageStats.pagesMissingSkipNav, seoCrawlSummary.totalPagesAudited, seoCrawlVerification, {
          goodAtMostPct: 20,
          warningAtMostPct: 50
        }, "Skip-nav coverage unavailable")
      ]
    },
    ...(
      seoAuditedPages.length > 0
        ? [
            {
              title: "Priority Pages",
              metrics: seoAuditedPages.slice(0, 3).map((page, index) =>
                metricFromText(
                  `Page ${index + 1}`,
                  `${page.url} (${page.issueCount} issue(s); ${page.notableIssues.slice(0, 2).join("; ") || "Needs manual follow-up"})`,
                  page.issueCount <= 2 ? "good" : page.issueCount <= 5 ? "warning" : "poor",
                  seoCrawlVerification
                )
              )
            }
          ]
        : []
    )
  ];

  const uiuxMetrics: ReportMetric[] = [
    metricFromText("Navigation clarity", formatScore(clampScore(average([args.report.scores.clarity, args.report.scores.navigation]))), labelFromScore(average([args.report.scores.clarity, args.report.scores.navigation])), uiuxCoverage.status),
    metricFromText(
      "Mobile responsiveness",
      siteChecks.mobileOptimization.responsiveVerdict === "responsive"
        ? "Responsive in dedicated mobile probe"
        : siteChecks.mobileOptimization.responsiveVerdict === "mixed"
          ? "Partially responsive in dedicated mobile probe"
          : siteChecks.mobileOptimization.responsiveVerdict === "poor"
            ? "Responsive issues found in dedicated mobile probe"
            : mobileDomVerification === "blocked"
              ? mobileCoverage.blockers[0] ?? "Blocked"
              : "Mobile probe did not load cleanly",
      siteChecks.mobileOptimization.responsiveVerdict === "responsive"
        ? "good"
        : siteChecks.mobileOptimization.responsiveVerdict === "mixed"
          ? "warning"
          : siteChecks.mobileOptimization.responsiveVerdict === "poor"
            ? "poor"
            : mobileDomVerification === "blocked"
              ? "blocked"
              : "poor",
      siteChecks.mobileOptimization.responsiveVerdict === "blocked" ? mobileDomVerification : "verified"
    ),
    metricFromText("Visual hierarchy", `Clarity score ${formatScore(args.report.scores.clarity)}`, labelFromScore(args.report.scores.clarity), uiuxCoverage.status),
    buildAccessibilityMetric(args.accessibility)
  ];

  const securityMetrics: ReportMetric[] = [
    metricFromBoolean("HTTPS", siteChecks.security.https, httpsVerification, "Enabled", "HTTP or blocked"),
    metricFromBoolean("Secure transport", siteChecks.security.secureTransportVerified, siteChecks.security.initialStatusCode !== null ? "verified" : securityCoverage.status, "Verified by live page probe", securityCoverage.blockers[0] ?? "Could not verify secure transport"),
    metricFromCount("Missing security headers", siteChecks.security.missingHeaders.length, securityHeaderVerification, {
      goodAtMost: 0,
      warningAtMost: 2,
      singular: "missing header",
      plural: "missing headers"
    }),
    metricFromText(
      "Main document status",
      siteChecks.security.initialStatusCode ? `${siteChecks.security.initialStatusCode}` : securityCoverage.blockers[0] ?? "Blocked",
      siteChecks.security.initialStatusCode === null && securityCoverage.status === "blocked" ? "blocked" : siteChecks.security.initialStatusCode && siteChecks.security.initialStatusCode < 400 ? "good" : "poor",
      siteChecks.security.initialStatusCode !== null ? "verified" : securityCoverage.status
    )
  ];

  const technicalMetrics: ReportMetric[] = [
    metricFromText(
      "Framework/CMS",
      siteChecks.technicalHealth.framework ?? "Could not confidently fingerprint from sampled markup",
      siteChecks.technicalHealth.framework ? "good" : "warning",
      siteChecks.technicalHealth.framework ? "verified" : technicalCoverage.status
    ),
    metricFromCount("Console errors", siteChecks.technicalHealth.consoleErrorCount, technicalCoverage.status, {
      goodAtMost: 0,
      warningAtMost: 1,
      singular: "console error",
      plural: "console errors"
    }),
    metricFromCount("Page errors", siteChecks.technicalHealth.pageErrorCount, technicalCoverage.status, {
      goodAtMost: 0,
      warningAtMost: 1,
      singular: "page error",
      plural: "page errors"
    }),
    metricFromCount("API failures", siteChecks.technicalHealth.apiFailureCount, technicalCoverage.status, {
      goodAtMost: 0,
      warningAtMost: 1,
      singular: "API failure",
      plural: "API failures"
    })
  ];

  const mobileMetrics: ReportMetric[] = [
    metricFromBoolean(
      "Dedicated mobile probe",
      siteChecks.mobileOptimization.mobile?.loadOk ?? false,
      mobileDomVerification,
      "Mobile page loaded successfully",
      mobileDomVerification === "blocked" ? mobileCoverage.blockers[0] ?? "Blocked" : "Mobile probe did not load cleanly"
    ),
    metricFromBoolean(
      "Horizontal overflow",
      !(siteChecks.mobileOptimization.mobile?.horizontalOverflow ?? true),
      mobileDomVerification,
      "No horizontal overflow detected",
      mobileDomVerification === "blocked" ? mobileCoverage.blockers[0] ?? "Blocked" : "Horizontal overflow detected"
    ),
    metricFromCount("Tap target issues", siteChecks.mobileOptimization.mobile?.tapTargetIssueCount ?? 0, mobileDomVerification, {
      goodAtMost: 0,
      warningAtMost: 2,
      singular: "tap target issue",
      plural: "tap target issues"
    }),
    metricFromCount("Small-text issues", siteChecks.mobileOptimization.mobile?.smallTextIssueCount ?? 0, mobileDomVerification, {
      goodAtMost: 0,
      warningAtMost: 4,
      singular: "small-text issue",
      plural: "small-text issues"
    })
  ];

  const contentMetrics: ReportMetric[] = [
    metricFromText(
      "Readability",
      siteChecks.contentQuality.readabilityScore !== null
        ? `${siteChecks.contentQuality.readabilityLabel} (${siteChecks.contentQuality.readabilityScore})`
        : contentMetricVerification === "blocked"
          ? contentCoverage.blockers[0] ?? "Blocked"
          : siteChecks.contentQuality.readabilityLabel || "Readability unavailable",
      contentMetricVerification === "blocked"
        ? "blocked"
        : siteChecks.contentQuality.readabilityLabel === "Easy"
          ? "good"
          : siteChecks.contentQuality.readabilityLabel === "Moderate"
            ? "warning"
            : "poor",
      contentMetricVerification
    ),
    metricFromCount("Visible word count", siteChecks.contentQuality.wordCount, contentMetricVerification, {
      goodAtMost: 999999,
      warningAtMost: 120,
      singular: "visible word",
      plural: "visible words"
    }),
    metricFromCount("Long paragraphs", siteChecks.contentQuality.longParagraphCount, contentMetricVerification, {
      goodAtMost: 0,
      warningAtMost: 2,
      singular: "long paragraph",
      plural: "long paragraphs"
    }),
    metricFromCount("Media elements", siteChecks.contentQuality.mediaCount, contentMetricVerification, {
      goodAtMost: 999999,
      warningAtMost: 0,
      singular: "media element",
      plural: "media elements"
    })
  ];

  const croMetrics: ReportMetric[] = [
    metricFromCount("Visible CTA count", siteChecks.cro.ctaCount, croMetricVerification, {
      goodAtMost: 999999,
      warningAtMost: 1,
      singular: "CTA",
      plural: "CTAs"
    }),
    metricFromCount("Forms", siteChecks.cro.formCount, croMetricVerification, {
      goodAtMost: 999999,
      warningAtMost: 0,
      singular: "form",
      plural: "forms"
    }),
    metricFromCount("Trust signals", siteChecks.cro.trustSignalCount, croMetricVerification, {
      goodAtMost: 999999,
      warningAtMost: 0,
      singular: "trust signal",
      plural: "trust signals"
    }),
    metricFromText("Funnel clarity", formatScore(clampScore(average([args.report.scores.clarity, args.report.scores.conversion_readiness]))), labelFromScore(average([args.report.scores.clarity, args.report.scores.conversion_readiness])), croCoverage.status)
  ];

  const performanceRecommendations = uniqueItems(
    [
      ...args.report.top_fixes,
      siteChecks.performance.imageFailureCount > 0 ? "Investigate the failing image requests that are weakening first-load stability." : "",
      siteChecks.performance.desktop?.performance.largestContentfulPaintMs && siteChecks.performance.desktop.performance.largestContentfulPaintMs > 2500
        ? "Optimize the largest above-the-fold content so it paints faster."
        : ""
    ].map((item) => ensureSentence(item)),
    4
  );

  const seoRecommendations = uniqueItems(
    [
      seoPageStats.pagesMissingTitle + seoPageStats.pagesBadTitleLength > 0 ? "Normalize page titles so each crawled page has a unique title in the ideal length range." : "",
      seoPageStats.pagesMissingMetaDescription + seoPageStats.pagesBadMetaDescriptionLength > 0 ? "Add or tighten meta descriptions across the pages missing strong search snippets." : "",
      seoPageStats.pagesMissingCanonical + seoPageStats.pagesNonSelfCanonical > 0 ? "Add self-referencing canonicals on the pages missing canonical consistency." : "",
      seoPageStats.pagesMissingH1 + seoPageStats.pagesWithMultipleH1 + seoPageStats.pagesWithHeadingOrderIssues > 0 ? "Normalize heading structure so pages expose one clear H1 and do not skip heading levels." : "",
      seoPageStats.pagesLowWordCount + seoPageStats.pagesThinOrPlaceholder > 0 ? "Expand thin pages with clearer, more useful copy and remove placeholder content." : "",
      seoPageStats.noindexPages + seoPageStats.nofollowPages > 0 ? "Review robots directives on pages marked noindex or nofollow and keep them only where they are intentional." : "",
      seoPageStats.pagesMissingOpenGraphBasics + seoPageStats.pagesMissingTwitterCard > 0 ? "Complete Open Graph and Twitter card metadata on pages missing social-preview tags." : "",
      siteChecks.seo.robotsTxt.ok ? "" : "Publish a reachable robots.txt file.",
      siteChecks.seo.sitemap.ok ? "" : "Publish a reachable sitemap.xml file.",
      siteChecks.seo.brokenLinks.length > 0 ? "Repair or redirect the failing sampled internal links." : "",
      seoPageStats.imagesMissingAlt > 0 ? "Add descriptive alt text to images that currently have empty or missing alt attributes." : "",
      seoPageStats.pagesWithUnlabeledInputs + seoPageStats.pagesWithUnlabeledInteractive > 0 ? "Add clear labels or accessible names to form fields and interactive controls." : "",
      seoPageStats.pagesMissingLang + seoPageStats.pagesMissingSkipNav > 0 ? "Add page language declarations and skip-navigation links to improve crawl clarity and accessibility." : "",
      seoPageStats.pagesWithNonLazyImages + Math.max(0, seoCrawlSummary.totalPagesAudited - seoPageStats.pagesWithResourceHints) > 0
        ? "Defer non-critical imagery and add preload, preconnect, or similar resource hints where they materially help the critical path."
        : "",
      seoPageStats.pagesWithRenderBlockingHeadScripts > 0 ? "Defer or async non-critical head scripts that are blocking crawl and render efficiency." : "",
      seoAuditedPages[0] ? `Start with ${seoAuditedPages[0].url}, which surfaced ${seoAuditedPages[0].issueCount} SEO issue(s) in the crawl.` : ""
    ].map((item) => ensureSentence(item)),
    8
  );

  const uiuxRecommendations = uniqueItems(
    [...args.report.top_fixes, ...mobileCoverage.evidence].map((item) => ensureSentence(item)),
    4
  );

  const securityRecommendations = uniqueItems(
    [
      siteChecks.security.missingHeaders.length > 0 ? `Add the missing security headers: ${siteChecks.security.missingHeaders.join(", ")}.` : "",
      siteChecks.security.https ? "" : "Serve the main experience over HTTPS.",
      signals.securityBarriers > 0 ? "Provide a QA-safe lane when verification walls block normal task coverage." : ""
    ].map((item) => ensureSentence(item)),
    4
  );

  const technicalRecommendations = uniqueItems(
    [
      siteChecks.technicalHealth.consoleErrorCount > 0 ? "Fix the console errors surfaced during the run." : "",
      siteChecks.technicalHealth.pageErrorCount > 0 ? "Fix the uncaught runtime page errors." : "",
      siteChecks.technicalHealth.apiFailureCount > 0 ? "Stabilize the failing API requests and backend responses." : ""
    ].map((item) => ensureSentence(item)),
    4
  );

  const mobileRecommendations = uniqueItems(
    [
      siteChecks.mobileOptimization.mobile?.horizontalOverflow ? "Fix horizontal overflow in the mobile layout." : "",
      (siteChecks.mobileOptimization.mobile?.tapTargetIssueCount ?? 0) > 0 ? "Increase the size of undersized mobile tap targets." : "",
      (siteChecks.mobileOptimization.mobile?.smallTextIssueCount ?? 0) > 0 ? "Increase mobile text size where content falls below the legibility threshold." : ""
    ].map((item) => ensureSentence(item)),
    4
  );

  const contentRecommendations = uniqueItems(
    [
      siteChecks.contentQuality.longParagraphCount > 0 ? "Break long paragraphs into shorter, more scannable blocks." : "",
      siteChecks.contentQuality.mediaCount === 0 ? "Add supporting media where visuals would help explain the offer faster." : "",
      args.report.scores.clarity <= 6 ? "Tighten headlines and supporting copy around the primary action." : ""
    ].map((item) => ensureSentence(item)),
    4
  );

  const croRecommendations = uniqueItems(
    [
      siteChecks.cro.ctaCount === 0 ? "Expose a clearer primary CTA above the fold." : "",
      siteChecks.cro.formCount === 0 ? "If lead capture matters, expose a clear form or conversion path on the sampled page." : "",
      siteChecks.cro.trustSignalCount === 0 ? "Add stronger trust signals near the main CTA." : "",
      ...args.report.top_fixes
    ].map((item) => ensureSentence(item)),
    4
  );

  const scoreBreakdown: StructuredReviewTemplate["scoreBreakdown"] = [
    { category: "Performance", score: formatScore(performanceScore) },
    { category: "SEO", score: formatScore(seoScore) },
    { category: "UI/UX", score: formatScore(uiuxScore) },
    { category: "Security", score: formatScore(securityScore) },
    { category: "Mobile", score: formatScore(mobileScore) },
    { category: "Overall", score: formatScore(args.report.overall_score) }
  ];

  const limitations = uniqueItems(
    [
      ...performanceCoverage.blockers,
      ...seoCoverage.blockers,
      ...securityCoverage.blockers,
      ...mobileCoverage.blockers,
      args.accessibility?.error ? ensureSentence(args.accessibility.error) : ""
    ],
    6
  );

  return {
    executiveSummary,
    performance: {
      coverage: performanceCoverage,
      tools: ["Dedicated desktop and mobile page probes", "Saved runtime network and interaction signals"],
      metrics: performanceMetrics,
      insights: uniqueItems([...siteChecks.performance.evidence, ...performanceCoverage.evidence], 5),
      recommendations: performanceRecommendations
    },
    seo: {
      coverage: seoCoverage,
      tools: ["Live DOM metadata probe", "Same-origin HTML crawl", "robots.txt fetch", "sitemap.xml fetch", "Sampled internal-link checks"],
      groups: seoGroups,
      recommendations: seoRecommendations
    },
    uiux: {
      coverage: uiuxCoverage,
      metrics: uiuxMetrics,
      issues: uniqueItems([...args.report.weaknesses, ...uiuxCoverage.evidence].map((item) => ensureSentence(item)), 5),
      recommendations: uiuxRecommendations
    },
    security: {
      coverage: securityCoverage,
      tools: ["Live document-response header probe", "HTTPS transport verification"],
      metrics: securityMetrics,
      recommendations: securityRecommendations
    },
    technicalHealth: {
      coverage: technicalCoverage,
      metrics: technicalMetrics,
      recommendations: technicalRecommendations
    },
    mobileOptimization: {
      coverage: mobileCoverage,
      metrics: mobileMetrics,
      recommendations: mobileRecommendations
    },
    contentQuality: {
      coverage: contentCoverage,
      metrics: contentMetrics,
      recommendations: contentRecommendations
    },
    cro: {
      coverage: croCoverage,
      metrics: croMetrics,
      recommendations: croRecommendations
    },
    actionPlan: buildActionPlan({
      report: args.report,
      accessibility: args.accessibility,
      siteChecks
    }),
    scoreBreakdown,
    agentNotes: {
      confidence: buildConfidence({
        report: args.report,
        taskResults: args.taskResults,
        accessibility: args.accessibility,
        siteChecks,
        signals
      }),
      dataSources: uniqueItems(
        [
          "Task outcomes and step-by-step interaction histories",
          (args.rawEvents?.length ?? 0) > 0 ? "Saved browser raw events and failed request logs" : "",
          args.accessibility ? "Automated accessibility scan output" : "",
          args.siteChecks ? "Supplemental desktop and mobile site checks artifact" : "",
          args.mobile ? "Primary run used a mobile-sized browser" : "Primary run used a desktop-sized browser"
        ],
        5
      ),
      limitations
    }
  };
}
